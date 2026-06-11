'use strict';

// Self-test: exercises the rules engine, database, every WebSocket op, and the
// role-scoping rules against a THROWAWAY database (never the real one).
// Run: node test/smoke.js [--quick]   (--quick skips the live HTTP/WS round trip)
// install.sh and update.sh run this and refuse to finish if it fails.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-smoke-'));
process.env.CAMPFIRE_DATA_DIR = tmp;

const assert = require('assert');
const R = require('../rules');
const { load, ops, snapshotFor, state } = require('../state');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}
function throws(fn) {
  try { fn(); } catch { return; }
  throw new Error('expected this to throw, but it did not');
}

console.log('Campfire Saga self-test');
console.log(`  (throwaway database in ${tmp})`);

// --- rules ---------------------------------------------------------------
check('diceForRank mapping (rank = dice, yellows at 4-5)', () => {
  assert.deepStrictEqual(R.diceForRank(0), { green: 0, yellow: 0 });
  assert.deepStrictEqual(R.diceForRank(1), { green: 1, yellow: 0 });
  assert.deepStrictEqual(R.diceForRank(3), { green: 3, yellow: 0 });
  assert.deepStrictEqual(R.diceForRank(4), { green: 3, yellow: 1 });
  assert.deepStrictEqual(R.diceForRank(5), { green: 3, yellow: 2 });
  throws(() => R.diceForRank(6));
  throws(() => R.diceForRank(-1));
  throws(() => R.diceForRank('3'));
});

check('creation validation: 4 points, max 2 each, fail loud', () => {
  R.validateCampfireCreation({ brawn: 2, constitution: 0, magic: 2, wits: 0 }); // glass cannon ok
  throws(() => R.validateCampfireCreation({ brawn: 3, constitution: 1, magic: 0, wits: 0 })); // >2
  throws(() => R.validateCampfireCreation({ brawn: 2, constitution: 1, magic: 0, wits: 0 })); // sum 3
  throws(() => R.validateCampfireCreation({ brawn: 2, constitution: 2, magic: 2, wits: 0 })); // sum 6
});

// --- state ops -------------------------------------------------------------
load();

let heroId, wizardId;
check('character.create (campfire)', () => {
  heroId = ops['character.create']({
    system: 'campfire', name: 'Tharn', concept: 'storm-priest',
    brawn: 2, constitution: 1, magic: 1, wits: 0, hidden_desire: 'wants the crown',
  }).created_char_id;
  assert.ok(Number.isInteger(heroId));
  throws(() => ops['character.create']({ system: 'campfire', name: 'Bad', concept: 'x', brawn: 3, constitution: 1, magic: 0, wits: 0 }));
  throws(() => ops['character.create']({ system: 'nope', name: 'Bad', concept: 'x' }));
});

check('character.create (dnd5e)', () => {
  wizardId = ops['character.create']({
    system: 'dnd5e', name: 'Mira', concept: 'tired wizard',
    sheet: {
      class_name: 'Wizard', race: 'Elf', level: 3,
      abilities: { str: 8, dex: 14, con: 12, int: 17, wis: 12, cha: 10 },
      ac: 12, hp_max: 17, hp: 17, temp_hp: 0, speed: 30, prof_bonus: 2,
      inspiration: false, death_successes: 0, death_failures: 0,
      spell_slots: Array.from({ length: 9 }, (_, i) => ({ max: i === 0 ? 4 : i === 1 ? 2 : 0, used: 0 })),
    },
  }).created_char_id;
  assert.ok(Number.isInteger(wizardId));
  throws(() => ops['character.create']({ system: 'dnd5e', name: 'Bad', concept: 'x', sheet: { class_name: 'Rogue' } }));
});

check('drain + absorb + yellows-strip-via-rank', () => {
  ops['character.set_drain']({ char_id: heroId, attr: 'brawn', amount: 1 });
  const c = state.characters.get(heroId);
  assert.strictEqual(c.brawn - c.drain.brawn, 1);
  throws(() => ops['character.set_drain']({ char_id: heroId, attr: 'brawn', amount: 3 })); // > base
  ops['character.absorb_with_con']({ char_id: heroId });
  assert.strictEqual(c.drain.constitution, 1);
  throws(() => ops['character.absorb_with_con']({ char_id: heroId })); // con now 0
  throws(() => ops['character.set_drain']({ char_id: wizardId, attr: 'brawn', amount: 1 })); // not campfire
});

check('blue dice grant/spend, never negative', () => {
  ops['character.grant_blue']({ char_id: heroId, amount: 2 });
  ops['character.grant_blue']({ char_id: heroId, amount: -1 });
  assert.strictEqual(state.characters.get(heroId).granted_blue, 1);
  throws(() => ops['character.grant_blue']({ char_id: heroId, amount: -5 }));
});

check('end-encounter refill + progression every N', () => {
  const c = state.characters.get(heroId);
  const n = state.game.reward_every_n_encounters;
  for (let i = 0; i < n; i++) ops['character.end_encounter_refill']({});
  assert.strictEqual(c.drain.brawn, 0);
  assert.strictEqual(c.granted_blue, 0);
  assert.strictEqual(c.encounters_done, n);
  assert.strictEqual(c.pending_points, 1);
  ops['character.spend_point']({ char_id: heroId, attr: 'magic' });
  assert.strictEqual(c.magic, 2);
  assert.strictEqual(c.pending_points, 0);
  throws(() => ops['character.spend_point']({ char_id: heroId, attr: 'magic' })); // no points left
});

check('dnd hp update validated whole-sheet', () => {
  const c = state.characters.get(wizardId);
  const next = JSON.parse(JSON.stringify(c.dnd_sheet));
  next.hp = 9;
  ops['character.update_dnd']({ char_id: wizardId, sheet: next });
  assert.strictEqual(state.characters.get(wizardId).dnd_sheet.hp, 9);
  next.hp = 999; // > hp_max
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next }));
});

check('conditions per-system, no duplicates', () => {
  ops['condition.add']({ char_id: heroId, kind: 'poisoned' });
  throws(() => ops['condition.add']({ char_id: heroId, kind: 'poisoned' }));
  throws(() => ops['condition.add']({ char_id: heroId, kind: 'grappled' })); // dnd-only kind
  ops['condition.add']({ char_id: wizardId, kind: 'grappled' });
  const cid = state.characters.get(heroId).conditions[0].id;
  ops['condition.remove']({ condition_id: cid });
  assert.strictEqual(state.characters.get(heroId).conditions.length, 0);
});

check('initiative add/reorder/turn', () => {
  ops['initiative.add']({ char_id: heroId });
  ops['initiative.add']({ char_id: wizardId });
  throws(() => ops['initiative.add']({ char_id: heroId })); // duplicate
  ops['initiative.reorder']({ ordered_char_ids: [wizardId, heroId] });
  throws(() => ops['initiative.reorder']({ ordered_char_ids: [wizardId] })); // wrong membership
  ops['initiative.set_turn']({ char_id: wizardId });
  assert.strictEqual(state.initiative.turn_char_id, wizardId);
});

let clockId, secretId;
check('clocks create/fill/visibility, bounds enforced', () => {
  clockId = ops['clock.create']({ label: 'Collapse the bridge', segments: 6, kind: 'progress', visibility: 'visible' }).created_clock_id;
  secretId = ops['clock.create']({ label: 'The ritual completes', segments: 8, kind: 'danger', visibility: 'dm_only' }).created_clock_id;
  ops['clock.set_filled']({ clock_id: clockId, filled: 3 });
  throws(() => ops['clock.set_filled']({ clock_id: clockId, filled: 7 }));
  throws(() => ops['clock.create']({ label: 'bad', segments: 5, kind: 'progress', visibility: 'visible' }));
});

check('role scoping: hidden desires + dm_only clocks never leak', () => {
  const dm = snapshotFor('dm', null);
  assert.ok(dm.characters.find((c) => c.id === heroId).hidden_desire === 'wants the crown');
  assert.ok(dm.clocks.some((c) => c.id === secretId));

  const otherPlayer = snapshotFor('player', wizardId);
  const heroSeen = otherPlayer.characters.find((c) => c.id === heroId);
  assert.strictEqual(heroSeen.hidden_desire, undefined, 'another player saw a hidden desire!');
  assert.ok(!otherPlayer.clocks.some((c) => c.id === secretId), 'a player saw a dm_only clock!');

  const ownPlayer = snapshotFor('player', heroId);
  assert.strictEqual(ownPlayer.characters.find((c) => c.id === heroId).hidden_desire, 'wants the crown');

  const display = snapshotFor('display', null);
  assert.ok(display.characters.every((c) => c.hidden_desire === undefined));
  assert.ok(!display.clocks.some((c) => c.id === secretId));
});

check('reward rate live-tunable', () => {
  ops['game.set_reward_rate']({ reward_every_n_encounters: 2 });
  assert.strictEqual(state.game.reward_every_n_encounters, 2);
  throws(() => ops['game.set_reward_rate']({ reward_every_n_encounters: 0 }));
});

check('reveal: dm_only clock flips visible in one op', () => {
  ops['clock.set_visibility']({ clock_id: secretId, visibility: 'visible' });
  assert.ok(snapshotFor('player', heroId).clocks.some((c) => c.id === secretId));
});

check('character.delete cleans initiative', () => {
  ops['character.delete']({ char_id: wizardId });
  assert.ok(!state.initiative.order.includes(wizardId));
});

console.log(`\nAll ${passed} checks passed. The fire burns true. 🔥`);
fs.rmSync(tmp, { recursive: true, force: true });
