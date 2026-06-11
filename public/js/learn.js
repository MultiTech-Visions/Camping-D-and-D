'use strict';

// Teaching-page extras: the rank→dice slider demo, and image-slot upgrading.
// Each .img-slot names its art file; when the user drops real art into
// public/assets/, the slot automatically shows the image instead of the
// labeled placeholder box.

(function () {
  // upgrade placeholders to real art when present
  for (const slot of document.querySelectorAll('.img-slot[data-img]')) {
    const img = new Image();
    img.onload = () => {
      slot.textContent = '';
      slot.style.border = 'none';
      slot.appendChild(img);
    };
    img.src = slot.dataset.img; // onerror: keep the placeholder text
  }

  // rank slider demo (mirrors rules.js diceForRank)
  const slider = document.getElementById('rank-slider');
  const num = document.getElementById('rank-num');
  const out = document.getElementById('rank-dice');

  function show() {
    const rank = Number(slider.value);
    num.textContent = rank;
    out.innerHTML = '';
    if (rank === 0) {
      out.innerHTML = '<span class="muted">no dice — you cannot act with this attribute</span>';
      return;
    }
    for (let i = 0; i < Math.min(rank, 3); i++) {
      out.insertAdjacentHTML('beforeend', '<span class="die lg die-green">A</span>');
    }
    for (let i = 0; i < Math.max(rank - 3, 0); i++) {
      out.insertAdjacentHTML('beforeend', '<span class="die lg die-yellow">P</span>');
    }
  }
  slider.addEventListener('input', show);
  show();
})();
