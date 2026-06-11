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
// initiative: { order: [char_id], turn_char_id: int|null }
// game:       { reward_every_n_encounters, active_map_id }

const state = {
  characters: new Map(),
  clocks: new Map(),
  initiative: { order: [], turn_char_id: null },
  game: null,
};

function zeroDrain() {
  return { brawn: 0, constitution: 0, magic: 0, wits: 0 };
}

function load() {
  const game = stmts.getGame.get();
  R.assert(game, 'corrupt DB: game singleton row missing');
  state.game = { reward_every_n_encounters: game.reward_every_n_encounters, active_map_id: game.active_map_id };

  const runtime = JSON.parse(stmts.getRuntime.get().json);
  R.assert(runtime && runtime.perChar && runtime.initiative, 'corrupt DB: runtime row malformed');

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

  // Drop initiative entries for characters that no longer exist.
  state.initiative.order = runtime.initiative.order.filter((id) => state.characters.has(id));
  state.initiative.turn_char_id = state.characters.has(runtime.initiative.turn_char_id)
    ? runtime.initiative.turn_char_id : null;
}

function persistRuntime() {
  const perChar = {};
  for (const [id, c] of state.characters) {
    perChar[id] = { drain: c.drain, granted_blue: c.granted_blue };
  }
  stmts.saveRuntime.run(JSON.stringify({ perChar, initiative: state.initiative }));
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
    stmts.deleteCharacter.run(c.id); // conditions cascade
    state.characters.delete(c.id);
    state.initiative.order = state.initiative.order.filter((id) => id !== c.id);
    if (state.initiative.turn_char_id === c.id) state.initiative.turn_char_id = null;
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

  'initiative.add'(p) {
    const c = getChar(p.char_id);
    R.assert(!state.initiative.order.includes(c.id), `${c.name} is already in initiative`);
    state.initiative.order.push(c.id);
    persistRuntime();
  },

  'initiative.remove'(p) {
    const c = getChar(p.char_id);
    R.assert(state.initiative.order.includes(c.id), `${c.name} is not in initiative`);
    state.initiative.order = state.initiative.order.filter((id) => id !== c.id);
    if (state.initiative.turn_char_id === c.id) state.initiative.turn_char_id = null;
    persistRuntime();
  },

  'initiative.reorder'(p) {
    R.assert(Array.isArray(p.ordered_char_ids), 'ordered_char_ids must be an array');
    const current = [...state.initiative.order].sort((a, b) => a - b);
    const proposed = [...p.ordered_char_ids].sort((a, b) => a - b);
    R.assert(current.length === proposed.length && current.every((v, i) => v === proposed[i]),
      'reorder must contain exactly the characters currently in initiative');
    state.initiative.order = [...p.ordered_char_ids];
    persistRuntime();
  },

  'initiative.set_turn'(p) {
    if (p.char_id === null) {
      state.initiative.turn_char_id = null;
    } else {
      const c = getChar(p.char_id);
      R.assert(state.initiative.order.includes(c.id), `${c.name} is not in initiative`);
      state.initiative.turn_char_id = c.id;
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
  const base = {
    game: { reward_every_n_encounters: state.game.reward_every_n_encounters },
    initiative: { order: [...state.initiative.order], turn_char_id: state.initiative.turn_char_id },
    config: {
      STARTING_POINTS: config.STARTING_POINTS,
      CREATION_MAX: config.CREATION_MAX,
      CEILING: config.CEILING,
      ATTRIBUTES: config.ATTRIBUTES,
      CONDITIONS: config.CONDITIONS,
      CLOCK_SEGMENT_CHOICES: config.CLOCK_SEGMENT_CHOICES,
      DND: config.DND,
    },
  };
  if (role === 'dm') {
    return {
      ...base,
      characters: chars.map((c) => publicCharacter(c, { includeHiddenDesire: true })),
      clocks: clocks.map((c) => ({ ...c })),
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
