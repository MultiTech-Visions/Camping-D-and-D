'use strict';

// Projector display client (Phase 2 version): roster + visible clocks + whose
// turn, with a cheap canvas ember effect. The Phase 3 PixiJS battle map slots
// into this page later — see HANDOFF §7 for the three coordinate spaces:
//   1. image space (raw map pixels) → 2. grid space (col,row — where tokens
//   live) → 3. camera/screen space (pure view transform at render time only).

(function () {
  const turnEl = document.getElementById('d-turn');
  const clocksEl = document.getElementById('d-clocks');
  const rosterEl = document.getElementById('d-roster');

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

  CampfireWS.connect({
    role: 'display',
    onSnapshot(snap) {
      // whose turn
      const turnId = snap.initiative.turn_char_id;
      const turnChar = snap.characters.find((c) => c.id === turnId);
      turnEl.textContent = turnChar ? `▶ ${turnChar.name}'s turn` : '';

      // visible clocks, big
      clocksEl.innerHTML = '';
      for (const clock of snap.clocks) {
        clocksEl.appendChild(CampfireDice.renderClock(clock, { size: 170 }));
      }

      // roster
      rosterEl.innerHTML = '<h2 style="margin-top:0">The Party</h2>';
      const order = snap.initiative.order;
      const sorted = [...snap.characters].sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
      for (const c of sorted) {
        const dead = c.conditions.some((x) => x.kind === 'dead');
        const card = el(`<div class="card ${dead ? 'is-dead' : ''} ${c.id === turnId ? 'turn-active' : ''}"></div>`);
        card.appendChild(el(`<strong>${c.id === turnId ? '▶ ' : ''}${esc(c.name)}</strong>`));
        if (c.system === 'campfire') {
          const dice = el(`<div></div>`);
          const total = { green: 0, yellow: 0, blue: c.granted_blue };
          for (const attr of snap.config.ATTRIBUTES) {
            if (attr === 'constitution') continue;
            total.green = Math.max(total.green, c.dice[attr].green);
            total.yellow = Math.max(total.yellow, c.dice[attr].yellow);
          }
          dice.appendChild(CampfireDice.renderPool(total));
          card.appendChild(dice);
          const conDrained = c.effective.constitution < c.constitution;
          card.appendChild(el(`<div class="small ${conDrained ? '' : 'muted'}">con ${c.effective.constitution}/${c.constitution}</div>`));
        } else {
          const s = c.dnd_sheet;
          const pct = Math.round((s.hp / s.hp_max) * 100);
          card.appendChild(el(`<div class="hp-bar" style="margin-top:6px"><div class="fill" style="width:${pct}%"></div><div class="txt">${s.hp}/${s.hp_max}</div></div>`));
        }
        if (c.conditions.length > 0) {
          card.appendChild(el(`<div class="small muted">${c.conditions.map((x) => esc(x.kind)).join(' · ')}</div>`));
        }
        rosterEl.appendChild(card);
      }
    },
  });

  // --- ember particles: cheap 2D canvas, fine on a Pi 5 at 1080p -------------
  const canvas = document.getElementById('embers');
  const ctx = canvas.getContext('2d');
  let embers = [];

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  }
  addEventListener('resize', resize);
  resize();

  function spawn() {
    return {
      x: Math.random() * canvas.width,
      y: canvas.height + 10,
      vy: 0.4 + Math.random() * 1.2,
      vx: (Math.random() - 0.5) * 0.6,
      r: 1 + Math.random() * 2.5,
      life: 1,
      decay: 0.002 + Math.random() * 0.004,
      hue: 20 + Math.random() * 25,
    };
  }
  for (let i = 0; i < 40; i++) {
    const e = spawn();
    e.y = Math.random() * canvas.height;
    embers.push(e);
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const e of embers) {
      e.y -= e.vy;
      e.x += e.vx + Math.sin(e.y / 40) * 0.3;
      e.life -= e.decay;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${e.hue}, 100%, 60%, ${Math.max(e.life, 0) * 0.7})`;
      ctx.fill();
    }
    embers = embers.filter((e) => e.life > 0 && e.y > -10);
    while (embers.length < 40) embers.push(spawn());
    requestAnimationFrame(tick);
  }
  tick();
})();
