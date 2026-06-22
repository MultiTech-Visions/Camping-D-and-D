'use strict';

// Campaign assistant client (GM port, prep-time, needs internet).
//   • Text  — POST /assist/chat with the running history; the server runs the
//             agent loop and returns the reply + a log of what it built.
//   • Voice — mint an ephemeral token at /assist/session, open a WebRTC session
//             straight to OpenAI's Realtime API, and forward its function calls
//             to /assist/tool. The real API key never reaches this browser.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- auto-scroll controllers ------------------------------------------------
// Each scrollable log gets a controller: it follows new content while pinned to
// the bottom, but the moment the GM scrolls up to read something it stops
// chasing — so the text holds still. Scrolling back to the bottom (or tapping
// the toggle) re-arms it. The toggle button shows the current state.
const scrollers = {};
function makeAutoScroll(boxId, btnId) {
  const box = $(boxId);
  const btn = $(btnId);
  let auto = true;
  const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  function reflect() {
    btn.classList.toggle('on', auto);
    btn.textContent = auto ? '⤓ Auto-scroll: on' : '⏸ Auto-scroll: off';
  }
  // A programmatic scroll-to-bottom fires 'scroll' too; guard against it
  // flipping our own state.
  let selfScrolling = false;
  box.addEventListener('scroll', () => {
    if (selfScrolling) return;
    const ab = atBottom();
    if (ab !== auto) { auto = ab; reflect(); }
  });
  btn.addEventListener('click', () => {
    auto = !auto;
    if (auto) { selfScrolling = true; box.scrollTop = box.scrollHeight; selfScrolling = false; }
    reflect();
  });
  reflect();
  const ctl = {
    follow() { if (auto) { selfScrolling = true; box.scrollTop = box.scrollHeight; selfScrolling = false; } },
  };
  scrollers[boxId] = ctl;
  return ctl;
}
function follow(boxId) { if (scrollers[boxId]) scrollers[boxId].follow(); }

// --- shared activity log ----------------------------------------------------
function logActivity(name, args, result) {
  const box = $('activity');
  if (box.querySelector('.muted')) box.innerHTML = '';
  const row = document.createElement('div');
  const isErr = result && result.error;
  row.className = 'row' + (isErr ? ' err' : '');
  const detail = isErr ? result.error
    : (result && (result.created_card_id ? `card #${result.created_card_id}`
      : result.image_path ? 'image' : 'done'));
  row.innerHTML = `<b>${name}</b> — ${detail || ''}`;
  if (result && result.image_path) {
    const img = document.createElement('img');
    img.src = result.image_path;
    row.appendChild(img);
  }
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function bubble(boxId, who, text, cls) {
  const box = $(boxId);
  if (box.querySelector('.muted')) box.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || '');
  div.innerHTML = `<span class="who">${who}</span>`;
  const body = document.createElement('span');
  body.textContent = text;
  div.appendChild(body);
  box.appendChild(div);
  follow(boxId);
  return body; // so streaming text can append
}

// --- inline activity cards (shown in the conversation as tools fire) ---------
// The model often works in silence (creating cards, generating art), so we narrate
// each tool call right in the transcript: a friendly title + a human summary of
// the arguments, never raw JSON. activityStart() drops a "working…" card the moment
// a call begins; activityResolve() updates it to a ✓ / image / error when it lands.
function describeTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'get_overview': return { icon: '👀', title: 'Reviewing the campaign so far' };
    case 'get_card': return { icon: '🔎', title: `Reading card #${a.card_id}` };
    case 'create_card': return { icon: '🎴', title: `Creating ${a.kind || ''} card`.trim(), detail: a.name ? `“${a.name}”` : '' };
    case 'delete_card': return { icon: '🗑', title: `Deleting card #${a.card_id}` };
    case 'generate_image': return { icon: '🎨', title: 'Generating image', detail: a.prompt ? `“${a.prompt}”` : '' };
    case 'update_card': {
      const parts = [];
      if (a.name !== undefined) parts.push('name');
      if (a.subtitle !== undefined) parts.push('subtitle');
      if (a.notes !== undefined) parts.push('GM notes');
      if (a.bg_effect) parts.push(`effect “${a.bg_effect}”`);
      if (Array.isArray(a.images)) parts.push(`${a.images.length} image${a.images.length === 1 ? '' : 's'}`);
      if (Array.isArray(a.sections)) {
        const entries = a.sections.reduce((n, s) => n + ((s && s.entries && s.entries.length) || 0), 0);
        parts.push(`${a.sections.length} section${a.sections.length === 1 ? '' : 's'}` +
          (entries ? ` / ${entries} entr${entries === 1 ? 'y' : 'ies'}` : ''));
      }
      return { icon: '✏️', title: `Filling in card #${a.card_id}`, detail: parts.length ? parts.join(', ') : '' };
    }
    default: return { icon: '•', title: name };
  }
}

function activityStart(boxId, name, args) {
  const box = $(boxId);
  if (box.querySelector('.muted')) box.innerHTML = '';
  const d = describeTool(name, args);
  const card = document.createElement('div');
  card.className = 'act-card working';
  card.innerHTML =
    `<span class="act-ico">${d.icon}</span>` +
    `<div class="act-body">` +
    `<div class="act-title">${esc(d.title)}</div>` +
    (d.detail ? `<div class="act-detail">${esc(d.detail)}</div>` : '') +
    `<div class="act-status"><span class="act-spin"></span>working<span class="dots"></span></div>` +
    `</div>`;
  // Image generation is the slow one — show a shimmering placeholder where the
  // picture will land, so it's obvious something is still cooking.
  if (name === 'generate_image') {
    const sk = document.createElement('div');
    sk.className = 'act-skeleton';
    card.querySelector('.act-body').appendChild(sk);
  }
  box.appendChild(card);
  follow(boxId);
  return { boxId, card };
}

function activityResolve(handle, name, args, result) {
  if (!handle) return;
  const { boxId, card } = handle;
  card.classList.remove('working'); // stops the spinner/dots
  const sk = card.querySelector('.act-skeleton');
  if (sk) sk.remove();
  const status = card.querySelector('.act-status');
  if (result && result.error) {
    card.classList.add('err');
    status.textContent = `couldn't: ${result.error}`;
  } else {
    card.classList.add('done');
    if (result && result.image_path) {
      status.textContent = 'done';
      const img = document.createElement('img');
      img.src = result.image_path;
      card.querySelector('.act-body').appendChild(img);
    } else if (result && result.created_card_id) {
      status.textContent = `created card #${result.created_card_id}`;
    } else {
      status.textContent = 'done';
    }
  }
  follow(boxId);
}

function showError(msg) {
  const note = $('key-note');
  note.style.display = '';
  note.textContent = msg;
}

// --- text chat --------------------------------------------------------------
const history = []; // [{role:'user'|'assistant', content}]

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  $('chat-send').disabled = true;
  bubble('chat-log', 'You', text, 'user');
  history.push({ role: 'user', content: text });
  const thinking = bubble('chat-log', 'Assistant', '…');
  try {
    const res = await fetch('/assist/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Drop the "…" placeholder, lay down a card per tool the agent ran, then the
    // reply — so the chat reads: you → what it built → its answer.
    thinking.parentElement.remove();
    (data.tool_log || []).forEach((tl) => {
      activityResolve(activityStart('chat-log', tl.name, tl.args), tl.name, tl.args, tl.result);
      logActivity(tl.name, tl.args, tl.result); // also keep the session summary box
    });
    bubble('chat-log', 'Assistant', data.reply || '(done)');
    history.push({ role: 'assistant', content: data.reply || '' });
  } catch (err) {
    thinking.textContent = `⚠ ${err.message}`;
    showError(`Text assistant error: ${err.message}`);
  } finally {
    $('chat-send').disabled = false;
    input.focus();
  }
});

// --- voice (WebRTC realtime) ------------------------------------------------
let pc = null;
let micStream = null;
let dc = null; // the open data channel, so settings changes can live-update it

function setVoiceState(label, live) {
  const pill = $('voice-state');
  pill.textContent = label;
  pill.classList.toggle('live', !!live);
}

async function startVoice() {
  $('voice-start').disabled = true;
  setVoiceState('connecting…');
  try {
    if (!settings) await initSettings(); // make sure the GM's voice settings are loaded
    const sess = await (await fetch('/assist/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    })).json();
    if (sess.error) throw new Error(sess.error);
    if (sess.settings) { settings = { ...settings, ...sess.settings }; reflectSettings(); } // adopt clamped values

    pc = new RTCPeerConnection();

    // Remote audio (the assistant's voice).
    pc.ontrack = (e) => { $('assistant-audio').srcObject = e.streams[0]; };

    // Local mic.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

    // Data channel for events (transcripts + function calls).
    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => {
      setVoiceState('listening', true);
      // Re-assert instructions + tools + the GM's voice settings in case the mint
      // didn't carry them. The GA Realtime API requires session.type on every
      // session.update (the beta interface didn't); without it the server rejects
      // the event with "Missing required parameter: 'session.type'". Voice is set
      // here (before any audio) since it can't be changed once the model has
      // spoken; speed/turn-taking can be changed live afterward.
      dc.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: sess.instructions, tools: sess.tools, tool_choice: 'auto',
          audio: {
            output: { voice: settings.voice, speed: settings.speed },
            input: { turn_detection: { type: 'server_vad', silence_duration_ms: settings.silence_ms } },
          },
        },
      }));
    });
    dc.addEventListener('message', (e) => handleRealtimeEvent(dc, JSON.parse(e.data)));

    // SDP offer/answer with OpenAI, authorized by the ephemeral token.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(sess.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${sess.client_secret}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) throw new Error(`realtime connect failed: ${await sdpRes.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    $('voice-stop').disabled = false;
  } catch (err) {
    setVoiceState('error');
    showError(`Voice error: ${err.message}`);
    stopVoice();
    $('voice-start').disabled = false;
  }
}

function stopVoice() {
  if (pc) { pc.close(); pc = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  dc = null;
  setVoiceState('off');
  $('voice-start').disabled = false;
  $('voice-stop').disabled = true;
}

// Accumulators for streamed transcript text, keyed by item/response id.
const liveText = {};

async function handleRealtimeEvent(dc, ev) {
  const t = ev.type || '';

  // Assistant speech transcript (event names have varied across versions).
  if (t.endsWith('output_audio_transcript.delta') || t === 'response.audio_transcript.delta') {
    const key = ev.response_id || ev.item_id || 'a';
    if (!liveText[key]) liveText[key] = bubble('transcript', 'Assistant', '');
    liveText[key].textContent += ev.delta || '';
    follow('transcript');
    return;
  }
  if (t.endsWith('output_audio_transcript.done') || t === 'response.audio_transcript.done') {
    delete liveText[ev.response_id || ev.item_id || 'a'];
    return;
  }
  // What the GM said (input transcription).
  if (t === 'conversation.item.input_audio_transcription.completed') {
    if (ev.transcript) bubble('transcript', 'You', ev.transcript, 'user');
    return;
  }

  // Function/tool call requested by the model → run it on the Pi, feed result back.
  if (t === 'response.function_call_arguments.done') {
    let args = {};
    try { args = JSON.parse(ev.arguments || '{}'); } catch { /* leave empty */ }
    // Narrate it in the transcript NOW so the GM sees work happening during the
    // model's silence, then resolve the same card with the outcome.
    const handle = activityStart('transcript', ev.name, args);
    let result;
    try {
      const r = await fetch('/assist/tool', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ev.name, arguments: args }),
      });
      result = (await r.json()).result;
    } catch (err) {
      result = { error: err.message };
    }
    activityResolve(handle, ev.name, args, result);
    logActivity(ev.name, args, result); // also keep the session summary box
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) },
    }));
    dc.send(JSON.stringify({ type: 'response.create' }));
    return;
  }

  if (t === 'error') {
    showError(`Realtime error: ${(ev.error && ev.error.message) || JSON.stringify(ev)}`);
  }
}

$('voice-start').addEventListener('click', startVoice);
$('voice-stop').addEventListener('click', stopVoice);

// --- voice settings (voice / speed / creativity / reply-wait) ---------------
// Options + ranges + defaults come from GET /assist/config (one source of truth);
// the GM's picks persist in localStorage and ride along when a session is minted.
// Speed, creativity and reply-wait can be nudged live mid-call via session.update;
// the voice itself only takes effect on the next "Start talking" (the realtime API
// won't change voice once the model has produced audio).
const SETTINGS_KEY = 'assist.voiceSettings';
let voiceCfg = null; // { voices, ranges, defaults }
let settings = null; // current effective settings

// NB: temperature is intentionally absent — the GA realtime API removed it.
const RANGE_FIELDS = [
  { key: 'speed', id: 'set-speed', fmt: (v) => v.toFixed(2) + '×' },
  { key: 'silence_ms', id: 'set-silence', fmt: (v) => (v / 1000).toFixed(2) + 's' },
];

function readStored() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } }
function saveStored() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ } }

// Push the current settings object back onto the controls (after load or clamping).
function reflectSettings() {
  if (!settings) return;
  $('set-voice').value = settings.voice;
  for (const f of RANGE_FIELDS) {
    $(f.id).value = settings[f.key];
    $(f.id + '-val').textContent = f.fmt(Number(settings[f.key]));
  }
}

// Nudge an in-progress call when a live-updatable setting changes (not voice).
function liveUpdateSettings() {
  if (!dc || dc.readyState !== 'open' || !settings) return;
  dc.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      audio: {
        output: { speed: settings.speed },
        input: { turn_detection: { type: 'server_vad', silence_duration_ms: settings.silence_ms } },
      },
    },
  }));
}

async function initSettings() {
  if (voiceCfg) return; // once
  try {
    voiceCfg = await (await fetch('/assist/config')).json();
  } catch {
    voiceCfg = {
      voices: ['marin', 'cedar', 'alloy'],
      ranges: { speed: { min: 0.25, max: 1.5, step: 0.05 }, silence_ms: { min: 200, max: 1500, step: 50 } },
      defaults: { voice: 'marin', speed: 1.0, silence_ms: 500 },
    };
  }
  settings = { ...voiceCfg.defaults, ...readStored() };
  if (!voiceCfg.voices.includes(settings.voice)) settings.voice = voiceCfg.defaults.voice;

  $('set-voice').innerHTML = voiceCfg.voices.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  for (const f of RANGE_FIELDS) {
    const r = voiceCfg.ranges[f.key];
    const el = $(f.id);
    el.min = r.min; el.max = r.max; el.step = r.step;
  }
  reflectSettings();

  $('set-voice').addEventListener('change', () => {
    settings.voice = $('set-voice').value;
    saveStored(); // voice applies on the next Start talking
  });
  for (const f of RANGE_FIELDS) {
    $(f.id).addEventListener('input', () => {
      settings[f.key] = Number($(f.id).value);
      $(f.id + '-val').textContent = f.fmt(settings[f.key]);
      saveStored();
      liveUpdateSettings();
    });
  }
}

// --- page init --------------------------------------------------------------
makeAutoScroll('transcript', 'transcript-autoscroll');
makeAutoScroll('chat-log', 'chat-log-autoscroll');
initSettings();

// --- prep-pack import -------------------------------------------------------
// Stream the newline-delimited JSON from /assist/import and show each card and
// each queued image as it lands. The same cards/images appear live on /dm.
function importRow(text, cls) {
  const box = $('import-log');
  if (box.querySelector('.muted')) box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'row' + (cls ? ' ' + cls : '');
  row.textContent = text;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  return row;
}

function handleImportEvent(ev) {
  if (ev.stage === 'game') {
    importRow(ev.action === 'created' ? `🆕 Created campaign "${ev.name}" — now live.` : `🎲 Switched to this campaign — now live.`);
  } else if (ev.stage === 'card') importRow(`📇 Creating card: ${ev.name}`);
  else if (ev.stage === 'image') importRow(`🎨 Generating image — ${ev.prompt.slice(0, 80)}…`);
  else if (ev.stage === 'image_done') {
    const r = importRow('   ✓ image ready');
    const img = document.createElement('img'); img.src = ev.image_path; r.appendChild(img);
  } else if (ev.stage === 'image_error') importRow(`   ⚠ image failed: ${ev.error}`, 'err');
  else if (ev.stage === 'card_done') importRow(`   ✓ card #${ev.id} done`);
  else if (ev.done) {
    const s = ev.summary || {};
    importRow(`✅ Imported ${s.cards_created} card(s), ${s.images_made} image(s)` +
      (s.image_errors && s.image_errors.length ? `, ${s.image_errors.length} image(s) failed` : '') +
      (ev.game_name ? ` into "${ev.game_name}".` : '.'));
    loadGames(); // a brand-new campaign may have just been created
  } else if (ev.error) importRow(`⚠ ${ev.error}`, 'err');
}

// Campaign ("Games") target picker. Populate the dropdown with every game (the
// active one preselected, so "add to the current campaign" is the default) plus
// a "New campaign…" choice that reveals a name field.
const NEW_GAME = '__new__';
async function loadGames() {
  try {
    const { games, active_game } = await (await fetch('/assist/games')).json();
    const sel = $('import-game');
    sel.innerHTML = '';
    for (const g of games) {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name + (g.id === active_game ? ' (current)' : '');
      sel.appendChild(o);
    }
    const newOpt = document.createElement('option');
    newOpt.value = NEW_GAME; newOpt.textContent = '＋ New campaign…';
    sel.appendChild(newOpt);
    sel.value = active_game || (games[0] && games[0].id) || NEW_GAME;
    reflectGamePick();
  } catch { /* offline / no server — leave the picker empty, import still works */ }
}
function reflectGamePick() {
  $('import-new-name').style.display = $('import-game').value === NEW_GAME ? '' : 'none';
}
// Returns the chosen destination for the import, or throws if a new campaign was
// asked for without a name.
function importTarget() {
  const id = $('import-game').value;
  if (id === NEW_GAME) {
    const name = $('import-new-name').value.trim();
    if (!name) throw new Error('name the new campaign first');
    return { mode: 'new', name };
  }
  if (!id) return null; // picker never loaded — import into whatever's active
  return { mode: 'existing', id };
}
$('import-game').addEventListener('change', reflectGamePick);

async function runImport(file) {
  $('import-pick').disabled = true;
  importRow(`Reading ${file.name}…`);
  let res;
  try {
    const target = importTarget();
    const text = await file.text();
    const pack = JSON.parse(text); // fail fast on a non-JSON file before hitting the server
    res = await fetch('/assist/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack, target }),
    });
  } catch (err) {
    importRow(`⚠ ${err.message}`, 'err');
    $('import-pick').disabled = false;
    return;
  }
  // Consume the NDJSON stream line by line.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) try { handleImportEvent(JSON.parse(line)); } catch { /* skip partial */ }
      }
    }
    if (buf.trim()) try { handleImportEvent(JSON.parse(buf.trim())); } catch { /* ignore */ }
  } catch (err) {
    importRow(`⚠ import interrupted: ${err.message}`, 'err');
  } finally {
    $('import-pick').disabled = false;
  }
}

$('import-pick').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  if (e.target.files[0]) runImport(e.target.files[0]);
  e.target.value = '';
});

loadGames();
