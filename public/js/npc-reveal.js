'use strict';

// Shared NPC "stat block" reveal: a full-screen, video-game-style splash with a
// framed portrait (cross-fading slideshow when there are several images) on the
// left and a black, easy-to-read info column on the right. Driven entirely by
// the scoped `revealed_card` snapshot field, so the GM toggling an entry on/off
// updates every screen live.
//
//   CampfireNPCReveal.show(npc, { dismissible, onClose })
//   CampfireNPCReveal.update(npc)   // re-render from a fresh snapshot, keep slideshow going
//   CampfireNPCReveal.hide()
//   CampfireNPCReveal.isOpen()
//
// The projector shows it locked (dismissible:false); players get a ✕ so they can
// read at their leisure and dismiss it.

window.CampfireNPCReveal = (function () {
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

  let cur = null; // { overlay, npcId, images, imgA, imgB, activeImg, slideIdx, timer, infoEl, nameEl, subEl, onClose }

  function imagesKey(images) { return JSON.stringify(images || []); }

  // Player-side section folding (the projector never folds — it auto-scrolls).
  // Keyed `${cardId}:${si}`, persisted so a reader keeps their layout.
  const PLAYER_FOLD_KEY = 'campfire_player_fold';
  let playerFold = new Set();
  try { playerFold = new Set(JSON.parse(localStorage.getItem(PLAYER_FOLD_KEY) || '[]')); } catch (e) { /* private mode */ }
  function savePlayerFold() { try { localStorage.setItem(PLAYER_FOLD_KEY, JSON.stringify([...playerFold])); } catch (e) { /* private mode */ } }

  function buildSections(sections, foldable, cardId) {
    const wrap = el(`<div class="npc-reveal-sections"></div>`);
    if (!sections || sections.length === 0) {
      wrap.appendChild(el(`<p class="npc-reveal-empty">…</p>`));
      return wrap;
    }
    // master fold controls (player only), above the list — like the GM screen
    if (foldable && sections.some((s) => s.entries.length)) {
      const bar = el(`<div class="npc-reveal-foldbar"></div>`);
      const ca = el(`<button class="npc-reveal-foldbtn">▸ Collapse all</button>`);
      ca.addEventListener('click', () => {
        sections.forEach((s, si) => {
          if (!s.entries.length) return;
          if (s.title) playerFold.add(`${cardId}:${si}`);
          s.entries.forEach((e, ei) => { if (e.label && e.text && e.text.trim()) playerFold.add(`${cardId}:${si}:${ei}`); });
        });
        savePlayerFold(); rebuildPlayerSections();
      });
      const ea = el(`<button class="npc-reveal-foldbtn">▾ Expand all</button>`);
      ea.addEventListener('click', () => {
        const prefix = `${cardId}:`;
        [...playerFold].forEach((k) => { if (k.startsWith(prefix)) playerFold.delete(k); });
        savePlayerFold(); rebuildPlayerSections();
      });
      bar.append(ca, ea);
      wrap.appendChild(bar);
    }
    // Each section is wrapped in a group so the GM's "focus" can lift the whole
    // section (title + its entries) as one raised card. Elements are tagged with
    // their public section/entry index so the connector line can find the text
    // that supplies the current image. On the player (foldable) a section title
    // is tappable to fold its entries away.
    sections.forEach((s, si) => {
      const group = el(`<div class="npc-reveal-group"></div>`);
      group.dataset.sec = si;
      const foldKey = `${cardId}:${si}`;
      if (foldable && s.title && playerFold.has(foldKey)) group.classList.add('player-collapsed');
      if (s.title) {
        const h = el(`<h3 class="npc-reveal-sec-title">${esc(s.title)}</h3>`);
        h.dataset.sec = si;
        h.dataset.sectitle = '1';
        if (foldable) {
          h.classList.add('foldable');
          h.insertBefore(el(`<span class="npc-reveal-caret">▾</span>`), h.firstChild);
          h.addEventListener('click', () => {
            const nowFolded = group.classList.toggle('player-collapsed');
            if (nowFolded) playerFold.add(foldKey); else playerFold.delete(foldKey);
            savePlayerFold();
          });
        }
        group.appendChild(h);
      }
      s.entries.forEach((e, ei) => {
        const row = el(`<div class="npc-reveal-entry"></div>`);
        row.dataset.sec = si;
        row.dataset.ent = ei;
        const entKey = `${cardId}:${si}:${ei}`;
        const entFoldable = foldable && !!e.label && !!(e.text && e.text.trim());
        if (entFoldable && playerFold.has(entKey)) row.classList.add('entry-collapsed');
        if (e.label) {
          const lab = el(`<span class="npc-reveal-label">${esc(e.label)}</span>`);
          if (entFoldable) {
            // tap the label to fold the entry down to just its label
            lab.classList.add('foldable');
            lab.insertBefore(el(`<span class="npc-reveal-caret">▾</span>`), lab.firstChild);
            lab.addEventListener('click', () => {
              const nowFolded = row.classList.toggle('entry-collapsed');
              if (nowFolded) playerFold.add(entKey); else playerFold.delete(entKey);
              savePlayerFold();
            });
          }
          row.appendChild(lab);
        }
        if (e.text) row.appendChild(el(`<span class="npc-reveal-text">${esc(e.text)}</span>`));
        group.appendChild(row);
      });
      wrap.appendChild(group);
    });
    return wrap;
  }

  // Draw a glowing connector from the text element that supplies the current
  // image to the image frame. Card-level images (source null) get no line.
  function drawLink() {
    if (!cur || !cur.linkSvg) return;
    const svg = cur.linkSvg;
    if (!cur.showLink) { svg.innerHTML = ''; return; } // GM turned the connector off
    const src = cur.imageSources && cur.imageSources[cur.slideIdx];
    if (!src || !cur.images.length) { svg.innerHTML = ''; return; }
    let elSrc = null;
    if (src.card) {
      elSrc = cur.nameEl; // the card's own images point at the title
    } else if (src.e === -1) {
      elSrc = cur.sectionsHost.querySelector(`[data-sec="${src.s}"][data-sectitle]`)
           || cur.sectionsHost.querySelector(`[data-sec="${src.s}"][data-ent]`);
    } else {
      elSrc = cur.sectionsHost.querySelector(`[data-sec="${src.s}"][data-ent="${src.e}"]`);
    }
    if (!elSrc) { svg.innerHTML = ''; return; }
    const root = cur.overlay.getBoundingClientRect();
    const fr = cur.frameEl.getBoundingClientRect();
    const sr = elSrc.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${root.width} ${root.height}`);
    svg.setAttribute('width', root.width);
    svg.setAttribute('height', root.height);
    const x1 = sr.left - root.left, y1 = sr.top - root.top + sr.height / 2; // caption side
    const x2 = fr.right - root.left, y2 = fr.top - root.top + fr.height / 2; // frame side
    const dx = Math.max(40, (x1 - x2) * 0.4);
    const d = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
    svg.innerHTML =
      `<path d="${d}" class="link-glow"/>` +
      `<path d="${d}" class="link-line"/>` +
      `<circle cx="${x1}" cy="${y1}" r="5" class="link-dot"/>` +
      `<circle cx="${x2}" cy="${y2}" r="6" class="link-dot"/>`;
  }
  function refreshLink() { if (cur) requestAnimationFrame(drawLink); }

  function imgIndexOf(npc) { return typeof npc.image_index === 'number' ? npc.image_index : null; }

  function stopAuto() {
    if (cur && cur.timer) { clearInterval(cur.timer); cur.timer = null; }
  }

  // --- projector text auto-scroll -------------------------------------------
  // A slow crawl down the reveal's text column when it overflows: dwell at the
  // top, ease down, dwell at the bottom, snap back, repeat. The GM can pause it
  // (scroll_paused) to hold the table on whatever is on screen.
  const SCROLL_PX_PER_MS = 0.022; // ~22px/s — readable, unhurried
  const SCROLL_DWELL_MS = 3500;   // pause at each end
  function stopCrawl() {
    if (cur && cur.scrollRaf) { cancelAnimationFrame(cur.scrollRaf); cur.scrollRaf = null; }
    if (cur) cur.crawling = false;
  }
  // Crawl `host` between scrollTop bounds [lo, hi] (hi null = its natural max):
  // dwell at lo, ease down to hi, dwell, snap back, repeat. Used for the whole
  // column, a single bounded section, or the focus popup's body.
  function startCrawl(host, lo, hi) {
    if (!cur || !cur.autoScroll || cur.crawling || !host) return;
    cur.crawling = true;
    lo = lo || 0;
    const top = () => lo;
    const bottom = () => (hi == null ? host.scrollHeight - host.clientHeight : hi);
    let phase = host.scrollTop > lo + 2 ? 'down' : 'topDwell';
    let phaseStart = performance.now();
    let last = phaseStart;
    const step = (now) => {
      if (!cur || !cur.crawling) return;
      const dt = now - last; last = now;
      if (bottom() - top() <= 4) { // fits — nothing to crawl
        host.scrollTop = top();
        cur.scrollRaf = requestAnimationFrame(step);
        return;
      }
      if (phase === 'topDwell') {
        if (now - phaseStart >= SCROLL_DWELL_MS) { phase = 'down'; }
      } else if (phase === 'down') {
        host.scrollTop = Math.min(bottom(), host.scrollTop + SCROLL_PX_PER_MS * (cur.scrollSpeed || 1) * dt);
        if (host.scrollTop >= bottom() - 1) { phase = 'bottomDwell'; phaseStart = now; }
      } else if (phase === 'bottomDwell') {
        if (now - phaseStart >= SCROLL_DWELL_MS) { host.scrollTop = top(); phase = 'topDwell'; phaseStart = now; }
      }
      cur.scrollRaf = requestAnimationFrame(step);
    };
    cur.scrollRaf = requestAnimationFrame(step);
  }

  // SECTION focus: dim the other sections in place, lift the chosen one (no zoom,
  // so nothing overflows the column sideways). ENTRY focus is handled by the
  // popup instead, so here we only ever class-up a whole-section focus.
  function applyFocusClasses(sectionFocus) {
    if (!cur) return;
    const wrap = cur.sectionsHost.querySelector('.npc-reveal-sections') || cur.sectionsHost;
    wrap.classList.toggle('reveal-focus-mode', sectionFocus != null);
    wrap.querySelectorAll('.is-focus').forEach((n) => n.classList.remove('is-focus'));
    wrap.querySelectorAll('.dimmed').forEach((n) => n.classList.remove('dimmed'));
    if (sectionFocus == null) return;
    wrap.querySelectorAll('.npc-reveal-group').forEach((g) => {
      g.classList.toggle('is-focus', Number(g.dataset.sec) === sectionFocus);
      g.classList.toggle('dimmed', Number(g.dataset.sec) !== sectionFocus);
    });
  }

  // Bring a focused section to the top of the column; if it's taller than the
  // viewport, crawl within just that section (bounded), honoring pause.
  function scrollAndCrawlSection(section, doScroll) {
    const host = cur.sectionsHost;
    const group = host.querySelector(`.npc-reveal-group[data-sec="${section}"]`);
    if (!group) return;
    requestAnimationFrame(() => {
      if (!cur) return;
      const hostRect = host.getBoundingClientRect();
      const gRect = group.getBoundingClientRect();
      const maxScroll = host.scrollHeight - host.clientHeight;
      const lo = Math.max(0, Math.min(maxScroll, host.scrollTop + (gRect.top - hostRect.top) - 16));
      const hi = Math.max(lo, Math.min(maxScroll, lo + gRect.height - host.clientHeight + 28));
      const overflows = hi - lo > 8;
      if (overflows && !cur.scrollPaused) {
        host.scrollTop = lo; // instant, so the crawl owns scrollTop cleanly
        startCrawl(host, lo, hi);
      } else if (doScroll) {
        if (host.scrollTo) host.scrollTo({ top: lo, behavior: 'smooth' });
        else host.scrollTop = lo;
      }
    });
  }

  // ENTRY focus: a centered, ornate popup floating above everything (images
  // included), casting a shadow over the darkened reveal beneath it.
  function ensureFocusPopup(npc, focus, refresh) {
    const sec = (npc.sections || [])[focus.section] || { entries: [] };
    const e = (sec.entries || [])[focus.entry] || {};
    if (!cur.pop) {
      // clear any popup still mid-exit so we don't stack two
      cur.overlay.querySelectorAll('.npc-focus-scrim').forEach((s) => s.remove());
      const scrim = el(`<div class="npc-focus-scrim"></div>`);
      const box = el(`<div class="npc-focus-pop"></div>`);
      box.append(
        el(`<span class="npc-focus-corner tl">⚜</span>`),
        el(`<span class="npc-focus-corner tr">⚜</span>`),
        el(`<span class="npc-focus-corner bl">⚜</span>`),
        el(`<span class="npc-focus-corner br">⚜</span>`),
      );
      const label = el(`<div class="npc-focus-pop-label"></div>`);
      const body = el(`<div class="npc-focus-pop-body"></div>`);
      box.append(label, body);
      scrim.appendChild(box);
      cur.overlay.appendChild(scrim);
      cur.pop = { scrim, box, label, body, key: null };
    }
    if (refresh || cur.pop.key !== cur.focusKey) {
      cur.pop.key = cur.focusKey;
      cur.pop.label.textContent = e.label || sec.title || '';
      cur.pop.label.style.display = (e.label || sec.title) ? 'block' : 'none';
      cur.pop.body.textContent = e.text || '';
      cur.pop.body.scrollTop = 0;
    }
  }
  function removeFocusPopup(immediate) {
    if (!cur || !cur.pop) return;
    const scrim = cur.pop.scrim;
    cur.pop = null;
    if (immediate) { scrim.remove(); return; }
    // ease out, then drop it from the DOM
    scrim.classList.add('closing');
    setTimeout(() => scrim.remove(), 320);
  }

  function applyScroll(npc) {
    if (!cur || !cur.autoScroll) return;
    cur.scrollPaused = !!npc.scroll_paused;
    cur.scrollSpeed = (typeof npc.scroll_speed === 'number') ? npc.scroll_speed : 1;
    const f = npc.focus;
    const focus = (f && typeof f.section === 'number')
      ? { section: f.section, entry: (typeof f.entry === 'number' ? f.entry : null) }
      : null;
    const key = focus ? `${focus.section}:${focus.entry}` : '';
    const changed = key !== cur.focusKey;
    const rebuilt = cur.rebuilt; cur.rebuilt = false;
    cur.focusKey = key;
    stopCrawl();

    // entry focus → centered popup (no in-column dimming; the scrim handles it)
    if (focus && focus.entry !== null) {
      applyFocusClasses(null);
      ensureFocusPopup(npc, focus, changed || rebuilt);
      if (!cur.scrollPaused) startCrawl(cur.pop.body, 0, null);
      return;
    }
    removeFocusPopup();

    // section focus → in-place dim + bounded crawl
    if (focus) {
      applyFocusClasses(focus.section);
      scrollAndCrawlSection(focus.section, changed || rebuilt);
      return;
    }

    // no focus → full-column crawl
    applyFocusClasses(null);
    if (!cur.scrollPaused) startCrawl(cur.sectionsHost, 0, null);
  }

  // Reset the two stacked <img> layers to a fresh image list (showing the first).
  function setImages(images) {
    cur.images = images.slice();
    cur.slideIdx = 0;
    const has = images.length > 0;
    cur.imgA.style.display = cur.imgB.style.display = has ? 'block' : 'none';
    cur.frameEl.classList.toggle('empty', !has);
    cur.activeImg = cur.imgA;
    if (has) {
      cur.imgA.src = images[0];
      cur.imgA.style.opacity = '1';
      cur.imgB.style.opacity = '0';
    }
  }

  // Cross-fade the next layer to image i (no-op if already there).
  function swapTo(i) {
    if (!cur.images.length) return;
    i = ((i % cur.images.length) + cur.images.length) % cur.images.length;
    if (i === cur.slideIdx) return;
    const next = cur.activeImg === cur.imgA ? cur.imgB : cur.imgA;
    next.src = cur.images[i];
    next.style.opacity = '1';
    cur.activeImg.style.opacity = '0';
    cur.activeImg = next;
    cur.slideIdx = i;
    refreshLink();
  }

  // A too-wide image (wider aspect than the frame) slowly scrolls left→right so
  // the whole picture is seen; returns how long the slide should linger (pan +
  // a hold at the end, or a plain rest for images that already fit). The opacity
  // cross-fade rides alongside the object-position transition so both animate.
  const PAN_MS = 9000, HOLD_MS = 2500, REST_MS = 7000, EDGE_HOLD_MS = 2000;
  // Scroll a too-wide image (wider aspect than the frame) so the whole picture
  // is seen. loop=true (a HELD image) ping-pongs left↔right forever; loop=false
  // (auto slideshow) does a single left→right and returns how long to linger.
  function panImage(imgEl, loop) {
    imgEl.style.animation = 'none';
    imgEl.style.transition = 'opacity 1.1s ease';
    imgEl.style.objectPosition = '50% 50%';
    const fr = cur.frameEl ? cur.frameEl.getBoundingClientRect() : null;
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    if (!fr || !fr.width || !fr.height || !nw || !nh) return REST_MS;
    if (nw / nh <= (fr.width / fr.height) * 1.05) return REST_MS; // fits — no pan
    imgEl.style.objectPosition = '0% 50%';
    void imgEl.offsetWidth; // commit the left edge before animating
    if (loop) {
      // ping-pong left↔right with a ~2s dwell at each end so the held image
      // settles before reversing. The npcpanpong keyframes bake the dwells in,
      // so one full cycle = pan + hold, out and back.
      const cycle = 2 * (PAN_MS + EDGE_HOLD_MS);
      imgEl.style.animation = `npcpanpong ${cycle}ms linear infinite`;
      return Infinity; // held — never advance
    }
    imgEl.style.transition = `opacity 1.1s ease, object-position ${PAN_MS}ms linear`;
    imgEl.style.objectPosition = '100% 50%';
    return PAN_MS + HOLD_MS;
  }

  // Pan the active image and, in auto mode, queue the next slide for after the
  // pan + hold. A held (manual) image pans continuously instead. Waits for the
  // image to load so the aspect test is accurate.
  function panAndSchedule() {
    stopAuto();
    if (!cur.images.length) return;
    const img = cur.activeImg;
    const loop = cur.mode === 'manual';
    const run = () => {
      if (!cur || cur.activeImg !== img) return; // superseded by a newer slide
      const dur = panImage(img, loop);
      if (cur.mode === 'auto' && cur.images.length > 1) {
        cur.timer = setTimeout(() => { swapTo(cur.slideIdx + 1); panAndSchedule(); }, dur);
      }
    };
    if (img.complete && img.naturalWidth) run();
    else img.onload = run;
  }

  // Reconcile the slides with the snapshot. A numeric image_index = GM steering
  // from their viewer (hold + pan that frame); null = auto cross-fade. Auto isn't
  // restarted each snapshot, and a held frame isn't re-panned unless it changes.
  function applySlides(images, manualIdx) {
    const changed = imagesKey(images) !== imagesKey(cur.images);
    if (changed) { setImages(images || []); cur.mode = null; }
    if (typeof manualIdx === 'number' && cur.images.length) {
      const wasManual = cur.mode === 'manual';
      cur.mode = 'manual';
      const target = ((manualIdx % cur.images.length) + cur.images.length) % cur.images.length;
      if (changed || !wasManual || target !== cur.slideIdx) {
        swapTo(target);
        panAndSchedule();
      }
    } else {
      const wasAuto = cur.mode === 'auto';
      cur.mode = 'auto';
      if (!wasAuto || changed) panAndSchedule();
    }
    refreshLink();
  }

  function show(npc, { dismissible = false, onClose } = {}) {
    if (cur && cur.npcId === npc.id) { update(npc); return; }
    hide();

    const overlay = el(`<div class="npc-reveal ${dismissible ? 'is-player' : 'is-projector'}"></div>`);
    // backdrop image (under everything) + particle effects canvas (above the
    // backdrop, under the content)
    const bgEl = el(`<div class="npc-reveal-bg"></div>`);
    const fx = el(`<canvas class="npc-reveal-fx"></canvas>`);
    overlay.append(bgEl, fx);
    const portrait = el(`<div class="npc-reveal-portrait"></div>`);
    const frameEl = el(`<div class="npc-frame"></div>`);
    const imgA = el(`<img class="npc-slide" draggable="false" alt="">`);
    const imgB = el(`<img class="npc-slide" draggable="false" alt="">`);
    frameEl.append(
      el(`<span class="npc-frame-corner tl"></span>`),
      el(`<span class="npc-frame-corner tr"></span>`),
      el(`<span class="npc-frame-corner bl"></span>`),
      el(`<span class="npc-frame-corner br"></span>`),
      imgA, imgB,
    );
    portrait.appendChild(frameEl);

    const info = el(`<div class="npc-reveal-info"></div>`);
    const nameEl = el(`<h1 class="npc-reveal-name"></h1>`);
    const subEl = el(`<div class="npc-reveal-sub"></div>`);
    const sectionsHost = el(`<div class="npc-reveal-scroll"></div>`);
    info.append(nameEl, subEl, sectionsHost);

    overlay.append(portrait, info);

    // connector line overlay (above the content, click-through)
    const linkSvg = el(`<svg class="npc-reveal-link" xmlns="http://www.w3.org/2000/svg"></svg>`);
    overlay.appendChild(linkSvg);

    if (dismissible) {
      const closeBtn = el(`<button class="npc-reveal-close">✕ close</button>`);
      closeBtn.onclick = () => { const cb = cur && cur.onClose; hide(); if (cb) cb(); };
      overlay.appendChild(closeBtn);
    }

    document.body.appendChild(overlay);
    const onResize = () => drawLink();
    window.addEventListener('resize', onResize);
    sectionsHost.addEventListener('scroll', () => drawLink(), { passive: true });
    cur = {
      overlay, npcId: npc.id, imgA, imgB, frameEl, activeImg: imgA, images: [], slideIdx: 0, timer: null,
      sectionsHost, nameEl, subEl, onClose, mode: null,
      bgEl, fx, fxHandle: null, effect: null, bgImage: null, locked: false,
      linkSvg, imageSources: [], onResize, showLink: true,
      // auto-scroll only crawls the projector reveal (the non-dismissible one);
      // a player reading on their own phone scrolls it themselves.
      autoScroll: !dismissible, scrollRaf: null, crawling: false, scrollPaused: false,
      focusKey: '', rebuilt: false, pop: null,
    };
    // Dismissible (player) reveals pin the page so scrolling the stat block
    // doesn't move the sheet behind it. The projector never scrolls, so skip it.
    if (dismissible && window.CampfireScrollLock) { CampfireScrollLock.lock(); cur.locked = true; }

    cur.showLink = npc.show_link !== false;
    paintInfo(npc);
    applySlides(npc.images || [], imgIndexOf(npc));
    applyAmbience(npc);
    applyScroll(npc);
  }

  // Backdrop image + particle effect. Both only re-applied when they change, so
  // the canvas isn't torn down on every snapshot (which would reset the embers).
  function applyAmbience(npc) {
    const bg = npc.bg_image || '';
    if (bg !== cur.bgImage) {
      cur.bgImage = bg;
      cur.bgEl.style.backgroundImage = bg ? `url('${bg}')` : '';
      cur.bgEl.classList.toggle('has-image', !!bg);
    }
    // global particle toggle overrides the card's effect
    const effect = (npc.particles_enabled === false) ? 'none' : (npc.bg_effect || 'none');
    if (effect !== cur.effect) { cur.effect = effect; startFx(effect); }
  }

  function stopFx() {
    if (cur && cur.fxHandle) { cur.fxHandle.stop(); cur.fxHandle = null; }
  }

  function startFx(effect) {
    stopFx();
    if (!cur) return;
    const fx = cur.fx;
    const on = effect && effect !== 'none';
    fx.style.display = on ? 'block' : 'none';
    if (on) cur.fxHandle = CampfireNpcFx.start(fx, effect);
  }

  // Re-render the player's section list in place (master collapse/expand all).
  function rebuildPlayerSections() {
    if (!cur) return;
    cur.sectionsHost.innerHTML = '';
    cur.sectionsHost.appendChild(buildSections(cur.sectionsData || [], !cur.autoScroll, cur.npcId));
  }

  function paintInfo(npc) {
    cur.nameEl.textContent = npc.name || '';
    cur.subEl.textContent = npc.subtitle || '';
    cur.subEl.style.display = npc.subtitle ? 'block' : 'none';
    cur.imageSources = npc.image_sources || [];
    cur.sectionsData = npc.sections || []; // for the master fold controls to rebuild from
    // Only rebuild the text column when its content actually changed — otherwise
    // every unrelated snapshot would wipe innerHTML and yank scrollTop back to 0,
    // fighting the auto-crawl and making a pause jump to the top.
    const key = JSON.stringify(npc.sections || []);
    if (key !== cur.sectionsKey) {
      cur.sectionsKey = key;
      cur.sectionsHost.innerHTML = '';
      // foldable only on the player (the projector auto-scrolls instead)
      cur.sectionsHost.appendChild(buildSections(npc.sections, !cur.autoScroll, npc.id));
      cur.rebuilt = true; // the focus spotlight/scroll must be re-applied
    }
    refreshLink();
  }

  function update(npc) {
    if (!cur) { show(npc); return; }
    if (cur.npcId !== npc.id) { show(npc, { dismissible: !!cur.onClose, onClose: cur.onClose }); return; }
    cur.showLink = npc.show_link !== false;
    paintInfo(npc);
    applySlides(npc.images || [], imgIndexOf(npc));
    applyAmbience(npc);
    applyScroll(npc);
  }

  function hide() {
    stopAuto();
    stopCrawl();
    removeFocusPopup(true);
    stopFx();
    if (cur) {
      if (cur.onResize) window.removeEventListener('resize', cur.onResize);
      if (cur.locked && window.CampfireScrollLock) CampfireScrollLock.unlock();
      cur.overlay.remove();
      cur = null;
    }
  }

  return { show, update, hide, isOpen: () => !!cur, currentId: () => (cur ? cur.npcId : null) };
})();
