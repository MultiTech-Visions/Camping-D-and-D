'use strict';

// Pure rule helpers shared across the server. FAIL LOUD: every helper throws on
// out-of-range input — bad state must surface, never be papered over.

const config = require('./config');

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
    this.expected = true; // expected validation failure → reported to the client, not a crash
  }
}

function assert(cond, message) {
  if (!cond) throw new RuleError(message);
}

function assertInt(value, name) {
  assert(Number.isInteger(value), `${name} must be an integer, got ${JSON.stringify(value)}`);
  return value;
}

function assertIntIn(value, min, max, name) {
  assertInt(value, name);
  assert(value >= min && value <= max, `${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function assertString(value, name) {
  assert(typeof value === 'string', `${name} must be a string, got ${typeof value}`);
  return value;
}

function assertNonEmptyString(value, name) {
  assertString(value, name);
  assert(value.trim().length > 0, `${name} must not be empty`);
  return value.trim();
}

function assertOneOf(value, choices, name) {
  assert(choices.includes(value), `${name} must be one of [${choices.join(', ')}], got ${JSON.stringify(value)}`);
  return value;
}

// THE core mapping (handoff §1). Rank → dice. The set has exactly 3 green + 2 yellow.
// There is no separate proficiency mechanic anywhere: high rank IS mastery.
function diceForRank(rank) {
  assertIntIn(rank, 0, config.CEILING, 'rank');
  return { green: Math.min(rank, 3), yellow: Math.max(rank - 3, 0) };
}

// Effective rank = base − drain. Negative means corrupt state → throw, never clamp.
function effectiveRank(baseRank, drained, attr) {
  assertIntIn(baseRank, 0, config.CEILING, `base ${attr}`);
  assertInt(drained, `drain.${attr}`);
  const eff = baseRank - drained;
  assert(eff >= 0, `corrupt state: effective ${attr} rank is ${eff} (base ${baseRank}, drain ${drained})`);
  return eff;
}

// Campfire Saga creation validation: attributes sum to exactly STARTING_POINTS,
// each within 0..CREATION_MAX. Constitution may be 0 (glass cannon).
function validateCampfireCreation(attrs) {
  let sum = 0;
  for (const attr of config.ATTRIBUTES) {
    assertIntIn(attrs[attr], 0, config.CREATION_MAX, attr);
    sum += attrs[attr];
  }
  assert(sum === config.STARTING_POINTS,
    `attribute points must sum to exactly ${config.STARTING_POINTS}, got ${sum}`);
}

// D&D 5e sheet validation. Sanity rails so corrupt data can't sneak in; the app
// tracks the sheet, it does not enforce 5e rules.
function validateDndSheet(sheet) {
  assert(sheet !== null && typeof sheet === 'object' && !Array.isArray(sheet), 'dnd sheet must be an object');
  const d = config.DND;
  assertNonEmptyString(sheet.class_name, 'class');
  assertString(sheet.race, 'race');
  assertIntIn(sheet.level, d.LEVEL_MIN, d.LEVEL_MAX, 'level');
  for (const ab of d.ABILITIES) {
    assertIntIn(sheet.abilities && sheet.abilities[ab], d.ABILITY_MIN, d.ABILITY_MAX, `ability ${ab}`);
  }
  assertIntIn(sheet.ac, d.AC_MIN, d.AC_MAX, 'AC');
  assertIntIn(sheet.hp_max, 1, d.HP_MAX_CAP, 'max HP');
  assertIntIn(sheet.hp, 0, sheet.hp_max, 'HP');
  assertIntIn(sheet.temp_hp, 0, d.HP_MAX_CAP, 'temp HP');
  assertIntIn(sheet.speed, 0, 200, 'speed');
  assertIntIn(sheet.prof_bonus, 0, 10, 'proficiency bonus');
  assert(typeof sheet.inspiration === 'boolean', 'inspiration must be a boolean');
  assertIntIn(sheet.death_successes, 0, 3, 'death save successes');
  assertIntIn(sheet.death_failures, 0, 3, 'death save failures');
  assert(Array.isArray(sheet.spell_slots) && sheet.spell_slots.length === d.SPELL_LEVELS,
    `spell_slots must be an array of ${d.SPELL_LEVELS} entries`);
  for (let i = 0; i < d.SPELL_LEVELS; i++) {
    const slot = sheet.spell_slots[i];
    assert(slot !== null && typeof slot === 'object', `spell slot level ${i + 1} must be an object`);
    assertIntIn(slot.max, 0, 20, `spell slot level ${i + 1} max`);
    assertIntIn(slot.used, 0, slot.max, `spell slot level ${i + 1} used`);
  }
  // skills: exactly the standard set, each {prof: 0|1|2, misc: flat extra}
  assert(sheet.skills !== null && typeof sheet.skills === 'object' && !Array.isArray(sheet.skills),
    'skills must be an object');
  const knownSkills = new Set(d.SKILLS.map((s) => s.key));
  for (const s of d.SKILLS) {
    const entry = sheet.skills[s.key];
    assert(entry !== null && typeof entry === 'object', `skill '${s.key}' is missing`);
    assertIntIn(entry.prof, 0, 2, `skill ${s.key} proficiency (0 none, 1 proficient, 2 expertise)`);
    assertIntIn(entry.misc, d.SKILL_MISC_MIN, d.SKILL_MISC_MAX, `skill ${s.key} misc bonus`);
  }
  for (const key of Object.keys(sheet.skills)) {
    assert(knownSkills.has(key), `unknown skill '${key}' (use custom_skills for tools etc.)`);
  }
  // custom skills/proficiencies (tools, instruments, languages…): freeform name + flat bonus
  assert(Array.isArray(sheet.custom_skills), 'custom_skills must be an array');
  for (const cs of sheet.custom_skills) {
    assert(cs !== null && typeof cs === 'object', 'each custom skill must be an object');
    assertNonEmptyString(cs.name, 'custom skill name');
    assertIntIn(cs.bonus, d.SKILL_MISC_MIN, d.SKILL_MISC_MAX, `custom skill '${cs.name}' bonus`);
  }
  return sheet;
}

function dndAbilityMod(score) {
  assertIntIn(score, config.DND.ABILITY_MIN, config.DND.ABILITY_MAX, 'ability score');
  return Math.floor((score - 10) / 2);
}

module.exports = {
  RuleError,
  assert,
  assertInt,
  assertIntIn,
  assertString,
  assertNonEmptyString,
  assertOneOf,
  diceForRank,
  effectiveRank,
  validateCampfireCreation,
  validateDndSheet,
  dndAbilityMod,
};
