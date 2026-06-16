'use strict';

// Campaign assistant client (GM port, prep-time, needs internet).
//   • Text  — POST /assist/chat with the running history; the server runs the
//             agent loop and returns the reply + a log of what it built.
//   • Voice — mint an ephemeral token at /assist/session, open a WebRTC session
//             straight to OpenAI's Realtime API, and forward its function calls
//             to /assist/tool. The real API key never reaches this browser.

const $ = (id) => document.getElementById(id);

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
  box.scrollTop = box.scrollHeight;
  return body; // so streaming text can append
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
    (data.tool_log || []).forEach((t) => logActivity(t.name, t.args, t.result));
    thinking.textContent = data.reply || '(done)';
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

function setVoiceState(label, live) {
  const pill = $('voice-state');
  pill.textContent = label;
  pill.classList.toggle('live', !!live);
}

async function startVoice() {
  $('voice-start').disabled = true;
  setVoiceState('connecting…');
  try {
    const sess = await (await fetch('/assist/session', { method: 'POST' })).json();
    if (sess.error) throw new Error(sess.error);

    pc = new RTCPeerConnection();

    // Remote audio (the assistant's voice).
    pc.ontrack = (e) => { $('assistant-audio').srcObject = e.streams[0]; };

    // Local mic.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

    // Data channel for events (transcripts + function calls).
    const dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => {
      setVoiceState('listening', true);
      // Re-assert instructions + tools in case the mint didn't carry them.
      dc.send(JSON.stringify({
        type: 'session.update',
        session: { instructions: sess.instructions, tools: sess.tools, tool_choice: 'auto' },
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
    $('transcript').scrollTop = $('transcript').scrollHeight;
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
    logActivity(ev.name, args, result);
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
