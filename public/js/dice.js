'use strict';

// Shared renderers used by every page: ONE dice-pool renderer, ONE clock
// renderer (handoff rule: modularity over duplication — no parallel copies).

window.CampfireDice = (function () {
  const LETTERS = { green: 'A', yellow: 'P', blue: 'B', purple: 'D', red: 'C', black: 'S' };
  const TITLES = {
    green: 'Ability (green)', yellow: 'Proficiency (yellow — has the Triumph face)',
    blue: 'Boost (blue)', purple: 'Difficulty (purple)',
    red: 'Challenge (red — has the Despair face)', black: 'Setback (black)',
  };

  // pool = {green, yellow, blue, purple, red, black} (missing keys mean zero dice
  // of that colour — a structural absence, not data corruption).
  function renderPool(pool, { large } = {}) {
    const wrap = document.createElement('span');
    wrap.className = 'dice-pool';
    let any = false;
    for (const color of ['green', 'yellow', 'blue', 'purple', 'red', 'black']) {
      const n = pool[color] === undefined ? 0 : pool[color];
      for (let i = 0; i < n; i++) {
        const d = document.createElement('span');
        d.className = `die die-${color}${large ? ' lg' : ''}`;
        d.textContent = LETTERS[color];
        d.title = TITLES[color];
        wrap.appendChild(d);
        any = true;
      }
    }
    if (!any) {
      const none = document.createElement('span');
      none.className = 'muted small';
      none.textContent = 'no dice';
      wrap.appendChild(none);
    }
    return wrap;
  }

  // SVG segmented clock. onSegmentTap(newFilled) makes it interactive: tapping
  // segment i sets filled to i+1; tapping the last filled segment clears it.
  function renderClock(clock, { size = 110, onSegmentTap } = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const box = document.createElement('div');
    box.className = 'clock-box' + (clock.visibility === 'dm_only' ? ' clock-secret' : '');

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'clock-svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 100 100');

    const cx = 50, cy = 50, r = 46;
    for (let i = 0; i < clock.segments; i++) {
      const a0 = (i / clock.segments) * 2 * Math.PI - Math.PI / 2;
      const a1 = ((i + 1) / clock.segments) * 2 * Math.PI - Math.PI / 2;
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d',
        `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} ` +
        `A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`);
      p.setAttribute('class', `seg ${i < clock.filled ? `filled ${clock.kind}` : ''}`);
      if (onSegmentTap) {
        p.addEventListener('click', () => {
          onSegmentTap(i + 1 === clock.filled ? i : i + 1);
        });
      }
      svg.appendChild(p);
    }
    box.appendChild(svg);

    const label = document.createElement('div');
    label.className = 'clock-label';
    label.textContent = `${clock.label} (${clock.filled}/${clock.segments})`;
    box.appendChild(label);

    const kind = document.createElement('div');
    kind.className = `clock-kind ${clock.kind}`;
    kind.textContent = clock.kind + (clock.visibility === 'dm_only' ? ' · secret' : '');
    box.appendChild(kind);
    return box;
  }

  function dndMod(score) {
    const m = Math.floor((score - 10) / 2);
    return m >= 0 ? `+${m}` : `${m}`;
  }

  return { renderPool, renderClock, dndMod };
})();
