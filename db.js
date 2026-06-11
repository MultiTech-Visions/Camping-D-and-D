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
  dnd_sheet       TEXT    NOT NULL   -- JSON for dnd5e characters; '' for campfire
);

CREATE TABLE IF NOT EXISTS condition_row (
  id      INTEGER PRIMARY KEY,
  char_id INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL
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
  id         INTEGER PRIMARY KEY,
  image_path TEXT    NOT NULL,
  image_w    INTEGER NOT NULL,
  image_h    INTEGER NOT NULL,
  cell_size  REAL    NOT NULL,
  offset_x   REAL    NOT NULL,
  offset_y   REAL    NOT NULL
);

-- Phase 3: tokens live in GRID coordinates (col,row) — never pixels/screen.
CREATE TABLE IF NOT EXISTS token (
  id          INTEGER PRIMARY KEY,
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('pc','monster','glow','terrain')),
  char_id     INTEGER REFERENCES character(id) ON DELETE CASCADE,  -- only for kind='pc'
  col         INTEGER NOT NULL,
  row         INTEGER NOT NULL,
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
      flavor, hidden_desire, gear, notes, encounters_done, pending_points, dnd_sheet)
    VALUES (@system, @name, @concept, @brawn, @constitution, @magic, @wits,
      @flavor, @hidden_desire, @gear, @notes, @encounters_done, @pending_points, @dnd_sheet)`),
  updateCharacter: db.prepare(`
    UPDATE character SET name=@name, concept=@concept, brawn=@brawn, constitution=@constitution,
      magic=@magic, wits=@wits, flavor=@flavor, hidden_desire=@hidden_desire, gear=@gear,
      notes=@notes, encounters_done=@encounters_done, pending_points=@pending_points,
      dnd_sheet=@dnd_sheet WHERE id=@id`),
  deleteCharacter: db.prepare(`DELETE FROM character WHERE id=?`),
  allCharacters: db.prepare(`SELECT * FROM character ORDER BY id`),

  insertCondition: db.prepare(`INSERT INTO condition_row (char_id, kind) VALUES (?, ?)`),
  deleteCondition: db.prepare(`DELETE FROM condition_row WHERE id=?`),
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
    INSERT INTO map_calibration (image_path, image_w, image_h, cell_size, offset_x, offset_y)
    VALUES (@image_path, @image_w, @image_h, @cell_size, @offset_x, @offset_y)`),
  deleteMap: db.prepare(`DELETE FROM map_calibration WHERE id=?`),
  allMaps: db.prepare(`SELECT * FROM map_calibration ORDER BY id`),

  insertToken: db.prepare(`
    INSERT INTO token (label, kind, char_id, col, row, glow_color, glow_radius, glow_pulse)
    VALUES (@label, @kind, @char_id, @col, @row, @glow_color, @glow_radius, @glow_pulse)`),
  updateToken: db.prepare(`
    UPDATE token SET label=@label, kind=@kind, char_id=@char_id, col=@col, row=@row,
      glow_color=@glow_color, glow_radius=@glow_radius, glow_pulse=@glow_pulse WHERE id=@id`),
  deleteToken: db.prepare(`DELETE FROM token WHERE id=?`),
  allTokens: db.prepare(`SELECT * FROM token ORDER BY id`),

  getRuntime: db.prepare(`SELECT json FROM runtime WHERE id=1`),
  saveRuntime: db.prepare(`UPDATE runtime SET json=? WHERE id=1`),
};

module.exports = { db, stmts };
