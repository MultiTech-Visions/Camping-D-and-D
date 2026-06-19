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

const config = require('../config');
function defaultSkills() {
  return Object.fromEntries(config.DND.SKILLS.map((s) => [s.key, { prof: 0, misc: 0 }]));
}

let heroId, wizardId;
// Both test heroes live on one phone: the player snapshot scopes characters by
// device_id, so a player view only resolves with the owning device passed in.
const DEV = 'dev-test-phone';
check('character.create (campfire)', () => {
  heroId = ops['character.create']({
    system: 'campfire', name: 'Tharn', concept: 'storm-priest',
    brawn: 2, constitution: 1, magic: 1, wits: 0, hidden_desire: 'wants the crown',
    device_id: DEV,
  }).created_char_id;
  assert.ok(Number.isInteger(heroId));
  throws(() => ops['character.create']({ system: 'campfire', name: 'Bad', concept: 'x', brawn: 3, constitution: 1, magic: 0, wits: 0 }));
  throws(() => ops['character.create']({ system: 'nope', name: 'Bad', concept: 'x' }));
});

check('character.create (dnd5e)', () => {
  wizardId = ops['character.create']({
    system: 'dnd5e', name: 'Mira', concept: 'tired wizard',
    device_id: DEV,
    sheet: {
      class_name: 'Wizard', race: 'Elf', level: 3,
      abilities: { str: 8, dex: 14, con: 12, int: 17, wis: 12, cha: 10 },
      ac: 12, hp_max: 17, hp: 17, temp_hp: 0, speed: 30, prof_bonus: 2,
      inspiration: false, death_successes: 0, death_failures: 0,
      spell_slots: Array.from({ length: 9 }, (_, i) => ({ max: i === 0 ? 4 : i === 1 ? 2 : 0, used: 0 })),
      skills: { ...defaultSkills(), arcana: { prof: 2, misc: 0 }, perception: { prof: 1, misc: 1 } },
      custom_skills: [{ name: "Alchemist's supplies", bonus: 5 }],
      spells: [
        { name: 'Fire Bolt', level: 0, prepared: true, concentration: false, note: '1d10 fire, 120ft' },
        { name: 'Haste', level: 3, prepared: true, concentration: true, note: '' },
      ],
    },
  }).created_char_id;
  assert.ok(Number.isInteger(wizardId));
  throws(() => ops['character.create']({ system: 'dnd5e', name: 'Bad', concept: 'x', sheet: { class_name: 'Rogue' } }));
});

check('dnd skills validated: prof 0..2, known keys only, custom list sane', () => {
  const c = state.characters.get(wizardId);
  assert.strictEqual(c.dnd_sheet.skills.arcana.prof, 2);
  const next = JSON.parse(JSON.stringify(c.dnd_sheet));
  next.skills.stealth.prof = 3;
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next }));
  next.skills.stealth.prof = 1;
  next.skills.lockpicking = { prof: 1, misc: 0 }; // unknown skill key
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next }));
  delete next.skills.lockpicking;
  next.custom_skills.push({ name: '  ', bonus: 2 }); // blank name
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next }));
  next.custom_skills[1] = { name: 'Disguise kit', bonus: 99 }; // bonus out of range
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next }));
  next.custom_skills[1] = { name: 'Disguise kit', bonus: 3 };
  ops['character.update_dnd']({ char_id: wizardId, sheet: next });
  assert.strictEqual(state.characters.get(wizardId).dnd_sheet.skills.stealth.prof, 1);
  assert.strictEqual(state.characters.get(wizardId).dnd_sheet.custom_skills.length, 2);
});

check('dnd spellbook validated: name+level required, bools, short notes', () => {
  const c = state.characters.get(wizardId);
  assert.strictEqual(c.dnd_sheet.spells.length, 2);
  const next = JSON.parse(JSON.stringify(c.dnd_sheet));
  next.spells.push({ name: 'Shield', level: 1, prepared: true, concentration: false, note: '+5 AC until next turn' });
  ops['character.update_dnd']({ char_id: wizardId, sheet: next });
  assert.strictEqual(state.characters.get(wizardId).dnd_sheet.spells.length, 3);
  next.spells.push({ name: '', level: 1, prepared: true, concentration: false, note: '' });
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next })); // blank name
  next.spells[3] = { name: 'Wish Plus', level: 10, prepared: true, concentration: false, note: '' };
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next })); // level > 9
  next.spells[3] = { name: 'Vague', level: 1, prepared: 'yes', concentration: false, note: '' };
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next })); // non-bool prepared
  next.spells[3] = { name: 'Rambling', level: 1, prepared: true, concentration: false, note: 'x'.repeat(201) };
  throws(() => ops['character.update_dnd']({ char_id: wizardId, sheet: next })); // novel-length note
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

check('blue dice: noted entries, add/edit/spend by id', () => {
  const c = state.characters.get(heroId);
  ops['character.add_blue']({ char_id: heroId, note: 'saved the village from the flood' });
  ops['character.add_blue']({ char_id: heroId, note: 'outwitted the river spirit' });
  assert.strictEqual(c.blue_dice.length, 2);
  assert.strictEqual(c.blue_dice[0].note, 'saved the village from the flood');
  throws(() => ops['character.add_blue']({ char_id: heroId, note: '   ' })); // note required
  throws(() => ops['character.add_blue']({ char_id: heroId })); // note required
  const firstId = c.blue_dice[0].id;
  ops['character.edit_blue_note']({ char_id: heroId, die_id: firstId, note: 'saved the WHOLE village' });
  assert.strictEqual(c.blue_dice[0].note, 'saved the WHOLE village');
  ops['character.spend_blue']({ char_id: heroId, die_id: firstId });
  assert.strictEqual(c.blue_dice.length, 1);
  assert.strictEqual(c.blue_dice[0].note, 'outwitted the river spirit');
  throws(() => ops['character.spend_blue']({ char_id: heroId, die_id: firstId })); // already gone
});

check('end-encounter refill clears drain but BANKS blue dice', () => {
  const c = state.characters.get(heroId);
  const n = state.game.reward_every_n_encounters;
  const bankedBefore = c.blue_dice.length;
  assert.ok(bankedBefore > 0, 'expected a banked die going into refill');
  for (let i = 0; i < n; i++) ops['character.end_encounter_refill']({});
  assert.strictEqual(c.drain.brawn, 0);
  assert.strictEqual(c.blue_dice.length, bankedBefore); // banked dice persist across encounters
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

check('conditions: freeform names, edit, visibility, both subject kinds', () => {
  const { snapshotFor } = require('../state');
  // freeform names on characters; duplicates (case-insensitive) rejected
  ops['condition.add']({ char_id: heroId, kind: 'poisoned' });
  ops['condition.add']({ char_id: heroId, kind: '+2 vs goblins until dawn' });
  throws(() => ops['condition.add']({ char_id: heroId, kind: 'Poisoned' }));
  throws(() => ops['condition.add']({ char_id: heroId, kind: '   ' }));
  assert.deepStrictEqual(state.used_conditions.slice(0, 2), ['+2 vs goblins until dawn', 'poisoned']);

  // GM-only note on a character: dm sees it, the player does not
  ops['condition.add']({ char_id: heroId, kind: 'secretly cursed', visibility: 'dm_only' });
  const dmHero = snapshotFor('dm', null).characters.find((c) => c.id === heroId);
  assert.ok(dmHero.conditions.some((x) => x.kind === 'secretly cursed'));
  const ownHero = snapshotFor('player', heroId, DEV).characters.find((c) => c.id === heroId);
  assert.ok(!ownHero.conditions.some((x) => x.kind === 'secretly cursed'), 'player saw a GM-only note!');

  // edit: rename + flip visibility
  const cursed = state.characters.get(heroId).conditions.find((x) => x.kind === 'secretly cursed');
  ops['condition.update']({ condition_id: cursed.id, kind: 'visibly cursed', visibility: 'visible' });
  assert.ok(snapshotFor('player', heroId, DEV).characters.find((c) => c.id === heroId)
    .conditions.some((x) => x.kind === 'visibly cursed'));

  // conditions on a custom initiative entry; removed with the entry
  const ogre = ops['initiative.add_custom']({ label: 'Test Ogre' }).created_entry_id;
  ops['condition.add']({ entry_id: ogre, kind: 'bloodied' });
  ops['condition.add']({ entry_id: ogre, kind: 'regenerates', visibility: 'dm_only' });
  throws(() => ops['condition.add']({ entry_id: 'custom:9999', kind: 'x' }));
  const dmOgre = snapshotFor('dm', null).initiative.entries.find((e) => e.id === ogre);
  assert.strictEqual(dmOgre.conditions.length, 2);
  const shownOgre = snapshotFor('display', null).initiative.entries.find((e) => e.id === ogre);
  assert.deepStrictEqual(shownOgre.conditions.map((x) => x.kind), ['bloodied'], 'projector saw a GM-only entry condition!');
  ops['initiative.remove']({ entry_id: ogre });
  assert.ok(!state.entryConditions.has(ogre), 'entry conditions survived entry removal');

  // cleanup char conditions for later checks
  for (const x of [...state.characters.get(heroId).conditions]) {
    ops['condition.remove']({ condition_id: x.id });
  }
  assert.strictEqual(state.characters.get(heroId).conditions.length, 0);
});

check('initiative: characters + custom entries, reorder, turn', () => {
  ops['initiative.add']({ char_id: heroId });
  ops['initiative.add']({ char_id: wizardId });
  throws(() => ops['initiative.add']({ char_id: heroId })); // duplicate
  const goblinId = ops['initiative.add_custom']({ label: 'Goblin Pack' }).created_entry_id;
  const lairId = ops['initiative.add_custom']({ label: 'Lair Action' }).created_entry_id;
  throws(() => ops['initiative.add_custom']({ label: '   ' })); // empty label
  assert.strictEqual(state.initiative.entries.length, 4);

  ops['initiative.reorder']({ ordered_entry_ids: [goblinId, `char:${wizardId}`, lairId, `char:${heroId}`] });
  assert.strictEqual(state.initiative.entries[0].label, 'Goblin Pack');
  throws(() => ops['initiative.reorder']({ ordered_entry_ids: [goblinId] })); // wrong membership

  ops['initiative.set_turn']({ entry_id: goblinId });
  assert.strictEqual(state.initiative.turn_id, goblinId);
  ops['initiative.set_turn']({ char_id: wizardId }); // char_id form still works
  assert.strictEqual(state.initiative.turn_id, `char:${wizardId}`);

  ops['initiative.set_turn']({ entry_id: lairId });
  ops['initiative.remove']({ entry_id: lairId }); // removing the turn-holder clears the turn
  assert.strictEqual(state.initiative.turn_id, null);
  assert.strictEqual(state.initiative.entries.length, 3);
  ops['initiative.set_turn']({ entry_id: goblinId });
});

let clockId, secretId;
check('clocks create/fill/visibility, bounds enforced', () => {
  clockId = ops['clock.create']({ label: 'Collapse the bridge', segments: 6, kind: 'progress', visibility: 'visible' }).created_clock_id;
  secretId = ops['clock.create']({ label: 'The ritual completes', segments: 8, kind: 'danger', visibility: 'dm_only' }).created_clock_id;
  ops['clock.set_filled']({ clock_id: clockId, filled: 3 });
  throws(() => ops['clock.set_filled']({ clock_id: clockId, filled: 7 }));
  throws(() => ops['clock.create']({ label: 'bad', segments: 5, kind: 'progress', visibility: 'visible' }));
});

check('clock notes: create with a note, set/clear, length-capped', () => {
  const id = ops['clock.create']({
    label: 'The duke remembers', segments: 4, kind: 'danger', visibility: 'visible',
    note: 'originated session 3 when they insulted him at the feast',
  }).created_clock_id;
  assert.strictEqual(state.clocks.get(id).note, 'originated session 3 when they insulted him at the feast');
  ops['clock.set_note']({ clock_id: id, note: 'updated: he hired assassins' });
  assert.strictEqual(state.clocks.get(id).note, 'updated: he hired assassins');
  ops['clock.set_note']({ clock_id: id }); // omitted note clears it
  assert.strictEqual(state.clocks.get(id).note, '');
  throws(() => ops['clock.set_note']({ clock_id: id, note: 'x'.repeat(2001) })); // capped
  ops['clock.delete']({ clock_id: id });
});

check('role scoping: hidden desires + dm_only clocks + clock notes never leak', () => {
  // give the visible clock a GM-only note to prove it never reaches players/display
  ops['clock.set_note']({ clock_id: clockId, note: 'GM eyes only: this is the warlord arriving' });

  const dm = snapshotFor('dm', null);
  assert.ok(dm.characters.find((c) => c.id === heroId).hidden_desire === 'wants the crown');
  assert.ok(dm.clocks.some((c) => c.id === secretId));
  assert.strictEqual(dm.clocks.find((c) => c.id === clockId).note, 'GM eyes only: this is the warlord arriving');

  const otherPlayer = snapshotFor('player', wizardId, DEV);
  const heroSeen = otherPlayer.characters.find((c) => c.id === heroId);
  assert.strictEqual(heroSeen.hidden_desire, undefined, 'another player saw a hidden desire!');
  assert.ok(!otherPlayer.clocks.some((c) => c.id === secretId), 'a player saw a dm_only clock!');
  assert.strictEqual(otherPlayer.clocks.find((c) => c.id === clockId).note, undefined, 'a player saw a GM clock note!');

  const ownPlayer = snapshotFor('player', heroId, DEV);
  assert.strictEqual(ownPlayer.characters.find((c) => c.id === heroId).hidden_desire, 'wants the crown');

  const display = snapshotFor('display', null);
  assert.ok(display.characters.every((c) => c.hidden_desire === undefined));
  assert.ok(!display.clocks.some((c) => c.id === secretId));
  assert.ok(display.clocks.every((c) => c.note === undefined), 'the wall showed a GM clock note!');
});

check('reward rate live-tunable', () => {
  ops['game.set_reward_rate']({ reward_every_n_encounters: 2 });
  assert.strictEqual(state.game.reward_every_n_encounters, 2);
  throws(() => ops['game.set_reward_rate']({ reward_every_n_encounters: 0 }));
});

check('reveal: dm_only clock flips visible in one op', () => {
  ops['clock.set_visibility']({ clock_id: secretId, visibility: 'visible' });
  assert.ok(snapshotFor('player', heroId, DEV).clocks.some((c) => c.id === secretId));
});

let mapId;
check('map calibrate: bounds enforced, becomes active with a camera', () => {
  throws(() => ops['token.create']({ label: 'early', kind: 'monster', col: 0, row: 0 })); // no map yet
  mapId = ops['map.calibrate']({
    name: 'Goblin Bridge', image_path: '/assets/maps/test.png', image_w: 1000, image_h: 800,
    cell_size: 50, offset_x: 10, offset_y: 20,
  }).created_map_id;
  assert.strictEqual(state.game.active_map_id, mapId);
  assert.ok(state.camera && state.camera.center_x === 500);
  throws(() => ops['map.calibrate']({ name: 'x', image_path: '/x.png', image_w: 100, image_h: 100, cell_size: 2, offset_x: 0, offset_y: 0 })); // cell too small
  throws(() => ops['map.calibrate']({ name: 'x', image_path: '/x.png', image_w: 100, image_h: 100, cell_size: 50, offset_x: 60, offset_y: 0 })); // offset >= cell
  throws(() => ops['map.calibrate']({ name: '  ', image_path: '/x.png', image_w: 100, image_h: 100, cell_size: 50, offset_x: 0, offset_y: 0 })); // blank name
});

check('map rename + re-calibration (tokens clamp to the new grid)', () => {
  ops['map.rename']({ map_id: mapId, name: 'Goblin Bridge (night)' });
  assert.strictEqual(state.maps.get(mapId).name, 'Goblin Bridge (night)');
  throws(() => ops['map.rename']({ map_id: mapId, name: '' }));

  const edge = ops['token.create']({ label: 'Edge Lurker', kind: 'monster', col: 18, row: 14 }).created_token_id;
  // bigger cells → fewer cells (9x7) → the lurker at (18,14) must clamp to (8,6)
  ops['map.update_calibration']({ map_id: mapId, cell_size: 100, offset_x: 50, offset_y: 50 });
  assert.strictEqual(state.maps.get(mapId).cell_size, 100);
  const lurker = state.tokens.get(edge);
  assert.deepStrictEqual({ col: lurker.col, row: lurker.row }, { col: 8, row: 6 });
  throws(() => ops['map.update_calibration']({ map_id: mapId, cell_size: 2, offset_x: 0, offset_y: 0 }));
  // restore the original grid for the following checks
  ops['map.update_calibration']({ map_id: mapId, cell_size: 50, offset_x: 10, offset_y: 20 });
  ops['token.delete']({ token_id: edge });
});

check('tokens live in grid space with bounds; one pc token per character', () => {
  // grid is floor((1000-10)/50)=19 cols x floor((800-20)/50)=15 rows
  const tok = ops['token.create']({ label: 'Tharn', kind: 'pc', char_id: heroId, col: 2, row: 3 }).created_token_id;
  throws(() => ops['token.create']({ label: 'Tharn again', kind: 'pc', char_id: heroId, col: 4, row: 4 })); // dup pc
  const gob = ops['token.create']({ label: 'Goblin', kind: 'monster', col: 18, row: 14 }).created_token_id;
  throws(() => ops['token.create']({ label: 'off-map', kind: 'monster', col: 19, row: 0 })); // out of bounds
  ops['token.move']({ token_id: tok, col: 3, row: 3 });
  throws(() => ops['token.move']({ token_id: tok, col: -1, row: 3 }));
  assert.strictEqual(state.tokens.get(tok).col, 3);
  const glow = ops['token.create']({ label: 'Campfire', kind: 'glow', col: 5, row: 5, glow_color: '#ff8c2e', glow_radius: 3, glow_pulse: 0.5 }).created_token_id;
  throws(() => ops['token.create']({ label: 'bad glow', kind: 'glow', col: 5, row: 6 })); // missing glow params
  ops['token.delete']({ token_id: gob });
  ops['token.delete']({ token_id: glow });
});

check('grid overlay toggle per map', () => {
  assert.strictEqual(state.maps.get(mapId).grid_visible, 1); // on by default
  ops['map.set_grid_visible']({ map_id: mapId, visible: false });
  assert.strictEqual(state.maps.get(mapId).grid_visible, 0);
  ops['map.set_grid_visible']({ map_id: mapId, visible: true });
  throws(() => ops['map.set_grid_visible']({ map_id: mapId, visible: 'yes' })); // not a boolean
  throws(() => ops['map.set_grid_visible']({ map_id: 9999, visible: true }));
});

check('fog of war: enable hides the board, bitmask + darkness + token concealment', () => {
  const map = state.maps.get(mapId);
  const cols = Math.floor((map.image_w - map.offset_x) / map.cell_size); // 19
  const rows = Math.floor((map.image_h - map.offset_y) / map.cell_size); // 15
  assert.strictEqual(map.fog_enabled, 0); // off by default — current behaviour preserved

  // enabling for the first time hides the whole board
  ops['map.set_fog_enabled']({ map_id: mapId, enabled: true });
  assert.strictEqual(state.maps.get(mapId).fog_enabled, 1);
  assert.strictEqual(state.maps.get(mapId).fog, '0'.repeat(cols * rows));
  throws(() => ops['map.set_fog_enabled']({ map_id: mapId, enabled: 'yes' }));

  // a fully-fogged token vanishes for players + display but never for the GM
  const lurker = ops['token.create']({ label: 'Lurker', kind: 'monster', col: 1, row: 1 }).created_token_id;
  const seen = (role) => snapshotFor(role, null).tokens.some((t) => t.id === lurker);
  assert.ok(seen('dm') && !seen('player') && !seen('display'));

  // reveal the lurker's cell → it reappears everywhere
  const reveal = '0'.repeat(cols * rows).split('');
  reveal[1 * cols + 1] = '1';
  ops['map.set_fog']({ map_id: mapId, fog: reveal.join('') });
  assert.ok(seen('dm') && seen('player') && seen('display'));
  ops['token.delete']({ token_id: lurker });

  // bitmask must match the grid exactly and be binary
  throws(() => ops['map.set_fog']({ map_id: mapId, fog: '01' }));               // wrong length
  throws(() => ops['map.set_fog']({ map_id: mapId, fog: '2'.repeat(cols * rows) })); // non-binary

  // darkness dial 0..1
  ops['map.set_fog_darkness']({ map_id: mapId, darkness: 0.4 });
  assert.strictEqual(state.maps.get(mapId).fog_darkness, 0.4);
  throws(() => ops['map.set_fog_darkness']({ map_id: mapId, darkness: 1.5 }));

  // re-calibration re-grids the fog instead of corrupting it (length follows dims)
  ops['map.update_calibration']({ map_id: mapId, cell_size: 100, offset_x: 50, offset_y: 50 });
  const nd = state.maps.get(mapId);
  const ncols = Math.floor((nd.image_w - nd.offset_x) / nd.cell_size);
  const nrows = Math.floor((nd.image_h - nd.offset_y) / nd.cell_size);
  assert.strictEqual(nd.fog.length, ncols * nrows);
  ops['map.update_calibration']({ map_id: mapId, cell_size: 50, offset_x: 10, offset_y: 20 });

  // turn fog back off for the remaining checks
  ops['map.set_fog_enabled']({ map_id: mapId, enabled: false });
  assert.strictEqual(state.maps.get(mapId).fog_enabled, 0);
});

check('map primary orientation seeds the camera + applies live', () => {
  ops['map.set_base_rotation']({ map_id: mapId, rotation_deg: 90 });
  assert.strictEqual(state.maps.get(mapId).base_rotation, 90);
  assert.strictEqual(state.camera.rotation_deg, 90); // active map → live
  throws(() => ops['map.set_base_rotation']({ map_id: mapId, rotation_deg: 45 })); // not a quarter turn
  // re-opening the map starts at its primary orientation
  ops['map.set_active']({ map_id: mapId });
  assert.strictEqual(state.camera.rotation_deg, 90);
  ops['map.set_base_rotation']({ map_id: mapId, rotation_deg: 0 });
});

check('camera: view-only transform with zoom rails + bookmarks', () => {
  ops['camera.update']({ center_x: 300, center_y: 200, zoom: 2, rotation_deg: 90 });
  assert.strictEqual(state.camera.zoom, 2);
  throws(() => ops['camera.update']({ center_x: 300, center_y: 200, zoom: 100, rotation_deg: 0 })); // zoom rail
  throws(() => ops['camera.update']({ center_x: 5000, center_y: 200, zoom: 1, rotation_deg: 0 })); // off-map center
  // camera never touches token grid coords
  const tok = [...state.tokens.values()].find((t) => t.char_id === heroId);
  assert.strictEqual(tok.col, 3);
  ops['camera.save_bookmark']({ name: 'ambush' });
  assert.strictEqual(state.camera_bookmarks.length, 1);
  ops['camera.delete_bookmark']({ name: 'ambush' });
  throws(() => ops['camera.delete_bookmark']({ name: 'ambush' }));
});

check('initiative visibility: dm_only entries never reach players/display', () => {
  const { snapshotFor } = require('../state');
  const reminder = ops['initiative.add_custom']({ label: 'Reinforcements at round 3' }).created_entry_id;
  ops['initiative.set_visibility']({ entry_id: reminder, visibility: 'dm_only' });
  assert.ok(snapshotFor('dm', null).initiative.entries.some((e) => e.id === reminder));
  assert.ok(!snapshotFor('display', null).initiative.entries.some((e) => e.id === reminder), 'projector saw a GM-only entry!');
  assert.ok(!snapshotFor('player', heroId, DEV).initiative.entries.some((e) => e.id === reminder), 'a player saw a GM-only entry!');
  ops['initiative.set_visibility']({ entry_id: reminder, visibility: 'visible' });
  assert.ok(snapshotFor('display', null).initiative.entries.some((e) => e.id === reminder));
  throws(() => ops['initiative.set_visibility']({ entry_id: reminder, visibility: 'sneaky' }));
  throws(() => ops['initiative.set_visibility']({ entry_id: 'custom:9999', visibility: 'dm_only' }));
  ops['initiative.remove']({ entry_id: reminder });
});

check('token colors + saved palette', () => {
  // default by kind, custom on create, recolor after
  const ogre = ops['token.create']({ label: 'Ogre', kind: 'monster', col: 1, row: 1 }).created_token_id;
  assert.strictEqual(state.tokens.get(ogre).color, '#c43c34');
  const wisp = ops['token.create']({ label: 'Wisp', kind: 'glow', col: 2, row: 2, color: '#66CCFF', glow_radius: 2, glow_pulse: 1 }).created_token_id;
  assert.strictEqual(state.tokens.get(wisp).color, '#66ccff');
  assert.strictEqual(state.tokens.get(wisp).glow_color, '#66ccff'); // glow mirrors color
  ops['token.set_color']({ token_id: ogre, color: '#112233' });
  assert.strictEqual(state.tokens.get(ogre).color, '#112233');
  throws(() => ops['token.set_color']({ token_id: ogre, color: 'red' })); // not #rrggbb
  throws(() => ops['token.create']({ label: 'bad', kind: 'monster', col: 1, row: 2, color: '#12' }));

  ops['palette.save_color']({ color: '#112233' });
  ops['palette.save_color']({ color: '#112233' }); // idempotent
  assert.deepStrictEqual(state.custom_colors, ['#112233']);
  ops['palette.delete_color']({ color: '#112233' });
  throws(() => ops['palette.delete_color']({ color: '#112233' })); // already gone
  ops['token.delete']({ token_id: ogre });
  ops['token.delete']({ token_id: wisp });
});

check('token size + shape: footprints, bounds, resize clamping', () => {
  // grid is 19x15; defaults: 1x1, terrain=square, creatures=circle
  const rock = ops['token.create']({ label: 'Boulder', kind: 'terrain', col: 0, row: 0 }).created_token_id;
  assert.strictEqual(state.tokens.get(rock).shape, 'square');
  const wall = ops['token.create']({ label: 'Wall', kind: 'terrain', col: 16, row: 10, w: 3, h: 5, shape: 'square' }).created_token_id;
  assert.strictEqual(state.tokens.get(wall).w, 3);
  throws(() => ops['token.create']({ label: 'too wide', kind: 'terrain', col: 17, row: 0, w: 3, h: 1 })); // footprint off the edge
  throws(() => ops['token.move']({ token_id: wall, col: 17, row: 10 })); // 3-wide can't start at col 17
  ops['token.move']({ token_id: wall, col: 16, row: 0 });
  // growing pulls the position back to fit instead of falling off the map
  ops['token.set_size']({ token_id: wall, w: 5, h: 5, shape: 'square' });
  assert.strictEqual(state.tokens.get(wall).col, 14);
  throws(() => ops['token.set_size']({ token_id: wall, w: 0, h: 5, shape: 'square' }));
  throws(() => ops['token.set_size']({ token_id: wall, w: 2, h: 2, shape: 'blob' }));
  ops['token.delete']({ token_id: rock });
  ops['token.delete']({ token_id: wall });
});

check('camera bookmarks are per-map', () => {
  const { snapshotFor } = require('../state');
  ops['camera.save_bookmark']({ name: 'throne room' });
  const mapB = ops['map.calibrate']({
    name: 'Swamp', image_path: '/assets/maps/swamp.png', image_w: 500, image_h: 500,
    cell_size: 50, offset_x: 0, offset_y: 0,
  }).created_map_id; // calibrating activates the swamp
  assert.strictEqual(snapshotFor('dm', null).camera_bookmarks.length, 0, 'throne-room view leaked onto the swamp map');
  throws(() => ops['camera.delete_bookmark']({ name: 'throne room' })); // not on this map
  ops['camera.save_bookmark']({ name: 'gator nest' });
  assert.deepStrictEqual(snapshotFor('dm', null).camera_bookmarks.map((b) => b.name), ['gator nest']);
  ops['map.set_active']({ map_id: mapId });
  assert.deepStrictEqual(snapshotFor('dm', null).camera_bookmarks.map((b) => b.name), ['throne room']);
  ops['map.delete']({ map_id: mapB }); // takes its bookmarks with it
  assert.ok(!state.camera_bookmarks.some((b) => b.map_id === mapB));
  ops['camera.delete_bookmark']({ name: 'throne room' });
});

check('profile edit + portrait: name/concept update, art flows to pc token', () => {
  ops['character.update_sheet']({ char_id: heroId, name: 'Tharn the Renamed', concept: 'storm-priest, reformed' });
  assert.strictEqual(state.characters.get(heroId).name, 'Tharn the Renamed');
  throws(() => ops['character.update_sheet']({ char_id: heroId, name: '  ' })); // can't blank a name
  throws(() => ops['character.update_sheet']({ char_id: heroId, token_art: 'http://evil/x.png' }));

  // clear the hero token left on the board by the earlier grid checks
  const leftover = [...state.tokens.values()].find((t) => t.char_id === heroId);
  if (leftover) ops['token.delete']({ token_id: leftover.id });

  // portrait set at character level → a freshly placed pc token wears it
  ops['character.update_sheet']({ char_id: heroId, token_art: '/assets/tokens/token-hero.png' });
  const tok = ops['token.create']({ label: 'Tharn', kind: 'pc', char_id: heroId, col: 0, row: 0 }).created_token_id;
  assert.strictEqual(state.tokens.get(tok).art, '/assets/tokens/token-hero.png');
  // changing the token art mirrors back to the character…
  ops['token.set_art']({ token_id: tok, art: '/assets/tokens/token-hero2.png' });
  assert.strictEqual(state.characters.get(heroId).token_art, '/assets/tokens/token-hero2.png');
  // …and updating the profile updates the live token
  ops['character.update_sheet']({ char_id: heroId, token_art: '' });
  assert.strictEqual(state.tokens.get(tok).art, null);
  ops['token.delete']({ token_id: tok });
});

check('token art: uploaded-path rails, clearable, no art on glows', () => {
  const drake = ops['token.create']({ label: 'Dragon', kind: 'monster', col: 4, row: 4, w: 3, h: 3 }).created_token_id;
  ops['token.set_art']({ token_id: drake, art: '/assets/tokens/token-123.png' });
  assert.strictEqual(state.tokens.get(drake).art, '/assets/tokens/token-123.png');
  throws(() => ops['token.set_art']({ token_id: drake, art: '/etc/passwd' }));
  throws(() => ops['token.set_art']({ token_id: drake, art: '/assets/maps/sneaky.png' }));
  ops['token.set_art']({ token_id: drake, art: null });
  assert.strictEqual(state.tokens.get(drake).art, null);
  const torch = ops['token.create']({ label: 'Torch', kind: 'glow', col: 1, row: 1, glow_radius: 2, glow_pulse: 1 }).created_token_id;
  throws(() => ops['token.set_art']({ token_id: torch, art: '/assets/tokens/token-1.png' }));
  ops['token.delete']({ token_id: drake });
  ops['token.delete']({ token_id: torch });
});

check('display viewport report (for the GM minimap projection box)', () => {
  ops['display.report_viewport']({ width: 1920, height: 1080 });
  assert.deepStrictEqual(state.display_viewport, { width: 1920, height: 1080 });
  const { snapshotFor } = require('../state');
  assert.deepStrictEqual(snapshotFor('dm', null).display_viewport, { width: 1920, height: 1080 });
  throws(() => ops['display.report_viewport']({ width: 0, height: 1080 }));
  throws(() => ops['display.report_viewport']({ width: 1920.5, height: 1080 }));
});

check('map deactivate + delete clears camera', () => {
  ops['map.set_active']({ map_id: null });
  assert.strictEqual(state.camera, null);
  ops['map.delete']({ map_id: mapId });
  assert.ok(!state.maps.has(mapId));
});

check('character.delete cleans initiative + pc tokens', () => {
  ops['character.delete']({ char_id: wizardId });
  assert.ok(!state.initiative.entries.some((e) => e.char_id === wizardId));
  assert.ok(![...state.tokens.values()].some((t) => t.char_id === wizardId));
});

// --- devices ---------------------------------------------------------------
check('devices: register, name, online flag, GM listing', () => {
  const { snapshotFor } = require('../state');
  // a device the GM names shows up in the GM's device list…
  ops['device.set_name']({ device_id: 'dev-phone-2', name: "  Mara's phone  " });
  const dm = snapshotFor('dm', null, null, ['dev-phone-2']);
  const d2 = dm.devices.find((d) => d.id === 'dev-phone-2');
  assert.ok(d2, 'GM did not see the named device');
  assert.strictEqual(d2.name, "Mara's phone", 'device name not trimmed');
  // …flagged online only while it is in the connected set
  assert.strictEqual(d2.online, true, 'connected device not marked online');
  assert.strictEqual(snapshotFor('dm', null, null, []).devices.find((d) => d.id === 'dev-phone-2').online,
    false, 'a disconnected device was still marked online');
  // a connected-but-unknown device still appears (so the GM can name it)
  assert.ok(snapshotFor('dm', null, null, ['ghost-device']).devices.some((d) => d.id === 'ghost-device'));
  throws(() => ops['device.set_name']({ device_id: '', name: 'x' })); // blank id rejected
});

check('device scoping: a phone sees only its own characters; forget unlinks', () => {
  const { snapshotFor } = require('../state');
  // hero starts on DEV; reassign it to dev-phone-2
  ops['character.set_device']({ char_id: heroId, device_id: 'dev-phone-2' });
  assert.ok(snapshotFor('player', heroId, 'dev-phone-2').characters.some((c) => c.id === heroId));
  assert.ok(!snapshotFor('player', heroId, DEV).characters.some((c) => c.id === heroId),
    'a character leaked onto the wrong phone');
  // forgetting a device unlinks its characters (never deletes them) and drops it
  // from the GM list
  ops['device.delete']({ device_id: 'dev-phone-2' });
  assert.strictEqual(state.characters.get(heroId).device_id, null);
  assert.ok(!snapshotFor('dm', null).devices.some((d) => d.id === 'dev-phone-2'),
    'a forgotten device was still listed');
  // an unassigned character reaches no player phone at all
  assert.ok(!snapshotFor('player', heroId, 'any-device').characters.some((c) => c.id === heroId));
  // unlinking to null is also allowed directly
  ops['character.set_device']({ char_id: heroId, device_id: null });
  assert.strictEqual(state.characters.get(heroId).device_id, null);
});

// --- reveal cards (NPCs / locations / story beats) -------------------------
let cardId;
check('reveal cards: create, kind + name + field validation', () => {
  cardId = ops['card.create']({ kind: 'npc', name: 'Grukk the Ogre' }).created_card_id;
  assert.ok(Number.isInteger(cardId));
  assert.strictEqual(state.cards.get(cardId).bg_effect, 'embers'); // sensible default
  throws(() => ops['card.create']({ kind: 'villain', name: 'x' })); // unknown kind
  throws(() => ops['card.create']({ kind: 'npc', name: '  ' }));    // blank name
  ops['card.update']({ card_id: cardId, subtitle: 'CR 2 brute', notes: 'secretly fears fire', bg_effect: 'arcane' });
  const c = state.cards.get(cardId);
  assert.strictEqual(c.subtitle, 'CR 2 brute');
  assert.strictEqual(c.bg_effect, 'arcane');
  throws(() => ops['card.update']({ card_id: cardId, bg_effect: 'lasers' }));           // not a known effect
  throws(() => ops['card.update']({ card_id: cardId, images: ['http://evil/x.png'] }));  // must be an uploaded path
  throws(() => ops['card.update']({ card_id: cardId, name: '  ' }));                     // can't blank the name
});

check('reveal cards: GM notes + hidden entries never reach the wall', () => {
  const { snapshotFor } = require('../state');
  ops['card.update']({ card_id: cardId, sections: [
    { title: 'Lore', entries: [
      { label: 'Origin', text: 'born in the marsh', visible: true },
      { label: 'Secret', text: 'fears the king', visible: false },
    ] },
    { title: 'Tactics', visible: false, entries: [
      { label: 'Opener', text: 'charges the loudest voice', visible: true },
    ] },
  ] });
  ops['card.reveal']({ card_id: cardId });
  const shown = snapshotFor('display', null).revealed_card;
  assert.strictEqual(shown.id, cardId);
  // only the visible entry of the visible chapter reaches the projector
  assert.deepStrictEqual(shown.sections.map((s) => s.title), ['Lore']);
  assert.deepStrictEqual(shown.sections[0].entries.map((e) => e.label), ['Origin']);
  // GM-only fields are stripped from the public view
  assert.ok(!('done' in shown.sections[0].entries[0]), 'a done flag leaked to the wall');
  assert.ok(!('notes' in shown), 'GM notes leaked to the wall');
  // the players' copy is scoped identically
  const playerSeen = snapshotFor('player', heroId, DEV).revealed_card;
  assert.deepStrictEqual(playerSeen.sections[0].entries.map((e) => e.label), ['Origin']);
  // the GM still sees the whole card (private notes + hidden entries) in their library
  const lib = snapshotFor('dm', null).cards.find((c) => c.id === cardId);
  assert.strictEqual(lib.notes, 'secretly fears fire');
  assert.strictEqual(lib.sections[1].entries.length, 1);
});

check('reveal cards: live toggles flip what the wall shows', () => {
  const { snapshotFor } = require('../state');
  ops['card.set_entry_visibility']({ card_id: cardId, section: 0, entry: 1, visible: true }); // reveal the secret
  assert.deepStrictEqual(snapshotFor('display', null).revealed_card.sections[0].entries.map((e) => e.label),
    ['Origin', 'Secret']);
  ops['card.set_section_visible']({ card_id: cardId, section: 1, visible: true }); // reveal the hidden chapter
  assert.deepStrictEqual(snapshotFor('display', null).revealed_card.sections.map((s) => s.title),
    ['Lore', 'Tactics']);
  // out-of-range indices and non-boolean flags fail loud
  throws(() => ops['card.set_entry_visibility']({ card_id: cardId, section: 9, entry: 0, visible: true }));
  throws(() => ops['card.set_entry_visibility']({ card_id: cardId, section: 0, entry: 9, visible: true }));
  throws(() => ops['card.set_entry_visibility']({ card_id: cardId, section: 0, entry: 0, visible: 'yes' }));
});

check('reveal cards: focus / pause / held image are transient and reset per reveal', () => {
  const { snapshotFor } = require('../state');
  ops['card.set_scroll_paused']({ paused: true });
  ops['card.set_focus']({ section: 0, entry: 1 });
  let shown = snapshotFor('display', null).revealed_card;
  assert.strictEqual(shown.scroll_paused, true);
  assert.deepStrictEqual(shown.focus, { section: 0, entry: 1 });
  // a focus past the end of the composed sections clears instead of dangling
  ops['card.set_focus']({ section: 0, entry: 99 });
  assert.strictEqual(snapshotFor('display', null).revealed_card.focus, null);
  // re-revealing the same card resets the transient presentation state
  ops['card.reveal']({ card_id: cardId });
  shown = snapshotFor('display', null).revealed_card;
  assert.strictEqual(shown.scroll_paused, false);
  assert.strictEqual(shown.focus, null);
});

check('reveal cards: slideshow gates compose card + chapter + scene images', () => {
  const { snapshotFor } = require('../state');
  ops['card.update']({ card_id: cardId,
    images: ['/assets/tokens/arc.png'], // the card's own gallery
    sections: [
      { title: 'Lore', images: ['/assets/tokens/chapter.png'], entries: [
        { label: 'Origin', text: 'born in the marsh', visible: true, images: ['/assets/tokens/scene.png'] },
      ] },
    ] });
  ops['card.reveal']({ card_id: cardId });
  // all three sources ride the slideshow, each tagged with where it came from
  let shown = snapshotFor('display', null).revealed_card;
  assert.deepStrictEqual(shown.images, ['/assets/tokens/arc.png', '/assets/tokens/chapter.png', '/assets/tokens/scene.png']);
  assert.deepStrictEqual(shown.image_sources, [{ card: true }, { s: 0, e: -1 }, { s: 0, e: 0 }]);
  // drop the card's own gallery out of the mix
  ops['card.update']({ card_id: cardId, images_slides: false });
  assert.deepStrictEqual(snapshotFor('display', null).revealed_card.images,
    ['/assets/tokens/chapter.png', '/assets/tokens/scene.png']);
  // …then the chapter's panels…
  ops['card.set_section_slides']({ card_id: cardId, section: 0, slides: false });
  assert.deepStrictEqual(snapshotFor('display', null).revealed_card.images, ['/assets/tokens/scene.png']);
  // …then the scene's panel — leaving an empty slideshow
  ops['card.set_entry_slides']({ card_id: cardId, section: 0, entry: 0, slides: false });
  assert.deepStrictEqual(snapshotFor('display', null).revealed_card.images, []);
  // the connector-line preference is per-card and rides the public view
  ops['card.set_show_link']({ card_id: cardId, on: false });
  assert.strictEqual(snapshotFor('display', null).revealed_card.show_link, false);
});

check('knowledge: visited locations + seen NPCs reach players, story never does', () => {
  const { snapshotFor } = require('../state');
  const loc = ops['card.create']({ kind: 'location', name: 'The Sunken Keep' }).created_card_id;
  const met = ops['card.create']({ kind: 'npc', name: 'Sera the Guide' }).created_card_id;
  const arc = ops['card.create']({ kind: 'story', name: 'The Gathering Storm' }).created_card_id;
  // give each a public detail so none is skipped as a blank entry
  for (const id of [loc, met, arc]) ops['card.update']({ card_id: id,
    sections: [{ title: 'Description', entries: [{ label: '', text: 'a place', visible: true }] }] });
  const known = () => snapshotFor('player', heroId, DEV).known_cards.map((c) => c.id).sort((a, b) => a - b);
  // nothing is known until the GM marks it
  assert.deepStrictEqual(known(), []);
  // the GM snapshot has no knowledge list — they already see the whole library
  assert.ok(!('known_cards' in snapshotFor('dm', null)));
  ops['card.update']({ card_id: loc, visited: true });
  ops['card.update']({ card_id: met, seen: true });
  ops['card.update']({ card_id: arc, seen: true }); // story is gated out regardless
  assert.deepStrictEqual(known(), [loc, met].sort((a, b) => a - b));
  // a knowledge entry is the same scoped shape as a reveal — no GM notes, no internals
  const view = snapshotFor('player', heroId, DEV).known_cards.find((c) => c.id === met);
  assert.strictEqual(view.name, 'Sera the Guide');
  assert.ok(!('notes' in view) && !('_publicSections' in view), 'GM/internal fields leaked into knowledge');
  // unmarking pulls it back out of the players' knowledge
  ops['card.update']({ card_id: met, seen: false });
  assert.deepStrictEqual(known(), [loc]);
  // a known card with nothing public to show is skipped (no blank entries)
  ops['card.update']({ card_id: loc, sections: [] });
  assert.deepStrictEqual(known(), []);
  for (const id of [loc, met, arc]) ops['card.delete']({ card_id: id });
});

check('reveal cards: dismiss + deleting the revealed card clears the wall', () => {
  const { snapshotFor } = require('../state');
  ops['card.reveal']({ card_id: null });
  assert.strictEqual(snapshotFor('display', null).revealed_card, null);
  // re-reveal, then delete it out from under the projector
  ops['card.reveal']({ card_id: cardId });
  assert.strictEqual(state.game.revealed_card_id, cardId);
  ops['card.delete']({ card_id: cardId });
  assert.strictEqual(state.game.revealed_card_id, null);
  assert.strictEqual(snapshotFor('display', null).revealed_card, null);
  assert.ok(!state.cards.has(cardId));
});

// --- projector settings ----------------------------------------------------
check('settings: scroll speed / particles / transitions validated + broadcast', () => {
  const { snapshotFor } = require('../state');
  ops['settings.update']({ scroll_speed: 2, particles_enabled: false, transitions_enabled: true, transition_ms: 800 });
  const s = snapshotFor('display', null).settings; // every role gets settings
  assert.strictEqual(s.scroll_speed, 2);
  assert.strictEqual(s.particles_enabled, false);
  assert.strictEqual(s.transition_ms, 800);
  // per-kind transition splash images must be uploaded paths
  ops['settings.update']({ transition_images: { npc: '/assets/tokens/splash.png' } });
  assert.strictEqual(snapshotFor('dm', null).settings.transition_images.npc, '/assets/tokens/splash.png');
  throws(() => ops['settings.update']({ scroll_speed: 9 }));                            // outside 0.3–3
  throws(() => ops['settings.update']({ transition_ms: 50 }));                          // below 200
  throws(() => ops['settings.update']({ transition_images: { npc: 'http://x/y.png' } }));
  throws(() => ops['settings.update']({ particles_enabled: 'no' }));
});

// --- multi-map token scoping ----------------------------------------------
check('tokens are scoped to their map; switching maps swaps the token set', () => {
  const { snapshotFor } = require('../state');
  const mapA = ops['map.calibrate']({ name: 'Cave', image_path: '/assets/maps/cave.png',
    image_w: 500, image_h: 500, cell_size: 50, offset_x: 0, offset_y: 0 }).created_map_id;
  const tokA = ops['token.create']({ label: 'Bat', kind: 'monster', col: 0, row: 0 }).created_token_id;
  const mapB = ops['map.calibrate']({ name: 'Keep', image_path: '/assets/maps/keep.png',
    image_w: 500, image_h: 500, cell_size: 50, offset_x: 0, offset_y: 0 }).created_map_id; // becomes active
  const tokB = ops['token.create']({ label: 'Guard', kind: 'monster', col: 1, row: 1 }).created_token_id;
  // the active map (Keep) only sends its own token
  assert.deepStrictEqual(snapshotFor('dm', null).tokens.map((t) => t.id), [tokB]);
  ops['map.set_active']({ map_id: mapA });
  assert.deepStrictEqual(snapshotFor('dm', null).tokens.map((t) => t.id), [tokA]);
  // deleting a map cascades its own tokens away, leaving the others untouched
  ops['map.delete']({ map_id: mapA });
  assert.ok(!state.tokens.has(tokA), 'a token outlived the map it was deleted with');
  assert.ok(state.tokens.has(tokB));
  ops['map.delete']({ map_id: mapB });
});

// --- prep-pack import (builder.html → /assist/import) ----------------------
// These two are async (importPack returns a promise), so they run through a
// small async runner below instead of the synchronous check() above.
async function acheck(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (err) { console.error(`  ✖ ${name}\n    ${err.message}`); process.exitCode = 1; throw err; }
}

async function asyncChecks() {
await acheck('prep pack import: builds cards/chapters/scenes, reveal_live → hidden', async () => {
  const { importPack } = require('../assistant');
  const before = state.cards.size;
  const progress = [];
  const summary = await importPack({
    format: 'campfire-saga-pack', version: 1, title: 'The Sunken Crown',
    cards: [
      { kind: 'story', name: 'Ambush at the Ford', subtitle: 'blades in the reeds',
        notes: 'the bandits flee at half strength', bg_effect: 'rain',
        sections: [{ title: 'Opening', entries: [
          { label: 'The whistle', text: 'an arrow thuds into the mast', reveal_live: false },
          { label: 'The trap', text: 'nets rise from the water', reveal_live: true },
        ] }] },
      { kind: 'npc', name: 'Reed-Witch', token_w: 2, token_h: 2 },
    ],
  }, { broadcast() {}, onProgress: (p) => progress.push(p) });

  assert.strictEqual(summary.cards_created, 2);
  assert.strictEqual(summary.images_made, 0); // no image requests → no network
  assert.strictEqual(state.cards.size, before + 2);
  const story = [...state.cards.values()].find((c) => c.name === 'Ambush at the Ford');
  assert.strictEqual(story.kind, 'story');
  assert.strictEqual(story.bg_effect, 'rain');
  assert.strictEqual(story.sections[0].title, 'Opening');
  // reveal_live:false starts shown; reveal_live:true (or omitted) starts hidden
  assert.strictEqual(story.sections[0].entries[0].visible, true);
  assert.strictEqual(story.sections[0].entries[1].visible, false);
  const witch = [...state.cards.values()].find((c) => c.name === 'Reed-Witch');
  assert.strictEqual(witch.token_w, 2);
  // cleanup so later size-based assertions (if any) stay honest
  ops['card.delete']({ card_id: story.id });
  ops['card.delete']({ card_id: witch.id });
});

await acheck('prep pack import: rejects a file that is not a pack', async () => {
  const { importPack } = require('../assistant');
  let threw = false;
  try { await importPack({ hello: 'world' }, { broadcast() {} }); } catch { threw = true; }
  assert.ok(threw, 'importing a non-pack object should fail loud');
});
}

asyncChecks().then(() => {
  console.log(`\nAll ${passed} checks passed. The fire burns true. 🔥`);
  fs.rmSync(tmp, { recursive: true, force: true });
}).catch(() => {
  // a failed check already logged + set exitCode; just clean up the temp DB
  fs.rmSync(tmp, { recursive: true, force: true });
});
