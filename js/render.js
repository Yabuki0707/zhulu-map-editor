/* ==========================================================================
   render.js —— 视图与渲染：缩放平移、图层合成、参考层金字塔、高亮、笔刷范围圈
   ========================================================================== */

import { G, W, H, unitOf, terName, DOM } from "./config.js";
import { terCanvas, plotCanvas, distCanvas, overlayCanvas, overlayImg, overlayCtx,
         plotData, distData, edgeMips, bedgeMips, buildEdges, buildEdgeMips, levelZeroCanvas,
         maskToCanvas } from "./raster.js";
import { state, getCellsOf, getCellsOfBlock, brushRadius, rebuildPlotColors,
         repaintPlotLayer, cellsWithBlock } from "./state.js";
import { REF } from "./refvec.js";

export const cv = document.getElementById("cv");
export const ctx = cv.getContext("2d");
let DPR = 1, VW = 0, VH = 0;
export const viewSize = () => [VW, VH];
export const FIT = () => Math.min(VW / W, VH / H);
export let spaceDown = false;
export const setSpace = v => { spaceDown = v; };
let cursorText = "—";
export const setCursorText = t => { cursorText = t; };

const EDGE_RGB = [58, 48, 36], BEDGE_RGB = [40, 74, 92];

export function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  VW = cv.clientWidth; VH = cv.clientHeight;
  cv.width = Math.round(VW * DPR); cv.height = Math.round(VH * DPR);
  ctx.imageSmoothingEnabled = false;
  state.dirty = true;
}
export function fit() {
  const s = FIT() * 0.98;
  state.view = { s, x: (VW - W * s) / 2, y: (VH - H * s) / 2 };
  state.dirty = true;
}
/* 把某格居中放大到给定倍率（清单里点对象时"跳过去"） */
export function centerOn(i, scale) {
  if (i < 0) return;
  const x = i % W, y = (i - x) / W;
  const s = scale || Math.max(state.view.s, FIT() * 6);
  state.view.s = s;
  state.view.x = VW / 2 - (x + 0.5) * s;
  state.view.y = VH / 2 - (y + 0.5) * s;
  state.dirty = true;
}
export const toCell = (sx, sy) => {
  const x = Math.floor((sx - state.view.x) / state.view.s), y = Math.floor((sy - state.view.y) / state.view.s);
  return (x < 0 || y < 0 || x >= W || y >= H) ? -1 : y * W + x;
};
/* 某个对象的代表格（清单跳转用） */
export function anchorCell(unit, id) {
  if (unit === "block") { const a = getCellsOfBlock().get(id); return a ? a[0] : -1; }
  if (unit === "plot") { const a = getCellsOf().get(id); return a ? a[0] : -1; }
  if (unit === "domain") {
    for (const [pid, arr] of getCellsOf()) {
      const p = state.plots[pid];
      if (p && p.d === id) return arr[0];
    }
    return -1;
  }
  return -1;
}

/* ---------------------------------------------------------------- 主绘制 */
/* 只把"看得见的那一块"喂给 canvas：大图上这一下能省掉大半光栅化开销 */
function blit(cvs, sw, sh, step) {
  const v = state.view, k = step || 1;
  const x0 = Math.max(0, Math.floor(-v.x / v.s / k)), y0 = Math.max(0, Math.floor(-v.y / v.s / k));
  const x1 = Math.min(sw, Math.ceil((VW - v.x) / v.s / k)), y1 = Math.min(sh, Math.ceil((VH - v.y) / v.s / k));
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(cvs, x0, y0, x1 - x0, y1 - y0,
                v.x + x0 * k * v.s, v.y + y0 * k * v.s, (x1 - x0) * k * v.s, (y1 - y0) * k * v.s);
}
export function draw() {
  state.dirty = false;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = "#cfd6d2"; ctx.fillRect(0, 0, VW, VH);
  const v = state.view, layer = unitOf(state.unit).layer;
  ctx.imageSmoothingEnabled = false;
  if (state.showTerrain || layer === "terrain") blit(terCanvas, W, H);
  else { ctx.fillStyle = "#eceae2"; ctx.fillRect(v.x, v.y, W * v.s, H * v.s); }
  if (layer === "plot") blit(plotCanvas, W, H);
  else if (layer === "dist") {
    blit(plotCanvas, W, H);                                  // 地块着色作底，便于看清块区落在哪
    if (cellsWithBlock) blit(distCanvas, W, H);
  }
  if (state.showEdge && v.s > 0.55) paintMask(edgeMips(), "plot", EDGE_RGB, 190);
  if (state.showBEdge && v.s > 0.55) paintMask(bedgeMips(), "dist", BEDGE_RGB, 200);
  if (state.showRef) drawRefVector();
  drawOverlay();
  drawOutline();
  if (state.mode === "view" || state.selCell >= 0) drawHoverCell();
  if (state.mode === "edit" && !spaceDown) drawBrushRing();
  updateFooter();
}

/* 掩膜绘制：放大到位 → 屏幕 1px 发丝线；缩小 → 取一级"每格 1~2 屏像素"的金字塔层 */
function paintMask(mips, kind, rgb, alpha) {
  const v = state.view;
  if (!mips) return;
  if (v.s >= 3) { strokeVectorEdges(kind, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.78)`); return; }
  const lvl = Math.min(Math.max(0, Math.ceil(Math.log2(1 / v.s))), mips.length - 1);
  const use = mips[lvl];
  if (lvl === 0) {                                            // 0 级已上色，直接用
    blit(levelZeroCanvas(kind), use.w, use.h);
    return;
  }
  const a = Math.max(64, Math.round(alpha * Math.pow(0.88, lvl)));
  blit(maskToCanvas(use, rgb, a), use.w, use.h, 1 << lvl);
}
/* 屏幕空间发丝边界：只遍历视野内的格子，一次成路径再描边。
   关键：同一条网格线上的端点必须用同一个取整结果，否则相邻格的线段首尾对不上，
   放大后就能看见断成一截一截的"虚线"（本轮修的正是这个）。 */
function strokeVectorEdges(kind, color) {
  const v = state.view;
  const x0 = Math.max(0, Math.floor(-v.x / v.s)), x1 = Math.min(W - 1, Math.ceil((VW - v.x) / v.s));
  const y0 = Math.max(0, Math.floor(-v.y / v.s)), y1 = Math.min(H - 1, Math.ceil((VH - v.y) / v.s));
  const nx = x1 - x0 + 2, ny = y1 - y0 + 2;
  const X = new Float64Array(nx), Y = new Float64Array(ny);
  for (let i = 0; i < nx; i++) X[i] = Math.round(v.x + (x0 + i) * v.s) + 0.5;
  for (let j = 0; j < ny; j++) Y[j] = Math.round(v.y + (y0 + j) * v.s) + 0.5;
  const diff = kind === "dist"
    ? (i, j) => distData[i] !== distData[j] && (distData[i] || distData[j])
    : (i, j) => plotData[i] !== plotData[j] && (plotData[i] || plotData[j]);
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) {
    const row = y * W, jy = y - y0;
    for (let x = x0; x <= x1; x++) {
      const i = row + x, ix = x - x0;
      if (x + 1 < W && diff(i, i + 1)) { ctx.moveTo(X[ix + 1], Y[jy]); ctx.lineTo(X[ix + 1], Y[jy + 1]); }
      if (y + 1 < H && diff(i, i + W)) { ctx.moveTo(X[ix], Y[jy + 1]); ctx.lineTo(X[ix + 1], Y[jy + 1]); }
    }
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
}

/* --------------------------------------------------------------------------
   参考层：矢量顶点（唐 741 州面 + 现代单元边界）。
   线宽按**屏幕像素**给（1 / 缩放），所以缩到全图不糊、放到街道级不粗；
   放大到 12 倍以上时把原始顶点落成小方块——那才是"顶点图"该有的样子。
   每环的 Path2D 按格坐标建一次并缓存，平移缩放只改变换上矩阵，不重建路径。
   -------------------------------------------------------------------------- */
const refPathCache = [];
function refRingPath(r) {
  if (refPathCache[r] !== undefined) return refPathCache[r];
  const R = REF, s = R.off[r], e = R.off[r + 1];
  let p = null;
  if (e - s >= 2) {
    p = new Path2D();
    p.moveTo(R.xy[s * 2] / 8, R.xy[s * 2 + 1] / 8);
    for (let i = s + 1; i < e; i++) p.lineTo(R.xy[i * 2] / 8, R.xy[i * 2 + 1] / 8);
  }
  refPathCache[r] = p;
  return p;
}
export function dropRefPathCache() { refPathCache.length = 0; }
const REF_DOT_SCALE = 12;          // 缩放 ≥ 此值才画顶点
const REF_DOT_MAX = 30000;         // 一帧最多落这么多顶点，免得街道级下糊住
function drawRefVector() {
  const R = REF;
  if (!R || !R.ready) return;
  const v = state.view;
  const gx0 = -v.x / v.s, gy0 = -v.y / v.s, gx1 = (VW - v.x) / v.s, gy1 = (VH - v.y) / v.s;
  const dots = v.s >= REF_DOT_SCALE;
  const bx = R.box;
  ctx.save();
  ctx.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  ctx.lineWidth = 1 / v.s; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(168,74,48,.55)";
  const dotPts = dots ? [] : null;
  for (let r = 0; r < R.n; r++) {
    if (bx[r * 4 + 2] < gx0 || bx[r * 4] > gx1 || bx[r * 4 + 3] < gy0 || bx[r * 4 + 1] > gy1) continue;
    const p = refRingPath(r);
    if (!p) continue;
    ctx.stroke(p);
    if (dotPts && dotPts.length < REF_DOT_MAX * 2) {
      const s = R.off[r], e = R.off[r + 1];
      for (let i = s; i < e && dotPts.length < REF_DOT_MAX * 2; i++) {
        dotPts.push(R.xy[i * 2] / 8, R.xy[i * 2 + 1] / 8);
      }
    }
  }
  if (dotPts && dotPts.length) {
    const d = 2.4 / v.s;
    ctx.fillStyle = "rgba(112,28,14,.92)";
    for (let i = 0; i < dotPts.length; i += 2) ctx.fillRect(dotPts[i] - d / 2, dotPts[i + 1] - d / 2, d, d);
  }
  ctx.restore();
}

/* --------------------------------------------------------------------------
   选中 / 悬停对象的轮廓：路径按"格坐标"建好并缓存，平移缩放只改变换不改路径。
   （全图边界线默认不画——大色块本身已经说明了分界，需要时再用顶栏开关打开）
   -------------------------------------------------------------------------- */
const OUTLINE_MAX = 24000;                 // 像元太多的对象不描轮廓（成本不值当）
const outlineCache = new Map();
function outlineFor(unit, id) {
  if (unit === "terrain" || id === undefined || id === null || id < 0) return null;
  const key = unit + "|" + id;
  const hit = outlineCache.get(key);
  if (hit !== undefined) return hit;
  let path = null;
  const arrs = cellsFor(unit, id);
  let total = 0;
  for (const a of arrs) total += a.length;
  if (total && total <= OUTLINE_MAX) {
    path = new Path2D();
    for (const arr of arrs) {
      const inSet = new Set();
      for (let n = 0; n < arr.length; n++) inSet.add(arr[n]);
      for (let n = 0; n < arr.length; n++) {
        const k = arr[n], x = k % W, y = (k - x) / W;
        if (x === 0 || !inSet.has(k - 1)) { path.moveTo(x, y); path.lineTo(x, y + 1); }
        if (x + 1 >= W || !inSet.has(k + 1)) { path.moveTo(x + 1, y); path.lineTo(x + 1, y + 1); }
        if (y === 0 || !inSet.has(k - W)) { path.moveTo(x, y); path.lineTo(x + 1, y); }
        if (y + 1 >= H || !inSet.has(k + W)) { path.moveTo(x, y + 1); path.lineTo(x + 1, y + 1); }
      }
    }
  }
  if (outlineCache.size > 12) outlineCache.clear();
  outlineCache.set(key, path);
  return path;
}
export function dropOutlineCache() { outlineCache.clear(); }
function strokePath(path, style, widthPx) {
  if (!path) return;
  const v = state.view;
  ctx.save();
  ctx.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.lineWidth = widthPx / v.s;                 // 屏幕像素宽
  ctx.strokeStyle = style;
  ctx.stroke(path);
  ctx.restore();
}
function drawOutline() {
  const unit = state.unit;
  const hov = state.hover[unit];
  if (hov !== undefined && hov !== state.sel[unit]) strokePath(outlineFor(unit, hov), "rgba(46,42,36,.35)", 1);
  strokePath(outlineFor(unit, state.sel[unit]), "rgba(28,24,20,.92)", 2);
  if (unit === "block" && !state.sel.block && state.sel.plot) {
    /* 还没选块区：把"允许的范围"（当前地块）圈出来 */
    strokePath(outlineFor("plot", state.sel.plot), "rgba(140,47,35,.7)", 1.4);
  }
}

/* ---------------------------------------------------------------- 高亮层 */
let overlayKey = "", overlayDirty = true, overlayEmpty = true, overlayBox = null;
export const markOverlayDirty = () => { overlayDirty = true; };
function cellsFor(unit, id) {
  if (!id && id !== 0) return [];
  if (unit === "plot") { const a = getCellsOf().get(id); return a ? [a] : []; }
  if (unit === "block") { const a = getCellsOfBlock().get(id); return a ? [a] : []; }
  if (unit === "domain") {
    const out = [];
    if (id < 0) return out;
    for (const [pid, arr] of getCellsOf()) {
      const p = state.plots[pid];
      if (p && p.d === id) out.push(arr);
    }
    return out;
  }
  return [];
}
function drawOverlay() {
  const unit = state.unit;
  const selId = state.sel[unit], hovId = state.hover[unit];
  const key = unit + "|" + selId + "|" + hovId;
  if (key !== overlayKey || overlayDirty) {
    const od = overlayImg.data; od.fill(0);
    let any = false, box = null;
    /* 边涂边记这一帧的包围盒：回写只走「上一帧 ∪ 这一帧」那一块。
       每一帧只画上一层、上一帧的像元也已在这一块里被清零，所以按块回写是完整的；
       原先每次都整幅（5.2M 像元 ≈ 21 MB）回传，换一次选中/悬停对象就卡一下。 */
    const touch = k => {
      const x = k % W, y = (k - x) / W;
      if (!box) box = [x, y, x + 1, y + 1];
      else {
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x + 1 > box[2]) box[2] = x + 1;
        if (y + 1 > box[3]) box[3] = y + 1;
      }
    };
    const paint = (kind, id, c, a) => {
      for (const arr of cellsFor(kind, id)) {
        if (!arr.length) continue;
        any = true;
        for (let n = 0; n < arr.length; n++) {
          const k = arr[n], j = k * 4;
          od[j] = c[0]; od[j + 1] = c[1]; od[j + 2] = c[2]; od[j + 3] = a;
          touch(k);
        }
      }
    };
    if (hovId !== undefined && hovId !== selId) paint(unit, hovId, [64, 54, 38], 92);
    paint(unit, selId, [140, 47, 35], 168);
    /* 块区单元下还没选块区时，把"当前地块"的范围铺一层淡色：新建块区只能落在这片里 */
    if (unit === "block" && !state.sel.block && state.sel.plot) paint("plot", state.sel.plot, [210, 190, 120], 72);
    const prev = overlayBox;
    const out = !prev ? box : !box ? prev
      : [Math.min(prev[0], box[0]), Math.min(prev[1], box[1]),
         Math.max(prev[2], box[2]), Math.max(prev[3], box[3])];
    if (out) overlayCtx.putImageData(overlayImg, 0, 0, out[0], out[1], out[2] - out[0], out[3] - out[1]);
    overlayKey = key; overlayDirty = false; overlayEmpty = !any; overlayBox = box;
  }
  if (!overlayEmpty) blit(overlayCanvas, W, H);
}
/* 悬停格：屏幕空间描一格虚线 */
function drawHoverCell() {
  const i = state.curCell; if (i < 0) return;
  const x = i % W, y = (i - x) / W, v = state.view;
  const s = Math.max(3, v.s);
  ctx.save();
  ctx.strokeStyle = "rgba(46,42,36,.9)"; ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(v.x + x * v.s) + 0.5, Math.round(v.y + y * v.s) + 0.5, Math.round(s), Math.round(s));
  ctx.restore();
}
/* 圆形笔刷在地图上的可预见范围 */
function drawBrushRing() {
  const i = state.curCell;
  if (i < 0) return;
  const x = i % W, y = (i - x) / W, rad = brushRadius();
  const cxp = state.view.x + (x + 0.5) * state.view.s, cyp = state.view.y + (y + 0.5) * state.view.s;
  const rpx = Math.max(2, (rad - 0.5) * state.view.s);
  ctx.strokeStyle = state.pen ? "rgba(46,42,36,.9)" : "rgba(150,60,40,.95)";
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(cxp, cyp, rpx, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.72)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cxp, cyp, rpx + 1.2, 0, Math.PI * 2); ctx.stroke();
  if (!state.pen) {                       // 橡皮：圈内加一道斜杠，形状上一眼可辨
    const k = rpx * 0.72;
    ctx.strokeStyle = "rgba(150,60,40,.75)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cxp - k, cyp + k); ctx.lineTo(cxp + k, cyp - k); ctx.stroke();
  }
}
let raf = 0;
export function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

/* ---------------------------------------------------------------- 页脚与悬停贴 */
export function unitInfoText(i) {
  if (i < 0) return "";
  const id = state.plot[i], b = state.dist[i], t = state.terr[i];
  const p = state.plots[id];
  const parts = [`地块 ${id || "无"}${p ? " " + p.n : ""}`];
  parts.push(`块区 ${b || "无"}${state.blocks[b] ? " " + state.blocks[b].n : ""}`);
  parts.push(`地形 ${terName(t)}`);
  return parts.join(" ｜ ");
}
export function objectLine(unit, id) {
  if (unit === "domain") return id >= 0 ? `地域 ${DOMNAME(id)}` : "地域（未选）";
  if (unit === "plot") return id ? `地块 ${id} ${state.plots[id] ? state.plots[id].n : ""}` : "地块（未选）";
  if (unit === "block") return id ? `块区 ${id} ${state.blocks[id] ? state.blocks[id].n : ""}` : "块区（未选）";
  return `地形 ${terName(id)}`;
}
const DOMNAME = i => (DOM[i] ? DOM[i].g + " · " + DOM[i].d : "—");

export function updateFooter() {
  const F = FIT();
  const z = document.getElementById("fZoom");
  if (z) z.textContent = `缩放 ${(state.view.s / F).toFixed(2)}× · 1 屏像素 ≈ ${
    (G.cell * 111 / state.view.s).toFixed(2)} km`;
  const cs = document.getElementById("fCursor");
  if (cs) cs.textContent = cursorText;
  const fc = document.getElementById("fCell");
  if (fc) fc.textContent = state.curCell >= 0
    ? `格 ${state.curCell % W},${Math.floor(state.curCell / W)} ｜ ${unitInfoText(state.curCell)}` : "";
  const chip = document.getElementById("chip");
  if (chip) {
    const i = state.curCell;
    if (i < 0 || state.mode !== "view") { chip.hidden = true; }
    else {
      const u = state.unit;
      const id = u === "plot" ? state.plot[i] : u === "block" ? state.dist[i]
               : u === "domain" ? (state.plots[state.plot[i]] || {}).d ?? -1 : state.terr[i];
      chip.hidden = false;
      chip.textContent = objectLine(u, u === "domain" ? (id === undefined ? -1 : id) : id);
      const x = state.view.x + ((i % W) + 1) * state.view.s + 10;
      const y = state.view.y + Math.floor(i / W) * state.view.s + 8;
      chip.style.transform = `translate(${Math.max(4, Math.min(VW - 12, x))}px,${Math.max(4, Math.min(VH - 30, y))}px)`;
    }
  }
}

/* 边界层重建（防抖 300ms，一次拖拽里不反复扫全图） */
let edgeTimer = 0, edgePending = false;
export function markEdgesDirty(onReady) {
  edgePending = true;
  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(() => {
    if (!edgePending) return;
    edgePending = false;
    buildEdgesNow();
    onReady && onReady();
    state.dirty = true; schedule();
  }, 300);
}
export const isEdgeDirty = () => edgePending;
export function buildEdgesNow() {
  buildEdges(plotData, distData);
  buildEdgeMips(plotData, distData, 5);
  rebuildPlotColors();                    // 地块邻接可能变了 → 重算"相邻必不同"的配色
  repaintPlotLayer();
  dropOutlineCache();
  edgePending = false;
}
