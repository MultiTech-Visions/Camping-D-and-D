'use strict';

// GM dashboard: every character (including hidden desires), drain/condition/blue
// controls, encounter refill + live reward rate, initiative board, clock manager.

(function () {
  const root = document.getElementById('root');
  let snap = null;

  const conn = CampfireWS.connect({
    role: 'dm',
    onSnapshot(s) {
      snap = s;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.dataset.live !== '1') return queueRender(s);
      render();
    },
  });

  let pendingSnap = null;
  function queueRender(s) { pendingSnap = s; }
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pendingSnap) { snap = pendingSnap; pendingSnap = null; render(); }
    }, 120);
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

  function render() {
    if (!snap) return;
    root.innerHTML = '';
    root.appendChild(encounterBar());
    root.appendChild(initiativeBoard());
    root.appendChild(clocksManager());
    root.appendChild(el(`<h2>The party</h2>`));
    const grid = el(`<div class="card-grid"></div>`);
    for (const c of snap.characters) grid.appendChild(charCard(c));
    if (snap.characters.length === 0) grid.appendChild(el(`<p class="muted">No characters yet — players join at the site address and forge heroes.</p>`));
    root.appendChild(grid);
  }

  // --- encounter / settings bar ---------------------------------------------
  function encounterBar() {
    const box = el(`<div class="banner"></div>`);
    const row = el(`<div class="btn-row"></div>`);
    const refill = el(`<button class="primary">🌅 End encounter — refill everyone</button>`);
    refill.onclick = () => {
      if (confirm('End the encounter? All drain refills, blue dice clear, and progression ticks.')) {
        conn.action('character.end_encounter_refill', {});
      }
    };
    row.appendChild(refill);
    const rateWrap = el(`<span style="display:inline-flex;align-items:center;gap:6px">⭐ +1 point every
      <input type="number" data-live="1" min="1" max="99" value="${snap.game.reward_every_n_encounters}" style="width:64px;text-align:center"> encounters</span>`);
    const rateIn = rateWrap.querySelector('input');
    rateIn.onchange = () => conn.action('game.set_reward_rate', { reward_every_n_encounters: Number(rateIn.value) });
    row.appendChild(rateWrap);
    box.appendChild(row);
    return box;
  }

  // --- initiative board ------------------------------------------------------
  function initiativeBoard() {
    const box = el(`<div class="card"><h3>⚔ Initiative</h3></div>`);
    const order = snap.initiative.order;

    if (order.length === 0) {
      box.appendChild(el(`<p class="muted small">No one in the order yet — add characters below.</p>`));
    }
    for (let i = 0; i < order.length; i++) {
      const c = snap.characters.find((x) => x.id === order[i]);
      if (!c) continue;
      const isTurn = snap.initiative.turn_char_id === c.id;
      const row = el(`<div class="attr-row ${isTurn ? 'turn-active' : ''}"></div>`);
      row.appendChild(el(`<span class="attr-name" style="width:auto;flex:1">${isTurn ? '▶ ' : ''}${esc(c.name)}</span>`));
      const ctl = el(`<span class="btn-row" style="margin:0"></span>`);
      const up = el(`<button class="mini" title="move up">↑</button>`);
      const down = el(`<button class="mini" title="move down">↓</button>`);
      const turn = el(`<button class="mini ${isTurn ? 'primary' : ''}">turn</button>`);
      const out = el(`<button class="mini ghost" title="remove from initiative">✕</button>`);
      up.disabled = i === 0;
      down.disabled = i === order.length - 1;
      up.onclick = () => reorder(i, i - 1);
      down.onclick = () => reorder(i, i + 1);
      turn.onclick = () => conn.action('initiative.set_turn', { char_id: c.id });
      out.onclick = () => conn.action('initiative.remove', { char_id: c.id });
      ctl.append(up, down, turn, out);
      row.appendChild(ctl);
      box.appendChild(row);
    }

    const foot = el(`<div class="btn-row"></div>`);
    if (order.length > 0) {
      const next = el(`<button>⏭ Next turn</button>`);
      next.onclick = () => {
        const cur = snap.initiative.turn_char_id;
        const idx = cur === null ? -1 : order.indexOf(cur);
        conn.action('initiative.set_turn', { char_id: order[(idx + 1) % order.length] });
      };
      foot.appendChild(next);
    }
    const addSel = el(`<select style="max-width:180px"></select>`);
    for (const c of snap.characters) {
      if (!order.includes(c.id)) addSel.appendChild(el(`<option value="${c.id}">${esc(c.name)}</option>`));
    }
    if (addSel.children.length > 0) {
      const addBtn = el(`<button class="mini">+ add</button>`);
      addBtn.onclick = () => conn.action('initiative.add', { char_id: Number(addSel.value) });
      foot.append(addSel, addBtn);
    }
    box.appendChild(foot);
    return box;

    function reorder(from, to) {
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      conn.action('initiative.reorder', { ordered_char_ids: next });
    }
  }

  // --- clocks manager ---------------------------------------------------------
  function clocksManager() {
    const box = el(`<div class="card"><h3>🕗 Clocks</h3></div>`);
    const row = el(`<div style="display:flex;flex-wrap:wrap"></div>`);
    for (const clock of snap.clocks) {
      const cell = el(`<div style="text-align:center"></div>`);
      cell.appendChild(CampfireDice.renderClock(clock, {
        onSegmentTap: (filled) => conn.action('clock.set_filled', { clock_id: clock.id, filled }),
      }));
      const ctl = el(`<div class="btn-row" style="justify-content:center"></div>`);
      const vis = el(`<button class="mini ${clock.visibility === 'dm_only' ? '' : 'ghost'}">${clock.visibility === 'dm_only' ? '👁 reveal' : '🙈 hide'}</button>`);
      vis.onclick = () => conn.action('clock.set_visibility', {
        clock_id: clock.id,
        visibility: clock.visibility === 'dm_only' ? 'visible' : 'dm_only',
      });
      const del = el(`<button class="mini danger">✕</button>`);
      del.onclick = () => { if (confirm(`Delete clock “${clock.label}”?`)) conn.action('clock.delete', { clock_id: clock.id }); };
      ctl.append(vis, del);
      cell.appendChild(ctl);
      row.appendChild(cell);
    }
    box.appendChild(row);

    const form = el(`<div class="btn-row"></div>`);
    const label = el(`<input type="text" placeholder="Collapse the bridge" style="max-width:200px" maxlength="60">`);
    const segs = el(`<select style="max-width:80px">${snap.config.CLOCK_SEGMENT_CHOICES.map((n) => `<option ${n === 6 ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
    const kind = el(`<select style="max-width:120px"><option value="progress">progress</option><option value="danger">danger</option></select>`);
    const vis = el(`<select style="max-width:110px"><option value="visible">visible</option><option value="dm_only">secret</option></select>`);
    const add = el(`<button class="mini primary">+ clock</button>`);
    add.onclick = () => {
      conn.action('clock.create', { label: label.value.trim(), segments: Number(segs.value), kind: kind.value, visibility: vis.value });
      label.value = '';
    };
    form.append(label, segs, kind, vis, add);
    box.appendChild(form);
    return box;
  }

  // --- character cards ---------------------------------------------------------
  function charCard(c) {
    const dead = c.conditions.some((x) => x.kind === 'dead');
    const isTurn = snap.initiative.turn_char_id === c.id;
    const card = el(`<div class="card ${dead ? 'is-dead' : ''} ${isTurn ? 'turn-active' : ''}"></div>`);
    const sys = c.system === 'campfire' ? '🔥' : '🐉';
    card.appendChild(el(`<div class="card-head"><h3>${sys} ${esc(c.name)}</h3><span class="muted small">${esc(c.concept)}</span></div>`));
    if (c.hidden_desire) {
      card.appendChild(el(`<p class="small" style="color:var(--gold)">🤫 ${esc(c.hidden_desire)}</p>`));
    }

    if (c.system === 'campfire') {
      for (const attr of snap.config.ATTRIBUTES) {
        const eff = c.effective[attr];
        const row = el(`<div class="attr-row"></div>`);
        row.appendChild(el(`<span class="attr-name small">${attr}</span>`));
        row.appendChild(el(`<span class="attr-rank">${eff < c[attr] ? `<span class="drained">${eff}</span>` : eff}<span class="muted small">/${c[attr]}</span></span>`));
        const dr = el(`<span class="btn-row" style="margin:0"></span>`);
        const dPlus = el(`<button class="mini" title="drain">−</button>`);
        const dMinus = el(`<button class="mini ghost" title="undo drain">+</button>`);
        dPlus.disabled = eff <= 0;
        dMinus.disabled = c.drain[attr] <= 0;
        dPlus.onclick = () => conn.action('character.set_drain', { char_id: c.id, attr, amount: c.drain[attr] + 1 });
        dMinus.onclick = () => conn.action('character.set_drain', { char_id: c.id, attr, amount: c.drain[attr] - 1 });
        dr.append(dPlus, dMinus);
        row.appendChild(dr);
        attachPool(row, c.dice[attr]);
        card.appendChild(row);
      }
      const ctl = el(`<div class="btn-row"></div>`);
      const absorb = el(`<button class="mini">🛡 Con absorb</button>`);
      absorb.disabled = c.effective.constitution <= 0;
      absorb.onclick = () => conn.action('character.absorb_with_con', { char_id: c.id });
      const blueMinus = el(`<button class="mini ghost">−🔷</button>`);
      blueMinus.disabled = c.granted_blue <= 0;
      blueMinus.onclick = () => conn.action('character.grant_blue', { char_id: c.id, amount: -1 });
      const bluePlus = el(`<button class="mini">+🔷 blue (${c.granted_blue})</button>`);
      bluePlus.onclick = () => conn.action('character.grant_blue', { char_id: c.id, amount: 1 });
      const refillOne = el(`<button class="mini ghost" title="refill just this character">refill</button>`);
      refillOne.onclick = () => conn.action('character.end_encounter_refill', { char_id: c.id });
      ctl.append(absorb, bluePlus, blueMinus, refillOne);
      card.appendChild(ctl);
      card.appendChild(el(`<p class="muted small">encounters: ${c.encounters_done}${c.pending_points > 0 ? ` · <strong style="color:var(--gold)">⭐ ${c.pending_points} point(s) to place</strong>` : ''}</p>`));
    } else {
      const s = c.dnd_sheet;
      const pct = Math.round((s.hp / s.hp_max) * 100);
      card.appendChild(el(`<p class="muted small">Lv ${s.level} ${esc(s.race)} ${esc(s.class_name)} · AC ${s.ac} · spd ${s.speed}</p>`));
      card.appendChild(el(`<div class="hp-bar"><div class="fill" style="width:${pct}%"></div><div class="txt">${s.hp}/${s.hp_max}${s.temp_hp > 0 ? ` +${s.temp_hp}t` : ''}</div></div>`));
      const ctl = el(`<div class="btn-row" style="margin-top:8px"></div>`);
      const amt = el(`<input type="number" data-live="1" value="1" min="1" max="999" style="width:64px;text-align:center">`);
      const dmg = el(`<button class="mini danger">💥</button>`);
      const heal = el(`<button class="mini">💚</button>`);
      const send = (mutate) => {
        const next = JSON.parse(JSON.stringify(s));
        mutate(next);
        conn.action('character.update_dnd', { char_id: c.id, sheet: next });
      };
      dmg.onclick = () => send((n) => {
        let d = Number(amt.value);
        const fromTemp = Math.min(d, n.temp_hp);
        n.temp_hp -= fromTemp; d -= fromTemp;
        n.hp = Math.max(0, n.hp - d);
      });
      heal.onclick = () => send((n) => { n.hp = Math.min(n.hp_max, n.hp + Number(amt.value)); });
      ctl.append(amt, dmg, heal);
      card.appendChild(ctl);
    }

    // conditions
    const chips = el(`<div class="chips"></div>`);
    for (const kind of snap.config.CONDITIONS[c.system]) {
      const existing = c.conditions.find((x) => x.kind === kind);
      const chip = el(`<span class="chip ${existing ? 'on' : ''} ${kind === 'dead' ? 'chip-dead' : ''}">${kind}</span>`);
      chip.onclick = () => {
        existing
          ? conn.action('condition.remove', { condition_id: existing.id })
          : conn.action('condition.add', { char_id: c.id, kind });
      };
      chips.appendChild(chip);
    }
    card.appendChild(chips);

    const foot = el(`<div class="btn-row"></div>`);
    if (!snap.initiative.order.includes(c.id)) {
      const init = el(`<button class="mini ghost">+ initiative</button>`);
      init.onclick = () => conn.action('initiative.add', { char_id: c.id });
      foot.appendChild(init);
    }
    const del = el(`<button class="mini danger ghost">delete</button>`);
    del.onclick = () => {
      if (confirm(`Permanently delete ${c.name}? This cannot be undone.`)) {
        conn.action('character.delete', { char_id: c.id });
      }
    };
    foot.appendChild(del);
    card.appendChild(foot);
    return card;
  }

  function attachPool(row, dice) {
    row.appendChild(CampfireDice.renderPool(dice));
  }
})();
