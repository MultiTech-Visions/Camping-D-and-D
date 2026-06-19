'use strict';

// In-memory canonical state + load/persist. The server is the single source of
// truth: clients request changes, ops here validate + mutate + persist, then
// ws.js broadcasts. Every op throws RuleError on bad input — no silent defaults.

const { db, stmts } = require('./db');
const config = require('./config');
const R = require('./rules');
const mushroom = require('./mushroom');

// Broadcast hook, wired by ws.js. Lets async hardware-status changes (the
// mushroom helper connecting / dying) push fresh snapshots to clients without
// state.js depending on ws.js. No-op until ws.js registers the real one.
let broadcast = () => {};
function setBroadcaster(fn) { broadcast = fn; }

// Mirror the mushroom controller's status into state and re-broadcast whenever
// it changes asynchronously (helper connects, light drops out of range, etc.).
mushroom.onChange((snap) => {
  state.mushroom = snap;
  broadcast();
});

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------
// characters: Map<id, char>  char = DB row + runtime {drain, blue_dice[], conditions[]}
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
  cards: new Map(),    // id -> reveal card { id, kind, name, subtitle, notes, images[], sections[], token_*, bg_*, visited, seen } — NPCs/locations/story (visited/seen gate the players' Knowledge section)
  camera: null,
  camera_bookmarks: [],
  custom_colors: [], // GM's saved token colors ('#rrggbb'), persisted in runtime
  // GM-tunable global settings (UX/feel knobs), persisted in runtime.
  settings: {
    // per-reveal-kind splash images shown when the projector swaps screens. A
    // kind with no image just does a soft direct fade instead of a splash.
    transition_images: { npc: '', location: '', story: '' },
    transitions_enabled: true,  // play transitions at all
    transition_ms: 520,         // how long the splash/fade lingers (ms)
    scroll_speed: 1,            // multiplier for the projector text auto-crawl speed
    particles_enabled: true,    // global on/off for the reveal particle effects
  },
  used_conditions: [], // every condition name the GM has used — quick-fill suggestions
  devices: new Map(),  // device_id -> { id, name } — player phones/tablets, named by their owner
  // Reported by the display client so the GM minimap can draw the exact
  // projected rectangle. Memory-only: the display re-reports on reconnect.
  display_viewport: null,
  // Which image of the revealed NPC the GM is holding on the projector (from
  // their viewer). null = let the reveal run its auto slideshow. Memory-only:
  // it's tied to the GM having their control window open, so a restart sensibly
  // falls back to the slideshow.
  reveal_image_index: null,
  // (connector-line on/off is now a per-card, persisted property — see card.show_link)
  // GM-driven slow auto-scroll of the reveal's text column on the PROJECTOR. When
  // paused the crawl holds where it is so the GM can dwell on what's on screen.
  // Memory-only; a fresh reveal starts unpaused.
  reveal_scroll_paused: false,
  // GM "focus" — { section, entry } into the PUBLIC (visible) sections/entries of
  // the revealed card. entry null = the whole section. The projector scrolls to
  // it and lifts it above the dimmed rest; null = no focus. Memory-only; cleared
  // on a fresh reveal.
  reveal_focus: null,
  // Mushroom lamp (BLE campfire on the projector stand). Memory-only hardware
  // status, mirrored from mushroom.js; defaults off on boot (a restart never
  // surprises the camp by lighting the lamp on its own). { on, status, detail }.
  mushroom: mushroom.snapshot(),
  game: null,
};

let customEntrySeq = 1;

function zeroDrain() {
  return { brawn: 0, constitution: 0, magic: 0, wits: 0 };
}

// Blue (Boost) dice are banked per-character as an array of entries, each
// carrying the origin note that says where/when it was earned — the heart of
// the storytelling feature. Legacy DBs stored a bare integer count; migrate
// those to that many noteless dice so nothing is lost.
function loadBlueDice(rt) {
  if (rt && Array.isArray(rt.blue_dice)) {
    return rt.blue_dice.map((d, i) => ({
      id: Number.isInteger(d.id) ? d.id : i + 1,
      note: typeof d.note === 'string' ? d.note : '',
      encounter: Number.isInteger(d.encounter) ? d.encounter : 0,
      ts: typeof d.ts === 'string' ? d.ts : '',
    }));
  }
  const legacy = rt && Number.isInteger(rt.granted_blue) ? rt.granted_blue : 0;
  return Array.from({ length: Math.max(0, legacy) }, (_, i) => ({
    id: i + 1, note: '', encounter: 0, ts: '',
  }));
}

// Next free id within a character's banked dice (ids are unique per character).
function nextBlueDieId(c) {
  return c.blue_dice.reduce((m, d) => Math.max(m, d.id), 0) + 1;
}

function load() {
  const game = stmts.getGame.get();
  R.assert(game, 'corrupt DB: game singleton row missing');
  state.game = {
    reward_every_n_encounters: game.reward_every_n_encounters,
    active_map_id: game.active_map_id,
    revealed_card_id: game.revealed_card_id == null ? null : game.revealed_card_id,
  };

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
      blue_dice: loadBlueDice(rt),
      conditions: [],
      notes_records: [],
    });
  }
  for (const id of migratedSheets) persistCharacter(state.characters.get(id));

  // Player notebook records, attached to their owning character (private to that
  // character's phone — see snapshotFor). FK CASCADE keeps these from outliving
  // a deleted character, so any orphan would be a corrupt DB.
  for (const row of stmts.allNotes.all()) {
    const c = state.characters.get(row.char_id);
    R.assert(c, `corrupt DB: note ${row.id} references missing character ${row.char_id}`);
    c.notes_records.push({
      id: row.id, char_id: row.char_id, title: row.title, body: row.body,
      pinned: !!row.pinned, created_at: row.created_at, updated_at: row.updated_at,
    });
  }
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

  state.cards.clear();
  for (const row of stmts.allCards.all()) {
    state.cards.set(row.id, {
      id: row.id, kind: row.kind, name: row.name, subtitle: row.subtitle, notes: row.notes,
      images: JSON.parse(row.images), sections: JSON.parse(row.sections),
      token_w: row.token_w, token_h: row.token_h, token_shape: row.token_shape,
      bg_image: row.bg_image, bg_effect: row.bg_effect, visited: !!row.visited,
      seen: !!row.seen,
      images_slides: row.images_slides === undefined ? true : !!row.images_slides,
      show_link: row.show_link === undefined ? true : !!row.show_link,
    });
  }
  // A revealed card that was since deleted leaves a dangling pointer — clear it.
  if (state.game.revealed_card_id !== null && !state.cards.has(state.game.revealed_card_id)) {
    state.game.revealed_card_id = null;
    stmts.updateGame.run(state.game);
  }

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
    .map((e) => ({
      ...e,
      visibility: e.visibility === undefined ? 'visible' : e.visibility,
      art: e.art === undefined || e.art === null ? '' : e.art,
      w: e.w === undefined ? 1 : e.w,
      h: e.h === undefined ? 1 : e.h,
      shape: e.shape === undefined ? 'circle' : e.shape,
    }));
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
  // Bookmarks are per-map. Pre-map_id bookmarks migrate to the map that was
  // active when we loaded; with no active map there's nothing they can belong
  // to, so they're dropped. Bookmarks for deleted maps are swept.
  state.camera_bookmarks = (Array.isArray(runtime.camera_bookmarks) ? runtime.camera_bookmarks : [])
    .map((b) => (b.map_id === undefined ? { ...b, map_id: game.active_map_id } : b))
    .filter((b) => b.map_id !== null && state.maps.has(b.map_id));
  state.custom_colors = Array.isArray(runtime.custom_colors) ? runtime.custom_colors : [];
  const rs = runtime.settings || {};
  const clampNum = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const safeImg = (v) => (typeof v === 'string' && (v === '' || /^\/assets\/tokens\/[\w.-]+$/.test(v))) ? v : '';
  const ti = rs.transition_images || {};
  state.settings = {
    transition_images: { npc: safeImg(ti.npc), location: safeImg(ti.location), story: safeImg(ti.story) },
    transitions_enabled: rs.transitions_enabled !== false,
    transition_ms: clampNum(rs.transition_ms, 200, 3000, 520),
    scroll_speed: clampNum(rs.scroll_speed, 0.3, 3, 1),
    particles_enabled: rs.particles_enabled !== false,
  };
  state.used_conditions = Array.isArray(runtime.used_conditions) ? runtime.used_conditions : [];

  state.devices.clear();
  for (const row of stmts.allDevices.all()) state.devices.set(row.id, { id: row.id, name: row.name });

  if (state.game.active_map_id !== null && !state.maps.has(state.game.active_map_id)) {
    throw new Error(`corrupt DB: active_map_id ${state.game.active_map_id} references missing map`);
  }
}

function persistRuntime() {
  const perChar = {};
  for (const [id, c] of state.characters) {
    perChar[id] = { drain: c.drain, blue_dice: c.blue_dice };
  }
  stmts.saveRuntime.run(JSON.stringify({
    perChar,
    initiative: state.initiative,
    camera: state.camera,
    camera_bookmarks: state.camera_bookmarks,
    custom_colors: state.custom_colors,
    settings: state.settings,
    used_conditions: state.used_conditions,
  }));
}

function persistCharacter(c) {
  stmts.updateCharacter.run({
    id: c.id, name: c.name, concept: c.concept, brawn: c.brawn, constitution: c.constitution,
    magic: c.magic, wits: c.wits, flavor: c.flavor, hidden_desire: c.hidden_desire,
    gear: c.gear, notes: c.notes, encounters_done: c.encounters_done,
    pending_points: c.pending_points, system: c.system, token_art: c.token_art,
    dnd_sheet: c.system === 'dnd5e' ? JSON.stringify(c.dnd_sheet) : '',
    device_id: c.device_id || null,
  });
}

function getChar(charId) {
  R.assertInt(charId, 'char_id');
  const c = state.characters.get(charId);
  R.assert(c, `no character with id ${charId}`);
  return c;
}

// Record a device seen on a hello. A non-empty name (the device naming itself)
// wins; an empty name only ensures the id exists without clobbering a prior name.
// Returns true if the known set or a name changed (so ws.js can broadcast).
function registerDevice(id, name) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const existing = state.devices.get(id);
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (cleanName) {
    if (existing && existing.name === cleanName) return false;
    state.devices.set(id, { id, name: cleanName });
    stmts.setDeviceName.run(id, cleanName);
    return true;
  }
  if (!existing) {
    state.devices.set(id, { id, name: '' });
    stmts.ensureDevice.run(id);
    return true;
  }
  return false;
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

function getCard(cardId) {
  R.assertInt(cardId, 'card_id');
  const c = state.cards.get(cardId);
  R.assert(c, `no card with id ${cardId}`);
  return c;
}

function persistCard(c) {
  stmts.updateCard.run({
    id: c.id, name: c.name, subtitle: c.subtitle, notes: c.notes,
    images: JSON.stringify(c.images), sections: JSON.stringify(c.sections),
    token_w: c.token_w, token_h: c.token_h, token_shape: c.token_shape,
    bg_image: c.bg_image, bg_effect: c.bg_effect, visited: c.visited ? 1 : 0,
    seen: c.seen ? 1 : 0,
    images_slides: c.images_slides === false ? 0 : 1,
    show_link: c.show_link === false ? 0 : 1,
  });
}

// Card images: an ordered list of genuinely-uploaded images (the slideshow; for
// an NPC the first is the map token). Same path rule as token art.
function assertCardImages(value, name) {
  R.assert(Array.isArray(value), `${name} must be an array`);
  R.assert(value.length <= 12, `${name}: too many images (12 max)`);
  return value.map((p) => {
    R.assert(typeof p === 'string' && /^\/assets\/tokens\/[\w.-]+$/.test(p),
      `${name} entries must be uploaded image paths, got ${JSON.stringify(p)}`);
    return p;
  });
}

// Card sections: [{ title, images, entries: [{ label, text, visible, done, images }] }].
// Free text throughout. visible drives whether an entry shows on the reveal;
// done is GM-only progress tracking. images on a chapter/scene join the reveal
// slideshow when that content is revealed (graphic-novel panels).
function assertCardSections(value, name) {
  R.assert(Array.isArray(value), `${name} must be an array`);
  R.assert(value.length <= 40, `${name}: too many sections (40 max)`);
  return value.map((s) => {
    R.assert(s !== null && typeof s === 'object' && !Array.isArray(s), 'each section must be an object');
    R.assert(Array.isArray(s.entries), 'section entries must be an array');
    R.assert(s.entries.length <= 100, 'too many entries in a section (100 max)');
    return {
      title: R.assertString(s.title === undefined ? '' : s.title, 'section title').slice(0, 80),
      images: assertCardImages(s.images === undefined ? [] : s.images, 'section images'),
      // visible: chapter-level reveal gate, INDEPENDENT of each scene's visible
      visible: s.visible === undefined ? true : !!s.visible,
      // slides: whether this chapter's images are included in the reveal slideshow
      slides: s.slides === undefined ? true : !!s.slides,
      entries: s.entries.map((e) => {
        R.assert(e !== null && typeof e === 'object' && !Array.isArray(e), 'each entry must be an object');
        return {
          label: R.assertString(e.label === undefined ? '' : e.label, 'entry label').slice(0, 80),
          text: R.assertString(e.text === undefined ? '' : e.text, 'entry text').slice(0, 4000),
          visible: e.visible === undefined ? true : !!e.visible,
          done: e.done === undefined ? false : !!e.done,
          images: assertCardImages(e.images === undefined ? [] : e.images, 'entry images'),
          slides: e.slides === undefined ? true : !!e.slides,
        };
      }),
    };
  });
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

// '' = no portrait; otherwise must be a genuinely uploaded token image.
function assertTokenArt(value, name) {
  R.assertString(value, name);
  R.assert(value === '' || /^\/assets\/tokens\/[\w.-]+$/.test(value),
    `${name} must be an uploaded token image path, got ${JSON.stringify(value)}`);
  return value;
}

// Clock note: freeform GM bookkeeping, capped so the DB can't balloon.
function assertClockNote(value) {
  R.assertString(value, 'note');
  R.assert(value.length <= 2000, 'note is too long (keep it under 2000 characters)');
  return value;
}

// Player notebook record fields. Title is a one-line label; body is the note
// itself (generous cap for long-term journaling, still bounded so the DB can't
// balloon).
function assertNoteTitle(value) {
  R.assertString(value, 'title');
  R.assert(value.length <= 120, 'title is too long (keep it under 120 characters)');
  return value;
}
function assertNoteBody(value) {
  R.assertString(value, 'body');
  R.assert(value.length <= 20000, 'note is too long (keep it under 20000 characters)');
  return value;
}

// Find a notebook record by id across every character (records carry a unique
// global id). Returns the record plus the list it lives in, for in-place edits.
function getNoteRecord(noteId) {
  R.assertInt(noteId, 'note_id');
  for (const c of state.characters.values()) {
    const rec = c.notes_records.find((r) => r.id === noteId);
    if (rec) return { rec, list: c.notes_records };
  }
  throw new R.RuleError(`no note with id ${noteId}`);
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
    const device_id = (typeof p.device_id === 'string' && p.device_id.length > 0) ? p.device_id : null;
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
      token_art: assertTokenArt(p.token_art === undefined ? '' : p.token_art, 'token_art'),
      device_id,
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
      drain: zeroDrain(), blue_dice: [], conditions: [], notes_records: [],
      device_id,
    });
    persistRuntime();
    return { created_char_id: id };
  },

  'character.update_sheet'(p) {
    const c = getChar(p.char_id);
    if (p.name !== undefined) c.name = R.assertNonEmptyString(p.name, 'name');
    if (p.concept !== undefined) c.concept = R.assertNonEmptyString(p.concept, 'concept');
    if (p.flavor !== undefined) c.flavor = R.assertString(p.flavor, 'flavor');
    if (p.gear !== undefined) c.gear = R.assertString(p.gear, 'gear');
    if (p.notes !== undefined) c.notes = R.assertString(p.notes, 'notes');
    if (p.hidden_desire !== undefined) c.hidden_desire = R.assertString(p.hidden_desire, 'hidden_desire');
    if (p.token_art !== undefined) {
      c.token_art = assertTokenArt(p.token_art, 'token_art');
      // keep a live map token in step with the portrait
      for (const t of state.tokens.values()) {
        if (t.char_id === c.id) {
          t.art = c.token_art === '' ? null : c.token_art;
          stmts.updateToken.run(t);
        }
      }
    }
    if (p.device_id !== undefined) {
      const did = (typeof p.device_id === 'string' && p.device_id.length > 0) ? p.device_id : null;
      c.device_id = did;
      stmts.setCharacterDevice.run(did, c.id);
    }
    if (c.system === 'campfire') {
      for (const attr of config.ATTRIBUTES) {
        if (p[attr] !== undefined) {
          R.assertIntIn(p[attr], 0, config.CEILING, attr);
          c[attr] = p[attr];
          if (c.drain[attr] > c[attr]) c.drain[attr] = c[attr];
        }
      }
    }
    persistCharacter(c);
  },

  'character.set_device'(p) {
    const c = getChar(p.char_id);
    const did = p.device_id === null ? null : (typeof p.device_id === 'string' && p.device_id.length > 0 ? p.device_id : null);
    c.device_id = did;
    stmts.setCharacterDevice.run(did, c.id);
  },

  // Name a device. Used by the device itself ("Sara's phone") and by the GM
  // to label a device that hasn't named itself.
  'device.set_name'(p) {
    const id = R.assertNonEmptyString(p.device_id, 'device_id');
    const name = R.assertString(p.name === undefined ? '' : p.name, 'name').trim().slice(0, 60);
    state.devices.set(id, { id, name });
    stmts.setDeviceName.run(id, name);
  },

  // Forget a device. Any characters still linked to it are unlinked (not deleted)
  // so they fall back to the "Unassigned" list instead of pointing at a ghost id.
  'device.delete'(p) {
    const id = R.assertNonEmptyString(p.device_id, 'device_id');
    for (const c of state.characters.values()) {
      if (c.device_id === id) {
        c.device_id = null;
        stmts.setCharacterDevice.run(null, c.id);
      }
    }
    state.devices.delete(id);
    stmts.deleteDevice.run(id);
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

  // Bank a single blue (Boost) die with the origin note that records where it
  // came from. The note is required — capturing the story is the whole point.
  'character.add_blue'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'blue dice apply only to Campfire Saga characters');
    const note = R.assertNonEmptyString(p.note, 'note');
    R.assert(note.length <= 500, 'note is too long (keep the origin to ~500 characters)');
    c.blue_dice.push({
      id: nextBlueDieId(c),
      note,
      encounter: c.encounters_done,
      ts: new Date().toISOString(),
    });
    persistRuntime();
  },

  // Spend (remove) one banked blue die by id.
  'character.spend_blue'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'blue dice apply only to Campfire Saga characters');
    R.assertInt(p.die_id, 'die_id');
    const i = c.blue_dice.findIndex((d) => d.id === p.die_id);
    R.assert(i !== -1, `${c.name} has no banked blue die #${p.die_id}`);
    c.blue_dice.splice(i, 1);
    persistRuntime();
  },

  // Edit the origin note on a banked die (fix a typo, flesh out the story).
  'character.edit_blue_note'(p) {
    const c = getChar(p.char_id);
    R.assert(c.system === 'campfire', 'blue dice apply only to Campfire Saga characters');
    R.assertInt(p.die_id, 'die_id');
    const die = c.blue_dice.find((d) => d.id === p.die_id);
    R.assert(die, `${c.name} has no banked blue die #${p.die_id}`);
    const note = R.assertNonEmptyString(p.note, 'note');
    R.assert(note.length <= 500, 'note is too long (keep the origin to ~500 characters)');
    die.note = note;
    persistRuntime();
  },

  // ---- Player notebook: many titled records per character, for long-term
  // note-taking. Private to the owning character's phone (snapshotFor only ships
  // a player their own characters' records). Each record lives in its own
  // note_record row, persisted immediately. Search is client-side over the
  // records a player already holds, so no server query op is needed.
  'note.create'(p) {
    const c = getChar(p.char_id);
    const title = assertNoteTitle(p.title === undefined ? '' : p.title);
    const body = assertNoteBody(p.body === undefined ? '' : p.body);
    R.assert(title.trim().length > 0 || body.trim().length > 0, 'a note needs a title or some text');
    const now = new Date().toISOString();
    const row = { char_id: c.id, title, body, pinned: 0, created_at: now, updated_at: now };
    const info = stmts.insertNote.run(row);
    const id = Number(info.lastInsertRowid);
    c.notes_records.push({ id, char_id: c.id, title, body, pinned: false, created_at: now, updated_at: now });
    return { created_note_id: id };
  },

  'note.update'(p) {
    const { rec } = getNoteRecord(p.note_id);
    if (p.title !== undefined) rec.title = assertNoteTitle(p.title);
    if (p.body !== undefined) rec.body = assertNoteBody(p.body);
    if (p.pinned !== undefined) {
      R.assert(typeof p.pinned === 'boolean', 'pinned must be a boolean');
      rec.pinned = p.pinned;
    }
    rec.updated_at = new Date().toISOString();
    stmts.updateNote.run({
      id: rec.id, title: rec.title, body: rec.body,
      pinned: rec.pinned ? 1 : 0, updated_at: rec.updated_at,
    });
  },

  'note.delete'(p) {
    const { rec, list } = getNoteRecord(p.note_id);
    stmts.deleteNote.run(rec.id);
    list.splice(list.indexOf(rec), 1);
  },

  // End-of-encounter refill (+ progression). All campfire characters when no
  // char_id given. Drain clears; encounters_done increments; every Nth
  // encounter banks +1 attribute point to place (capped at CEILING by
  // character.spend_point). Banked blue dice deliberately PERSIST across
  // encounters — players carry their noted dice forward to call back to the
  // moments that earned them.
  'character.end_encounter_refill'(p) {
    const targets = p.char_id === undefined
      ? [...state.characters.values()].filter((c) => c.system === 'campfire')
      : [getChar(p.char_id)];
    const n = state.game.reward_every_n_encounters;
    const tx = db.transaction(() => {
      for (const c of targets) {
        if (c.system !== 'campfire') continue;
        c.drain = zeroDrain();
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
    stmts.deleteCharacter.run(c.id); // conditions + pc tokens + notebook cascade
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
    // optional portrait + footprint — lets NPC/token-derived entries carry their
    // token image and size into the turn order (and onto the map when spawned)
    const art = assertTokenArt(p.art === undefined || p.art === null ? '' : p.art, 'art');
    const w = p.w === undefined ? 1 : R.assertIntIn(p.w, 1, config.TOKEN_MAX_SIZE, 'w');
    const h = p.h === undefined ? 1 : R.assertIntIn(p.h, 1, config.TOKEN_MAX_SIZE, 'h');
    const shape = p.shape === undefined ? 'circle' : R.assertOneOf(p.shape, config.TOKEN_SHAPES, 'shape');
    const id = `custom:${customEntrySeq++}`;
    state.initiative.entries.push({ id, char_id: null, label, visibility: 'visible', art, w, h, shape });
    persistRuntime();
    return { created_entry_id: id };
  },

  // Change (or clear) a custom entry's portrait after the fact.
  'initiative.set_art'(p) {
    const entry = state.initiative.entries.find((e) => e.id === p.entry_id && e.char_id === null);
    R.assert(entry, `no custom initiative entry '${p.entry_id}'`);
    entry.art = assertTokenArt(p.art === undefined || p.art === null ? '' : p.art, 'art');
    persistRuntime();
  },

  // Rename a custom entry — lets the GM tell apart multiple copies of the same
  // monster ("Ogre King A", "Ogre King B"). Character entries take their name
  // from the character, so only custom entries are renameable.
  'initiative.set_label'(p) {
    const entry = state.initiative.entries.find((e) => e.id === p.entry_id && e.char_id === null);
    R.assert(entry, `no custom initiative entry '${p.entry_id}'`);
    entry.label = R.assertNonEmptyString(p.label, 'label');
    persistRuntime();
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
      note: assertClockNote(p.note === undefined ? '' : p.note),
    };
    const info = stmts.insertClock.run(row);
    const id = Number(info.lastInsertRowid);
    state.clocks.set(id, { ...row, id });
    return { created_clock_id: id };
  },

  // The GM's long-term note on a clock — where it came from, what it's for,
  // anything worth remembering. GM-only bookkeeping; never reaches players or
  // the projector (stripped in the role-scoped snapshots).
  'clock.set_note'(p) {
    const c = getClock(p.clock_id);
    c.note = assertClockNote(p.note === undefined ? '' : p.note);
    stmts.updateClock.run(c);
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

  // Mushroom lamp on/off. Memory-only (hardware state, not persisted): spawns /
  // kills the BLE flame helper via mushroom.js. The controller's async onChange
  // keeps state.mushroom current as the helper connects or drops.
  'mushroom.set'(p) {
    R.assert(typeof p.on === 'boolean', 'mushroom.set: on must be true or false');
    mushroom.setOn(p.on);
    state.mushroom = mushroom.snapshot();
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
        if (t.map_id !== map.id) continue; // only this map's tokens live on this grid
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
    stmts.deleteMap.run(p.map_id); // ON DELETE CASCADE clears the map's tokens in the DB
    state.maps.delete(p.map_id);
    for (const [id, t] of state.tokens) if (t.map_id === p.map_id) state.tokens.delete(id); // and from memory
    state.camera_bookmarks = state.camera_bookmarks.filter((b) => b.map_id !== p.map_id);
    persistRuntime();
  },

  'token.create'(p) {
    const map = activeMap();
    const kind = R.assertOneOf(p.kind, config.TOKEN_KINDS, 'kind');
    const row = {
      map_id: map.id, // tokens belong to the map they were placed on
      label: R.assertNonEmptyString(p.label, 'label'),
      kind,
      char_id: null,
      col: p.col, row: p.row,
      // creation defaults by kind — overridable per token
      w: p.w === undefined ? 1 : p.w,
      h: p.h === undefined ? 1 : p.h,
      shape: p.shape === undefined ? config.TOKEN_DEFAULT_SHAPES[kind] : R.assertOneOf(p.shape, config.TOKEN_SHAPES, 'shape'),
      color: p.color === undefined ? config.TOKEN_DEFAULT_COLORS[kind] : assertHexColor(p.color, 'color'),
      art: null, // set via token.set_art after upload
      glow_color: null, glow_radius: null, glow_pulse: null,
    };
    assertFootprintOnGrid(row.col, row.row, row.w, row.h, map);
    if (kind === 'pc') {
      const c = getChar(p.char_id);
      R.assert(![...state.tokens.values()].some((t) => t.char_id === c.id && t.map_id === map.id),
        `${c.name} already has a token on this map`);
      row.char_id = c.id;
      if (c.token_art !== '') row.art = c.token_art; // the portrait follows the character
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

  // Attach uploaded art to a token (null clears it back to the colored shape).
  'token.set_art'(p) {
    const t = getToken(p.token_id);
    R.assert(t.kind !== 'glow', 'glow tokens are pure light — no art');
    if (p.art === null) {
      t.art = null;
    } else {
      R.assertNonEmptyString(p.art, 'art');
      R.assert(/^\/assets\/tokens\/[\w.-]+$/.test(p.art), `art must be an uploaded token image path, got ${JSON.stringify(p.art)}`);
      t.art = p.art;
    }
    stmts.updateToken.run(t);
    if (t.char_id !== null) {
      // pc tokens mirror back to the character's portrait, so it survives the
      // token being removed and re-placed next encounter
      const c = getChar(t.char_id);
      c.token_art = t.art === null ? '' : t.art;
      persistCharacter(c);
    }
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

  // Saved views belong to the map they were framed on — a "throne room" view
  // means nothing on the swamp map.
  'camera.save_bookmark'(p) {
    R.assert(state.camera, 'no camera to bookmark — activate a map first');
    const mapId = state.game.active_map_id;
    const name = R.assertNonEmptyString(p.name, 'name');
    state.camera_bookmarks = state.camera_bookmarks.filter((b) => !(b.name === name && b.map_id === mapId));
    state.camera_bookmarks.push({ name, map_id: mapId, ...state.camera });
    persistRuntime();
  },

  'camera.delete_bookmark'(p) {
    const mapId = state.game.active_map_id;
    const name = R.assertNonEmptyString(p.name, 'name');
    R.assert(state.camera_bookmarks.some((b) => b.name === name && b.map_id === mapId),
      `no bookmark named '${name}' on the active map`);
    state.camera_bookmarks = state.camera_bookmarks.filter((b) => !(b.name === name && b.map_id === mapId));
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

  // --- Reveal cards: NPCs, locations, and story beats (one mechanism) --------

  'card.create'(p) {
    const kind = R.assertOneOf(p.kind, config.CARD_KINDS, 'kind');
    const name = R.assertNonEmptyString(p.name, 'name');
    const row = {
      kind, name, subtitle: '', notes: '', images: '[]', sections: '[]',
      token_w: 1, token_h: 1, token_shape: 'circle', bg_image: '', bg_effect: 'embers', visited: 0, seen: 0, images_slides: 1, show_link: 1,
    };
    const info = stmts.insertCard.run(row);
    const id = Number(info.lastInsertRowid);
    state.cards.set(id, {
      id, kind, name, subtitle: '', notes: '', images: [], sections: [],
      token_w: 1, token_h: 1, token_shape: 'circle', bg_image: '', bg_effect: 'embers', visited: false, seen: false, images_slides: true, show_link: true,
    });
    return { created_card_id: id };
  },

  // Partial update — only the fields present are touched. images/sections are
  // replaced wholesale and validated (same shape the GM edits client-side).
  'card.update'(p) {
    const c = getCard(p.card_id);
    if (p.name !== undefined) c.name = R.assertNonEmptyString(p.name, 'name');
    if (p.subtitle !== undefined) c.subtitle = R.assertString(p.subtitle, 'subtitle').slice(0, 120);
    if (p.notes !== undefined) c.notes = R.assertString(p.notes, 'notes').slice(0, 8000);
    if (p.images !== undefined) c.images = assertCardImages(p.images, 'images');
    if (p.sections !== undefined) c.sections = assertCardSections(p.sections, 'sections');
    if (p.token_w !== undefined) c.token_w = R.assertIntIn(p.token_w, 1, config.TOKEN_MAX_SIZE, 'token_w');
    if (p.token_h !== undefined) c.token_h = R.assertIntIn(p.token_h, 1, config.TOKEN_MAX_SIZE, 'token_h');
    if (p.token_shape !== undefined) c.token_shape = R.assertOneOf(p.token_shape, config.TOKEN_SHAPES, 'token_shape');
    if (p.bg_image !== undefined) c.bg_image = assertTokenArt(p.bg_image === null ? '' : p.bg_image, 'bg_image');
    if (p.bg_effect !== undefined) c.bg_effect = R.assertOneOf(p.bg_effect, config.NPC_EFFECTS, 'bg_effect');
    if (p.visited !== undefined) { R.assert(typeof p.visited === 'boolean', 'visited must be a boolean'); c.visited = p.visited; }
    if (p.seen !== undefined) { R.assert(typeof p.seen === 'boolean', 'seen must be a boolean'); c.seen = p.seen; }
    if (p.images_slides !== undefined) { R.assert(typeof p.images_slides === 'boolean', 'images_slides must be a boolean'); c.images_slides = p.images_slides; }
    persistCard(c);
  },

  // GM holds a specific image of the revealed card on the projector (driven from
  // their viewer's carousel); null releases back to the auto slideshow.
  'card.set_reveal_image'(p) {
    if (p.index === null || p.index === undefined) {
      state.reveal_image_index = null;
    } else {
      state.reveal_image_index = R.assertIntIn(p.index, 0, 1000, 'index');
    }
  },

  // Live toggle of a single entry's visibility — the GM flips these on/off as a
  // scene unfolds, and the reveal screen updates instantly.
  'card.set_entry_visibility'(p) {
    const c = getCard(p.card_id);
    const si = R.assertInt(p.section, 'section');
    const ei = R.assertInt(p.entry, 'entry');
    R.assert(c.sections[si], `no section ${si} on card ${c.id}`);
    R.assert(c.sections[si].entries[ei], `no entry ${ei} in section ${si}`);
    R.assert(typeof p.visible === 'boolean', 'visible must be a boolean');
    c.sections[si].entries[ei].visible = p.visible;
    persistCard(c);
  },

  // GM-only progress tracking: mark an entry (e.g. a story scene) done/not done.
  'card.set_entry_done'(p) {
    const c = getCard(p.card_id);
    const si = R.assertInt(p.section, 'section');
    const ei = R.assertInt(p.entry, 'entry');
    R.assert(c.sections[si], `no section ${si} on card ${c.id}`);
    R.assert(c.sections[si].entries[ei], `no entry ${ei} in section ${si}`);
    R.assert(typeof p.done === 'boolean', 'done must be a boolean');
    c.sections[si].entries[ei].done = p.done;
    persistCard(c);
  },

  // Whether a scene's / chapter's images ride in the reveal slideshow — separate
  // from whether its text is shown, so a done scene can stay visible but drop its
  // panels out of the mix.
  'card.set_entry_slides'(p) {
    const c = getCard(p.card_id);
    const si = R.assertInt(p.section, 'section');
    const ei = R.assertInt(p.entry, 'entry');
    R.assert(c.sections[si] && c.sections[si].entries[ei], `no entry ${ei} in section ${si}`);
    R.assert(typeof p.slides === 'boolean', 'slides must be a boolean');
    c.sections[si].entries[ei].slides = p.slides;
    persistCard(c);
  },

  'card.set_section_slides'(p) {
    const c = getCard(p.card_id);
    const si = R.assertInt(p.section, 'section');
    R.assert(c.sections[si], `no section ${si} on card ${c.id}`);
    R.assert(typeof p.slides === 'boolean', 'slides must be a boolean');
    c.sections[si].slides = p.slides;
    persistCard(c);
  },

  // Reveal/hide a whole chapter via its OWN visibility gate — independent of the
  // individual scene show/hides (those are preserved).
  'card.set_section_visible'(p) {
    const c = getCard(p.card_id);
    const si = R.assertInt(p.section, 'section');
    R.assert(c.sections[si], `no section ${si} on card ${c.id}`);
    R.assert(typeof p.visible === 'boolean', 'visible must be a boolean');
    c.sections[si].visible = p.visible;
    persistCard(c);
  },

  'card.delete'(p) {
    const c = getCard(p.card_id);
    stmts.deleteCard.run(c.id);
    state.cards.delete(c.id);
    if (state.game.revealed_card_id === c.id) {
      state.game.revealed_card_id = null;
      state.reveal_image_index = null;
      stmts.updateGame.run(state.game);
    }
  },

  // Show this card full-screen on the projector + players (null to dismiss).
  // Like map.set_active, it's a single piece of presentation state.
  'card.reveal'(p) {
    if (p.card_id === null || p.card_id === undefined) {
      state.game.revealed_card_id = null;
    } else {
      state.game.revealed_card_id = getCard(p.card_id).id;
    }
    state.reveal_image_index = null; // a new reveal starts on the auto slideshow
    state.reveal_scroll_paused = false; // ...and with the text crawl running
    state.reveal_focus = null; // ...and with nothing spotlighted
    stmts.updateGame.run(state.game);
  },

  // GM toggles a card's connector line on/off — a per-card preference (some
  // cards it helps, others it's noise), persisted so it survives restarts.
  'card.set_show_link'(p) {
    const c = getCard(p.card_id);
    c.show_link = !!p.on;
    persistCard(c);
  },

  // GM pauses/resumes the projector's slow text crawl so the table can dwell.
  'card.set_scroll_paused'(p) {
    state.reveal_scroll_paused = !!p.paused;
  },

  // GM spotlights a public section (entry null) or one entry on the projector
  // (scroll-to + lift over the dimmed rest); section null clears it. Indices are
  // into the revealed card's VISIBLE sections/entries.
  'card.set_focus'(p) {
    if (!p || p.section === null || p.section === undefined) {
      state.reveal_focus = null;
      return;
    }
    const section = R.assertIntIn(p.section, 0, 1000, 'section');
    const entry = (p.entry === null || p.entry === undefined)
      ? null : R.assertIntIn(p.entry, 0, 1000, 'entry');
    state.reveal_focus = { section, entry };
  },

  // GM global UX settings (persisted). Only the keys present are touched.
  'settings.update'(p) {
    if (p.transition_images !== undefined) {
      R.assert(p.transition_images && typeof p.transition_images === 'object', 'transition_images must be an object');
      for (const kind of ['npc', 'location', 'story']) {
        const v = p.transition_images[kind];
        if (v !== undefined) {
          state.settings.transition_images[kind] = assertTokenArt(v === null ? '' : v, `transition_images.${kind}`);
        }
      }
    }
    if (p.transitions_enabled !== undefined) {
      R.assert(typeof p.transitions_enabled === 'boolean', 'transitions_enabled must be a boolean');
      state.settings.transitions_enabled = p.transitions_enabled;
    }
    if (p.transition_ms !== undefined) {
      state.settings.transition_ms = R.assertIntIn(p.transition_ms, 200, 3000, 'transition_ms');
    }
    if (p.scroll_speed !== undefined) {
      R.assert(typeof p.scroll_speed === 'number' && p.scroll_speed >= 0.3 && p.scroll_speed <= 3, 'scroll_speed must be 0.3–3');
      state.settings.scroll_speed = p.scroll_speed;
    }
    if (p.particles_enabled !== undefined) {
      R.assert(typeof p.particles_enabled === 'boolean', 'particles_enabled must be a boolean');
      state.settings.particles_enabled = p.particles_enabled;
    }
    persistRuntime();
  },
};

// Clamp the GM's focus to the composed public sections — a section/entry that
// was hidden or removed since it was set clears the focus rather than dangling.
function publicFocus(publicSections) {
  const f = state.reveal_focus;
  if (!f || typeof f.section !== 'number' || f.section >= publicSections.length) return null;
  if (f.entry === null || f.entry === undefined) return { section: f.section, entry: null };
  const sec = publicSections[f.section];
  if (!sec || f.entry >= sec.entries.length) return null;
  return { section: f.section, entry: f.entry };
}

// Player/projector view of the revealed card: visible entries only, no GM notes
// or done flags. Sections with nothing visible are dropped so no empty headers
// reach the wall.
// Static player/projector view of ANY card: visible entries only, no GM notes or
// done flags. Sections with nothing visible are dropped so no empty headers reach
// the wall. The live reveal-only knobs (GM-held image index, paused crawl, focus)
// default to "off" here — publicRevealedCard() layers those on for the card that's
// actually being presented.
function publicCardView(c) {
  // Compose the slideshow AND the public sections together, so each image can
  // carry the index of the (public) chapter/scene that supplied it — the reveal
  // draws a connector line from that text to the image frame. e:-1 = chapter
  // image, e>=0 = scene image, source null = the card's own images.
  const publicSections = [];
  const images = [];
  const imageSources = [];
  // the card's own images (the "arc" gallery) — gated by images_slides, sourced
  // to the card name so the reveal can draw the connector from the title
  if (c.images_slides !== false) {
    for (const img of c.images) { images.push(img); imageSources.push({ card: true }); }
  }
  for (const s of c.sections) {
    if (s.visible === false) continue; // chapter hidden → nothing from it
    const visEntries = s.entries.filter((e) => e.visible);
    if (visEntries.length === 0) continue;
    const psIdx = publicSections.length;
    publicSections.push({ title: s.title, entries: visEntries.map((e) => ({ label: e.label, text: e.text })) });
    if (s.slides !== false && Array.isArray(s.images)) {
      for (const img of s.images) { images.push(img); imageSources.push({ s: psIdx, e: -1 }); }
    }
    visEntries.forEach((e, peIdx) => {
      if (e.slides !== false && Array.isArray(e.images)) {
        for (const img of e.images) { images.push(img); imageSources.push({ s: psIdx, e: peIdx }); }
      }
    });
  }
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    subtitle: c.subtitle,
    images,
    image_sources: imageSources,
    bg_image: c.bg_image,
    bg_effect: c.bg_effect,
    image_index: null,      // no GM-held image — let the slideshow run
    show_link: c.show_link !== false,
    scroll_paused: false,   // not the live reveal — never paused
    // global feel knobs the reveal honors (auto-scroll speed, particle on/off)
    scroll_speed: state.settings.scroll_speed || 1,
    particles_enabled: state.settings.particles_enabled !== false,
    focus: null,            // focus is a live-reveal spotlight only
    _publicSections: publicSections, // internal handle so the live view can clamp focus
    sections: publicSections,
  };
}

function publicRevealedCard() {
  if (state.game.revealed_card_id === null) return null;
  const c = state.cards.get(state.game.revealed_card_id);
  if (!c) return null;
  const view = publicCardView(c);
  const publicSections = view._publicSections;
  delete view._publicSections;
  // layer the live reveal-only state onto the static view
  // GM-held image index (clamped to the composed list), else null = slideshow
  view.image_index = (typeof state.reveal_image_index === 'number' && state.reveal_image_index < view.images.length)
    ? state.reveal_image_index : null;
  view.scroll_paused = !!state.reveal_scroll_paused;
  // clamp to a real section/entry; a stale focus (content changed underneath) clears
  view.focus = publicFocus(publicSections);
  return view;
}

// The party's shared Knowledge: cards the players have been let in on — visited
// locations and met NPCs (story stays GM-only for now). Each is the same static
// public view the reveal component renders, so tapping one in the Knowledge
// section replays exactly the screen they were shown.
function knownCards() {
  const out = [];
  for (const c of state.cards.values()) {
    const known = (c.kind === 'location' && c.visited) || (c.kind === 'npc' && c.seen);
    if (!known) continue;
    const view = publicCardView(c);
    delete view._publicSections;
    // a known card with nothing public to show would be a blank entry — skip it
    if (view.images.length === 0 && view.sections.length === 0) continue;
    out.push(view);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Role-scoped snapshots (handoff §5). Scoping is enforced HERE, server-side —
// secrets never leave the process for the wrong role.
// ---------------------------------------------------------------------------

function publicCharacter(c, { includeHiddenDesire, includeSecretConditions, includeDeviceId, includeNotes }) {
  const out = {
    id: c.id, system: c.system, name: c.name, concept: c.concept,
    flavor: c.flavor, gear: c.gear, notes: c.notes, token_art: c.token_art,
    encounters_done: c.encounters_done, pending_points: c.pending_points,
    drain: { ...c.drain },
    blue_dice: c.blue_dice.map((d) => ({ ...d })),
    granted_blue: c.blue_dice.length, // derived count, kept for the dice-pool renderers
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
  if (includeDeviceId) out.device_id = c.device_id || null;
  // Notebook records ride only the owning player's snapshot — never the GM's or
  // the projector's — keeping a player's private journal private (and snapshots
  // for the other roles lean).
  if (includeNotes) out.notes_records = c.notes_records.map((r) => ({ ...r }));
  return out;
}

function snapshotFor(role, charId, deviceId, connectedDeviceIds = []) {
  R.assertOneOf(role, ['player', 'dm', 'display'], 'role');
  const chars = [...state.characters.values()];
  const clocks = [...state.clocks.values()];
  const activeMapRow = state.game.active_map_id === null ? null : { ...state.maps.get(state.game.active_map_id) };
  // Tokens lurking entirely in the fog are dropped for players and the projector
  // (decision: hide ALL tokens in fog, PCs included). The GM keeps the full set.
  // Tokens are scoped to their map — only the active map's tokens are ever sent.
  const allTokens = activeMapRow === null
    ? []
    : [...state.tokens.values()].filter((t) => t.map_id === activeMapRow.id);
  const roleTokens = (role === 'dm' || activeMapRow === null || !activeMapRow.fog_enabled)
    ? allTokens
    : allTokens.filter((t) => !tokenConcealed(activeMapRow, t));
  const base = {
    game: { reward_every_n_encounters: state.game.reward_every_n_encounters, active_map_id: state.game.active_map_id },
    // global UX settings (transition splash, etc.) — every role gets them so the
    // projector can act on them and the GM can edit them.
    settings: {
      transition_images: {
        npc: state.settings.transition_images.npc || '',
        location: state.settings.transition_images.location || '',
        story: state.settings.transition_images.story || '',
      },
      transitions_enabled: state.settings.transitions_enabled !== false,
      transition_ms: state.settings.transition_ms || 520,
      scroll_speed: state.settings.scroll_speed || 1,
      particles_enabled: state.settings.particles_enabled !== false,
    },
    // reveal display prefs the GM drives from their preview (connector line is now
    // per-card on card.show_link; these two are transient runtime state).
    reveal_scroll_paused: !!state.reveal_scroll_paused,
    reveal_focus: state.reveal_focus ? { section: state.reveal_focus.section, entry: state.reveal_focus.entry } : null,
    // Mushroom lamp status for the GM toggle (every role gets it; only the GM
    // screen renders a control).
    mushroom: { on: !!state.mushroom.on, status: state.mushroom.status, detail: state.mushroom.detail || '' },
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
      NPC_EFFECTS: config.NPC_EFFECTS,
      CARD_KINDS: config.CARD_KINDS,
      DND: config.DND,
    },
  };
  if (role === 'dm') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: true, includeSecretConditions: true, includeDeviceId: true })),
      clocks: clocks.map((c) => ({ ...c })),
      maps: [...state.maps.values()].map((m) => ({ ...m })),
      // only the active map's saved views — a view is meaningless elsewhere
      camera_bookmarks: state.camera_bookmarks
        .filter((b) => b.map_id === state.game.active_map_id)
        .map((b) => ({ ...b })),
      custom_colors: [...state.custom_colors],
      used_conditions: [...state.used_conditions],
      // full card library (GM-only — includes private notes, hidden + done flags)
      cards: JSON.parse(JSON.stringify([...state.cards.values()])),
      revealed_card_id: state.game.revealed_card_id,
      revealed_card: publicRevealedCard(),
      connected_device_ids: connectedDeviceIds,
      // Every known device (named or not) plus any connected ones, with names + online flag.
      devices: [...new Set([...state.devices.keys(), ...connectedDeviceIds])].map((id) => ({
        id,
        name: (state.devices.get(id) || {}).name || '',
        online: connectedDeviceIds.includes(id),
      })),
    };
  }
  if (role === 'player') {
    const playerChars = deviceId
      ? chars.filter((c) => c.device_id === deviceId)
      : [];
    return {
      ...base,
      characters: playerChars.map((c) => publicCharacter(c, { includeHiddenDesire: c.id === charId, includeSecretConditions: false, includeNotes: true })),
      // note is GM-only bookkeeping — strip it from player snapshots
      clocks: clocks.filter((c) => c.visibility === 'visible').map(({ note, ...c }) => c),
      device_name: deviceId ? ((state.devices.get(deviceId) || {}).name || '') : '',
      revealed_card: publicRevealedCard(),
      // shared party knowledge — visited locations + met NPCs, browsable any time
      known_cards: knownCards(),
    };
  }
  // display: roster + visible clocks only; never hidden desires, never dm_only
  // clocks, never the GM's private clock notes.
  return {
    ...base,
    characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: false, includeSecretConditions: false })),
    clocks: clocks.filter((c) => c.visibility === 'visible').map(({ note, ...c }) => c),
    revealed_card: publicRevealedCard(),
  };
}

module.exports = { state, load, ops, snapshotFor, registerDevice, setBroadcaster };
