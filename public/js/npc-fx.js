'use strict';

// Shared NPC reveal particle effects. A cheap 2D-canvas field — each effect is a
// spawn() + a per-frame step; particles recycle so the count stays flat. Used by
// the projector/player reveal (npc-reveal.js) AND the GM's preview (dm.js) so the
// ambience looks identical in both places.
//
//   const fx = CampfireNpcFx.start(canvasEl, 'embers');  // sizes to the canvas box
//   fx.stop();                                           // cancel + cleanup
//
// Effects: embers · snow · rain · motes · arcane  ('none'/'' → an inert handle).

window.CampfireNpcFx = (function () {
  function start(canvas, effect) {
    if (!effect || effect === 'none') return { stop() {} };
    const ctx = canvas.getContext('2d');
    let raf = null;
    const resize = () => {
      canvas.width = canvas.offsetWidth || canvas.clientWidth || window.innerWidth;
      canvas.height = canvas.offsetHeight || canvas.clientHeight || window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    // Track the canvas's real on-screen box. start() can be called before the
    // (full-screen) overlay has been laid out, so the first offsetWidth read can
    // come back as the default 300×150 — which paints the field into a small box
    // in the top-left. The observer re-syncs the buffer the moment layout lands.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
    }
    const W = () => canvas.width, H = () => canvas.height;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function spawn(seed) {
      const x = Math.random() * W();
      switch (effect) {
        case 'embers':
          return { x, y: seed ? Math.random() * H() : H() + 10, vx: rnd(-0.3, 0.3), vy: rnd(0.4, 1.6), r: rnd(1, 3.5), life: 1, decay: rnd(0.002, 0.006), hue: rnd(18, 45) };
        case 'snow':
          return { x, y: seed ? Math.random() * H() : -10, vx: rnd(-0.4, 0.4), vy: rnd(0.5, 1.7), r: rnd(1, 3.2), sway: Math.random() * 6.28 };
        case 'rain':
          return { x, y: seed ? Math.random() * H() : -20, vx: rnd(-0.6, -0.2), vy: rnd(5.6, 10.5), len: rnd(8, 20) };
        case 'motes':
          return { x, y: seed ? Math.random() * H() : H() + 10, vx: rnd(-0.25, 0.25), vy: rnd(0.12, 0.5), r: rnd(0.8, 2.2), sway: Math.random() * 6.28 };
        case 'arcane':
          return { x, y: seed ? Math.random() * H() : H() + 10, vx: rnd(-0.5, 0.5), vy: rnd(0.4, 1.4), r: rnd(1, 2.4), life: 1, decay: rnd(0.003, 0.008), hue: rnd(190, 320) };
        default:
          return { x, y: Math.random() * H() };
      }
    }
    const target = effect === 'rain' ? 150 : effect === 'snow' ? 120 : 80;
    let parts = [];
    for (let i = 0; i < target; i++) parts.push(spawn(true));

    function tick() {
      ctx.clearRect(0, 0, W(), H());
      for (const p of parts) {
        if (effect === 'embers') {
          p.y -= p.vy; p.x += p.vx + Math.sin(p.y / 40) * 0.3; p.life -= p.decay;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fillStyle = `hsla(${p.hue},100%,60%,${Math.max(p.life, 0) * 0.75})`; ctx.fill();
        } else if (effect === 'snow') {
          p.y += p.vy; p.x += p.vx + Math.sin((p.y + p.sway * 20) / 50) * 0.4;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
        } else if (effect === 'rain') {
          p.y += p.vy; p.x += p.vx;
          ctx.strokeStyle = 'rgba(170,200,255,0.45)'; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx, p.y + p.len); ctx.stroke();
        } else if (effect === 'motes') {
          p.y -= p.vy; p.x += p.vx + Math.sin((p.y + p.sway * 20) / 60) * 0.3;
          const tw = 0.35 + 0.6 * Math.abs(Math.sin((p.y + p.sway * 30) / 30));
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fillStyle = `rgba(225,212,170,${0.5 * tw})`; ctx.fill();
        } else if (effect === 'arcane') {
          p.y -= p.vy; p.x += p.vx + Math.sin(p.y / 35) * 0.4; p.life -= p.decay;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fillStyle = `hsla(${p.hue},90%,72%,${Math.max(p.life, 0) * 0.85})`; ctx.fill();
        }
      }
      parts = parts.filter((p) => {
        if (effect === 'rain' || effect === 'snow') return p.y < H() + 30;
        return (p.life === undefined || p.life > 0) && p.y > -25;
      });
      while (parts.length < target) parts.push(spawn(false));
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      stop() {
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        window.removeEventListener('resize', resize);
      },
    };
  }

  return { start };
})();
