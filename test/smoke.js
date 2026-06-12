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
  const ownHero = snapshotFor('player', heroId).characters.find((c) => c.id === heroId);
  assert.ok(!ownHero.conditions.some((x) => x.kind === 'secretly cursed'), 'player saw a GM-only note!');

  // edit: rename + flip visibility
  const cursed = state.characters.get(heroId).conditions.find((x) => x.kind === 'secretly cursed');
  ops['condition.update']({ condition_id: cursed.id, kind: 'visibly cursed', visibility: 'visible' });
  assert.ok(snapshotFor('player', heroId).characters.find((c) => c.id === heroId)
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
  assert.ok(!snapshotFor('player', heroId).initiative.entries.some((e) => e.id === reminder), 'a player saw a GM-only entry!');
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

console.log(`\nAll ${passed} checks passed. The fire burns true. 🔥`);
fs.rmSync(tmp, { recursive: true, force: true });
