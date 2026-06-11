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
  maps: new Map(),
  tokens: new Map(),
  camera: null,
  camera_bookmarks: [],
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
  for (const row of stmts.allCharacters.all()) {
    const rt = runtime.perChar[row.id];
    state.characters.set(row.id, {
      ...row,
      dnd_sheet: row.system === 'dnd5e' ? R.validateDndSheet(JSON.parse(row.dnd_sheet)) : null,
      drain: rt ? rt.drain : zeroDrain(),
      granted_blue: rt ? rt.granted_blue : 0,
      conditions: [],
    });
  }
  for (const c of stmts.allConditions.all()) {
    const char = state.characters.get(c.char_id);
    R.assert(char, `corrupt DB: condition ${c.id} references missing character ${c.char_id}`);
    char.conditions.push({ id: c.id, kind: c.kind });
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
  state.initiative.entries = init.entries.filter((e) => e.char_id === null || state.characters.has(e.char_id));
  state.initiative.turn_id = state.initiative.entries.some((e) => e.id === init.turn_id) ? init.turn_id : null;
  for (const e of state.initiative.entries) {
    if (e.id.startsWith('custom:')) {
      customEntrySeq = Math.max(customEntrySeq, Number(e.id.slice(7)) + 1 || customEntrySeq);
    }
  }

  state.camera = runtime.camera === undefined ? null : runtime.camera;
  state.camera_bookmarks = Array.isArray(runtime.camera_bookmarks) ? runtime.camera_bookmarks : [];

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

function assertOnGrid(col, row, map) {
  const { cols, rows } = gridDims(map);
  R.assertIntIn(col, 0, cols - 1, 'col');
  R.assertIntIn(row, 0, rows - 1, 'row');
}

function assertFiniteNumber(value, name) {
  R.assert(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function removeInitiativeEntries(predicate) {
  state.initiative.entries = state.initiative.entries.filter((e) => !predicate(e));
  if (!state.initiative.entries.some((e) => e.id === state.initiative.turn_id)) {
    state.initiative.turn_id = null;
  }
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
  'character.update_dnd'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'dnd5e', `character ${c.id} is not a D&D 5e character`);
    c.dnd_sheet = R.validateDndSheet(p.sheet);
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

  'condition.add'(p) {
    const c = getChar(p.char_id);
    R.assertOneOf(p.kind, config.CONDITIONS[c.system], 'condition kind');
    R.assert(!c.conditions.some((x) => x.kind === p.kind), `${c.name} already has condition '${p.kind}'`);
    const info = stmts.insertCondition.run(c.id, p.kind);
    c.conditions.push({ id: Number(info.lastInsertRowid), kind: p.kind });
  },

  'condition.remove'(p) {
    R.assertInt(p.condition_id, 'condition_id');
    let owner = null;
    for (const c of state.characters.values()) {
      if (c.conditions.some((x) => x.id === p.condition_id)) { owner = c; break; }
    }
    R.assert(owner, `no condition with id ${p.condition_id}`);
    stmts.deleteCondition.run(p.condition_id);
    owner.conditions = owner.conditions.filter((x) => x.id !== p.condition_id);
  },

  // --- initiative: characters AND free-standing entries (monsters, hazards,
  //     lair actions, countdowns — anything the GM types in) -----------------
  'initiative.add'(p) {
    const c = getChar(p.char_id);
    const id = `char:${c.id}`;
    R.assert(!state.initiative.entries.some((e) => e.id === id), `${c.name} is already in initiative`);
    state.initiative.entries.push({ id, char_id: c.id, label: null });
    persistRuntime();
  },

  'initiative.add_custom'(p) {
    const label = R.assertNonEmptyString(p.label, 'label');
    const id = `custom:${customEntrySeq++}`;
    state.initiative.entries.push({ id, char_id: null, label });
    persistRuntime();
    return { created_entry_id: id };
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
      image_path: R.assertNonEmptyString(p.image_path, 'image_path'),
      image_w: R.assertIntIn(p.image_w, 1, 16384, 'image_w'),
      image_h: R.assertIntIn(p.image_h, 1, 16384, 'image_h'),
      cell_size: assertFiniteNumber(p.cell_size, 'cell_size'),
      offset_x: assertFiniteNumber(p.offset_x, 'offset_x'),
      offset_y: assertFiniteNumber(p.offset_y, 'offset_y'),
    };
    R.assert(row.cell_size >= 4, `cell_size must be at least 4 image pixels, got ${row.cell_size}`);
    R.assert(row.offset_x >= 0 && row.offset_x < row.cell_size, 'offset_x must be within [0, cell_size)');
    R.assert(row.offset_y >= 0 && row.offset_y < row.cell_size, 'offset_y must be within [0, cell_size)');
    const dims = gridDims(row);
    R.assert(dims.cols >= 1 && dims.rows >= 1, 'calibration leaves no whole cells on the map');
    const info = stmts.insertMap.run(row);
    const id = Number(info.lastInsertRowid);
    state.maps.set(id, { ...row, id });
    ops['map.set_active']({ map_id: id });
    return { created_map_id: id };
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
      state.camera = { center_x: map.image_w / 2, center_y: map.image_h / 2, zoom: 1, rotation_deg: 0 };
    }
    stmts.updateGame.run(state.game);
    persistRuntime();
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
      glow_color: null, glow_radius: null, glow_pulse: null,
    };
    assertOnGrid(p.col, p.row, map);
    if (kind === 'pc') {
      const c = getChar(p.char_id);
      R.assert(![...state.tokens.values()].some((t) => t.char_id === c.id),
        `${c.name} already has a token on the map`);
      row.char_id = c.id;
    }
    if (kind === 'glow') {
      row.glow_color = R.assertNonEmptyString(p.glow_color, 'glow_color');
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

  'token.move'(p) {
    const t = getToken(p.token_id);
    assertOnGrid(p.col, p.row, activeMap());
    t.col = p.col;
    t.row = p.row;
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
};

// ---------------------------------------------------------------------------
// Role-scoped snapshots (handoff §5). Scoping is enforced HERE, server-side —
// secrets never leave the process for the wrong role.
// ---------------------------------------------------------------------------

function publicCharacter(c, { includeHiddenDesire }) {
  const out = {
    id: c.id, system: c.system, name: c.name, concept: c.concept,
    flavor: c.flavor, gear: c.gear, notes: c.notes,
    encounters_done: c.encounters_done, pending_points: c.pending_points,
    drain: { ...c.drain }, granted_blue: c.granted_blue,
    conditions: c.conditions.map((x) => ({ ...x })),
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
  const base = {
    game: { reward_every_n_encounters: state.game.reward_every_n_encounters, active_map_id: state.game.active_map_id },
    initiative: {
      entries: state.initiative.entries.map((e) => ({ ...e })),
      turn_id: state.initiative.turn_id,
    },
    map: activeMapRow,
    tokens: [...state.tokens.values()].map((t) => ({ ...t })),
    camera: state.camera === null ? null : { ...state.camera },
    config: {
      STARTING_POINTS: config.STARTING_POINTS,
      CREATION_MAX: config.CREATION_MAX,
      CEILING: config.CEILING,
      ATTRIBUTES: config.ATTRIBUTES,
      CONDITIONS: config.CONDITIONS,
      CLOCK_SEGMENT_CHOICES: config.CLOCK_SEGMENT_CHOICES,
      TOKEN_KINDS: config.TOKEN_KINDS,
      DND: config.DND,
    },
  };
  if (role === 'dm') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: true })),
      clocks: clocks.map((c) => ({ ...c })),
      maps: [...state.maps.values()].map((m) => ({ ...m })),
      camera_bookmarks: state.camera_bookmarks.map((b) => ({ ...b })),
    };
  }
  if (role === 'player') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: c.id === charId })),
      clocks: clocks.filter((c) => c.visibility === 'visible').map((c) => ({ ...c })),
    };
  }
  // display: roster + visible clocks only; never hidden desires, never dm_only clocks.
  return {
    ...base,
    characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: false })),
    clocks: clocks.filter((c) => c.visibility === 'visible').map((c) => ({ ...c })),
  };
}

module.exports = { state, load, ops, snapshotFor };
