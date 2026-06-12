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

  return { gridDims, cellCenter, imageToGrid, clampToGrid, screenStepToGrid };
})();
