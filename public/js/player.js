'use strict';

// Player app: character builder (Campfire Saga point-buy or D&D 5e sheet entry)
// + live tracker. The server owns all state; this file only renders snapshots
// and sends action requests.

(function () {
  const root = document.getElementById('root');
  const params = new URLSearchParams(location.search);
  let myCharId = Number(localStorage.getItem('campfire_char_id')) || null;
  let snap = null;
  let pendingSnap = null;
  let builderSystem = params.get('new'); // 'campfire' | 'dnd5e' | null

  const conn = CampfireWS.connect({
    role: 'player',
    charId: myCharId,
    onSnapshot(s) {
      snap = s;
      renderMapViewer(); // live token updates while the map viewer is open
      // Don't blow away a textarea mid-thought; re-render after the field blurs.
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type === 'text'))) {
        pendingSnap = s;
        return;
      }
      render();
    },
    onResult(msg) {
      if (msg.op === 'character.create' && msg.created_char_id) {
        myCharId = msg.created_char_id;
        localStorage.setItem('campfire_char_id', String(myCharId));
        builderSystem = null;
        history.replaceState(null, '', '/play');
        conn.setCharId(myCharId);
        conn.toast('Welcome to the saga! 🔥', true);
      }
    },
  });

  document.addEventListener('focusout', () => {
    if (pendingSnap) {
      setTimeout(() => {
        const ae = document.activeElement;
        if (pendingSnap && !(ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type === 'text')))) {
          snap = pendingSnap;
          pendingSnap = null;
          render();
        }
      }, 100);
    }
  });

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function myChar() {
    if (!myCharId || !snap) return null;
    return snap.characters.find((c) => c.id === myCharId) || null;
  }

  function render() {
    if (!snap) return;
    const me = myChar();
    if (builderSystem === 'campfire') return renderCampfireBuilder();
    if (builderSystem === 'dnd5e') return renderDndBuilder();
    if (!me) {
      root.innerHTML = '';
      root.appendChild(el(`<div class="banner">No character selected. <a href="/">Pick or create one</a>.</div>`));
      return;
    }
    me.system === 'campfire' ? renderCampfireTracker(me) : renderDndTracker(me);
  }

  // =========================================================================
  // Campfire Saga builder
  // =========================================================================
  const cfDraft = { brawn: 0, constitution: 0, magic: 0, wits: 0 };

  function renderCampfireBuilder() {
    const cfg = snap.config;
    const spent = cfg.ATTRIBUTES.reduce((s, a) => s + cfDraft[a], 0);
    const remaining = cfg.STARTING_POINTS - spent;

    root.innerHTML = '';
    root.appendChild(el(`<h2>Forge your hero</h2>`));
    const card = el(`<div class="card"></div>`);

    card.appendChild(el(`<label>Name</label>`));
    const nameIn = el(`<input type="text" id="b-name" placeholder="Tharn of the Black Pines" maxlength="40">`);
    card.appendChild(nameIn);
    card.appendChild(el(`<label>Concept — one line that says who you are</label>`));
    const conceptIn = el(`<input type="text" id="b-concept" placeholder="Runaway storm-priest with a debt to pay" maxlength="100">`);
    card.appendChild(conceptIn);

    const pts = el(`<div class="banner center" style="font-size:1.2rem">Points remaining: <strong>${remaining}</strong> of ${cfg.STARTING_POINTS} <span class="muted small">(max ${cfg.CREATION_MAX} per attribute)</span></div>`);
    card.appendChild(pts);

    for (const attr of cfg.ATTRIBUTES) {
      const row = el(`<div class="attr-row"></div>`);
      row.appendChild(el(`<span class="attr-name">${attr}</span>`));
      const stepper = el(`<span class="stepper"></span>`);
      const minus = el(`<button>−</button>`);
      const val = el(`<span class="val">${cfDraft[attr]}</span>`);
      const plus = el(`<button>+</button>`);
      minus.disabled = cfDraft[attr] <= 0;
      plus.disabled = cfDraft[attr] >= cfg.CREATION_MAX || remaining <= 0;
      minus.onclick = () => { cfDraft[attr]--; keepDraftText(); renderCampfireBuilder(); };
      plus.onclick = () => { cfDraft[attr]++; keepDraftText(); renderCampfireBuilder(); };
      stepper.append(minus, val, plus);
      row.appendChild(stepper);
      const dice = diceForRankClient(cfDraft[attr]);
      row.appendChild(CampfireDice.renderPool(dice));
      root_hint(row, attr, cfDraft[attr]);
      card.appendChild(row);
    }

    card.appendChild(el(`<label>Flavor label <span class="small">(optional, pure cosmetics — e.g. “lightning”)</span></label>`));
    const flavorIn = el(`<input type="text" id="b-flavor" maxlength="40">`);
    card.appendChild(flavorIn);
    card.appendChild(el(`<label>Hidden desire <span class="small">(optional — only the GM ever sees this)</span></label>`));
    const desireIn = el(`<input type="text" id="b-desire" maxlength="200" placeholder="I secretly want…">`);
    card.appendChild(desireIn);

    const create = el(`<button class="primary" style="width:100%;margin-top:14px;font-size:1.1rem">🔥 Join the saga</button>`);
    create.disabled = remaining !== 0;
    create.onclick = () => {
      conn.action('character.create', {
        system: 'campfire',
        name: nameIn.value.trim(),
        concept: conceptIn.value.trim(),
        brawn: cfDraft.brawn, constitution: cfDraft.constitution,
        magic: cfDraft.magic, wits: cfDraft.wits,
        flavor: flavorIn.value.trim(),
        hidden_desire: desireIn.value.trim(),
      });
    };
    card.appendChild(create);
    if (remaining !== 0) card.appendChild(el(`<p class="muted small center">Spend all ${cfg.STARTING_POINTS} points to continue.</p>`));
    root.appendChild(card);
    restoreDraftText(nameIn, conceptIn, flavorIn, desireIn);
  }

  // keep typed text across stepper re-renders
  const draftText = {};
  function keepDraftText() {
    for (const id of ['b-name', 'b-concept', 'b-flavor', 'b-desire']) {
      const n = document.getElementById(id);
      if (n) draftText[id] = n.value;
    }
  }
  function restoreDraftText(...inputs) {
    for (const n of inputs) if (draftText[n.id] !== undefined) n.value = draftText[n.id];
  }
  function root_hint(row, attr, rank) {
    if (attr === 'constitution' && rank === 0) {
      row.appendChild(el(`<span class="muted small">glass cannon — no buffer!</span>`));
    }
  }
  function diceForRankClient(rank) {
    return { green: Math.min(rank, 3), yellow: Math.max(rank - 3, 0) };
  }

  // =========================================================================
  // D&D 5e builder
  // =========================================================================
  function renderDndBuilder() {
    const cfg = snap.config.DND;
    root.innerHTML = '';
    root.appendChild(el(`<h2>🐉 New D&amp;D 5e character</h2>`));
    root.appendChild(el(`<p class="muted">Bring any character you've already built — just copy the numbers in. Works for 5e or any d20-style game.</p>`));
    const card = el(`<div class="card"></div>`);

    const f = {};
    function field(label, id, type, value, attrs = '') {
      card.appendChild(el(`<label>${label}</label>`));
      const input = el(`<input type="${type}" id="${id}" value="${value}" ${attrs}>`);
      card.appendChild(input);
      f[id] = input;
    }
    field('Name', 'd-name', 'text', '', 'maxlength="40"');
    field('Concept — one line (e.g. “grizzled dwarf bounty hunter”)', 'd-concept', 'text', '', 'maxlength="100"');
    const row1 = el(`<div class="field-row"></div>`);
    card.appendChild(row1);
    function fieldIn(parent, label, id, type, value, attrs = '') {
      const wrap = el(`<div></div>`);
      wrap.appendChild(el(`<label>${label}</label>`));
      const input = el(`<input type="${type}" id="${id}" value="${value}" ${attrs}>`);
      wrap.appendChild(input);
      parent.appendChild(wrap);
      f[id] = input;
    }
    fieldIn(row1, 'Class', 'd-class', 'text', '', 'maxlength="30" placeholder="Fighter"');
    fieldIn(row1, 'Race', 'd-race', 'text', '', 'maxlength="30" placeholder="Human"');
    fieldIn(row1, 'Level', 'd-level', 'number', 1, `min="1" max="${cfg.LEVEL_MAX}"`);

    card.appendChild(el(`<h3 style="margin-top:16px">Ability scores</h3>`));
    const grid = el(`<div class="stat-grid"></div>`);
    const ABILITY_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
    for (const ab of cfg.ABILITIES) {
      const tile = el(`<div class="stat-tile"><div class="k">${ABILITY_NAMES[ab]}</div></div>`);
      const input = el(`<input type="number" id="d-${ab}" value="10" min="${cfg.ABILITY_MIN}" max="${cfg.ABILITY_MAX}" style="text-align:center">`);
      const mod = el(`<div class="m">+0</div>`);
      input.oninput = () => { mod.textContent = CampfireDice.dndMod(Number(input.value) || 10); };
      tile.append(input, mod);
      grid.appendChild(tile);
      f[`d-${ab}`] = input;
    }
    card.appendChild(grid);

    const row2 = el(`<div class="field-row"></div>`);
    card.appendChild(row2);
    fieldIn(row2, 'Armor Class', 'd-ac', 'number', 10, 'min="0" max="40"');
    fieldIn(row2, 'Max HP', 'd-hpmax', 'number', 10, 'min="1" max="999"');
    fieldIn(row2, 'Speed', 'd-speed', 'number', 30, 'min="0" max="200"');
    fieldIn(row2, 'Prof. bonus', 'd-prof', 'number', 2, 'min="0" max="10"');

    // skills: tap to cycle proficiency; bonuses recompute live from the
    // ability and proficiency inputs above
    card.appendChild(el(`<h3 style="margin-top:16px">Skills <span class="muted small">(tap to cycle: ○ none → ● proficient → ★ expertise)</span></h3>`));
    const builderSkills = {};
    const skillGrid = el(`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:4px"></div>`);
    const skillRefreshers = [];
    for (const sk of cfg.SKILLS) {
      builderSkills[sk.key] = 0;
      const b = el(`<button class="mini ghost" style="text-align:left"></button>`);
      const refresh = () => {
        const mod = Math.floor(((Number(f[`d-${sk.ability}`].value) || 10) - 10) / 2);
        const bonus = mod + builderSkills[sk.key] * (Number(f['d-prof'].value) || 0);
        b.innerHTML = `${['○', '●', '★'][builderSkills[sk.key]]} ${sk.label}<span style="float:right;color:var(--gold)">${bonus >= 0 ? '+' : ''}${bonus}</span>`;
      };
      b.onclick = () => { builderSkills[sk.key] = (builderSkills[sk.key] + 1) % 3; refresh(); };
      skillRefreshers.push(refresh);
      refresh();
      skillGrid.appendChild(b);
    }
    card.appendChild(skillGrid);
    const refreshSkills = () => skillRefreshers.forEach((fn) => fn());
    for (const ab of cfg.ABILITIES) f[`d-${ab}`].addEventListener('input', refreshSkills);
    f['d-prof'].addEventListener('input', refreshSkills);

    field('Gear (optional)', 'd-gear', 'text', '');
    field('Secret / hook only the GM sees (optional)', 'd-desire', 'text', '', 'maxlength="200"');

    const create = el(`<button class="primary" style="width:100%;margin-top:14px;font-size:1.1rem">🐉 Join the party</button>`);
    create.onclick = () => {
      const num = (id) => Number(f[id].value);
      const sheet = {
        class_name: f['d-class'].value.trim(),
        race: f['d-race'].value.trim(),
        level: num('d-level'),
        abilities: { str: num('d-str'), dex: num('d-dex'), con: num('d-con'), int: num('d-int'), wis: num('d-wis'), cha: num('d-cha') },
        ac: num('d-ac'),
        hp_max: num('d-hpmax'),
        hp: num('d-hpmax'),
        temp_hp: 0,
        speed: num('d-speed'),
        prof_bonus: num('d-prof'),
        inspiration: false,
        death_successes: 0,
        death_failures: 0,
        spell_slots: Array.from({ length: cfg.SPELL_LEVELS }, () => ({ max: 0, used: 0 })),
        skills: Object.fromEntries(cfg.SKILLS.map((sk) => [sk.key, { prof: builderSkills[sk.key], misc: 0 }])),
        custom_skills: [],
        spells: [],
      };
      conn.action('character.create', {
        system: 'dnd5e',
        name: f['d-name'].value.trim(),
        concept: f['d-concept'].value.trim(),
        gear: f['d-gear'].value.trim(),
        hidden_desire: f['d-desire'].value.trim(),
        sheet,
      });
    };
    card.appendChild(create);
    root.appendChild(card);
  }

  // =========================================================================
  // Shared tracker pieces
  // =========================================================================
  function initiativeRibbon() {
    const entries = snap.initiative.entries;
    if (entries.length === 0) return el(`<span></span>`);
    const box = el(`<div class="card"><h3>Turn order</h3></div>`);
    const row = el(`<div class="chips"></div>`);
    for (const e of entries) {
      const c = e.char_id === null ? null : snap.characters.find((x) => x.id === e.char_id);
      const name = c ? c.name : e.label;
      const isTurn = snap.initiative.turn_id === e.id;
      row.appendChild(el(`<span class="chip ${isTurn ? 'on' : ''}">${isTurn ? '▶ ' : ''}${c ? '' : '👹 '}${esc(name)}</span>`));
    }
    box.appendChild(row);
    return box;
  }

  // My token on the battle map (Phase 3): arrows move me one cell in GRID space.
  function tokenRemote(me) {
    if (!snap.map) return el(`<span></span>`);
    const mine = snap.tokens.find((t) => t.char_id === me.id);
    const box = el(`<div class="card"><h3>🗺 Battle map</h3></div>`);
    const viewBtn = el(`<button style="width:100%;margin-bottom:8px">🔍 View the map (pinch to zoom)</button>`);
    viewBtn.onclick = openMapViewer;
    box.appendChild(viewBtn);
    if (!mine) {
      box.appendChild(el(`<p class="muted small">The GM hasn't placed your token yet.</p>`));
      return box;
    }
    box.appendChild(el(`<p class="muted small center">You're at (${mine.col}, ${mine.row})</p>`));
    const pad = el(`<div style="display:grid;grid-template-columns:repeat(3,64px);gap:6px;justify-content:center"></div>`);
    // arrows match what's on the wall: ▲ = up on the projector, even with the
    // map rotated
    const mv = (sx, sy, txt) => {
      const b = el(`<button style="font-size:1.3rem">${txt}</button>`);
      b.onclick = () => {
        const rot = snap.camera === null ? 0 : snap.camera.rotation_deg;
        const step = CampfireMap.screenStepToGrid(rot, sx, sy);
        conn.action('token.move', { token_id: mine.id, col: mine.col + step.dc, row: mine.row + step.dr });
      };
      return b;
    };
    pad.append(el(`<span></span>`), mv(0, -1, '▲'), el(`<span></span>`),
      mv(-1, 0, '◀'), el(`<span></span>`), mv(1, 0, '▶'),
      el(`<span></span>`), mv(0, 1, '▼'), el(`<span></span>`));
    box.appendChild(pad);
    return box;
  }

  function clocksSection() {
    if (snap.clocks.length === 0) return el(`<span></span>`);
    const box = el(`<div class="card"><h3>Clocks</h3></div>`);
    const row = el(`<div style="display:flex;flex-wrap:wrap;justify-content:center"></div>`);
    for (const clock of snap.clocks) {
      row.appendChild(CampfireDice.renderClock(clock, {
        onSegmentTap: (filled) => conn.action('clock.set_filled', { clock_id: clock.id, filled }),
      }));
    }
    box.appendChild(row);
    box.appendChild(el(`<p class="muted small center">Tap a segment to fill up to it; tap the last filled segment to empty it.</p>`));
    return box;
  }

  function conditionsSection(me) {
    const box = el(`<div class="card"><h3>Conditions</h3></div>`);
    if (me.conditions.length === 0) {
      box.appendChild(el(`<p class="muted small">Nothing — healthy as a horse.</p>`));
    }
    for (const c of me.conditions) {
      const row = el(`<div class="attr-row" style="padding:5px 0"></div>`);
      row.appendChild(el(`<span style="flex:1">⚑ ${esc(c.kind)}</span>`));
      const del = el(`<button class="mini danger ghost">✕</button>`);
      del.onclick = () => conn.action('condition.remove', { condition_id: c.id });
      row.appendChild(del);
      box.appendChild(row);
    }
    const add = el(`<div class="btn-row"></div>`);
    const input = el(`<input type="text" list="my-cond-suggestions" placeholder="poisoned, blessed, anything…" maxlength="60" style="max-width:220px">`);
    const btn = el(`<button class="mini">+ add</button>`);
    const doAdd = () => {
      if (!input.value.trim()) return;
      conn.action('condition.add', { char_id: me.id, kind: input.value.trim() });
      input.value = '';
    };
    btn.onclick = doAdd;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') doAdd(); };
    add.append(input, btn);
    box.appendChild(add);
    box.appendChild(el(`<datalist id="my-cond-suggestions">${snap.config.CONDITIONS[me.system].map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`));
    return box;
  }

  function notesSection(me) {
    const box = el(`<div class="card"><h3>Gear &amp; notes</h3></div>`);
    box.appendChild(el(`<label>Gear</label>`));
    const gear = el(`<textarea></textarea>`);
    gear.value = me.gear;
    box.appendChild(gear);
    box.appendChild(el(`<label>Notes</label>`));
    const notes = el(`<textarea></textarea>`);
    notes.value = me.notes;
    box.appendChild(notes);
    box.appendChild(el(`<label>Hidden desire (only you and the GM see this)</label>`));
    const desire = el(`<textarea></textarea>`);
    desire.value = me.hidden_desire === undefined ? '' : me.hidden_desire;
    box.appendChild(desire);
    const save = el(`<button class="mini">Save gear &amp; notes</button>`);
    save.onclick = () => conn.action('character.update_sheet', {
      char_id: me.id, gear: gear.value, notes: notes.value, hidden_desire: desire.value,
    });
    box.appendChild(save);
    return box;
  }

  function headerSection(me) {
    const sys = me.system === 'campfire' ? '🔥' : '🐉';
    const box = el(`<div class="card-head"><h2 style="margin-top:6px;border:none">${sys} ${esc(me.name)}</h2></div>`);
    const sub = el(`<div class="muted">${esc(me.concept)}${me.flavor ? ` · <em>${esc(me.flavor)}</em>` : ''}</div>`);
    const wrap = el(`<div></div>`);
    wrap.append(box, sub);
    return wrap;
  }

  // =========================================================================
  // Player map viewer: a read-only fullscreen look at the battle map with all
  // visible tokens — pinch to zoom, drag to pan. Pure scouting: it never
  // touches the projector camera.
  // =========================================================================
  let viewer = null; // { overlay, holder, tokenLayer, imagePath, scale, tx, ty, apply }

  function openMapViewer() {
    if (viewer || !snap.map) return;
    const overlay = el(`<div style="position:fixed;inset:0;background:#0c0906;z-index:50;overflow:hidden;touch-action:none"></div>`);
    const holder = el(`<div style="position:absolute;left:0;top:0;transform-origin:0 0"></div>`);
    const img = el(`<img draggable="false" style="display:block;width:100%;user-select:none">`);
    const tokenLayer = el(`<div></div>`);
    holder.append(img, tokenLayer);
    overlay.appendChild(holder);
    const bar = el(`<div style="position:absolute;top:10px;right:10px;display:flex;gap:8px;z-index:2"></div>`);
    const close = el(`<button>✕ close</button>`);
    close.onclick = closeMapViewer;
    bar.appendChild(close);
    overlay.appendChild(bar);
    document.body.appendChild(overlay);

    viewer = { overlay, holder, img, tokenLayer, imagePath: null, scale: 1, tx: 0, ty: 0 };
    viewer.apply = () => {
      holder.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.scale})`;
    };

    // --- pinch zoom + drag pan (pointer events; works mouse + touch) --------
    const pointers = new Map();
    let pinchStart = null; // {dist, scale, mid:{x,y}, world:{x,y}}
    const clampView = () => {
      const vw = overlay.clientWidth, vh = overlay.clientHeight;
      const cw = holder.offsetWidth * viewer.scale, ch = holder.offsetHeight * viewer.scale;
      viewer.tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, viewer.tx));
      viewer.ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, viewer.ty));
    };
    overlay.onpointerdown = (ev) => {
      overlay.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          scale: viewer.scale,
          world: { x: (mid.x - viewer.tx) / viewer.scale, y: (mid.y - viewer.ty) / viewer.scale },
        };
      }
    };
    overlay.onpointermove = (ev) => {
      const prev = pointers.get(ev.pointerId);
      if (!prev) return;
      const cur = { x: ev.clientX, y: ev.clientY };
      if (pointers.size === 2 && pinchStart) {
        pointers.set(ev.pointerId, cur);
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        viewer.scale = Math.min(10, Math.max(1, pinchStart.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist)));
        viewer.tx = mid.x - pinchStart.world.x * viewer.scale;
        viewer.ty = mid.y - pinchStart.world.y * viewer.scale;
      } else if (pointers.size === 1) {
        viewer.tx += cur.x - prev.x;
        viewer.ty += cur.y - prev.y;
        pointers.set(ev.pointerId, cur);
      }
      clampView();
      viewer.apply();
    };
    const lift = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchStart = null;
    };
    overlay.onpointerup = lift;
    overlay.onpointercancel = lift;
    // desktop nicety: mouse wheel zooms around the cursor
    overlay.onwheel = (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      const world = { x: (ev.clientX - viewer.tx) / viewer.scale, y: (ev.clientY - viewer.ty) / viewer.scale };
      viewer.scale = Math.min(10, Math.max(1, viewer.scale * factor));
      viewer.tx = ev.clientX - world.x * viewer.scale;
      viewer.ty = ev.clientY - world.y * viewer.scale;
      clampView();
      viewer.apply();
    };

    renderMapViewer();
  }

  function closeMapViewer() {
    if (!viewer) return;
    viewer.overlay.remove();
    viewer = null;
  }

  // (re)paint the viewer from the latest snapshot — called on every snapshot
  // while open, so tokens move live as the table plays
  function renderMapViewer() {
    if (!viewer) return;
    if (!snap.map) { closeMapViewer(); return; }
    const map = snap.map;
    if (viewer.imagePath !== map.image_path) {
      viewer.imagePath = map.image_path;
      viewer.img.src = map.image_path;
      // size the holder to fill the screen width at scale 1
      viewer.holder.style.width = `${viewer.overlay.clientWidth}px`;
      viewer.scale = 1;
      viewer.tx = 0;
      viewer.ty = (viewer.overlay.clientHeight - viewer.overlay.clientWidth * (map.image_h / map.image_w)) / 2;
      viewer.apply();
    }
    viewer.tokenLayer.innerHTML = '';
    for (const t of snap.tokens) {
      const color = t.kind === 'glow' ? t.glow_color : t.color;
      const left = ((map.offset_x + t.col * map.cell_size) / map.image_w) * 100;
      const top = ((map.offset_y + t.row * map.cell_size) / map.image_h) * 100;
      const wPct = ((t.w * map.cell_size) / map.image_w) * 100;
      const hPct = ((t.h * map.cell_size) / map.image_h) * 100;
      const tok = el(`<div style="position:absolute;left:${left}%;top:${top}%;width:${wPct}%;height:${hPct}%;border-radius:${t.shape === 'square' ? '12%' : '50%'};background:${color};opacity:.85;border:1px solid #000"></div>`);
      viewer.tokenLayer.appendChild(tok);
      viewer.tokenLayer.appendChild(el(`<div style="position:absolute;left:${left + wPct / 2}%;top:${top + hPct}%;transform:translateX(-50%);color:#fff;font-size:9px;text-shadow:0 1px 2px #000;white-space:nowrap">${esc(t.label)}</div>`));
    }
  }

  // =========================================================================
  // Campfire Saga tracker
  // =========================================================================
  function renderCampfireTracker(me) {
    root.innerHTML = '';
    root.appendChild(headerSection(me));

    if (me.pending_points > 0) {
      const b = el(`<div class="banner"><strong>⭐ You earned ${me.pending_points} attribute point${me.pending_points > 1 ? 's' : ''}!</strong> Place ${me.pending_points > 1 ? 'them' : 'it'} now:</div>`);
      const row = el(`<div class="btn-row"></div>`);
      for (const attr of snap.config.ATTRIBUTES) {
        const btn = el(`<button class="mini">+1 ${attr} (${me[attr]}→${me[attr] + 1})</button>`);
        btn.disabled = me[attr] >= snap.config.CEILING;
        btn.onclick = () => conn.action('character.spend_point', { char_id: me.id, attr });
        row.appendChild(btn);
      }
      b.appendChild(row);
      root.appendChild(b);
    }

    // Attributes + drain
    const attrCard = el(`<div class="card"><h3>Attributes <span class="muted small">(your dice)</span></h3></div>`);
    for (const attr of snap.config.ATTRIBUTES) {
      const eff = me.effective[attr];
      const row = el(`<div class="attr-row"></div>`);
      row.appendChild(el(`<span class="attr-name">${attr}${me.flavor && attr === 'magic' ? ` <span class="muted small">(${esc(me.flavor)})</span>` : ''}</span>`));
      row.appendChild(el(`<span class="attr-rank">${eff < me[attr] ? `<span class="drained">${eff}</span>` : eff}<span class="muted small">/${me[attr]}</span></span>`));
      row.appendChild(CampfireDice.renderPool({ ...me.dice[attr], blue: 0 }));
      const drainCtl = el(`<span class="stepper"></span>`);
      const dPlus = el(`<button class="mini" title="drain 1 (failed action)">drain −1</button>`);
      const dMinus = el(`<button class="mini ghost" title="undo drain">undo</button>`);
      dPlus.disabled = eff <= 0;
      dMinus.disabled = me.drain[attr] <= 0;
      dPlus.onclick = () => conn.action('character.set_drain', { char_id: me.id, attr, amount: me.drain[attr] + 1 });
      dMinus.onclick = () => conn.action('character.set_drain', { char_id: me.id, attr, amount: me.drain[attr] - 1 });
      drainCtl.append(dPlus, dMinus);
      row.appendChild(drainCtl);
      if (eff === 0 && me[attr] > 0) row.appendChild(el(`<span class="attr-zero">tapped out — can't act with ${attr}!</span>`));
      attrCard.appendChild(row);
    }
    const effCon = me.effective.constitution;
    const absorb = el(`<button class="primary" style="width:100%;margin-top:10px">🛡 Absorb a failure with Constitution (${effCon} left)</button>`);
    absorb.disabled = effCon <= 0;
    absorb.onclick = () => conn.action('character.absorb_with_con', { char_id: me.id });
    attrCard.appendChild(absorb);
    if (effCon === 0) attrCard.appendChild(el(`<p class="attr-zero center small">Constitution is gone — another failure and you're down for the count.</p>`));
    root.appendChild(attrCard);

    // Blue dice
    const blueCard = el(`<div class="card"><h3>Boost dice</h3></div>`);
    const pool = el(`<div class="btn-row"></div>`);
    pool.appendChild(CampfireDice.renderPool({ blue: me.granted_blue }, { large: true }));
    blueCard.appendChild(pool);
    const useBtn = el(`<button class="mini">Use a blue die</button>`);
    useBtn.disabled = me.granted_blue <= 0;
    useBtn.onclick = () => conn.action('character.grant_blue', { char_id: me.id, amount: -1 });
    const giveRow = el(`<div class="btn-row"></div>`);
    const allySel = el(`<select style="max-width:200px"></select>`);
    for (const c of snap.characters) {
      if (c.id !== me.id && c.system === 'campfire') {
        allySel.appendChild(el(`<option value="${c.id}">${esc(c.name)}</option>`));
      }
    }
    const giveBtn = el(`<button class="mini">🎁 Hand ally a blue die</button>`);
    giveBtn.disabled = allySel.children.length === 0;
    giveBtn.onclick = () => conn.action('character.grant_blue', { char_id: Number(allySel.value), amount: 1 });
    giveRow.append(useBtn, allySel, giveBtn);
    blueCard.appendChild(giveRow);
    blueCard.appendChild(el(`<p class="muted small">Spend 2 leftover advantage (or a kind GM ruling) to gain or gift a blue die.</p>`));
    root.appendChild(blueCard);

    root.appendChild(initiativeRibbon());
    root.appendChild(tokenRemote(me));
    root.appendChild(clocksSection());
    root.appendChild(conditionsSection(me));
    root.appendChild(notesSection(me));
    root.appendChild(el(`<p class="muted small center">Encounters survived: ${me.encounters_done} · next attribute point after encounter ${Math.ceil((me.encounters_done + 1) / snap.game.reward_every_n_encounters) * snap.game.reward_every_n_encounters}</p>`));
  }

  // =========================================================================
  // D&D 5e tracker
  // =========================================================================
  function renderDndTracker(me) {
    const s = me.dnd_sheet;
    root.innerHTML = '';
    root.appendChild(headerSection(me));
    root.appendChild(el(`<p class="muted">Level ${s.level} ${esc(s.race)} ${esc(s.class_name)}</p>`));

    function sendSheet(mutate) {
      const next = JSON.parse(JSON.stringify(s));
      mutate(next);
      conn.action('character.update_dnd', { char_id: me.id, sheet: next });
    }

    // HP
    const hpCard = el(`<div class="card"><h3>Hit points</h3></div>`);
    const pct = Math.round((s.hp / s.hp_max) * 100);
    hpCard.appendChild(el(`<div class="hp-bar"><div class="fill" style="width:${pct}%"></div><div class="txt">${s.hp} / ${s.hp_max}${s.temp_hp > 0 ? ` (+${s.temp_hp} temp)` : ''}</div></div>`));
    const hpRow = el(`<div class="btn-row" style="margin-top:10px"></div>`);
    const amt = el(`<input type="number" value="1" min="1" max="999" style="width:80px;text-align:center">`);
    const dmg = el(`<button class="danger">💥 Damage</button>`);
    const heal = el(`<button>💚 Heal</button>`);
    const temp = el(`<button class="mini ghost">+temp</button>`);
    dmg.onclick = () => sendSheet((n) => {
      let d = Number(amt.value);
      const fromTemp = Math.min(d, n.temp_hp);
      n.temp_hp -= fromTemp; d -= fromTemp;
      n.hp = Math.max(0, n.hp - d);
    });
    heal.onclick = () => sendSheet((n) => { n.hp = Math.min(n.hp_max, n.hp + Number(amt.value)); n.death_successes = 0; n.death_failures = 0; });
    temp.onclick = () => sendSheet((n) => { n.temp_hp += Number(amt.value); });
    hpRow.append(amt, dmg, heal, temp);
    hpCard.appendChild(hpRow);

    if (s.hp === 0) {
      hpCard.appendChild(el(`<h3 style="color:var(--danger)">☠ Death saves</h3>`));
      const dsRow = el(`<div class="btn-row"></div>`);
      const mkPips = (label, key, cls) => {
        const wrap = el(`<span>${label} <span class="pips"></span></span>`);
        const pips = wrap.querySelector('.pips');
        for (let i = 1; i <= 3; i++) {
          const pip = el(`<span class="pip ${cls} ${s[key] >= i ? 'on' : ''}"></span>`);
          pip.onclick = () => sendSheet((n) => { n[key] = n[key] >= i ? i - 1 : i; });
          pips.appendChild(pip);
        }
        return wrap;
      };
      dsRow.append(mkPips('Saves', 'death_successes', ''), mkPips('Fails', 'death_failures', 'death-fail'));
      hpCard.appendChild(dsRow);
    }
    root.appendChild(hpCard);

    // Core stats
    const statCard = el(`<div class="card"><h3>Stats</h3></div>`);
    const top = el(`<div class="stat-grid"></div>`);
    top.appendChild(el(`<div class="stat-tile"><div class="k">AC</div><div class="v">🛡 ${s.ac}</div></div>`));
    top.appendChild(el(`<div class="stat-tile"><div class="k">Speed</div><div class="v">${s.speed}</div></div>`));
    top.appendChild(el(`<div class="stat-tile"><div class="k">Prof</div><div class="v">+${s.prof_bonus}</div></div>`));
    const insp = el(`<div class="stat-tile" style="cursor:pointer"><div class="k">Inspiration</div><div class="v">${s.inspiration ? '✨' : '—'}</div></div>`);
    insp.onclick = () => sendSheet((n) => { n.inspiration = !n.inspiration; });
    top.appendChild(insp);
    statCard.appendChild(top);

    const abGrid = el(`<div class="stat-grid"></div>`);
    const ABILITY_NAMES = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
    for (const ab of snap.config.DND.ABILITIES) {
      abGrid.appendChild(el(`<div class="stat-tile"><div class="k">${ABILITY_NAMES[ab]}</div><div class="v">${s.abilities[ab]}</div><div class="m">${CampfireDice.dndMod(s.abilities[ab])}</div></div>`));
    }
    statCard.appendChild(abGrid);

    const editBtn = el(`<button class="mini ghost">✏ Edit stats</button>`);
    editBtn.onclick = () => renderDndEdit(me);
    statCard.appendChild(editBtn);
    root.appendChild(statCard);

    // Skills: tap to cycle proficiency; bonus = ability mod + prof×bonus + misc
    const skillCard = el(`<div class="card"><h3>Skills <span class="muted small">(tap: ○ none → ● proficient → ★ expertise)</span></h3></div>`);
    const skillGrid = el(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px"></div>`);
    for (const sk of snap.config.DND.SKILLS) {
      const entry = s.skills[sk.key];
      const mod = Math.floor((s.abilities[sk.ability] - 10) / 2);
      const bonus = mod + entry.prof * s.prof_bonus + entry.misc;
      const b = el(`<button class="mini ghost" style="text-align:left">${['○', '●', '★'][entry.prof]} ${sk.label}<span style="float:right;color:var(--gold)">${bonus >= 0 ? '+' : ''}${bonus}${entry.misc !== 0 ? '*' : ''}</span></button>`);
      b.title = `${sk.label} (${sk.ability.toUpperCase()})${entry.misc !== 0 ? ` — includes ${entry.misc > 0 ? '+' : ''}${entry.misc} misc` : ''}`;
      b.onclick = () => sendSheet((n) => { n.skills[sk.key].prof = (n.skills[sk.key].prof + 1) % 3; });
      skillGrid.appendChild(b);
    }
    skillCard.appendChild(skillGrid);

    // custom proficiencies: tools, instruments, languages, weird stuff
    if (s.custom_skills.length > 0) {
      skillCard.appendChild(el(`<h3 style="margin-top:10px">Other proficiencies</h3>`));
      s.custom_skills.forEach((cs, i) => {
        const row = el(`<div class="attr-row" style="padding:6px 0"></div>`);
        row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1">${esc(cs.name)} <span style="color:var(--gold)">${cs.bonus >= 0 ? '+' : ''}${cs.bonus}</span></span>`));
        const del = el(`<button class="mini danger ghost">✕</button>`);
        del.onclick = () => sendSheet((n) => { n.custom_skills.splice(i, 1); });
        row.appendChild(del);
        skillCard.appendChild(row);
      });
    }
    const addRow = el(`<div class="btn-row"></div>`);
    const csName = el(`<input type="text" placeholder="Thieves' tools, Elvish…" style="max-width:200px" maxlength="40">`);
    const csBonus = el(`<input type="number" value="0" min="-20" max="20" style="width:70px;text-align:center">`);
    const csAdd = el(`<button class="mini">+ add</button>`);
    csAdd.onclick = () => {
      if (!csName.value.trim()) return;
      const name = csName.value.trim();
      const bonus = Number(csBonus.value) || 0;
      sendSheet((n) => { n.custom_skills.push({ name, bonus }); });
      csName.value = '';
    };
    addRow.append(csName, csBonus, csAdd);
    skillCard.appendChild(addRow);
    skillCard.appendChild(el(`<p class="muted small">* includes a misc bonus — set those in ✏ Edit stats.</p>`));
    root.appendChild(skillCard);

    // Spellbook: name + level is all a spell needs; the optional note line is
    // the player's own cheat sheet; cast consumes a matching slot
    const spellBook = el(`<div class="card"><h3>📜 Spellbook</h3></div>`);
    if (s.spells.length > 0) {
      const sorted = s.spells.map((sp, idx) => ({ sp, idx }))
        .sort((a, b) => a.sp.level - b.sp.level || a.sp.name.localeCompare(b.sp.name));
      let lastLevel = -1;
      for (const { sp, idx } of sorted) {
        if (sp.level !== lastLevel) {
          lastLevel = sp.level;
          spellBook.appendChild(el(`<div class="muted small" style="margin-top:8px;text-transform:uppercase;letter-spacing:.08em">${sp.level === 0 ? 'Cantrips' : `Level ${sp.level}`}</div>`));
        }
        const row = el(`<div class="attr-row" style="padding:6px 0;${sp.level > 0 && !sp.prepared ? 'opacity:.45' : ''}"></div>`);
        const main = el(`<span class="attr-name" style="width:auto;flex:1"></span>`);
        if (sp.level > 0) {
          const prep = el(`<button class="mini ghost" title="${sp.prepared ? 'prepared — tap to unprepare' : 'not prepared — tap to prepare'}" style="min-width:36px">${sp.prepared ? '●' : '○'}</button>`);
          prep.onclick = () => sendSheet((n) => { n.spells[idx].prepared = !n.spells[idx].prepared; });
          main.appendChild(prep);
        } else {
          main.appendChild(el(`<span class="muted" style="display:inline-block;min-width:36px;text-align:center">◆</span>`));
        }
        main.appendChild(el(`<span> ${esc(sp.name)}${sp.concentration ? ' <span title="concentration" style="color:var(--gold)">Ⓒ</span>' : ''}</span>`));
        if (sp.note) main.appendChild(el(`<div class="muted small" style="margin-left:42px">${esc(sp.note)}</div>`));
        row.appendChild(main);
        if (sp.level > 0) {
          const slot = s.spell_slots[sp.level - 1];
          const cast = el(`<button class="mini">⚡ cast</button>`);
          cast.disabled = !sp.prepared || slot.used >= slot.max;
          cast.title = slot.max === 0
            ? `no level ${sp.level} slots — set them in ✏ Edit stats`
            : `${slot.max - slot.used} of ${slot.max} level-${sp.level} slots left (to upcast, tap a higher slot pip below)`;
          cast.onclick = () => {
            sendSheet((n) => { n.spell_slots[sp.level - 1].used += 1; });
            conn.toast(`${sp.name} cast — level ${sp.level} slot used ⚡`, true);
          };
          row.appendChild(cast);
        } else {
          row.appendChild(el(`<span class="muted small">at will</span>`));
        }
        const del = el(`<button class="mini danger ghost">✕</button>`);
        del.onclick = () => sendSheet((n) => { n.spells.splice(idx, 1); });
        row.appendChild(del);
        spellBook.appendChild(row);
      }
    }
    const spAdd = el(`<div class="btn-row" style="margin-top:10px"></div>`);
    const spName = el(`<input type="text" placeholder="Fireball" style="max-width:150px" maxlength="60">`);
    const spLevel = el(`<select style="max-width:110px"><option value="0">cantrip</option>${Array.from({ length: 9 }, (_, i) => `<option value="${i + 1}">level ${i + 1}</option>`).join('')}</select>`);
    const spConc = el(`<label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="checkbox" style="width:auto"> Ⓒ</label>`);
    const spNote = el(`<input type="text" placeholder="cheat note: 8d6 fire, 150ft, DEX half (optional)" maxlength="200" style="max-width:280px">`);
    const spBtn = el(`<button class="mini">+ add</button>`);
    spBtn.onclick = () => {
      if (!spName.value.trim()) return;
      const spell = {
        name: spName.value.trim(),
        level: Number(spLevel.value),
        prepared: true,
        concentration: spConc.querySelector('input').checked,
        note: spNote.value.trim(),
      };
      sendSheet((n) => { n.spells.push(spell); });
      spName.value = '';
      spNote.value = '';
      spConc.querySelector('input').checked = false;
    };
    spAdd.append(spName, spLevel, spConc, spNote, spBtn);
    spellBook.appendChild(spAdd);
    if (s.spells.length === 0) spellBook.appendChild(el(`<p class="muted small">Just a name and a level is enough — the note is your optional one-line cheat sheet.</p>`));
    root.appendChild(spellBook);

    // Spell slots
    const hasSlots = s.spell_slots.some((x) => x.max > 0);
    const slotCard = el(`<div class="card"><h3>Spell slots</h3></div>`);
    if (hasSlots) {
      for (let lvl = 0; lvl < s.spell_slots.length; lvl++) {
        const slot = s.spell_slots[lvl];
        if (slot.max === 0) continue;
        const row = el(`<div class="attr-row"><span class="attr-name">Level ${lvl + 1}</span></div>`);
        const pips = el(`<span class="pips"></span>`);
        for (let i = 1; i <= slot.max; i++) {
          const pip = el(`<span class="pip ${i <= slot.used ? 'on' : ''}"></span>`);
          pip.onclick = () => sendSheet((n) => { n.spell_slots[lvl].used = n.spell_slots[lvl].used >= i ? i - 1 : i; });
          pips.appendChild(pip);
        }
        row.appendChild(pips);
        slotCard.appendChild(row);
      }
      const rest = el(`<button class="mini">🌙 Long rest (full HP + slots)</button>`);
      rest.onclick = () => sendSheet((n) => {
        n.hp = n.hp_max; n.temp_hp = 0; n.death_successes = 0; n.death_failures = 0;
        for (const slot of n.spell_slots) slot.used = 0;
      });
      slotCard.appendChild(rest);
    } else {
      slotCard.appendChild(el(`<p class="muted small">No spell slots configured — tap “Edit stats” to add them.</p>`));
    }
    root.appendChild(slotCard);

    root.appendChild(initiativeRibbon());
    root.appendChild(tokenRemote(me));
    root.appendChild(clocksSection());
    root.appendChild(conditionsSection(me));
    root.appendChild(notesSection(me));
  }

  function renderDndEdit(me) {
    const s = me.dnd_sheet;
    root.innerHTML = '';
    root.appendChild(el(`<h2>✏ Edit ${esc(me.name)}</h2>`));
    const card = el(`<div class="card"></div>`);
    const f = {};
    function fieldIn(parent, label, id, value, min, max) {
      const wrap = el(`<div></div>`);
      wrap.appendChild(el(`<label>${label}</label>`));
      const input = el(`<input type="number" id="${id}" value="${value}" min="${min}" max="${max}">`);
      wrap.appendChild(input);
      parent.appendChild(wrap);
      f[id] = input;
    }
    const r1 = el(`<div class="field-row"></div>`);
    fieldIn(r1, 'Level', 'e-level', s.level, 1, 20);
    fieldIn(r1, 'AC', 'e-ac', s.ac, 0, 40);
    fieldIn(r1, 'Max HP', 'e-hpmax', s.hp_max, 1, 999);
    fieldIn(r1, 'Prof', 'e-prof', s.prof_bonus, 0, 10);
    card.appendChild(r1);
    const r2 = el(`<div class="field-row"></div>`);
    fieldIn(r2, 'Speed', 'e-speed', s.speed, 0, 200);
    card.appendChild(r2);
    card.appendChild(el(`<h3>Abilities</h3>`));
    const grid = el(`<div class="stat-grid"></div>`);
    for (const ab of snap.config.DND.ABILITIES) {
      const tile = el(`<div class="stat-tile"><div class="k">${ab.toUpperCase()}</div></div>`);
      const input = el(`<input type="number" id="e-${ab}" value="${s.abilities[ab]}" min="1" max="30" style="text-align:center">`);
      tile.appendChild(input);
      grid.appendChild(tile);
      f[`e-${ab}`] = input;
    }
    card.appendChild(grid);
    card.appendChild(el(`<h3>Spell slots per level (max)</h3>`));
    const slotGrid = el(`<div class="stat-grid"></div>`);
    for (let lvl = 0; lvl < s.spell_slots.length; lvl++) {
      const tile = el(`<div class="stat-tile"><div class="k">Lv ${lvl + 1}</div></div>`);
      const input = el(`<input type="number" id="e-slot-${lvl}" value="${s.spell_slots[lvl].max}" min="0" max="20" style="text-align:center">`);
      tile.appendChild(input);
      slotGrid.appendChild(tile);
      f[`e-slot-${lvl}`] = input;
    }
    card.appendChild(slotGrid);

    card.appendChild(el(`<h3>Skill misc bonuses <span class="muted small">(flat extras from feats/items — proficiency is tapped on the sheet)</span></h3>`));
    const miscGrid = el(`<div class="stat-grid"></div>`);
    for (const sk of snap.config.DND.SKILLS) {
      const tile = el(`<div class="stat-tile"><div class="k" style="font-size:0.6rem">${sk.label}</div></div>`);
      const input = el(`<input type="number" id="e-misc-${sk.key}" value="${s.skills[sk.key].misc}" min="-20" max="20" style="text-align:center">`);
      tile.appendChild(input);
      miscGrid.appendChild(tile);
      f[`e-misc-${sk.key}`] = input;
    }
    card.appendChild(miscGrid);

    const row = el(`<div class="btn-row"></div>`);
    const save = el(`<button class="primary">Save</button>`);
    save.onclick = () => {
      const num = (id) => Number(f[id].value);
      const next = JSON.parse(JSON.stringify(s));
      next.level = num('e-level'); next.ac = num('e-ac'); next.prof_bonus = num('e-prof'); next.speed = num('e-speed');
      next.hp_max = num('e-hpmax');
      next.hp = Math.min(next.hp, next.hp_max);
      for (const ab of snap.config.DND.ABILITIES) next.abilities[ab] = num(`e-${ab}`);
      for (let lvl = 0; lvl < next.spell_slots.length; lvl++) {
        next.spell_slots[lvl].max = num(`e-slot-${lvl}`);
        next.spell_slots[lvl].used = Math.min(next.spell_slots[lvl].used, next.spell_slots[lvl].max);
      }
      for (const sk of snap.config.DND.SKILLS) {
        next.skills[sk.key].misc = num(`e-misc-${sk.key}`);
      }
      conn.action('character.update_dnd', { char_id: me.id, sheet: next });
      render();
    };
    const cancel = el(`<button class="ghost">Cancel</button>`);
    cancel.onclick = () => render();
    row.append(save, cancel);
    card.appendChild(row);
    root.appendChild(card);
  }
})();
