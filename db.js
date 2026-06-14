'use strict';

// better-sqlite3 setup: schema + prepared statements. Synchronous and throws on
// bad SQL — exactly the fail-loud behaviour we want. One logical read = one query.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

// CAMPFIRE_DATA_DIR override exists for the self-test, which must never touch
// the real campaign database.
const DATA_DIR = process.env.CAMPFIRE_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'campfire.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS character (
  id              INTEGER PRIMARY KEY,
  system          TEXT    NOT NULL CHECK (system IN ('campfire','dnd5e')),
  name            TEXT    NOT NULL,
  concept         TEXT    NOT NULL,
  brawn           INTEGER NOT NULL,
  constitution    INTEGER NOT NULL,
  magic           INTEGER NOT NULL,
  wits            INTEGER NOT NULL,
  flavor          TEXT    NOT NULL,
  hidden_desire   TEXT    NOT NULL,
  gear            TEXT    NOT NULL,
  notes           TEXT    NOT NULL,
  encounters_done INTEGER NOT NULL,
  pending_points  INTEGER NOT NULL,
  token_art       TEXT    NOT NULL DEFAULT '',  -- portrait; auto-applied to their map token
  dnd_sheet       TEXT    NOT NULL   -- JSON for dnd5e characters; '' for campfire
);

-- Conditions are freeform tags/notes on a subject: either a character or a
-- custom initiative entry (monster, hazard…). dm_only ones are the GM's
-- private bookkeeping and never reach players or the projector.
CREATE TABLE IF NOT EXISTS condition_row (
  id         INTEGER PRIMARY KEY,
  char_id    INTEGER REFERENCES character(id) ON DELETE CASCADE,
  entry_id   TEXT,                -- initiative entry id ('custom:N')
  kind       TEXT    NOT NULL,
  visibility TEXT    NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','dm_only')),
  CHECK ((char_id IS NULL) != (entry_id IS NULL))
);

CREATE TABLE IF NOT EXISTS clock (
  id         INTEGER PRIMARY KEY,
  label      TEXT    NOT NULL,
  segments   INTEGER NOT NULL,
  filled     INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('progress','danger')),
  visibility TEXT    NOT NULL CHECK (visibility IN ('visible','dm_only')),
  token_id   INTEGER          -- nullable optional attachment (inert until Phase 3)
);

CREATE TABLE IF NOT EXISTS game (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  reward_every_n_encounters INTEGER NOT NULL,
  active_map_id             INTEGER          -- nullable; references map_calibration
);

-- Phase 3: battle map. One row per calibrated map image.
CREATE TABLE IF NOT EXISTS map_calibration (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  image_path   TEXT    NOT NULL,
  image_w      INTEGER NOT NULL,
  image_h      INTEGER NOT NULL,
  cell_size    REAL    NOT NULL,
  offset_x     REAL    NOT NULL,
  offset_y     REAL    NOT NULL,
  grid_visible INTEGER NOT NULL DEFAULT 1,  -- overlay the calibrated grid (off for pre-gridded art)
  -- Fog of war + orientation (see handoff §7). base_rotation is the map's
  -- primary orientation in degrees (0/90/180/270): it seeds the camera when the
  -- map opens. fog is a per-cell visibility bitmask, one char per grid cell in
  -- row-major order ('1' visible, '0' hidden), length cols*rows; '' means no fog
  -- data yet. fog_darkness 0..1 dials the projector fog from light gray (0) to
  -- pitch black (1).
  base_rotation REAL    NOT NULL DEFAULT 0,
  fog_enabled   INTEGER NOT NULL DEFAULT 0,
  fog           TEXT    NOT NULL DEFAULT '',
  fog_darkness  REAL    NOT NULL DEFAULT 0.85
);

-- Phase 3: tokens live in GRID coordinates (col,row) — never pixels/screen.
CREATE TABLE IF NOT EXISTS token (
  id          INTEGER PRIMARY KEY,
  map_id      INTEGER REFERENCES map_calibration(id) ON DELETE CASCADE,  -- tokens belong to ONE map; never shared
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('pc','monster','glow','terrain')),
  char_id     INTEGER REFERENCES character(id) ON DELETE CASCADE,  -- only for kind='pc'
  col         INTEGER NOT NULL,    -- top-left cell of the footprint
  row         INTEGER NOT NULL,
  w           INTEGER NOT NULL DEFAULT 1,   -- footprint in cells (3x5 etc.)
  h           INTEGER NOT NULL DEFAULT 1,
  shape       TEXT    NOT NULL DEFAULT 'circle' CHECK (shape IN ('circle','square')),
  color       TEXT    NOT NULL,    -- '#rrggbb' disc color (mirrors glow_color for glows)
  art         TEXT,                -- uploaded image path; null = plain colored shape
  glow_color  TEXT,
  glow_radius REAL,
  glow_pulse  REAL
);

-- Encounter-scoped runtime state (drain, granted blue, initiative). Canonical
-- copy lives in memory; persisted here so a campsite power blip mid-encounter
-- doesn't wipe the fight.
CREATE TABLE IF NOT EXISTS runtime (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

-- Player devices (phones/tablets). Each browser mints a UUID in localStorage;
-- the player names it so the GM sees "Sara's phone" instead of a raw fingerprint.
CREATE TABLE IF NOT EXISTS device (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT ''
);

-- Reusable "reveal cards" the GM prepares ahead of time: monsters/NPCs,
-- locations, and story beats. One mechanism, three kinds. images is a JSON
-- array of uploaded image paths (a slideshow on the reveal screen; for NPCs [0]
-- doubles as the map token). sections is a JSON array of
--   { title, entries: [{ label, text, visible, done }] }
-- — a video-game-style panel the GM reveals on the projector + players,
-- toggling individual entries on/off live. token_w/h/shape are the default map
-- footprint (NPCs only). visited marks a location as visited; entry.done marks
-- a story scene complete.
CREATE TABLE IF NOT EXISTS card (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL DEFAULT 'npc' CHECK (kind IN ('npc','location','story')),
  name        TEXT    NOT NULL,
  subtitle    TEXT    NOT NULL DEFAULT '',
  notes       TEXT    NOT NULL DEFAULT '',
  images      TEXT    NOT NULL DEFAULT '[]',
  sections    TEXT    NOT NULL DEFAULT '[]',
  token_w     INTEGER NOT NULL DEFAULT 1,
  token_h     INTEGER NOT NULL DEFAULT 1,
  token_shape TEXT    NOT NULL DEFAULT 'circle',
  bg_image    TEXT    NOT NULL DEFAULT '',
  bg_effect   TEXT    NOT NULL DEFAULT 'embers',
  visited     INTEGER NOT NULL DEFAULT 0,
  -- whether the card's OWN images are included in the reveal slideshow
  images_slides INTEGER NOT NULL DEFAULT 1,
  -- whether the reveal draws the connector line from caption text to the image
  show_link   INTEGER NOT NULL DEFAULT 1
);
`);

// One-time import of the old npc table into the unified card table (kind='npc'),
// preserving ids so the revealed pointer still resolves. Dropped afterwards so
// this runs exactly once. ?? fallbacks cover npc tables from before some columns
// existed, so the obsolete npc ALTER migrations are no longer needed.
if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='npc'`).get()) {
  const rows = db.prepare(`SELECT * FROM npc`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO card
    (id, kind, name, subtitle, notes, images, sections, token_w, token_h, token_shape, bg_image, bg_effect, visited)
    VALUES (@id,'npc',@name,@subtitle,@notes,@images,@sections,@token_w,@token_h,@token_shape,@bg_image,@bg_effect,0)`);
  const tx = db.transaction(() => {
    for (const r of rows) ins.run({
      id: r.id, name: r.name, subtitle: r.subtitle ?? '', notes: r.notes ?? '',
      images: r.images ?? '[]', sections: r.sections ?? '[]',
      token_w: r.token_w ?? 1, token_h: r.token_h ?? 1, token_shape: r.token_shape ?? 'circle',
      bg_image: r.bg_image ?? '', bg_effect: r.bg_effect ?? 'embers',
    });
  });
  tx();
  db.exec(`DROP TABLE npc`);
}

// Migrations for databases created before these columns existed.
// Conditions: the original table had char_id NOT NULL and no entry_id /
// visibility — rebuild it (SQLite can't relax NOT NULL in place).
if (!db.prepare(`PRAGMA table_info(condition_row)`).all().some((c) => c.name === 'entry_id')) {
  db.exec(`
    CREATE TABLE condition_row_new (
      id         INTEGER PRIMARY KEY,
      char_id    INTEGER REFERENCES character(id) ON DELETE CASCADE,
      entry_id   TEXT,
      kind       TEXT    NOT NULL,
      visibility TEXT    NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','dm_only')),
      CHECK ((char_id IS NULL) != (entry_id IS NULL))
    );
    INSERT INTO condition_row_new (id, char_id, entry_id, kind, visibility)
      SELECT id, char_id, NULL, kind, 'visible' FROM condition_row;
    DROP TABLE condition_row;
    ALTER TABLE condition_row_new RENAME TO condition_row;
  `);
}
const mapCols = db.prepare(`PRAGMA table_info(map_calibration)`).all();
if (!mapCols.some((c) => c.name === 'grid_visible')) {
  db.exec(`ALTER TABLE map_calibration ADD COLUMN grid_visible INTEGER NOT NULL DEFAULT 1`);
}
if (!mapCols.some((c) => c.name === 'name')) {
  db.exec(`ALTER TABLE map_calibration ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  db.exec(`UPDATE map_calibration SET name = 'Map ' || id WHERE name = ''`);
}
if (!mapCols.some((c) => c.name === 'fog')) {
  db.exec(`ALTER TABLE map_calibration ADD COLUMN base_rotation REAL NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE map_calibration ADD COLUMN fog_enabled INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE map_calibration ADD COLUMN fog TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE map_calibration ADD COLUMN fog_darkness REAL NOT NULL DEFAULT 0.85`);
}
if (!db.prepare(`PRAGMA table_info(token)`).all().some((c) => c.name === 'w')) {
  db.exec(`ALTER TABLE token ADD COLUMN w INTEGER NOT NULL DEFAULT 1`);
  db.exec(`ALTER TABLE token ADD COLUMN h INTEGER NOT NULL DEFAULT 1`);
  db.exec(`ALTER TABLE token ADD COLUMN shape TEXT NOT NULL DEFAULT 'circle'`);
  db.exec(`UPDATE token SET shape = 'square' WHERE kind = 'terrain'`);
}
if (!db.prepare(`PRAGMA table_info(character)`).all().some((c) => c.name === 'token_art')) {
  db.exec(`ALTER TABLE character ADD COLUMN token_art TEXT NOT NULL DEFAULT ''`);
}
if (!db.prepare(`PRAGMA table_info(token)`).all().some((c) => c.name === 'art')) {
  db.exec(`ALTER TABLE token ADD COLUMN art TEXT`);
}
// Scope tokens to a map. Older DBs had one global token pool shared across every
// map; backfill those onto the currently-active map so they don't vanish.
if (!db.prepare(`PRAGMA table_info(token)`).all().some((c) => c.name === 'map_id')) {
  db.exec(`ALTER TABLE token ADD COLUMN map_id INTEGER REFERENCES map_calibration(id) ON DELETE CASCADE`);
  const activeId = db.prepare(`SELECT active_map_id FROM game WHERE id = 1`).get()?.active_map_id ?? null;
  if (activeId !== null) db.prepare(`UPDATE token SET map_id = ? WHERE map_id IS NULL`).run(activeId);
  // No active map to claim them and no way to know which map they were for — drop orphans.
  db.exec(`DELETE FROM token WHERE map_id IS NULL`);
}
if (!db.prepare(`PRAGMA table_info(token)`).all().some((c) => c.name === 'color')) {
  db.exec(`ALTER TABLE token ADD COLUMN color TEXT NOT NULL DEFAULT ''`);
  db.exec(`UPDATE token SET color = CASE kind
    WHEN 'pc' THEN '#3e8ed0' WHEN 'monster' THEN '#c43c34'
    WHEN 'terrain' THEN '#8a8a8a' ELSE COALESCE(glow_color, '#ff8c2e') END
    WHERE color = ''`);
}
if (!db.prepare(`PRAGMA table_info(character)`).all().some((c) => c.name === 'device_id')) {
  db.exec(`ALTER TABLE character ADD COLUMN device_id TEXT`);
}
// Which prepared card is currently revealed on the projector + players
// (nullable). Migrates the old revealed_npc_id pointer if present.
{
  const gameCols = () => db.prepare(`PRAGMA table_info(game)`).all().map((c) => c.name);
  if (!gameCols().includes('revealed_card_id')) {
    db.exec(`ALTER TABLE game ADD COLUMN revealed_card_id INTEGER`);
    if (gameCols().includes('revealed_npc_id')) {
      db.exec(`UPDATE game SET revealed_card_id = revealed_npc_id WHERE id = 1`);
    }
  }
}
// Card-level "include my own images in the slideshow" toggle (added later).
if (db.prepare(`PRAGMA table_info(card)`).all().length > 0
    && !db.prepare(`PRAGMA table_info(card)`).all().some((c) => c.name === 'images_slides')) {
  db.exec(`ALTER TABLE card ADD COLUMN images_slides INTEGER NOT NULL DEFAULT 1`);
}
// Card-level "draw the connector line on the reveal" toggle (added later).
if (db.prepare(`PRAGMA table_info(card)`).all().length > 0
    && !db.prepare(`PRAGMA table_info(card)`).all().some((c) => c.name === 'show_link')) {
  db.exec(`ALTER TABLE card ADD COLUMN show_link INTEGER NOT NULL DEFAULT 1`);
}

db.prepare(`INSERT OR IGNORE INTO game (id, reward_every_n_encounters, active_map_id) VALUES (1, ?, NULL)`)
  .run(config.REWARD_EVERY_N_ENCOUNTERS_DEFAULT);
db.prepare(`INSERT OR IGNORE INTO runtime (id, json) VALUES (1, ?)`)
  .run(JSON.stringify({
    perChar: {},
    initiative: { entries: [], turn_id: null },
    camera: null,
    camera_bookmarks: [],
  }));

const stmts = {
  insertCharacter: db.prepare(`
    INSERT INTO character (system, name, concept, brawn, constitution, magic, wits,
      flavor, hidden_desire, gear, notes, encounters_done, pending_points, token_art, dnd_sheet, device_id)
    VALUES (@system, @name, @concept, @brawn, @constitution, @magic, @wits,
      @flavor, @hidden_desire, @gear, @notes, @encounters_done, @pending_points, @token_art, @dnd_sheet, @device_id)`),
  updateCharacter: db.prepare(`
    UPDATE character SET name=@name, concept=@concept, brawn=@brawn, constitution=@constitution,
      magic=@magic, wits=@wits, flavor=@flavor, hidden_desire=@hidden_desire, gear=@gear,
      notes=@notes, encounters_done=@encounters_done, pending_points=@pending_points,
      token_art=@token_art, dnd_sheet=@dnd_sheet, device_id=@device_id WHERE id=@id`),
  setCharacterDevice: db.prepare(`UPDATE character SET device_id=? WHERE id=?`),
  deleteCharacter: db.prepare(`DELETE FROM character WHERE id=?`),
  allCharacters: db.prepare(`SELECT * FROM character ORDER BY id`),

  insertCondition: db.prepare(`INSERT INTO condition_row (char_id, entry_id, kind, visibility) VALUES (?, ?, ?, ?)`),
  updateCondition: db.prepare(`UPDATE condition_row SET kind=?, visibility=? WHERE id=?`),
  deleteCondition: db.prepare(`DELETE FROM condition_row WHERE id=?`),
  deleteConditionsByEntry: db.prepare(`DELETE FROM condition_row WHERE entry_id=?`),
  allConditions: db.prepare(`SELECT * FROM condition_row ORDER BY id`),

  insertClock: db.prepare(`
    INSERT INTO clock (label, segments, filled, kind, visibility, token_id)
    VALUES (@label, @segments, @filled, @kind, @visibility, @token_id)`),
  updateClock: db.prepare(`
    UPDATE clock SET label=@label, segments=@segments, filled=@filled, kind=@kind,
      visibility=@visibility, token_id=@token_id WHERE id=@id`),
  deleteClock: db.prepare(`DELETE FROM clock WHERE id=?`),
  allClocks: db.prepare(`SELECT * FROM clock ORDER BY id`),

  getGame: db.prepare(`SELECT * FROM game WHERE id=1`),
  updateGame: db.prepare(`UPDATE game SET reward_every_n_encounters=@reward_every_n_encounters, active_map_id=@active_map_id, revealed_card_id=@revealed_card_id WHERE id=1`),

  insertMap: db.prepare(`
    INSERT INTO map_calibration (name, image_path, image_w, image_h, cell_size, offset_x, offset_y,
      grid_visible, base_rotation, fog_enabled, fog, fog_darkness)
    VALUES (@name, @image_path, @image_w, @image_h, @cell_size, @offset_x, @offset_y,
      @grid_visible, @base_rotation, @fog_enabled, @fog, @fog_darkness)`),
  setMapGridVisible: db.prepare(`UPDATE map_calibration SET grid_visible=? WHERE id=?`),
  setMapBaseRotation: db.prepare(`UPDATE map_calibration SET base_rotation=? WHERE id=?`),
  setMapFogEnabled: db.prepare(`UPDATE map_calibration SET fog_enabled=?, fog=? WHERE id=?`),
  setMapFog: db.prepare(`UPDATE map_calibration SET fog=? WHERE id=?`),
  setMapFogDarkness: db.prepare(`UPDATE map_calibration SET fog_darkness=? WHERE id=?`),
  renameMap: db.prepare(`UPDATE map_calibration SET name=? WHERE id=?`),
  updateMapCalibration: db.prepare(`UPDATE map_calibration SET cell_size=?, offset_x=?, offset_y=? WHERE id=?`),
  deleteMap: db.prepare(`DELETE FROM map_calibration WHERE id=?`),
  allMaps: db.prepare(`SELECT * FROM map_calibration ORDER BY id`),

  insertToken: db.prepare(`
    INSERT INTO token (map_id, label, kind, char_id, col, row, w, h, shape, color, art, glow_color, glow_radius, glow_pulse)
    VALUES (@map_id, @label, @kind, @char_id, @col, @row, @w, @h, @shape, @color, @art, @glow_color, @glow_radius, @glow_pulse)`),
  updateToken: db.prepare(`
    UPDATE token SET label=@label, kind=@kind, char_id=@char_id, col=@col, row=@row,
      w=@w, h=@h, shape=@shape,
      color=@color, art=@art, glow_color=@glow_color, glow_radius=@glow_radius, glow_pulse=@glow_pulse WHERE id=@id`),
  deleteToken: db.prepare(`DELETE FROM token WHERE id=?`),
  allTokens: db.prepare(`SELECT * FROM token ORDER BY id`),

  insertCard: db.prepare(`INSERT INTO card (kind, name, subtitle, notes, images, sections, token_w, token_h, token_shape, bg_image, bg_effect, visited, images_slides, show_link)
    VALUES (@kind, @name, @subtitle, @notes, @images, @sections, @token_w, @token_h, @token_shape, @bg_image, @bg_effect, @visited, @images_slides, @show_link)`),
  updateCard: db.prepare(`UPDATE card SET name=@name, subtitle=@subtitle, notes=@notes,
    images=@images, sections=@sections, token_w=@token_w, token_h=@token_h, token_shape=@token_shape,
    bg_image=@bg_image, bg_effect=@bg_effect, visited=@visited, images_slides=@images_slides, show_link=@show_link WHERE id=@id`),
  deleteCard: db.prepare(`DELETE FROM card WHERE id=?`),
  allCards: db.prepare(`SELECT * FROM card ORDER BY id`),

  getRuntime: db.prepare(`SELECT json FROM runtime WHERE id=1`),
  saveRuntime: db.prepare(`UPDATE runtime SET json=? WHERE id=1`),

  // Devices: ensureDevice records a freshly-seen id (keeps any existing name);
  // setDeviceName upserts a chosen name.
  ensureDevice: db.prepare(`INSERT INTO device (id, name) VALUES (?, '') ON CONFLICT(id) DO NOTHING`),
  setDeviceName: db.prepare(`INSERT INTO device (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`),
  deleteDevice: db.prepare(`DELETE FROM device WHERE id=?`),
  allDevices: db.prepare(`SELECT * FROM device`),
};

module.exports = { db, stmts };
