'use strict';

// Tunable constants. Everything the GM may want to adjust between trips lives here.
// Runtime-tunable values (reward rate) are seeded from here into the DB and then
// edited live from the GM screen.

module.exports = {
  PORT: 3000,
  GM_PORT: 3001,

  // --- Mushroom lamp (BLE) — the projector stand glows like a campfire when
  //     the GM toggles it on. MAC of the Magic Lantern controller (found
  //     2026-06-15, name MELK-OA21). Keep the Pi within ~1m of it. ---
  MUSHROOM_ADDRESS: 'BE:28:55:00:10:24',

  // --- Campsite WiFi hotspot (START.sh turns it on when no WiFi is around;
  //     the /status screen shows a join-QR for it) ---
  HOTSPOT: {
    SSID: 'CampfireSaga',
    PASSWORD: 'tellmeastory',
  },

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

  // --- Reveal cards: prepared NPCs, locations, and story beats share one
  //     full-screen reveal mechanism (images + toggleable text sections) ---
  CARD_KINDS: ['npc', 'location', 'story'],
  // particle effect choices for the full-screen splash background
  NPC_EFFECTS: ['none', 'embers', 'snow', 'rain', 'motes', 'arcane'],

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

  // --- Battle map (Phase 3) ---
  TOKEN_KINDS: ['pc', 'monster', 'glow', 'terrain'],
  TOKEN_DEFAULT_COLORS: { pc: '#3e8ed0', monster: '#c43c34', terrain: '#8a8a8a', glow: '#ff8c2e' },
  TOKEN_SHAPES: ['circle', 'square'],
  TOKEN_DEFAULT_SHAPES: { pc: 'circle', monster: 'circle', terrain: 'square', glow: 'circle' },
  TOKEN_MAX_SIZE: 50, // max footprint edge in cells
  CUSTOM_COLOR_LIMIT: 24,
  CAMERA_ZOOM_MIN: 0.05,
  CAMERA_ZOOM_MAX: 20,
  // Fog of war: a map's primary orientation snaps to these; fog darkness dials
  // the projector clouds from light gray (0) to pitch black (1).
  MAP_ROTATIONS: [0, 90, 180, 270],
  FOG_DARKNESS_DEFAULT: 0.85,
  MAP_MAX_BYTES: 40 * 1024 * 1024, // Pi 5 single-texture territory; tiling is post-MVP

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
    // the standard 18 skills; prof level per skill: 0 none, 1 proficient, 2 expertise
    SKILLS: [
      { key: 'acrobatics', label: 'Acrobatics', ability: 'dex' },
      { key: 'animal_handling', label: 'Animal Handling', ability: 'wis' },
      { key: 'arcana', label: 'Arcana', ability: 'int' },
      { key: 'athletics', label: 'Athletics', ability: 'str' },
      { key: 'deception', label: 'Deception', ability: 'cha' },
      { key: 'history', label: 'History', ability: 'int' },
      { key: 'insight', label: 'Insight', ability: 'wis' },
      { key: 'intimidation', label: 'Intimidation', ability: 'cha' },
      { key: 'investigation', label: 'Investigation', ability: 'int' },
      { key: 'medicine', label: 'Medicine', ability: 'wis' },
      { key: 'nature', label: 'Nature', ability: 'int' },
      { key: 'perception', label: 'Perception', ability: 'wis' },
      { key: 'performance', label: 'Performance', ability: 'cha' },
      { key: 'persuasion', label: 'Persuasion', ability: 'cha' },
      { key: 'religion', label: 'Religion', ability: 'int' },
      { key: 'sleight_of_hand', label: 'Sleight of Hand', ability: 'dex' },
      { key: 'stealth', label: 'Stealth', ability: 'dex' },
      { key: 'survival', label: 'Survival', ability: 'wis' },
    ],
    SKILL_MISC_MIN: -20,
    SKILL_MISC_MAX: 20,
  },
};
