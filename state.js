'use strict';

// In-memory canonical state + load/persist. The server is the single source of
// truth: clients request changes, ops here validate + mutate + persist, then
// ws.js broadcasts. Every op throws RuleError on bad input — no silent defaults.

const { db, stmts } = require('./db');
const config = require('./config');
const R = require('./rules');

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------
// characters: Map<id, char>  char = DB row + runtime {drain, granted_blue, conditions[]}
// clocks:     Map<id, clock>
// initiative: { entries: [{id, char_id|null, label|null}], turn_id: string|null }
//             — entries may be characters (id 'char:<n>') or free-standing
//               monsters/counters (id 'custom:<n>', label text)
// maps:       Map<id, map_calibration row>
// tokens:     Map<id, token row>            (grid coords — NEVER pixels)
// camera:     {center_x, center_y, zoom, rotation_deg} | null  (view-only transform)
// camera_bookmarks: [{name, center_x, center_y, zoom, rotation_deg}]
// game:       { reward_every_n_encounters, active_map_id }

const state = {
  characters: new Map(),
  clocks: new Map(),
  initiative: { entries: [], turn_id: null },
  entryConditions: new Map(), // entry_id -> [{id, kind, visibility}] for custom initiative entries
  maps: new Map(),
  tokens: new Map(),
  camera: null,
  camera_bookmarks: [],
  custom_colors: [], // GM's saved token colors ('#rrggbb'), persisted in runtime
  used_conditions: [], // every condition name the GM has used — quick-fill suggestions
  // Reported by the display client so the GM minimap can draw the exact
  // projected rectangle. Memory-only: the display re-reports on reconnect.
  display_viewport: null,
  game: null,
};

let customEntrySeq = 1;

function zeroDrain() {
  return { brawn: 0, constitution: 0, magic: 0, wits: 0 };
}

function load() {
  const game = stmts.getGame.get();
  R.assert(game, 'corrupt DB: game singleton row missing');
  state.game = { reward_every_n_encounters: game.reward_every_n_encounters, active_map_id: game.active_map_id };

  const runtime = JSON.parse(stmts.getRuntime.get().json);
  R.assert(runtime && runtime.perChar, 'corrupt DB: runtime row malformed');

  state.characters.clear();
  const migratedSheets = [];
  for (const row of stmts.allCharacters.all()) {
    const rt = runtime.perChar[row.id];
    let sheet = null;
    if (row.system === 'dnd5e') {
      sheet = JSON.parse(row.dnd_sheet);
      // One-time migration for sheets created before skills existed.
      let migrated = false;
      if (sheet.skills === undefined) {
        sheet.skills = {};
        for (const s of config.DND.SKILLS) sheet.skills[s.key] = { prof: 0, misc: 0 };
        migrated = true;
      }
      if (sheet.custom_skills === undefined) {
        sheet.custom_skills = [];
        migrated = true;
      }
      if (sheet.spells === undefined) {
        sheet.spells = [];
        migrated = true;
      }
      R.validateDndSheet(sheet);
      if (migrated) migratedSheets.push(row.id);
    }
    state.characters.set(row.id, {
      ...row,
      dnd_sheet: sheet,
      drain: rt ? rt.drain : zeroDrain(),
      granted_blue: rt ? rt.granted_blue : 0,
      conditions: [],
    });
  }
  for (const id of migratedSheets) persistCharacter(state.characters.get(id));
  state.entryConditions.clear();
  for (const c of stmts.allConditions.all()) {
    if (c.char_id !== null) {
      const char = state.characters.get(c.char_id);
      R.assert(char, `corrupt DB: condition ${c.id} references missing character ${c.char_id}`);
      char.conditions.push({ id: c.id, kind: c.kind, visibility: c.visibility });
    } else if (!state.entryConditions.has(c.entry_id)) {
      state.entryConditions.set(c.entry_id, [{ id: c.id, kind: c.kind, visibility: c.visibility }]);
    } else {
      state.entryConditions.get(c.entry_id).push({ id: c.id, kind: c.kind, visibility: c.visibility });
    }
  }

  state.clocks.clear();
  for (const row of stmts.allClocks.all()) state.clocks.set(row.id, row);

  state.maps.clear();
  for (const row of stmts.allMaps.all()) state.maps.set(row.id, row);
  state.tokens.clear();
  for (const row of stmts.allTokens.all()) state.tokens.set(row.id, row);

  // --- initiative: load, with one-time migration from the pre-custom-entries
  //     format ({order:[char_id], turn_char_id}) to entry objects. -----------
  let init = runtime.initiative;
  R.assert(init, 'corrupt DB: runtime.initiative missing');
  if (Array.isArray(init.order)) {
    init = {
      entries: init.order.map((id) => ({ id: `char:${id}`, char_id: id, label: null })),
      turn_id: Number.isInteger(init.turn_char_id) ? `char:${init.turn_char_id}` : null,
    };
  }
  R.assert(Array.isArray(init.entries), 'corrupt DB: runtime.initiative.entries malformed');
  // Drop entries for characters that no longer exist; keep custom entries.
  // Entries saved before per-entry visibility existed migrate to 'visible'.
  state.initiative.entries = init.entries
    .filter((e) => e.char_id === null || state.characters.has(e.char_id))
    .map((e) => ({ ...e, visibility: e.visibility === undefined ? 'visible' : e.visibility }));
  state.initiative.turn_id = state.initiative.entries.some((e) => e.id === init.turn_id) ? init.turn_id : null;
  for (const e of state.initiative.entries) {
    if (e.id.startsWith('custom:')) {
      customEntrySeq = Math.max(customEntrySeq, Number(e.id.slice(7)) + 1 || customEntrySeq);
    }
  }

  // Sweep conditions whose custom initiative entry no longer exists.
  for (const [entryId, conds] of [...state.entryConditions]) {
    if (!state.initiative.entries.some((e) => e.id === entryId)) {
      for (const c of conds) stmts.deleteCondition.run(c.id);
      state.entryConditions.delete(entryId);
    }
  }

  state.camera = runtime.camera === undefined ? null : runtime.camera;
  state.camera_bookmarks = Array.isArray(runtime.camera_bookmarks) ? runtime.camera_bookmarks : [];
  state.custom_colors = Array.isArray(runtime.custom_colors) ? runtime.custom_colors : [];
  state.used_conditions = Array.isArray(runtime.used_conditions) ? runtime.used_conditions : [];

  if (state.game.active_map_id !== null && !state.maps.has(state.game.active_map_id)) {
    throw new Error(`corrupt DB: active_map_id ${state.game.active_map_id} references missing map`);
  }
}

function persistRuntime() {
  const perChar = {};
  for (const [id, c] of state.characters) {
    perChar[id] = { drain: c.drain, granted_blue: c.granted_blue };
  }
  stmts.saveRuntime.run(JSON.stringify({
    perChar,
    initiative: state.initiative,
    camera: state.camera,
    camera_bookmarks: state.camera_bookmarks,
    custom_colors: state.custom_colors,
    used_conditions: state.used_conditions,
  }));
}

function persistCharacter(c) {
  stmts.updateCharacter.run({
    id: c.id, name: c.name, concept: c.concept, brawn: c.brawn, constitution: c.constitution,
    magic: c.magic, wits: c.wits, flavor: c.flavor, hidden_desire: c.hidden_desire,
    gear: c.gear, notes: c.notes, encounters_done: c.encounters_done,
    pending_points: c.pending_points, system: c.system,
    dnd_sheet: c.system === 'dnd5e' ? JSON.stringify(c.dnd_sheet) : '',
  });
}

function getChar(charId) {
  R.assertInt(charId, 'char_id');
  const c = state.characters.get(charId);
  R.assert(c, `no character with id ${charId}`);
  return c;
}

function getClock(clockId) {
  R.assertInt(clockId, 'clock_id');
  const c = state.clocks.get(clockId);
  R.assert(c, `no clock with id ${clockId}`);
  return c;
}

function getToken(tokenId) {
  R.assertInt(tokenId, 'token_id');
  const t = state.tokens.get(tokenId);
  R.assert(t, `no token with id ${tokenId}`);
  return t;
}

function activeMap() {
  R.assert(state.game.active_map_id !== null, 'no active map — upload and calibrate one first');
  return state.maps.get(state.game.active_map_id);
}

// Grid bounds derived from calibration (image space → grid space, handoff §7).
function gridDims(map) {
  return {
    cols: Math.floor((map.image_w - map.offset_x) / map.cell_size),
    rows: Math.floor((map.image_h - map.offset_y) / map.cell_size),
  };
}

// A token occupies a w×h footprint of cells; (col,row) is its top-left cell.
function assertFootprintOnGrid(col, row, w, h, map) {
  const { cols, rows } = gridDims(map);
  R.assertIntIn(w, 1, Math.min(config.TOKEN_MAX_SIZE, cols), 'w');
  R.assertIntIn(h, 1, Math.min(config.TOKEN_MAX_SIZE, rows), 'h');
  R.assertIntIn(col, 0, cols - w, 'col');
  R.assertIntIn(row, 0, rows - h, 'row');
}

function assertFiniteNumber(value, name) {
  R.assert(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

// --- Fog of war (handoff §7) ------------------------------------------------
// Per-cell visibility as a row-major bitmask: one char per grid cell, '1'
// visible / '0' hidden, length cols*rows. '' means the map has no fog data.
// Concealment is honor-system over LAN (the full map image is already served);
// what fog adds is hiding the unexplored map AND the tokens lurking in it.
function fogAllHidden(map) {
  const { cols, rows } = gridDims(map);
  return '0'.repeat(cols * rows);
}
function fogLen(map) {
  const { cols, rows } = gridDims(map);
  return cols * rows;
}
function fogCellVisible(map, col, row) {
  if (!map.fog_enabled || !map.fog) return true;
  const { cols, rows } = gridDims(map);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
  return map.fog[row * cols + col] === '1';
}
// A token is concealed when its WHOLE footprint sits on hidden cells; if any
// cell it occupies is revealed, it shows.
function tokenConcealed(map, t) {
  if (!map.fog_enabled || !map.fog) return false;
  for (let r = t.row; r < t.row + t.h; r++) {
    for (let c = t.col; c < t.col + t.w; c++) {
      if (fogCellVisible(map, c, r)) return false;
    }
  }
  return true;
}
function assertFog(fog, map, name) {
  R.assert(typeof fog === 'string', `${name} must be a string`);
  R.assert(fog.length === fogLen(map), `${name} length ${fog.length} doesn't match the ${fogLen(map)}-cell grid`);
  R.assert(/^[01]*$/.test(fog), `${name} must contain only '0' and '1'`);
  return fog;
}

function assertHexColor(value, name) {
  R.assert(typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value),
    `${name} must be a '#rrggbb' color, got ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

function assertCalibrationSane(row) {
  R.assert(row.cell_size >= 4, `cell_size must be at least 4 image pixels, got ${row.cell_size}`);
  R.assert(row.offset_x >= 0 && row.offset_x < row.cell_size, 'offset_x must be within [0, cell_size)');
  R.assert(row.offset_y >= 0 && row.offset_y < row.cell_size, 'offset_y must be within [0, cell_size)');
  const dims = gridDims(row);
  R.assert(dims.cols >= 1 && dims.rows >= 1, 'calibration leaves no whole cells on the map');
}

function removeInitiativeEntries(predicate) {
  for (const e of state.initiative.entries) {
    if (predicate(e) && state.entryConditions.has(e.id)) {
      stmts.deleteConditionsByEntry.run(e.id); // conditions die with their entry
      state.entryConditions.delete(e.id);
    }
  }
  state.initiative.entries = state.initiative.entries.filter((e) => !predicate(e));
  if (!state.initiative.entries.some((e) => e.id === state.initiative.turn_id)) {
    state.initiative.turn_id = null;
  }
}

function findCondition(conditionId) {
  R.assertInt(conditionId, 'condition_id');
  for (const c of state.characters.values()) {
    const cond = c.conditions.find((x) => x.id === conditionId);
    if (cond) return { cond, list: c.conditions };
  }
  for (const list of state.entryConditions.values()) {
    const cond = list.find((x) => x.id === conditionId);
    if (cond) return { cond, list };
  }
  throw new R.RuleError(`no condition with id ${conditionId}`);
}

// ---------------------------------------------------------------------------
// Operations (the WebSocket contract, handoff §5)
// Each returns an optional result object sent back to the requesting client.
// ---------------------------------------------------------------------------
const ops = {
  'character.create'(p) {
    const system = R.assertOneOf(p.system, config.SYSTEMS, 'system');
    const base = {
      system,
      name: R.assertNonEmptyString(p.name, 'name'),
      concept: R.assertNonEmptyString(p.concept, 'concept'),
      // Blessed empty defaults — the ONLY optional user text fields:
      flavor: R.assertString(p.flavor === undefined ? '' : p.flavor, 'flavor'),
      hidden_desire: R.assertString(p.hidden_desire === undefined ? '' : p.hidden_desire, 'hidden_desire'),
      gear: R.assertString(p.gear === undefined ? '' : p.gear, 'gear'),
      notes: R.assertString(p.notes === undefined ? '' : p.notes, 'notes'),
      encounters_done: 0,
      pending_points: 0,
    };
    let row;
    if (system === 'campfire') {
      const attrs = { brawn: p.brawn, constitution: p.constitution, magic: p.magic, wits: p.wits };
      R.validateCampfireCreation(attrs);
      row = { ...base, ...attrs, dnd_sheet: '' };
    } else {
      const sheet = R.validateDndSheet(p.sheet);
      row = { ...base, brawn: 0, constitution: 0, magic: 0, wits: 0, dnd_sheet: JSON.stringify(sheet) };
    }
    const info = stmts.insertCharacter.run(row);
    const id = Number(info.lastInsertRowid);
    state.characters.set(id, {
      ...row, id,
      dnd_sheet: system === 'dnd5e' ? JSON.parse(row.dnd_sheet) : null,
      drain: zeroDrain(), granted_blue: 0, conditions: [],
    });
    persistRuntime();
    return { created_char_id: id };
  },

  'character.update_sheet'(p) {
    const c = getChar(p.char_id);
    if (p.flavor !== undefined) c.flavor = R.assertString(p.flavor, 'flavor');
    if (p.gear !== undefined) c.gear = R.assertString(p.gear, 'gear');
    if (p.notes !== undefined) c.notes = R.assertString(p.notes, 'notes');
    if (p.hidden_desire !== undefined) c.hidden_desire = R.assertString(p.hidden_desire, 'hidden_desire');
    persistCharacter(c);
  },

  // D&D 5e sheet edit: client sends the full new sheet; server validates whole-sheet.
  // Deep-copy before storing: canonical state must never alias a caller's object.
  'character.update_dnd'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'dnd5e', `character ${c.id} is not a D&D 5e character`);
    c.dnd_sheet = R.validateDndSheet(JSON.parse(JSON.stringify(p.sheet)));
    persistCharacter(c);
  },

  'character.set_drain'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'drain applies only to Campfire Saga characters');
    const attr = R.assertOneOf(p.attr, config.ATTRIBUTES, 'attr');
    R.assertIntIn(p.amount, 0, c[attr], `drain on ${attr} (base rank ${c[attr]})`);
    c.drain[attr] = p.amount;
    persistRuntime();
  },

  'character.absorb_with_con'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'Constitution buffer applies only to Campfire Saga characters');
    const effCon = R.effectiveRank(c.constitution, c.drain.constitution, 'constitution');
    R.assert(effCon > 0, `${c.name} has no Constitution left to absorb with`);
    c.drain.constitution += 1;
    persistRuntime();
  },

  'character.grant_blue'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'blue dice apply only to Campfire Saga characters');
    R.assertInt(p.amount, 'amount');
    const next = c.granted_blue + p.amount;
    R.assert(next >= 0, `${c.name} only has ${c.granted_blue} blue dice`);
    c.granted_blue = next;
    persistRuntime();
  },

  // End-of-encounter refill (+ progression). All campfire characters when no
  // char_id given. Drain and granted blue clear; encounters_done increments;
  // every Nth encounter banks +1 attribute point to place (capped at CEILING by
  // character.spend_point).
  'character.end_encounter_refill'(p) {
    const targets = p.char_id === undefined
      ? [...state.characters.values()].filter((c) => c.system === 'campfire')
      : [getChar(p.char_id)];
    const n = state.game.reward_every_n_encounters;
    const tx = db.transaction(() => {
      for (const c of targets) {
        if (c.system !== 'campfire') continue;
        c.drain = zeroDrain();
        c.granted_blue = 0;
        c.encounters_done += 1;
        if (c.encounters_done % n === 0) c.pending_points += 1;
        persistCharacter(c);
      }
      persistRuntime();
    });
    tx();
  },

  // Place a banked progression point (the prompt surfaced by pending_points).
  'character.spend_point'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'attribute points apply only to Campfire Saga characters');
    const attr = R.assertOneOf(p.attr, config.ATTRIBUTES, 'attr');
    R.assert(c.pending_points > 0, `${c.name} has no attribute points to spend`);
    R.assert(c[attr] < config.CEILING, `${attr} is already at the ceiling of ${config.CEILING}`);
    c[attr] += 1;
    c.pending_points -= 1;
    persistCharacter(c);
  },

  'character.delete'(p) {
    const c = getChar(p.char_id);
    stmts.deleteCharacter.run(c.id); // conditions + pc tokens cascade
    state.characters.delete(c.id);
    for (const [tid, t] of state.tokens) {
      if (t.char_id === c.id) state.tokens.delete(tid);
    }
    removeInitiativeEntries((e) => e.char_id === c.id);
    persistRuntime();
  },

  // Conditions are freeform tags/notes (the built-in lists are just quick-fill
  // suggestions). Subject is a character OR a custom initiative entry.
  'condition.add'(p) {
    const kind = R.assertNonEmptyString(p.kind, 'condition name');
    R.assert(kind.length <= 60, 'condition name is too long (60 max)');
    const visibility = p.visibility === undefined ? 'visible'
      : R.assertOneOf(p.visibility, ['visible', 'dm_only'], 'visibility');
    let list, charId = null, entryId = null;
    if (p.entry_id !== undefined) {
      R.assert(state.initiative.entries.some((e) => e.id === p.entry_id && e.char_id === null),
        `no custom initiative entry '${p.entry_id}'`);
      entryId = p.entry_id;
      if (!state.entryConditions.has(entryId)) state.entryConditions.set(entryId, []);
      list = state.entryConditions.get(entryId);
    } else {
      const c = getChar(p.char_id);
      charId = c.id;
      list = c.conditions;
    }
    R.assert(!list.some((x) => x.kind.toLowerCase() === kind.toLowerCase()),
      `'${kind}' is already applied there`);
    const info = stmts.insertCondition.run(charId, entryId, kind, visibility);
    list.push({ id: Number(info.lastInsertRowid), kind, visibility });
    // remember the name for quick-fill next time (newest first, capped)
    state.used_conditions = [kind, ...state.used_conditions.filter((k) => k.toLowerCase() !== kind.toLowerCase())].slice(0, 60);
    persistRuntime();
  },

  'condition.update'(p) {
    const found = findCondition(p.condition_id);
    if (p.kind !== undefined) {
      const kind = R.assertNonEmptyString(p.kind, 'condition name');
      R.assert(kind.length <= 60, 'condition name is too long (60 max)');
      found.cond.kind = kind;
    }
    if (p.visibility !== undefined) {
      found.cond.visibility = R.assertOneOf(p.visibility, ['visible', 'dm_only'], 'visibility');
    }
    stmts.updateCondition.run(found.cond.kind, found.cond.visibility, found.cond.id);
  },

  'condition.remove'(p) {
    const found = findCondition(p.condition_id);
    stmts.deleteCondition.run(found.cond.id);
    found.list.splice(found.list.indexOf(found.cond), 1);
  },

  // --- initiative: characters AND free-standing entries (monsters, hazards,
  //     lair actions, countdowns — anything the GM types in) -----------------
  'initiative.add'(p) {
    const c = getChar(p.char_id);
    const id = `char:${c.id}`;
    R.assert(!state.initiative.entries.some((e) => e.id === id), `${c.name} is already in initiative`);
    state.initiative.entries.push({ id, char_id: c.id, label: null, visibility: 'visible' });
    persistRuntime();
  },

  'initiative.add_custom'(p) {
    const label = R.assertNonEmptyString(p.label, 'label');
    const id = `custom:${customEntrySeq++}`;
    state.initiative.entries.push({ id, char_id: null, label, visibility: 'visible' });
    persistRuntime();
    return { created_entry_id: id };
  },

  // Hide an entry from the projector + players (a GM-only reminder, an
  // unrevealed ambusher…) — same idea as dm_only clocks.
  'initiative.set_visibility'(p) {
    const entry = state.initiative.entries.find((e) => e.id === p.entry_id);
    R.assert(entry, `no initiative entry '${p.entry_id}'`);
    entry.visibility = R.assertOneOf(p.visibility, ['visible', 'dm_only'], 'visibility');
    persistRuntime();
  },

  // Remove by entry_id (works for both kinds); char_id accepted for characters.
  'initiative.remove'(p) {
    let entryId = p.entry_id;
    if (entryId === undefined) {
      entryId = `char:${R.assertInt(p.char_id, 'char_id')}`;
    }
    R.assert(state.initiative.entries.some((e) => e.id === entryId), `no initiative entry '${entryId}'`);
    removeInitiativeEntries((e) => e.id === entryId);
    persistRuntime();
  },

  'initiative.reorder'(p) {
    R.assert(Array.isArray(p.ordered_entry_ids), 'ordered_entry_ids must be an array');
    const current = state.initiative.entries.map((e) => e.id).sort();
    const proposed = [...p.ordered_entry_ids].sort();
    R.assert(current.length === proposed.length && current.every((v, i) => v === proposed[i]),
      'reorder must contain exactly the entries currently in initiative');
    const byId = new Map(state.initiative.entries.map((e) => [e.id, e]));
    state.initiative.entries = p.ordered_entry_ids.map((id) => byId.get(id));
    persistRuntime();
  },

  'initiative.set_turn'(p) {
    if (p.entry_id === null || (p.entry_id === undefined && p.char_id === null)) {
      state.initiative.turn_id = null;
    } else {
      const entryId = p.entry_id !== undefined ? p.entry_id : `char:${R.assertInt(p.char_id, 'char_id')}`;
      R.assert(state.initiative.entries.some((e) => e.id === entryId), `no initiative entry '${entryId}'`);
      state.initiative.turn_id = entryId;
    }
    persistRuntime();
  },

  'clock.create'(p) {
    const row = {
      label: R.assertNonEmptyString(p.label, 'label'),
      segments: R.assertOneOf(p.segments, config.CLOCK_SEGMENT_CHOICES, 'segments'),
      filled: 0,
      kind: R.assertOneOf(p.kind, config.CLOCK_KINDS, 'kind'),
      visibility: R.assertOneOf(p.visibility, config.CLOCK_VISIBILITIES, 'visibility'),
      token_id: p.token_id === undefined ? null : R.assertInt(p.token_id, 'token_id'),
    };
    const info = stmts.insertClock.run(row);
    const id = Number(info.lastInsertRowid);
    state.clocks.set(id, { ...row, id });
    return { created_clock_id: id };
  },

  'clock.set_filled'(p) {
    const c = getClock(p.clock_id);
    c.filled = R.assertIntIn(p.filled, 0, c.segments, 'filled');
    stmts.updateClock.run(c);
  },

  'clock.set_visibility'(p) {
    const c = getClock(p.clock_id);
    c.visibility = R.assertOneOf(p.visibility, config.CLOCK_VISIBILITIES, 'visibility');
    stmts.updateClock.run(c);
  },

  'clock.delete'(p) {
    const c = getClock(p.clock_id);
    stmts.deleteClock.run(c.id);
    state.clocks.delete(c.id);
  },

  'game.set_reward_rate'(p) {
    R.assertIntIn(p.reward_every_n_encounters, 1, 99, 'reward_every_n_encounters');
    state.game.reward_every_n_encounters = p.reward_every_n_encounters;
    stmts.updateGame.run(state.game);
  },

  // --- Phase 3: map / tokens / camera ---------------------------------------

  // After HTTP upload (§6), the GM calibrates: cell_size + offsets in IMAGE
  // pixels. Creates the map record and makes it active with a fresh camera.
  'map.calibrate'(p) {
    const row = {
      name: R.assertNonEmptyString(p.name, 'name'),
      image_path: R.assertNonEmptyString(p.image_path, 'image_path'),
      image_w: R.assertIntIn(p.image_w, 1, 16384, 'image_w'),
      image_h: R.assertIntIn(p.image_h, 1, 16384, 'image_h'),
      cell_size: assertFiniteNumber(p.cell_size, 'cell_size'),
      offset_x: assertFiniteNumber(p.offset_x, 'offset_x'),
      offset_y: assertFiniteNumber(p.offset_y, 'offset_y'),
      grid_visible: 1,
      base_rotation: 0,
      fog_enabled: 0,
      fog: '',
      fog_darkness: config.FOG_DARKNESS_DEFAULT,
    };
    assertCalibrationSane(row);
    const info = stmts.insertMap.run(row);
    const id = Number(info.lastInsertRowid);
    state.maps.set(id, { ...row, id });
    ops['map.set_active']({ map_id: id });
    return { created_map_id: id };
  },

  // Fine-tune an existing map's grid after the fact. Tokens that the new grid
  // leaves out of bounds are clamped to its edge — a deliberate migration of
  // the board, not a silent default.
  'map.update_calibration'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    const oldFog = map.fog;
    const oldDims = gridDims(map);
    const next = {
      ...map,
      cell_size: assertFiniteNumber(p.cell_size, 'cell_size'),
      offset_x: assertFiniteNumber(p.offset_x, 'offset_x'),
      offset_y: assertFiniteNumber(p.offset_y, 'offset_y'),
    };
    assertCalibrationSane(next);
    Object.assign(map, next);
    stmts.updateMapCalibration.run(map.cell_size, map.offset_x, map.offset_y, map.id);
    // Re-grid the fog: the new grid is a different size, so re-stamp visibility
    // for the cells the two grids share and leave the rest hidden.
    if (map.fog_enabled && oldFog) {
      const nd = gridDims(map);
      const arr = new Array(nd.cols * nd.rows).fill('0');
      for (let r = 0; r < Math.min(oldDims.rows, nd.rows); r++) {
        for (let c = 0; c < Math.min(oldDims.cols, nd.cols); c++) {
          if (oldFog[r * oldDims.cols + c] === '1') arr[r * nd.cols + c] = '1';
        }
      }
      map.fog = arr.join('');
      stmts.setMapFog.run(map.fog, map.id);
    }
    if (state.game.active_map_id === map.id) {
      const dims = gridDims(map);
      for (const t of state.tokens.values()) {
        // shrink footprints that no longer fit, then pull positions onto the grid
        const w = Math.min(t.w, dims.cols);
        const h = Math.min(t.h, dims.rows);
        const col = Math.min(Math.max(t.col, 0), dims.cols - w);
        const row = Math.min(Math.max(t.row, 0), dims.rows - h);
        if (col !== t.col || row !== t.row || w !== t.w || h !== t.h) {
          Object.assign(t, { col, row, w, h });
          stmts.updateToken.run(t);
        }
      }
    }
  },

  'map.rename'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    map.name = R.assertNonEmptyString(p.name, 'name');
    stmts.renameMap.run(map.name, map.id);
  },

  'map.set_active'(p) {
    if (p.map_id === null) {
      state.game.active_map_id = null;
      state.camera = null;
    } else {
      R.assertInt(p.map_id, 'map_id');
      const map = state.maps.get(p.map_id);
      R.assert(map, `no map with id ${p.map_id}`);
      state.game.active_map_id = map.id;
      // open at the map's primary orientation; the GM can still rotate from there
      state.camera = { center_x: map.image_w / 2, center_y: map.image_h / 2, zoom: 1, rotation_deg: map.base_rotation || 0 };
    }
    stmts.updateGame.run(state.game);
    persistRuntime();
  },

  // Overlay the calibrated grid on the projector — off for art with its own grid.
  'map.set_grid_visible'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    R.assert(typeof p.visible === 'boolean', 'visible must be a boolean');
    map.grid_visible = p.visible ? 1 : 0;
    stmts.setMapGridVisible.run(map.grid_visible, map.id);
  },

  // The map's primary orientation (0/90/180/270). Persisted with the map and
  // used to seed the camera when it opens; applied live if it's already showing.
  'map.set_base_rotation'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    map.base_rotation = R.assertOneOf(p.rotation_deg, config.MAP_ROTATIONS, 'rotation_deg');
    stmts.setMapBaseRotation.run(map.base_rotation, map.id);
    if (state.game.active_map_id === map.id && state.camera) {
      state.camera.rotation_deg = map.base_rotation;
      persistRuntime();
    }
  },

  // Turn fog of war on/off for a map. Switching it on for a map that has no fog
  // data yet hides the whole board — the GM then reveals the opening area.
  'map.set_fog_enabled'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    R.assert(typeof p.enabled === 'boolean', 'enabled must be a boolean');
    map.fog_enabled = p.enabled ? 1 : 0;
    if (map.fog_enabled && map.fog.length !== fogLen(map)) map.fog = fogAllHidden(map);
    stmts.setMapFogEnabled.run(map.fog_enabled, map.fog, map.id);
  },

  // Replace the whole visibility bitmask (the fog editor commits the result of a
  // paint/lasso stroke, or a reveal-all / hide-all, this way).
  'map.set_fog'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    map.fog = assertFog(p.fog, map, 'fog');
    stmts.setMapFog.run(map.fog, map.id);
  },

  // Dial the projector fog from light gray (0) to pitch black (1) — dark room vs
  // actual fog.
  'map.set_fog_darkness'(p) {
    R.assertInt(p.map_id, 'map_id');
    const map = state.maps.get(p.map_id);
    R.assert(map, `no map with id ${p.map_id}`);
    const d = assertFiniteNumber(p.darkness, 'darkness');
    R.assert(d >= 0 && d <= 1, 'darkness must be within [0, 1]');
    map.fog_darkness = d;
    stmts.setMapFogDarkness.run(d, map.id);
  },

  'map.delete'(p) {
    R.assertInt(p.map_id, 'map_id');
    R.assert(state.maps.has(p.map_id), `no map with id ${p.map_id}`);
    if (state.game.active_map_id === p.map_id) ops['map.set_active']({ map_id: null });
    stmts.deleteMap.run(p.map_id);
    state.maps.delete(p.map_id);
  },

  'token.create'(p) {
    const map = activeMap();
    const kind = R.assertOneOf(p.kind, config.TOKEN_KINDS, 'kind');
    const row = {
      label: R.assertNonEmptyString(p.label, 'label'),
      kind,
      char_id: null,
      col: p.col, row: p.row,
      // creation defaults by kind — overridable per token
      w: p.w === undefined ? 1 : p.w,
      h: p.h === undefined ? 1 : p.h,
      shape: p.shape === undefined ? config.TOKEN_DEFAULT_SHAPES[kind] : R.assertOneOf(p.shape, config.TOKEN_SHAPES, 'shape'),
      color: p.color === undefined ? config.TOKEN_DEFAULT_COLORS[kind] : assertHexColor(p.color, 'color'),
      glow_color: null, glow_radius: null, glow_pulse: null,
    };
    assertFootprintOnGrid(row.col, row.row, row.w, row.h, map);
    if (kind === 'pc') {
      const c = getChar(p.char_id);
      R.assert(![...state.tokens.values()].some((t) => t.char_id === c.id),
        `${c.name} already has a token on the map`);
      row.char_id = c.id;
    }
    if (kind === 'glow') {
      row.glow_color = row.color; // the glow IS the color
      row.glow_radius = assertFiniteNumber(p.glow_radius, 'glow_radius');
      R.assert(row.glow_radius > 0 && row.glow_radius <= 20, 'glow_radius must be in (0, 20] cells');
      row.glow_pulse = assertFiniteNumber(p.glow_pulse, 'glow_pulse');
      R.assert(row.glow_pulse >= 0 && row.glow_pulse <= 5, 'glow_pulse must be in [0, 5] Hz');
    }
    const info = stmts.insertToken.run(row);
    const id = Number(info.lastInsertRowid);
    state.tokens.set(id, { ...row, id });
    return { created_token_id: id };
  },

  'token.set_color'(p) {
    const t = getToken(p.token_id);
    t.color = assertHexColor(p.color, 'color');
    if (t.kind === 'glow') t.glow_color = t.color;
    stmts.updateToken.run(t);
  },

  'token.move'(p) {
    const t = getToken(p.token_id);
    assertFootprintOnGrid(p.col, p.row, t.w, t.h, activeMap());
    t.col = p.col;
    t.row = p.row;
    stmts.updateToken.run(t);
  },

  // Resize / reshape a token. If growing it would push the footprint past the
  // map edge, the position is pulled back to fit — deliberate, not silent.
  'token.set_size'(p) {
    const t = getToken(p.token_id);
    const map = activeMap();
    const { cols, rows } = gridDims(map);
    const w = R.assertIntIn(p.w, 1, Math.min(config.TOKEN_MAX_SIZE, cols), 'w');
    const h = R.assertIntIn(p.h, 1, Math.min(config.TOKEN_MAX_SIZE, rows), 'h');
    t.shape = R.assertOneOf(p.shape, config.TOKEN_SHAPES, 'shape');
    t.w = w;
    t.h = h;
    t.col = Math.min(t.col, cols - w);
    t.row = Math.min(t.row, rows - h);
    stmts.updateToken.run(t);
  },

  'token.delete'(p) {
    const t = getToken(p.token_id);
    stmts.deleteToken.run(t.id);
    state.tokens.delete(t.id);
  },

  // Camera is a pure view transform (handoff §7) — it NEVER touches token
  // positions. rotation_deg is degrees; the display converts to radians.
  'camera.update'(p) {
    const map = activeMap();
    const cam = {
      center_x: assertFiniteNumber(p.center_x, 'center_x'),
      center_y: assertFiniteNumber(p.center_y, 'center_y'),
      zoom: assertFiniteNumber(p.zoom, 'zoom'),
      rotation_deg: assertFiniteNumber(p.rotation_deg, 'rotation_deg'),
    };
    R.assert(cam.zoom >= config.CAMERA_ZOOM_MIN && cam.zoom <= config.CAMERA_ZOOM_MAX,
      `zoom must be within ${config.CAMERA_ZOOM_MIN}..${config.CAMERA_ZOOM_MAX}`);
    R.assert(cam.center_x >= 0 && cam.center_x <= map.image_w
      && cam.center_y >= 0 && cam.center_y <= map.image_h, 'camera center must be on the map');
    state.camera = cam;
    persistRuntime();
  },

  // The projector tells us its screen size (on connect and resize) so the GM
  // minimap can outline exactly what's being shown on the wall.
  'display.report_viewport'(p) {
    R.assertIntIn(p.width, 1, 20000, 'width');
    R.assertIntIn(p.height, 1, 20000, 'height');
    state.display_viewport = { width: p.width, height: p.height };
  },

  'camera.save_bookmark'(p) {
    R.assert(state.camera, 'no camera to bookmark — activate a map first');
    const name = R.assertNonEmptyString(p.name, 'name');
    state.camera_bookmarks = state.camera_bookmarks.filter((b) => b.name !== name);
    state.camera_bookmarks.push({ name, ...state.camera });
    persistRuntime();
  },

  'camera.delete_bookmark'(p) {
    const name = R.assertNonEmptyString(p.name, 'name');
    R.assert(state.camera_bookmarks.some((b) => b.name === name), `no bookmark named '${name}'`);
    state.camera_bookmarks = state.camera_bookmarks.filter((b) => b.name !== name);
    persistRuntime();
  },

  // GM's saved token colors — a small personal palette that survives restarts.
  'palette.save_color'(p) {
    const color = assertHexColor(p.color, 'color');
    if (!state.custom_colors.includes(color)) {
      R.assert(state.custom_colors.length < config.CUSTOM_COLOR_LIMIT,
        `palette is full (${config.CUSTOM_COLOR_LIMIT}) — delete a saved color first`);
      state.custom_colors.push(color);
      persistRuntime();
    }
  },

  'palette.delete_color'(p) {
    const color = assertHexColor(p.color, 'color');
    R.assert(state.custom_colors.includes(color), `'${color}' is not in the saved palette`);
    state.custom_colors = state.custom_colors.filter((c) => c !== color);
    persistRuntime();
  },
};

// ---------------------------------------------------------------------------
// Role-scoped snapshots (handoff §5). Scoping is enforced HERE, server-side —
// secrets never leave the process for the wrong role.
// ---------------------------------------------------------------------------

function publicCharacter(c, { includeHiddenDesire, includeSecretConditions }) {
  const out = {
    id: c.id, system: c.system, name: c.name, concept: c.concept,
    flavor: c.flavor, gear: c.gear, notes: c.notes,
    encounters_done: c.encounters_done, pending_points: c.pending_points,
    drain: { ...c.drain }, granted_blue: c.granted_blue,
    // dm_only conditions are the GM's private notes — even about your own character
    conditions: c.conditions
      .filter((x) => includeSecretConditions || x.visibility === 'visible')
      .map((x) => ({ ...x })),
  };
  if (c.system === 'campfire') {
    out.brawn = c.brawn; out.constitution = c.constitution; out.magic = c.magic; out.wits = c.wits;
    out.effective = {};
    out.dice = {};
    for (const attr of config.ATTRIBUTES) {
      const eff = R.effectiveRank(c[attr], c.drain[attr], attr);
      out.effective[attr] = eff;
      out.dice[attr] = R.diceForRank(eff);
    }
  } else {
    out.dnd_sheet = JSON.parse(JSON.stringify(c.dnd_sheet));
  }
  if (includeHiddenDesire) out.hidden_desire = c.hidden_desire;
  return out;
}

function snapshotFor(role, charId) {
  R.assertOneOf(role, ['player', 'dm', 'display'], 'role');
  const chars = [...state.characters.values()];
  const clocks = [...state.clocks.values()];
  const activeMapRow = state.game.active_map_id === null ? null : { ...state.maps.get(state.game.active_map_id) };
  // Tokens lurking entirely in the fog are dropped for players and the projector
  // (decision: hide ALL tokens in fog, PCs included). The GM keeps the full set.
  const allTokens = [...state.tokens.values()];
  const roleTokens = (role === 'dm' || activeMapRow === null || !activeMapRow.fog_enabled)
    ? allTokens
    : allTokens.filter((t) => !tokenConcealed(activeMapRow, t));
  const base = {
    game: { reward_every_n_encounters: state.game.reward_every_n_encounters, active_map_id: state.game.active_map_id },
    initiative: {
      // dm_only entries (GM reminders, hidden threats) never reach players or
      // the projector — filtered server-side like dm_only clocks. Entry
      // conditions ride along, with the same visibility filter.
      entries: state.initiative.entries
        .filter((e) => role === 'dm' || e.visibility === 'visible')
        .map((e) => ({
          ...e,
          conditions: (state.entryConditions.get(e.id) === undefined ? [] : state.entryConditions.get(e.id))
            .filter((x) => role === 'dm' || x.visibility === 'visible')
            .map((x) => ({ ...x })),
        })),
      turn_id: state.initiative.turn_id,
    },
    map: activeMapRow,
    tokens: roleTokens.map((t) => ({ ...t })),
    camera: state.camera === null ? null : { ...state.camera },
    display_viewport: state.display_viewport === null ? null : { ...state.display_viewport },
    config: {
      STARTING_POINTS: config.STARTING_POINTS,
      CREATION_MAX: config.CREATION_MAX,
      CEILING: config.CEILING,
      ATTRIBUTES: config.ATTRIBUTES,
      CONDITIONS: config.CONDITIONS,
      CLOCK_SEGMENT_CHOICES: config.CLOCK_SEGMENT_CHOICES,
      TOKEN_KINDS: config.TOKEN_KINDS,
      TOKEN_DEFAULT_COLORS: config.TOKEN_DEFAULT_COLORS,
      TOKEN_SHAPES: config.TOKEN_SHAPES,
      TOKEN_DEFAULT_SHAPES: config.TOKEN_DEFAULT_SHAPES,
      MAP_ROTATIONS: config.MAP_ROTATIONS,
      DND: config.DND,
    },
  };
  if (role === 'dm') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: true, includeSecretConditions: true })),
      clocks: clocks.map((c) => ({ ...c })),
      maps: [...state.maps.values()].map((m) => ({ ...m })),
      camera_bookmarks: state.camera_bookmarks.map((b) => ({ ...b })),
      custom_colors: [...state.custom_colors],
      used_conditions: [...state.used_conditions],
    };
  }
  if (role === 'player') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: c.id === charId, includeSecretConditions: false })),
      clocks: clocks.filter((c) => c.visibility === 'visible').map((c) => ({ ...c })),
    };
  }
  // display: roster + visible clocks only; never hidden desires, never dm_only clocks.
  return {
    ...base,
    characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: false, includeSecretConditions: false })),
    clocks: clocks.filter((c) => c.visibility === 'visible').map((c) => ({ ...c })),
  };
}

module.exports = { state, load, ops, snapshotFor };
