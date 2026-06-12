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
`);

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
if (!db.prepare(`PRAGMA table_info(token)`).all().some((c) => c.name === 'color')) {
  db.exec(`ALTER TABLE token ADD COLUMN color TEXT NOT NULL DEFAULT ''`);
  db.exec(`UPDATE token SET color = CASE kind
    WHEN 'pc' THEN '#3e8ed0' WHEN 'monster' THEN '#c43c34'
    WHEN 'terrain' THEN '#8a8a8a' ELSE COALESCE(glow_color, '#ff8c2e') END
    WHERE color = ''`);
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
      flavor, hidden_desire, gear, notes, encounters_done, pending_points, token_art, dnd_sheet)
    VALUES (@system, @name, @concept, @brawn, @constitution, @magic, @wits,
      @flavor, @hidden_desire, @gear, @notes, @encounters_done, @pending_points, @token_art, @dnd_sheet)`),
  updateCharacter: db.prepare(`
    UPDATE character SET name=@name, concept=@concept, brawn=@brawn, constitution=@constitution,
      magic=@magic, wits=@wits, flavor=@flavor, hidden_desire=@hidden_desire, gear=@gear,
      notes=@notes, encounters_done=@encounters_done, pending_points=@pending_points,
      token_art=@token_art, dnd_sheet=@dnd_sheet WHERE id=@id`),
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
  updateGame: db.prepare(`UPDATE game SET reward_every_n_encounters=@reward_every_n_encounters, active_map_id=@active_map_id WHERE id=1`),

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
    INSERT INTO token (label, kind, char_id, col, row, w, h, shape, color, art, glow_color, glow_radius, glow_pulse)
    VALUES (@label, @kind, @char_id, @col, @row, @w, @h, @shape, @color, @art, @glow_color, @glow_radius, @glow_pulse)`),
  updateToken: db.prepare(`
    UPDATE token SET label=@label, kind=@kind, char_id=@char_id, col=@col, row=@row,
      w=@w, h=@h, shape=@shape,
      color=@color, art=@art, glow_color=@glow_color, glow_radius=@glow_radius, glow_pulse=@glow_pulse WHERE id=@id`),
  deleteToken: db.prepare(`DELETE FROM token WHERE id=?`),
  allTokens: db.prepare(`SELECT * FROM token ORDER BY id`),

  getRuntime: db.prepare(`SELECT json FROM runtime WHERE id=1`),
  saveRuntime: db.prepare(`UPDATE runtime SET json=? WHERE id=1`),
};

module.exports = { db, stmts };
