'use strict';

// Tunable constants. Everything the GM may want to adjust between trips lives here.
// Runtime-tunable values (reward rate) are seeded from here into the DB and then
// edited live from the GM screen.

module.exports = {
  PORT: 3000,

  // --- Campfire Saga character creation ---
  STARTING_POINTS: 4, // points distributed across the four attributes at creation
  CREATION_MAX: 2,    // no attribute may exceed this at creation
  CEILING: 5,         // absolute attribute maximum, ever

  // --- Progression ---
  REWARD_EVERY_N_ENCOUNTERS_DEFAULT: 3, // GM-editable live from the dashboard

  // --- Campfire Saga attributes (order matters for display) ---
  ATTRIBUTES: ['brawn', 'constitution', 'magic', 'wits'],

  // --- Game systems a character can belong to ---
  SYSTEMS: ['campfire', 'dnd5e'],

  // --- Built-in condition sets, per system (custom conditions are post-MVP) ---
  CONDITIONS: {
    campfire: ['dead', 'poisoned', 'prone', 'stunned', 'blessed', 'frightened', 'burning', 'entangled', 'inspired', 'hidden'],
    dnd5e: ['dead', 'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
      'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion', 'concentrating'],
  },

  // --- Clocks ---
  CLOCK_SEGMENT_CHOICES: [4, 6, 8, 10, 12],
  CLOCK_KINDS: ['progress', 'danger'],
  CLOCK_VISIBILITIES: ['visible', 'dm_only'],

  // --- D&D 5e sheet bounds (sanity rails, not rules enforcement) ---
  DND: {
    ABILITIES: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
    ABILITY_MIN: 1,
    ABILITY_MAX: 30,
    LEVEL_MIN: 1,
    LEVEL_MAX: 20,
    HP_MAX_CAP: 999,
    AC_MIN: 0,
    AC_MAX: 40,
    SPELL_LEVELS: 9,
  },
};
