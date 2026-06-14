'use strict';

// Shared fullscreen map viewer: pinch to zoom, drag to pan, mouse-wheel zoom.
// Read-only — it never touches the projector camera. Used by the player's
// scouting view and the GM's token mover (which docks a control pad below).

window.CampfireMapViewer = (function () {
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // open({ bottomEl?, onClose?, onZoomChange?, fog? })
  //   -> { update(snap, {highlight?}), close(), setTapMode(fn), setZoom(s), getZoom() }
  // fog defaults on (players scout through fog of war); the GM's token mover
  // passes fog:false so the omniscient GM sees the whole board while placing.
  function open({ bottomEl, onClose, onZoomChange, fog = true } = {}) {
    const overlay = el(`<div style="position:fixed;inset:0;background:#0c0906;z-index:60;display:flex;flex-direction:column"></div>`);
    const viewport = el(`<div style="flex:1;position:relative;overflow:hidden;touch-action:none"></div>`);
    const holder = el(`<div style="position:absolute;left:0;top:0;transform-origin:0 0"></div>`);
    const img = el(`<img draggable="false" style="display:block;width:100%;user-select:none">`);
    // fog canvas rides the holder transform, so the fog pans/zooms with the map
    const fogCanvas = el(`<canvas style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></canvas>`);
    const tokenLayer = el(`<div></div>`);
    holder.append(img, fogCanvas, tokenLayer);
    viewport.appendChild(holder);
    const closeBtn = el(`<button style="position:absolute;top:10px;right:10px;z-index:2">✕ close</button>`);
    viewport.appendChild(closeBtn);
    overlay.appendChild(viewport);
    if (bottomEl) {
      const bar = el(`<div style="padding:12px;background:var(--bg-card);border-top:1px solid var(--line)"></div>`);
      bar.appendChild(bottomEl);
      overlay.appendChild(bar);
    }
    CampfireScrollLock.lock();
    document.body.appendChild(overlay);

    const v = { scale: 1, tx: 0, ty: 0, imagePath: null, focused: false, map: null };
    let fogRaf = null;
    const apply = () => {
      holder.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
      if (onZoomChange) onZoomChange(v.scale);
    };
    const clampView = () => {
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      const cw = holder.offsetWidth * v.scale, ch = holder.offsetHeight * v.scale;
      v.tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, v.tx));
      v.ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, v.ty));
    };

    const pointers = new Map();
    let pinchStart = null;
    let tapHandler = null; // when set, taps place instead of pan/zoom
    let downAt = null;
    viewport.onpointerdown = (ev) => {
      if (ev.target === closeBtn) return;
      viewport.setPointerCapture(ev.pointerId);
      downAt = { x: ev.clientX, y: ev.clientY };
      if (tapHandler) return; // tap-to-place mode: no pan/pinch
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          scale: v.scale,
          world: { x: (mid.x - v.tx) / v.scale, y: (mid.y - v.ty) / v.scale },
        };
      }
    };
    viewport.onpointermove = (ev) => {
      if (tapHandler) return;
      const prev = pointers.get(ev.pointerId);
      if (!prev) return;
      const cur = { x: ev.clientX, y: ev.clientY };
      if (pointers.size === 2 && pinchStart) {
        pointers.set(ev.pointerId, cur);
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        v.scale = Math.min(10, Math.max(1, pinchStart.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist)));
        v.tx = mid.x - pinchStart.world.x * v.scale;
        v.ty = mid.y - pinchStart.world.y * v.scale;
      } else if (pointers.size === 1) {
        v.tx += cur.x - prev.x;
        v.ty += cur.y - prev.y;
        pointers.set(ev.pointerId, cur);
      }
      clampView();
      apply();
    };
    const lift = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchStart = null;
      // tap-to-place: a clean tap (not a swipe) reports image-fraction coords
      if (tapHandler && downAt
          && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) < 12) {
        const r = holder.getBoundingClientRect();
        const fx = (ev.clientX - r.left) / r.width;
        const fy = (ev.clientY - r.top) / r.height;
        if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) tapHandler(fx, fy);
      }
      downAt = null;
    };
    viewport.onpointerup = lift;
    viewport.onpointercancel = lift;
    viewport.onwheel = (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      const world = { x: (ev.clientX - v.tx) / v.scale, y: (ev.clientY - v.ty) / v.scale };
      v.scale = Math.min(10, Math.max(1, v.scale * factor));
      v.tx = ev.clientX - world.x * v.scale;
      v.ty = ev.clientY - world.y * v.scale;
      clampView();
      apply();
    };

    function update(snap, { highlight } = {}) {
      if (!snap.map) { close(); return; }
      const map = snap.map;
      if (v.imagePath !== map.image_path) {
        v.imagePath = map.image_path;
        img.src = map.image_path;
        const baseW = viewport.clientWidth;
        holder.style.width = `${baseW}px`;
        // match the fog canvas resolution to the on-screen map at scale 1
        fogCanvas.width = Math.max(1, Math.round(baseW));
        fogCanvas.height = Math.max(1, Math.round(baseW * (map.image_h / map.image_w)));
        v.scale = 1;
        v.tx = 0;
        v.ty = (viewport.clientHeight - viewport.clientWidth * (map.image_h / map.image_w)) / 2;
        apply();
      }
      v.map = map; // hand the latest fog/calibration to the drift loop
      tokenLayer.innerHTML = '';
      for (const t of snap.tokens) {
        const color = t.kind === 'glow' ? t.glow_color : t.color;
        const left = ((map.offset_x + t.col * map.cell_size) / map.image_w) * 100;
        const top = ((map.offset_y + t.row * map.cell_size) / map.image_h) * 100;
        const wPct = ((t.w * map.cell_size) / map.image_w) * 100;
        const hPct = ((t.h * map.cell_size) / map.image_h) * 100;
        const hot = highlight !== undefined && t.id === highlight;
        const fill = t.art
          ? `background-image:url('${t.art}');background-size:cover;background-position:center`
          : `background:${color}`;
        tokenLayer.appendChild(el(`<div style="position:absolute;left:${left}%;top:${top}%;width:${wPct}%;height:${hPct}%;border-radius:${t.shape === 'square' ? '12%' : '50%'};${fill};opacity:${t.art ? 1 : 0.85};border:${hot ? '2px solid var(--ember);box-shadow:0 0 10px var(--ember)' : '1px solid #000'}"></div>`));
        tokenLayer.appendChild(el(`<div style="position:absolute;left:${left + wPct / 2}%;top:${top + hPct}%;transform:translateX(-50%);color:#fff;font-size:9px;text-shadow:0 1px 2px #000;white-space:nowrap">${esc(t.label)}</div>`));
      }
      // first update with a highlight: jump the view to that token
      if (highlight !== undefined && !v.focused) {
        v.focused = true;
        const t = snap.tokens.find((x) => x.id === highlight);
        if (t) {
          requestAnimationFrame(() => {
            const cx = holder.offsetWidth * ((map.offset_x + (t.col + t.w / 2) * map.cell_size) / map.image_w);
            const cy = holder.offsetHeight * ((map.offset_y + (t.row + t.h / 2) * map.cell_size) / map.image_h);
            v.scale = 2.5;
            v.tx = viewport.clientWidth / 2 - cx * v.scale;
            v.ty = viewport.clientHeight / 2 - cy * v.scale;
            clampView();
            apply();
          });
        }
      }
    }

    // Billowing fog over the hidden cells: a darkness-dialed floor (light gray →
    // near black) with two drifting cloud layers that fade out toward pitch
    // black. Tokens in fog are dropped server-side, so this only ever covers
    // unexplored ground. Matches the projector's PIXI fog.
    function drawFog() {
      const ctx = fogCanvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
      const map = v.map;
      if (fog && map && map.fog_enabled && map.fog && fogCanvas.width > 0) {
        const sc = fogCanvas.width / map.image_w;
        const { cols, rows } = CampfireMap.gridDims(map);
        ctx.save();
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
          let run = -1;
          for (let c = 0; c <= cols; c++) {
            const hidden = c < cols && map.fog[r * cols + c] === '0';
            if (hidden && run < 0) run = c;
            else if (!hidden && run >= 0) {
              ctx.rect((map.offset_x + run * map.cell_size) * sc, (map.offset_y + r * map.cell_size) * sc,
                (c - run) * map.cell_size * sc, map.cell_size * sc);
              run = -1;
            }
          }
        }
        ctx.clip();
        const d = Math.min(Math.max(map.fog_darkness == null ? 0.85 : map.fog_darkness, 0), 1);
        const floor = CampfireMap.lerpHex(0x9aa1ad, 0x050608, d);
        ctx.globalAlpha = 0.5 + 0.5 * d;
        ctx.fillStyle = `#${floor.toString(16).padStart(6, '0')}`;
        ctx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
        const cloudVis = 1 - d;
        if (cloudVis > 0.01) {
          const t = performance.now() / 1000;
          const pat = ctx.createPattern(CampfireMap.cloudCanvas(), 'repeat');
          if (pat && pat.setTransform && typeof DOMMatrix === 'function') {
            pat.setTransform(new DOMMatrix().translateSelf(t * 6 * sc, t * 3 * sc).scaleSelf((map.cell_size * 5 * sc) / 256));
          }
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.6 * cloudVis;
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      fogRaf = requestAnimationFrame(drawFog);
    }
    drawFog();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (fogRaf) cancelAnimationFrame(fogRaf);
      overlay.remove();
      CampfireScrollLock.unlock();
      if (onClose) onClose();
    }
    closeBtn.onclick = close;

    // setTapMode(fn): taps call fn(fx, fy) in image fractions and pan/pinch is
    // suspended; setTapMode(null) restores normal navigation.
    function setTapMode(fn) {
      tapHandler = fn;
      viewport.style.cursor = fn ? 'crosshair' : '';
      viewport.style.outline = fn ? '3px solid var(--ember)' : '';
      viewport.style.outlineOffset = '-3px';
    }

    // setZoom(s): zoom around the center of the viewport (for external sliders)
    function setZoom(scale) {
      const cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2;
      const world = { x: (cx - v.tx) / v.scale, y: (cy - v.ty) / v.scale };
      v.scale = Math.min(10, Math.max(1, scale));
      v.tx = cx - world.x * v.scale;
      v.ty = cy - world.y * v.scale;
      clampView();
      apply();
    }

    return { update, close, setTapMode, setZoom, getZoom: () => v.scale };
  }

  return { open };
})();
