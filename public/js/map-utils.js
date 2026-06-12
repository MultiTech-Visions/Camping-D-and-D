'use strict';

// Shared grid math (handoff §7) — the ONE place the three coordinate spaces
// meet on the client:
//   1. image space: raw pixels of the uploaded map (calibration lives here)
//   2. grid space:  (col,row) integers — where tokens live, ALWAYS
//   3. screen space: derived at render time from the camera transform only
// Tokens never live in screen space; the camera never moves a token.

window.CampfireMap = (function () {
  function gridDims(map) {
    return {
      cols: Math.floor((map.image_w - map.offset_x) / map.cell_size),
      rows: Math.floor((map.image_h - map.offset_y) / map.cell_size),
    };
  }

  // center of a cell, in image pixels — for rendering a token
  function cellCenter(map, col, row) {
    return {
      x: map.offset_x + (col + 0.5) * map.cell_size,
      y: map.offset_y + (row + 0.5) * map.cell_size,
    };
  }

  // image pixel → containing cell
  function imageToGrid(map, x, y) {
    return {
      col: Math.floor((x - map.offset_x) / map.cell_size),
      row: Math.floor((y - map.offset_y) / map.cell_size),
    };
  }

  function clampToGrid(map, col, row) {
    const d = gridDims(map);
    return {
      col: Math.min(Math.max(col, 0), d.cols - 1),
      row: Math.min(Math.max(row, 0), d.rows - 1),
    };
  }

  // Translate an arrow press (screen direction sx,sy) into a one-cell grid
  // step, honoring the camera rotation: ▲ always moves the token UP AS SEEN
  // ON THE PROJECTOR. The rotated vector snaps to the dominant grid axis.
  function screenStepToGrid(rotationDeg, sx, sy) {
    const th = (rotationDeg * Math.PI) / 180;
    const vx = sx * Math.cos(th) + sy * Math.sin(th);
    const vy = -sx * Math.sin(th) + sy * Math.cos(th);
    return Math.abs(vx) >= Math.abs(vy)
      ? { dc: Math.sign(vx), dr: 0 }
      : { dc: 0, dr: Math.sign(vy) };
  }

  // --- Fog of war ---------------------------------------------------------
  // map.fog is a row-major visibility bitmask, one char per cell ('1' visible,
  // '0' hidden), length cols*rows. '' (or fog disabled) means everything shows.
  function fogVisible(map, col, row) {
    if (!map.fog_enabled || !map.fog) return true;
    const { cols, rows } = gridDims(map);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    return map.fog[row * cols + col] === '1';
  }

  // A blank (all-hidden) bitmask for this map's grid.
  function fogAllHidden(map) {
    const { cols, rows } = gridDims(map);
    return '0'.repeat(cols * rows);
  }

  // Tileable grayscale cloud tile (built once, shared by the projector's PIXI
  // fog and the player viewer's canvas fog). Soft white blobs on black, stamped
  // with wrap-around so the edges meet seamlessly when repeated.
  let cloudTile = null;
  function cloudCanvas() {
    if (cloudTile) return cloudTile;
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';
    const wraps = [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S], [S, S], [-S, -S], [S, -S], [-S, S]];
    for (let i = 0; i < 64; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 28 + Math.random() * 70;
      const a = 0.05 + Math.random() * 0.07;
      for (const [dx, dy] of wraps) {
        const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
    cloudTile = cv;
    return cloudTile;
  }

  // Interpolate two 0xRRGGBB colors; the fog darkness dial rides this from a
  // light gray fog to near-pitch black.
  function lerpHex(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return ((Math.round(ar + (br - ar) * t) << 16)
      | (Math.round(ag + (bg - ag) * t) << 8)
      | Math.round(ab + (bb - ab) * t));
  }

  return {
    gridDims, cellCenter, imageToGrid, clampToGrid, screenStepToGrid,
    fogVisible, fogAllHidden, cloudCanvas, lerpHex,
  };
})();
