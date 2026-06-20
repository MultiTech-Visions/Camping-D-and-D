'use strict';

// Campaign AI assistant — a PREP-TIME, GM-side authoring layer (needs internet,
// so it's used at home before a trip; the campsite Pi runs offline as ever).
//
// It is purely additive: it drives the SAME state.ops the GM screen drives, so
// everything it makes is a normal card / character / clock that shows up live on
// /dm and /display. Nothing about field play or the data model changes.
//
// Two front-ends, ONE tool executor (executeTool below):
//   • voice  — the browser opens a WebRTC session straight to OpenAI's Realtime
//              API using an ephemeral token we mint here (the real key never
//              leaves the Pi). Function calls come back over the data channel and
//              the browser POSTs them to /assist/tool.
//   • text   — /assist/chat runs the agent loop server-side (Chat Completions +
//              tools), executing tools inline.
//
// FAIL LOUD: tools call ops that throw on bad input; we hand the thrown message
// back to the model as a tool error so it self-corrects, and never paper over it.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const R = require('./rules');
const { state, ops } = require('./state');

const DATA_DIR = process.env.CAMPFIRE_DATA_DIR || path.join(__dirname, 'data');
const TOKENS_DIR = path.join(__dirname, 'public', 'assets', 'tokens');

// --- secret -----------------------------------------------------------------
// Read at request time, NOT at boot: the app must start and run offline with no
// key. Throw a clear, expected error only when the assistant is actually used.
function getApiKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    return process.env.OPENAI_API_KEY.trim();
  }
  const keyFile = path.join(DATA_DIR, 'openai.key');
  if (fs.existsSync(keyFile)) {
    const k = fs.readFileSync(keyFile, 'utf8').trim();
    if (k) return k;
  }
  throw Object.assign(
    new Error('No OpenAI API key found. Set OPENAI_API_KEY in the environment, or put the key in data/openai.key, then restart.'),
    { expected: true, status: 503 });
}

async function openai(pathname, body) {
  const res = await fetch(`https://api.openai.com${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const reason = (json && json.error && json.error.message) || text || `HTTP ${res.status}`;
    throw Object.assign(new Error(`OpenAI ${pathname} failed: ${reason}`), { expected: true, status: 502 });
  }
  return json;
}

// --- system prompt ----------------------------------------------------------
// Teaches the model what it can build and how the data is shaped. Kept in sync
// with the card/character/clock ops it actually drives.
const SYSTEM_PROMPT = `You are the Campfire Saga campaign assistant — a creative partner helping a game master (GM) flesh out a tabletop RPG campaign BEFORE a trip, while there is still internet. Everything you create is saved into the GM's app and will be available offline at the campsite.

The app supports two systems: "campfire" (a homebrew narrative-dice game with four attributes — brawn, constitution, magic, wits, each rank 0..5) and "dnd5e" (standard D&D 5e character sheets). It is system-agnostic for the story content below.

You can author campaign content as CARDS — the heart of campaign prep. A card is a full-screen "reveal" with a portrait/slideshow and toggleable text. Three kinds:
   • "npc" — a monster or character; its first image doubles as a battle-map token.
   • "location" — a place the party arrives at.
   • "story" — a narrated beat, handout, or scene.
   A card has: name, subtitle (short, <=120 chars), notes (GM-only, never shown to players), bg_effect (one of: none, embers, snow, rain, motes, arcane), an images[] slideshow, and sections[]. Each section = { title, visible, entries:[ { label, text, visible, images } ] }. Sections/entries are how a scene unfolds: the GM toggles entries on/off live during play, so author plenty of them. Keep entry text vivid but tight (a paragraph or two).

IMAGES: To add art, call generate_image with a rich visual prompt; it returns an image_path. Then put that path into a card's images[] array, a section/entry's images[], or bg_image, or a character's token_art via the update tools. Always generate a portrait for NPCs and a scene image for locations unless told otherwise.

WORKFLOW: First call get_overview to see what already exists so you build on it and avoid duplicates. Propose a quick plan out loud, then create_card to make the shell, generate images, and update_card to fill in subtitle/notes/sections/images in one rich update. Work in small confirmable steps when the GM is steering; batch confidently when they say "just do it". Ask before deleting or overwriting substantial existing content. Be concise and evocative — you are helping tell a story.`;

// Spoken-only addendum for the realtime (voice) session. Tools like card and
// image creation take a noticeable beat, during which the model would otherwise
// fall silent — so we follow OpenAI's realtime "preamble" guidance and have it
// announce the work out loud before it starts. (The text chat doesn't get this:
// it has no voice, and the on-screen activity cards already narrate it.)
const PREAMBLE_GUIDANCE = `# Preambles
Give a short spoken preamble right before you call a tool that takes a noticeable moment — creating or updating a card, generating an image, or making several changes in a row — so the GM always hears that work is underway and is never left in silence.
- Keep it to one short, natural sentence (two at most before a large or destructive action). Describe the action, not your reasoning, and skip filler.
- Vary the wording across turns. For example: "I'll sketch that NPC now." / "Let me draft the location card." / "Generating the portrait — one moment." / "I'll add those scenes to the card."
- When you fire several tools back to back, say one brief line up front (e.g. "I'll build that out now — the card first, then the art.") and give the occasional progress update rather than narrating every single call.
- Don't preamble when you can simply answer right away, when the GM is only confirming/correcting/declining, or when the audio is unclear or silent.
- After the tools finish, briefly confirm what you made before moving on.`;

// What the realtime session is actually instructed with: the shared system prompt
// plus the spoken preamble rules above.
const REALTIME_INSTRUCTIONS = `${SYSTEM_PROMPT}\n\n${PREAMBLE_GUIDANCE}`;

// --- tool definitions (one source → both Chat and Realtime shapes) ----------
// Each: { name, description, parameters(JSON Schema) }.
const TOOL_DEFS = [
  {
    name: 'get_overview',
    description: 'List the cards currently in the campaign so you can build on them and avoid duplicates. Call this first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_card',
    description: 'Get the full content of one card (its sections, entries, images) so you can edit it precisely.',
    parameters: {
      type: 'object',
      properties: { card_id: { type: 'integer' } },
      required: ['card_id'], additionalProperties: false,
    },
  },
  {
    name: 'create_card',
    description: 'Create an empty card shell, then fill it with update_card. Returns the new card_id.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: config.CARD_KINDS },
        name: { type: 'string' },
      },
      required: ['kind', 'name'], additionalProperties: false,
    },
  },
  {
    name: 'update_card',
    description: 'Fill in or edit a card. Only the fields you pass are changed. images/sections REPLACE what was there, so include everything you want kept. Image paths must come from generate_image.',
    parameters: {
      type: 'object',
      properties: {
        card_id: { type: 'integer' },
        name: { type: 'string' },
        subtitle: { type: 'string' },
        notes: { type: 'string', description: 'GM-only notes; never shown to players.' },
        bg_effect: { type: 'string', enum: config.NPC_EFFECTS },
        bg_image: { type: 'string', description: 'A generate_image path, or "" to clear.' },
        images: {
          type: 'array', description: 'Slideshow image paths from generate_image.',
          items: { type: 'string' },
        },
        sections: {
          type: 'array',
          description: 'Replaces the card body. Each section reveals as a chapter the GM toggles live.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              visible: { type: 'boolean' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    text: { type: 'string' },
                    visible: { type: 'boolean' },
                    images: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['text'], additionalProperties: false,
                },
              },
            },
            required: ['entries'], additionalProperties: false,
          },
        },
        token_w: { type: 'integer', description: 'NPC map-token width in cells.' },
        token_h: { type: 'integer', description: 'NPC map-token height in cells.' },
      },
      required: ['card_id'], additionalProperties: false,
    },
  },
  {
    name: 'delete_card',
    description: 'Delete a card. Destructive — confirm with the GM first.',
    parameters: {
      type: 'object',
      properties: { card_id: { type: 'integer' } },
      required: ['card_id'], additionalProperties: false,
    },
  },
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt and save it. Returns { image_path } to use in cards/characters. Write a rich, specific visual prompt (style, lighting, mood, composition).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] },
      },
      required: ['prompt'], additionalProperties: false,
    },
  },
];

// --- realtime voice settings ------------------------------------------------
// The GM tweaks these in "Voice settings" on /assist. Ranges mirror the GA
// Realtime API bounds; the client builds its sliders from SETTING_RANGES (served
// by GET /assist/config) and we re-clamp here so a hand-crafted request can't
// push an out-of-range value at OpenAI.
const SETTING_RANGES = {
  speed: { min: 0.25, max: 1.5, step: 0.05 },        // audio.output.speed
  temperature: { min: 0.6, max: 1.2, step: 0.05 },   // realtime temperature bounds
  silence_ms: { min: 200, max: 1500, step: 50 },     // turn_detection.silence_duration_ms
};

function clamp(n, fallback, { min, max }) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function defaultSettings() {
  return {
    voice: config.ASSISTANT.REALTIME_VOICE,
    speed: config.ASSISTANT.REALTIME_SPEED,
    temperature: config.ASSISTANT.REALTIME_TEMPERATURE,
    silence_ms: config.ASSISTANT.REALTIME_SILENCE_MS,
  };
}

function sanitizeSettings(raw) {
  const d = defaultSettings();
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    voice: config.ASSISTANT.REALTIME_VOICES.includes(s.voice) ? s.voice : d.voice,
    speed: clamp(s.speed, d.speed, SETTING_RANGES.speed),
    temperature: clamp(s.temperature, d.temperature, SETTING_RANGES.temperature),
    silence_ms: Math.round(clamp(s.silence_ms, d.silence_ms, SETTING_RANGES.silence_ms)),
  };
}

// Build the GA Realtime session config from sanitized settings. Shared field
// shape with the client's live session.update so both stay in sync.
function realtimeSession(settings) {
  return {
    type: 'realtime',
    model: config.ASSISTANT.REALTIME_MODEL,
    instructions: REALTIME_INSTRUCTIONS,
    audio: {
      output: { voice: settings.voice, speed: settings.speed },
      input: { turn_detection: { type: 'server_vad', silence_duration_ms: settings.silence_ms } },
    },
    temperature: settings.temperature,
    tools: TOOL_DEFS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    tool_choice: 'auto',
  };
}

// --- image generation -------------------------------------------------------
async function generateImage(prompt, size) {
  const json = await openai('/v1/images/generations', {
    model: config.ASSISTANT.IMAGE_MODEL,
    prompt,
    size: size || config.ASSISTANT.IMAGE_SIZE,
    n: 1,
  });
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw Object.assign(new Error('image API returned no image data'), { expected: true, status: 502 });
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
  const name = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  fs.writeFileSync(path.join(TOKENS_DIR, name), Buffer.from(b64, 'base64'));
  return `/assets/tokens/${name}`;
}

// --- prep-pack import (the "upload at home" path) ---------------------------
// A friend/co-GM builds a campaign offline in public/builder.html and exports a
// "prep pack" JSON (cards + sections + scenes + text-only IMAGE REQUESTS). Here,
// at home with internet, we turn it into real cards and run every image request
// through generateImage — the image queue. onProgress streams a line per step so
// the browser can show the queue working; one bad image is reported and skipped
// rather than sinking the whole import.
async function importPack(pack, { broadcast, onProgress }) {
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  if (!pack || typeof pack !== 'object' || pack.format !== 'campfire-saga-pack') {
    throw Object.assign(new Error('not a Campfire Saga prep pack (missing format marker)'), { expected: true, status: 400 });
  }
  const cards = Array.isArray(pack.cards) ? pack.cards : [];
  R.assert(cards.length > 0, 'this prep pack has no cards in it');

  // Pre-flight: validate every card's kind + name BEFORE creating anything or
  // spending money on images, so a trivial typo can't leave a half-built import.
  cards.forEach((c, i) => {
    R.assertOneOf(c && c.kind, config.CARD_KINDS, `cards[${i}].kind`);
    R.assertNonEmptyString(c && c.name, `cards[${i}].name`);
  });

  const summary = { cards_created: 0, images_made: 0, image_errors: [] };

  // Generate every prompt in a request list, in order, returning the asset
  // paths that succeeded. Failures are logged into the summary and skipped.
  async function runRequests(list, where) {
    const out = [];
    for (const req of (Array.isArray(list) ? list : [])) {
      const prompt = req && typeof req.prompt === 'string' ? req.prompt.trim() : '';
      if (!prompt) continue;
      emit({ stage: 'image', where, prompt });
      try {
        const image_path = await generateImage(prompt, req.size);
        out.push(image_path);
        summary.images_made++;
        emit({ stage: 'image_done', where, image_path });
      } catch (err) {
        summary.image_errors.push({ where, prompt, error: err.message });
        emit({ stage: 'image_error', where, prompt, error: err.message });
      }
    }
    return out;
  }

  for (const card of cards) {
    const kind = card && card.kind;
    const name = card && card.name;
    emit({ stage: 'card', name: name || '(unnamed)', kind });
    const { created_card_id: id } = ops['card.create']({ kind, name });
    broadcast();

    const cardImages = await runRequests(card.image_requests, `card "${name}"`);

    const sections = [];
    for (const s of (Array.isArray(card.sections) ? card.sections : [])) {
      const secImages = await runRequests(s && s.image_requests, `chapter in "${name}"`);
      const entries = [];
      for (const e of (Array.isArray(s && s.entries) ? s.entries : [])) {
        const entryImages = await runRequests(e && e.image_requests, `scene in "${name}"`);
        entries.push({
          label: (e && e.label) || '',
          text: (e && e.text) || '',
          // reveal_live (default true) means the GM unveils it during play, so it
          // starts hidden on the projector. visible is the inverse.
          visible: e && e.reveal_live === false ? true : false,
          images: entryImages,
        });
      }
      sections.push({ title: (s && s.title) || '', images: secImages, entries });
    }

    const update = { card_id: id, sections };
    if (card.subtitle !== undefined) update.subtitle = String(card.subtitle);
    if (card.notes !== undefined) update.notes = String(card.notes);
    if (card.bg_effect && config.NPC_EFFECTS.includes(card.bg_effect)) update.bg_effect = card.bg_effect;
    if (cardImages.length) update.images = cardImages;
    if (kind === 'npc') {
      if (Number.isInteger(card.token_w)) update.token_w = card.token_w;
      if (Number.isInteger(card.token_h)) update.token_h = card.token_h;
    }
    ops['card.update'](update);
    broadcast();
    summary.cards_created++;
    emit({ stage: 'card_done', id, name: name || '(unnamed)' });
  }

  return summary;
}

// --- the one tool executor (shared by voice + text) -------------------------
// Returns a plain object the model receives as the tool result. Mutating tools
// broadcast a fresh snapshot so any open /dm or /display updates live.
async function executeTool(name, args, broadcast) {
  const a = args || {};
  switch (name) {
    case 'get_overview':
      return {
        cards: [...state.cards.values()].map((c) => ({ id: c.id, kind: c.kind, name: c.name, subtitle: c.subtitle })),
      };

    case 'get_card': {
      const c = state.cards.get(a.card_id);
      if (!c) throw Object.assign(new Error(`no card ${a.card_id}`), { expected: true });
      return c;
    }

    case 'create_card': {
      const r = ops['card.create']({ kind: a.kind, name: a.name });
      broadcast();
      return r; // { created_card_id }
    }

    case 'update_card': {
      const p = { card_id: a.card_id };
      for (const k of ['name', 'subtitle', 'notes', 'bg_effect', 'bg_image', 'images', 'sections', 'token_w', 'token_h']) {
        if (a[k] !== undefined) p[k] = a[k];
      }
      ops['card.update'](p);
      broadcast();
      return { ok: true, card_id: a.card_id };
    }

    case 'delete_card':
      ops['card.delete']({ card_id: a.card_id });
      broadcast();
      return { ok: true };

    case 'generate_image': {
      const image_path = await generateImage(a.prompt, a.size);
      return { image_path };
    }

    default:
      throw Object.assign(new Error(`unknown tool '${name}'`), { expected: true });
  }
}

// --- HTTP wiring ------------------------------------------------------------
function mount(app, { broadcast, log }) {
  const express = require('express');
  const json = express.json({ limit: '2mb' });

  // Voice-settings metadata so the client can build its controls from the one
  // authoritative source (the option list + ranges + current defaults).
  app.get('/assist/config', (req, res) => {
    res.json({
      voices: config.ASSISTANT.REALTIME_VOICES,
      ranges: SETTING_RANGES,
      defaults: defaultSettings(),
    });
  });

  // Mint a short-lived ephemeral token for the browser's WebRTC Realtime session.
  // The real key never reaches the browser. Tools + instructions + the GM's voice
  // settings are baked into the session here; the client also re-asserts them on
  // connect (belt + braces) and can live-update speed/temperature/turn-taking.
  app.post('/assist/session', json, async (req, res) => {
    try {
      const settings = sanitizeSettings(req.body && req.body.settings);
      const data = await openai('/v1/realtime/client_secrets', { session: realtimeSession(settings) });
      // GA returns { value, expires_at, ... }; older shape nests client_secret.
      const value = data.value || (data.client_secret && data.client_secret.value);
      if (!value) throw Object.assign(new Error('session mint returned no client secret'), { expected: true, status: 502 });
      res.json({
        client_secret: value,
        expires_at: data.expires_at || (data.client_secret && data.client_secret.expires_at) || null,
        model: config.ASSISTANT.REALTIME_MODEL,
        instructions: REALTIME_INSTRUCTIONS,
        tools: TOOL_DEFS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
        settings, // the clamped values actually used, so the UI can reflect them
      });
    } catch (err) {
      log(`assist/session error: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Execute one tool call (the voice front-end posts here from the data channel).
  app.post('/assist/tool', json, async (req, res) => {
    const { name, arguments: args } = req.body || {};
    try {
      const result = await executeTool(name, args, broadcast);
      log(`assist tool ${name} ok`);
      res.json({ result });
    } catch (err) {
      // Hand the error back as a tool RESULT (200) so the model can self-correct.
      log(`assist tool ${name} rejected: ${err.message}`);
      res.json({ result: { error: err.message } });
    }
  });

  // Import a prep pack built offline in builder.html. Streams newline-delimited
  // JSON progress (one line per card/image) so the browser can show the image
  // queue working live, then a final {done,summary} line. Errors mid-stream are
  // sent as a {error} line rather than an HTTP status, since the body is already
  // flowing by then.
  app.post('/assist/import', express.json({ limit: '8mb' }), async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (o) => { res.write(JSON.stringify(o) + '\n'); };
    try {
      const summary = await importPack(req.body, { broadcast, onProgress: send });
      log(`assist/import ok: ${summary.cards_created} cards, ${summary.images_made} images, ${summary.image_errors.length} image errors`);
      send({ done: true, summary });
    } catch (err) {
      log(`assist/import error: ${err.message}`);
      send({ error: err.message });
    }
    res.end();
  });

  // Text-chat agent loop: run Chat Completions with tools, executing inline.
  // The client sends the running [{role,content}] history; we prepend the system
  // prompt and return the final reply plus a log of what was built.
  app.post('/assist/chat', json, async (req, res) => {
    try {
      const history = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
      const tools = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const toolLog = [];

      for (let turn = 0; turn < config.ASSISTANT.MAX_TOOL_TURNS; turn++) {
        const data = await openai('/v1/chat/completions', {
          model: config.ASSISTANT.TEXT_MODEL, messages, tools, tool_choice: 'auto',
        });
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) throw Object.assign(new Error('chat API returned no message'), { expected: true, status: 502 });
        messages.push(msg);

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          return res.json({ reply: msg.content || '', tool_log: toolLog });
        }

        for (const call of msg.tool_calls) {
          let parsed = {};
          try { parsed = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty */ }
          let result;
          try {
            result = await executeTool(call.function.name, parsed, broadcast);
          } catch (err) {
            result = { error: err.message };
          }
          toolLog.push({ name: call.function.name, args: parsed, result });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      res.json({ reply: '(Reached the tool-step limit for one turn — ask me to continue.)', tool_log: toolLog });
    } catch (err) {
      log(`assist/chat error: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = { mount, executeTool, importPack, TOOL_DEFS, SYSTEM_PROMPT };
