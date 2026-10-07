/* ==========================================================================
   state.js —— 世界状态：地块/块区/地形、归属台账、撤销栈、统计、增量存档
   ========================================================================== */

import { DATA, W, H, NC, DOM, GEO_INDEX, COLOR, UNASSIGNED, toRgb,
         plotColorFallback, PLOT_PALETTE, blockColor,
         ALPHA_ASSIGNED, ALPHA_FREE, ALPHA_PLOTMODE, ALPHA_BLOCK,
         LS_KEY, LS_PREFIX, LS_HELP, LAY_KEY, T_PLAIN,
         R_DEF, terColor } from "./config.js";
import { plotData, terrData, distData, plotImg, terImg, distImg,
         idImg, distIdImg, terRawImg, plotCtx, terCtx, distCtx, idCtx, distIdCtx, terRawCtx,
         flushAll, putBox, BASE, EDGE_COLORS } from "./raster.js";

/* ---------------- 状态 ---------------- */
export const state = {
  plot: plotData, terr: terrData, dist: distData,
  plots: {},                       // 地块编码 → {n 名称, g 地缘下标, d 地域下标}
  blocks: {},                      // 块区编码 → {n 名称, p 所属地块编码}
  nextId: 1, nextBid: 1,
  sel: { domain: 0, plot: 0, block: 0, terrain: T_PLAIN },   // 每个单元"当前对象"（编辑层=笔刷，视图层=选中）
  hover: { domain: -1, plot: 0, block: 0, terrain: -1 },      // 光标下的同类对象（轻量高亮）
  curCell: -1, selCell: -1,                        // selCell = 右键选中的那一格（新建对象的落点）
  showTerrain: true, showRef: false, showEdge: false, showBEdge: false,   // 边界线默认不画（用选中轮廓代替）
  view: { s: 1, x: 0, y: 0 },
  /* 工具状态：main.js 的启动序列一上来就调 setMode/setUnit/setRadius/setPen，
     初值必须在这里给全 —— 缺 unit 会让 setMode 里的 UNIT[state.unit].tip 抛错、init 直接中止
     （本地有同基线存档时 applySnapshot 顺手补了 unit，才把问题盖住了）；
     缺 radius 会让半径钳位算出 NaN，笔刷范围为空、一格都涂不上。 */
  unit: "plot", mode: "edit", pen: true, radius: R_DEF,
  dirty: true, hist: [], histAt: -1,
};
export const touched = new Set();       // 本次会话改过的像元（存档只存这些）
export const brushRadius = () => state.radius;                                  // 半径（格）
export const selOf = u => state.sel[u === undefined ? state.unit : u];
export const setSel = (u, v) => { state.sel[u] = v; };

/* ---------------- 配色与写像素 ---------------- */
/* 地块层的着色口径：地块单元 = 按编码散开；其余单元 = 按地域（更可读） */
export const plotColorMode = () => (state.unit === "plot" ? "plot" : "domain");
export function plotAlpha(id) {
  if (!id) return 0;
  if (plotColorMode() === "plot") return ALPHA_PLOTMODE;
  const p = state.plots[id];
  return (p && p.d >= 0) ? ALPHA_ASSIGNED : ALPHA_FREE;
}
/* --------------------------------------------------------------------------
   地块配色表（相邻必不同）：一次性扫 5.2M 像元收集邻接关系，再贪心着色。
   只依赖像元的地块编码，所以每次"边界层重建"时顺带重算即可（已经防抖）。
   -------------------------------------------------------------------------- */
export const PLOT_COLOR = { map: new Map() };
/* 返回**颜色串**。这里不能写 `map.get(id) || plotColorFallback(id)`：
   调色板下标 0 是个假值，会被误判成"还没算过"，于是第 0 号色的地块掉回散列色。 */
export const plotColorOf = id => PLOT_COLOR.map.get(id) ?? plotColorFallback(id);
export function rebuildPlotColors() {
  const p = state.plot, W_ = W, H_ = H;
  const adj = new Map();
  const link = (a, b) => {
    let sa = adj.get(a); if (!sa) { sa = new Set(); adj.set(a, sa); }
    let sb = adj.get(b); if (!sb) { sb = new Set(); adj.set(b, sb); }
    sa.add(b); sb.add(a);
  };
  for (let y = 0; y < H_; y++) {
    const row = y * W_;
    for (let x = 0; x < W_; x++) {
      const i = row + x, a = p[i];
      if (!a) continue;
      if (x + 1 < W_) { const b = p[i + 1]; if (b && b !== a) link(a, b); }
      if (y + 1 < H_) { const b = p[i + W_]; if (b && b !== a) link(a, b); }
    }
  }
  const ids = Object.keys(state.plots).map(Number);
  for (const id of ids) if (!adj.has(id)) adj.set(id, new Set());   // 孤岛/空地也要有颜色
  ids.sort((a, b) => (adj.get(b).size - adj.get(a).size) || (a - b));   // 邻居多的先上色
  const color = new Map();
  for (const id of ids) {
    const used = new Set();
    for (const nb of adj.get(id)) if (color.has(nb)) used.add(color.get(nb));
    let c = 0;
    while (used.has(c)) c++;
    color.set(id, c % PLOT_PALETTE.length);          // 贪心这一步先按下标算
  }
  /* 但存进 PLOT_COLOR.map 的必须是**颜色串**：调用链是 plotRgbOf → toRgb(str)，
     它要的是颜色。存下标的话 toRgb 会收到数字，(5).match 抛
     "str.match is not a function" —— 整个 init 因此中断，编辑器停在"载入失败"。 */
  PLOT_COLOR.map = new Map([...color].map(([id, i]) => [id, PLOT_PALETTE[i]]));
  return PLOT_COLOR.map;
}

export function plotRgbOf(id) {
  const p = state.plots[id];
  if (plotColorMode() === "domain") {
    const d = p ? p.d : -1;
    return toRgb(d >= 0 ? COLOR[d] : UNASSIGNED);
  }
  if (!id) return toRgb(UNASSIGNED);
  return toRgb(plotColorOf(id));
}
export function blockRgbOf(bid) {
  if (!bid) return toRgb(UNASSIGNED);
  const b = state.blocks[bid];
  return toRgb(b && b.p ? blockColor(bid) : "#a9a396");        // 未挂地块的块区画灰
}
export function writeAll(i) {
  const j = i * 4, id = state.plot[i], t = state.terr[i], b = state.dist[i];
  const col = plotRgbOf(id), pd = plotImg.data;
  pd[j] = col[0]; pd[j + 1] = col[1]; pd[j + 2] = col[2]; pd[j + 3] = plotAlpha(id);
  const tc = toRgb(terColor(t)), td = terImg.data;
  td[j] = tc[0]; td[j + 1] = tc[1]; td[j + 2] = tc[2]; td[j + 3] = 255;
  const bc = blockRgbOf(b), bd = distImg.data;
  bd[j] = bc[0]; bd[j + 1] = bc[1]; bd[j + 2] = bc[2]; bd[j + 3] = b ? ALPHA_BLOCK : 0;
  const idd = idImg.data;
  idd[j] = id & 255; idd[j + 1] = id >> 8; idd[j + 2] = 0; idd[j + 3] = 255;
  const did = distIdImg.data;
  did[j] = b & 255; did[j + 1] = b >> 8; did[j + 2] = 0; did[j + 3] = 255;
  const trd = terRawImg.data; trd[j] = trd[j + 1] = trd[j + 2] = t; trd[j + 3] = 255;
}
export const writeCell = writeAll;

export function repaintAll() {
  for (let i = 0; i < NC; i++) writeAll(i);
  plotCtx.putImageData(plotImg, 0, 0); terCtx.putImageData(terImg, 0, 0);
  distCtx.putImageData(distImg, 0, 0);
  idCtx.putImageData(idImg, 0, 0); distIdCtx.putImageData(distIdImg, 0, 0);
  terRawCtx.putImageData(terRawImg, 0, 0);
  state.dirty = true;
}
/* 只重刷地块着色层（切换单元时用，比重建档便宜） */
export function repaintPlotLayer() {
  const pd = plotImg.data;
  for (let i = 0, j = 0; i < NC; i++, j += 4) {
    const id = state.plot[i], col = plotRgbOf(id);
    pd[j] = col[0]; pd[j + 1] = col[1]; pd[j + 2] = col[2]; pd[j + 3] = plotAlpha(id);
  }
  plotCtx.putImageData(plotImg, 0, 0);
  state.dirty = true;
}
/* 只重绘某地块 / 某块区（涂地域、改归属时避免整图重绘）。
   回写只走这个对象的**包围盒**：cellsOf 的数组是计数排序产出的（下标升序），
   首尾像元就是包围盒的对角。原先无脑 putImageData(img, 0, 0) 每次整幅回传
   两层 5.2M 像元 ≈ 21 MB —— 半径 50 的笔刷扫过 43 个地块时就是 43 × 2 次全图上传，
   实测 564 ms；改成按块回写后同样的操作降到个位数毫秒。 */
function boxOfSorted(arr) {
  const a = arr[0], b = arr[arr.length - 1];
  const ax = a % W, ay = (a - ax) / W, bx = b % W, by = (b - bx) / W;
  return [ax, ay, bx + 1, by + 1];
}
export function repaintPlot(id) {
  const arr = cellsOf.get(id); if (!arr || !arr.length) return;
  const col = plotRgbOf(id), alpha = plotAlpha(id);
  const pd = plotImg.data, idd = idImg.data;
  for (let n = 0; n < arr.length; n++) {
    const j = arr[n] * 4;
    pd[j] = col[0]; pd[j + 1] = col[1]; pd[j + 2] = col[2]; pd[j + 3] = alpha;
    idd[j] = id & 255; idd[j + 1] = id >> 8; idd[j + 2] = 0; idd[j + 3] = 255;
  }
  const b = boxOfSorted(arr);
  putBox(plotCtx, plotImg, b); putBox(idCtx, idImg, b);
  state.dirty = true;
}
export function repaintBlock(bid) {
  const arr = cellsOfBlock.get(bid); if (!arr || !arr.length) return;
  const col = blockRgbOf(bid), bd = distImg.data, did = distIdImg.data;
  for (let n = 0; n < arr.length; n++) {
    const j = arr[n] * 4;
    bd[j] = col[0]; bd[j + 1] = col[1]; bd[j + 2] = col[2]; bd[j + 3] = ALPHA_BLOCK;
    did[j] = bid & 255; did[j + 1] = bid >> 8; did[j + 2] = 0; did[j + 3] = 255;
  }
  const b = boxOfSorted(arr);
  putBox(distCtx, distImg, b); putBox(distIdCtx, distIdImg, b);
  state.dirty = true;
}

/* ---------------- 统计（计数排序，O(N) 且不产生 JS 小对象） ---------------- */
export let domCells = new Int32Array(DOM.length), cellsWithPlot = 0, cellsWithBlock = 0;
export let cellsOf = new Map(), plotCells = {}, cellsOfBlock = new Map(), blockCells = {};
export function recount() {
  const N = NC;
  const p = state.plot, d = state.dist;
  /* 容量取「实际出现的最大编号」，不能只看 nextId：手改存档、或合并两份存档时，
     nextId 可能比台账与栅格里的编号都小 —— 编号更大的地块会整块统计不到，
     看着像"这地块空了"（面积 0、没轮廓、"清空编码"也清不掉），其实像元还在栅格里。
     台账最大编号从键上读（免费），栅格最大编号要多扫一趟栅格（745 万格，几毫秒）——
     两处都要看：台账与栅格可以各自有对方没有的编号。 */
  let maxP = state.nextId, maxB = state.nextBid;
  for (const k in state.plots) { const v = +k; if (v > maxP) maxP = v; }
  for (const k in state.blocks) { const v = +k; if (v > maxB) maxB = v; }
  for (let i = 0; i < N; i++) {
    const id = p[i]; if (id > maxP) maxP = id;
    const b = d[i]; if (b > maxB) maxB = b;
  }
  const capP = Math.max(2, maxP + 1), capB = Math.max(2, maxB + 1);
  const cntP = new Int32Array(capP), cntB = new Int32Array(capB);
  let np = 0, nb = 0;
  for (let i = 0; i < N; i++) {
    const id = p[i]; if (id) { if (id < capP) cntP[id]++; np++; }
    const b = d[i]; if (b) { if (b < capB) cntB[b]++; nb++; }
  }
  const startP = new Int32Array(capP), startB = new Int32Array(capB);
  let acc = 0;
  for (let i = 0; i < capP; i++) { startP[i] = acc; acc += cntP[i]; }
  acc = 0;
  for (let i = 0; i < capB; i++) { startB[i] = acc; acc += cntB[i]; }
  const arrP = new Int32Array(np), arrB = new Int32Array(nb);
  const curP = startP.slice(), curB = startB.slice();
  for (let i = 0; i < N; i++) {
    const id = p[i]; if (id && id < capP) arrP[curP[id]++] = i;
    const b = d[i]; if (b && b < capB) arrB[curB[b]++] = i;
  }
  const co = new Map(), pc = {};
  for (let id = 1; id < capP; id++) {
    if (!cntP[id]) continue;
    co.set(id, arrP.subarray(startP[id], startP[id] + cntP[id]));
    pc[id] = cntP[id];
  }
  const cob = new Map(), bc = {};
  for (let id = 1; id < capB; id++) {
    if (!cntB[id]) continue;
    cob.set(id, arrB.subarray(startB[id], startB[id] + cntB[id]));
    bc[id] = cntB[id];
  }
  const dm = new Int32Array(DOM.length);
  for (const [id, n] of Object.entries(pc)) {
    const pl = state.plots[id];
    if (pl && pl.d >= 0) dm[pl.d] += n;
  }
  cellsOf = co; plotCells = pc; domCells = dm; cellsWithPlot = np;
  cellsOfBlock = cob; blockCells = bc; cellsWithBlock = nb;
}
export const getCellsOf = () => cellsOf;
export const getPlotCells = () => plotCells;
export const getCellsOfBlock = () => cellsOfBlock;
export const getBlockCells = () => blockCells;

/* ---------------- 台账写操作（都在手势里记一步，可撤销） ---------------- */
/* 地块/块区编码写在 PNG 的 R、G 两个通道（`R + G×256`），上限就是 65535。
   超限时 writeAll 的 `id & 255 / id >> 8` 会把两个不同对象写进同一格、互相覆盖，
   而且**不报错** —— 所以宁可在分配处就拒绝，返回 0 由调用方提示。 */
export const ID_MAX = 65535;
export function newPlot(name) {
  if (state.nextId > ID_MAX) return 0;
  const id = state.nextId++;
  state.plots[id] = { n: name || `新地块 ${id}`, g: -1, d: -1 };
  return id;
}
export function newBlock(name, owner) {
  if (state.nextBid > ID_MAX) return 0;
  const id = state.nextBid++;
  state.blocks[id] = { n: name || `新块区 ${id}`, p: owner || 0 };
  return id;
}
/* 删掉一条台账（进撤销栈）：applyMeta 认 `to === null` 为"删除"，
   所以这里把 from 记全、to 记 null，撤销就能把记录原样还原。 */
export function dropMeta(obj, id) {
  const store = obj === "plot" ? state.plots : state.blocks;
  if (!store[id]) return false;
  const from = Object.assign({}, store[id]);
  delete store[id];
  if (gesture) gesture.meta.push({ obj, id, from, to: null });
  return true;
}
function metaTouch(obj, id, patch) {
  const store = obj === "plot" ? state.plots : state.blocks;
  const cur = store[id] || (store[id] = obj === "plot" ? { n: `地块 ${id}`, g: -1, d: -1 }
                                                     : { n: `块区 ${id}`, p: 0 });
  const from = Object.assign({}, cur);
  Object.assign(cur, patch);
  /* 取消指派（d < 0）时要连地缘一起清掉，否则台账 CSV 的「地缘」列会留着旧值、与空的「地域」列矛盾 */
  if (obj === "plot" && "d" in patch) cur.g = patch.d >= 0 ? GEO_INDEX[DOM[patch.d].g] : -1;
  if (gesture) gesture.meta.push({ obj, id, from, to: Object.assign({}, cur) });
  return { cur, from };
}
/* 改地块的地域（顺带改地缘），并只重绘这个地块 */
export function setPlotDomain(id, d) {
  const old = state.plots[id] ? state.plots[id].d : -1;
  if (old === d) return false;
  metaTouch("plot", id, { d });
  if (old >= 0) domCells[old] -= plotCells[id] || 0;
  if (d >= 0) domCells[d] += plotCells[id] || 0;
  repaintPlot(id);
  return true;
}
export function setPlotName(id, n) { metaTouch("plot", id, { n }); return true; }
/* 改块区的所属地块：越界的像元留给"修正"动作处理 */
export function setBlockOwner(bid, pid) {
  const old = state.blocks[bid] ? state.blocks[bid].p : 0;
  if (old === pid) return false;
  metaTouch("block", bid, { p: pid });
  repaintBlock(bid);
  return true;
}
export function setBlockName(bid, n) { metaTouch("block", bid, { n }); return true; }

/* ---------------- 撤销栈（一次手势 = 一步） ---------------- */
const K_PLOT = 0, K_TERR = 1, K_DIST = 2;
export const KIND = { plot: K_PLOT, terr: K_TERR, dist: K_DIST };
let gesture = null;
export function beginGesture() {
  if (!gesture) gesture = { idx: [], kind: [], from: [], to: [], meta: [] };
  return gesture;
}
export function endGesture(onCommit) {
  const g = gesture; gesture = null;
  if (!g || (!g.idx.length && !g.meta.length)) return;
  const op = { idx: Int32Array.from(g.idx), kind: Uint8Array.from(g.kind),
               from: Int32Array.from(g.from), to: Int32Array.from(g.to), meta: g.meta };
  state.hist = state.hist.slice(0, state.histAt + 1);
  state.hist.push(op);
  trimHist();
  /* 存档挂在这个"状态已经定形"的接缝上，而不是散在每个 UI 回调里：
     谁结束了一次手势都会落盘，将来新加的操作路径漏接也不会静默丢数据。 */
  autosave();
  onCommit && onCommit();
}
/* 撤销栈按「步数 + 像元总量」双上限裁剪，都从最旧的一步开始丢：
   半径 50 的一次长拖拽可以是几十万像元（一步 ≈ 13 B/像元），只限步数会吃出几百 MB。
   histCells 每次现算（栈深 ≤ 200，开销可忽略），省得再维护一个会忘记同步的计数器。 */
const HIST_MAX_STEPS = 200, HIST_MAX_CELLS = 6e6;
const histCells = () => state.hist.reduce((n, op) => n + op.idx.length, 0);
function trimHist() {
  while (state.hist.length > 1 &&
         (state.hist.length > HIST_MAX_STEPS || histCells() > HIST_MAX_CELLS)) {
    state.hist.shift();
  }
  state.histAt = state.hist.length - 1;
}
function applyMeta(m, dir) {
  const store = m.obj === "plot" ? state.plots : state.blocks;
  const val = dir > 0 ? m.to : m.from;
  if (val === null || val === undefined) delete store[m.id];      // 撤销"新建"= 删掉记录
  else store[m.id] = Object.assign({}, val);
  if (m.obj === "plot") repaintPlot(m.id); else repaintBlock(m.id);
}
function applyOp(op, dir) {
  const box = [W, H, 0, 0];
  for (let n = 0; n < op.idx.length; n++) {
    const k = op.idx[n], kind = op.kind[n], val = dir > 0 ? op.to[n] : op.from[n];
    if (kind === K_PLOT) state.plot[k] = val;
    else if (kind === K_TERR) state.terr[k] = val;
    else state.dist[k] = val;
    touched.add(k); writeAll(k);
    const x = k % W, y = (k - x) / W;
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
    if (x + 1 > box[2]) box[2] = x + 1; if (y + 1 > box[3]) box[3] = y + 1;
  }
  if (op.idx.length) flushAll(box);
  for (const m of op.meta) applyMeta(m, dir);
  state.dirty = true;
}
export function undo(onText) {
  if (state.histAt < 0) return false;
  applyOp(state.hist[state.histAt], -1); state.histAt--; autosave(onText); return true;
}
export function redo(onText) {
  if (state.histAt >= state.hist.length - 1) return false;
  applyOp(state.hist[++state.histAt], +1); autosave(onText); return true;
}
export const canUndo = () => state.histAt >= 0;
export const canRedo = () => state.histAt < state.hist.length - 1;

/* ---------------- 存档（只存增量，避免撑爆 localStorage） ---------------- */
export function snapshot() {
  const pi = [], pv = [], ti = [], tv = [], di = [], dv = [];
  for (const k of touched) {
    if (state.plot[k] !== BASE.plot[k]) { pi.push(k); pv.push(state.plot[k]); }
    if (state.terr[k] !== BASE.terr[k]) { ti.push(k); tv.push(state.terr[k]); }
    if (state.dist[k] !== BASE.dist[k]) { di.push(k); dv.push(state.dist[k]); }
  }
  return { v: 3, app: "zhulu-raster-editor", savedAt: Date.now(), base: DATA.base_tag,
           pi, pv, ti, tv, di, dv,
           plots: state.plots, blocks: state.blocks,
           nextId: state.nextId, nextBid: state.nextBid, sel: state.sel, unit: state.unit };
}
export function saveNow(onText) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot()));
    onText && onText("已保存 " + new Date().toLocaleTimeString().slice(0, 5));
    return true;
  } catch (e) { onText && onText("保存失败：" + e.message); return false; }
}
/* 自动保存：防抖 800 ms，但**最长只推迟 5 s**。
   纯防抖会被拖拽饿死 —— 画笔每动一下都重置计时器，按住不松手画一分钟，
   这一整段手势就始终没落盘，页面一崩全丢。所以再给一个"最晚必须写"的死线。
   状态文案沿用上一次传进来的那个（调用点不必每次都带）。 */
let saveTimer = 0, saveDeadline = 0, lastSaved = null;
export function autosave(onText) {
  if (onText) lastSaved = onText;
  const now = Date.now();
  if (!saveDeadline) saveDeadline = now + 5000;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDeadline = 0; saveNow(lastSaved); },
                         Math.max(0, Math.min(800, saveDeadline - now)));
  lastSaved && lastSaved("…未保存");
}
export function clearSave() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* 忽略 */ }
}
/* 启动时清掉旧版本的键：键名带版本（…v3），换版后 v2 的存档会永远留在浏览器里
   （本机实测残留过 59 KB 的 v2 存档 + 一个旧 help 键）。攒久了会顶到浏览器
   5 MB 上限，那时新存档写不进去 —— 所以每次启动扫一遍前缀，只留当前版本那三个。 */
export function purgeOldKeys() {
  const keep = new Set([LS_KEY, LAY_KEY, LS_HELP]);
  const dead = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX) && !keep.has(k)) dead.push(k);
    }
    for (const k of dead) localStorage.removeItem(k);      // 先收集再删，边遍历边删会漏项
  } catch (e) { /* 忽略（隐私模式等） */ }
  return dead;
}
export function applySnapshot(d) {
  state.plot.set(BASE.plot); state.terr.set(BASE.terr); state.dist.set(BASE.dist);
  touched.clear();
  for (let k = 0; k < (d.pi || []).length; k++) { state.plot[d.pi[k]] = d.pv[k]; touched.add(d.pi[k]); }
  for (let k = 0; k < (d.ti || []).length; k++) { state.terr[d.ti[k]] = d.tv[k]; touched.add(d.ti[k]); }
  for (let k = 0; k < (d.di || []).length; k++) { state.dist[d.di[k]] = d.dv[k]; touched.add(d.di[k]); }
  state.plots = d.plots || {};
  state.blocks = d.blocks || {};
  state.nextId = d.nextId || (Math.max(0, ...Object.keys(state.plots).map(Number)) + 1);
  state.nextBid = d.nextBid || (Math.max(0, ...Object.keys(state.blocks).map(Number)) + 1);
  state.sel = Object.assign({ domain: -1, plot: 0, block: 0, terrain: T_PLAIN }, d.sel || {});
  if (d.unit) state.unit = d.unit;
  state.hist = []; state.histAt = -1;
}
/* 只读本地存档、**不套用** —— 套不套得由调用方按"草稿/本地/真源三者是否同底"决定
   （工单 §4.6.5）。loadLocal 把读与套糅在一起，草稿场景下需要拆开。 */
export function peekLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY); if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}
export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY); if (!raw) return false;
    const d = JSON.parse(raw);
    if (d.base !== DATA.base_tag) return "mismatch";
    applySnapshot(d);
    return (d.pi || []).length + (d.ti || []).length + (d.di || []).length;
  } catch (e) { return false; }
}
export function seedPlots() {
  /* 种子台账 = 管线给的地块底稿。`domain` 是设计数据（某地块属于哪个地域），
     由 tools/import_editor.py 从编辑器台账写进 data.js，这里读回来——
     否则每次「清空本地存档」都会把手工指派好的地域全丢掉。 */
  const domIdx = new Map();
  DOM.forEach((d, i) => { if (!domIdx.has(d.d)) domIdx.set(d.d, i); });
  state.plots = {};
  for (const p of DATA.plots) {
    const d = (p.domain !== undefined && domIdx.has(p.domain)) ? domIdx.get(p.domain) : -1;
    state.plots[p.id] = { n: p.name, g: d >= 0 ? GEO_INDEX[DOM[d].g] : -1, d };
  }
  state.nextId = Math.max(1, ...DATA.plots.map(p => p.id)) + 1;
  state.sel.plot = DATA.plots[0] ? DATA.plots[0].id : 0;
  state.blocks = {};
  state.nextBid = 1;
}

/* ---------------- 一致性检查：块区是否越出所属地块 ---------------- */
export function blockStrays(bid) {
  const b = state.blocks[bid]; if (!b || !b.p) return 0;
  const arr = cellsOfBlock.get(bid); if (!arr) return 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (state.plot[arr[i]] !== b.p) n++;
  return n;
}

/* --------------------------------------------------------------------------
   飞地检测：一个地块 / 块区被拆成几块互不相连的像元集合（4 邻域连通）
   海岛、真实飞地、以及"手滑涂远了"都会表现为多连通块——所以这里只报事实，
   拆不拆由人决定（`splitComponent` 可把任意一块拆成新的地块/块区）。
   -------------------------------------------------------------------------- */
export function componentsOf(kind, id) {
  const map = kind === "block" ? cellsOfBlock : cellsOf;
  const cells = map.get(+id);
  if (!cells || !cells.length) return [];
  const inObj = new Set();
  for (let i = 0; i < cells.length; i++) inObj.add(cells[i]);
  const seen = new Set(), out = [];
  for (let n = 0; n < cells.length; n++) {
    const start = cells[n];
    if (seen.has(start)) continue;
    const stack = [start], comp = [];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      const x = k % W, y = (k - x) / W;
      if (x > 0) { const j = k - 1; if (inObj.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); } }
      if (x + 1 < W) { const j = k + 1; if (inObj.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); } }
      if (y > 0) { const j = k - W; if (inObj.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); } }
      if (y + 1 < H) { const j = k + W; if (inObj.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); } }
    }
    out.push(comp);
  }
  out.sort((a, b) => b.length - a.length);        // 第 0 块永远是最大块（主体）
  return out;
}
/* 把第 idx 个连通块拆成新的地块 / 块区（自成一步撤销） */
export function splitComponent(kind, id, idx, name) {
  const comps = componentsOf(kind, id);
  if (comps.length < 2) return 0;
  const comp = comps[idx];
  if (!comp) return 0;
  const owner = kind === "block" ? (state.blocks[id] ? state.blocks[id].p : 0) : 0;
  const newId = kind === "block" ? newBlock(name, owner) : newPlot(name);
  if (!newId) return 0;             // 编码到上限：不拆，交给调用方提示（别写坏栅格）
  const src = kind === "block" ? state.dist : state.plot;
  const g = beginGesture();
  for (let n = 0; n < comp.length; n++) {
    const k = comp[n];
    g.idx.push(k); g.kind.push(kind === "block" ? KIND.dist : KIND.plot);
    g.from.push(src[k]); g.to.push(newId);
    src[k] = newId; touched.add(k);
    writeAll(k);
  }
  /* 新台账也做成一步：撤销时把记录删掉（applyMeta 认 null = 删除） */
  g.meta.push({ obj: kind === "block" ? "block" : "plot", id: newId, from: null,
                to: Object.assign({}, kind === "block" ? state.blocks[newId] : state.plots[newId]) });
  endGesture();                     // 自成一步：不留给下一个手势，否则这一步永远进不了撤销栈
  return newId;
}
/* 全图扫描：谁被拆成了多块（含海岛，只报事实） */
export function scanParts(limit) {
  const out = [];
  for (const [id, arr] of cellsOf) {
    if (arr.length < 2) continue;
    const n = componentsOf("plot", id).length;
    if (n > 1) out.push({ kind: "plot", id, cells: arr.length, parts: n });
  }
  for (const [id, arr] of cellsOfBlock) {
    if (arr.length < 2) continue;
    const n = componentsOf("block", id).length;
    if (n > 1) out.push({ kind: "block", id, cells: arr.length, parts: n });
  }
  out.sort((a, b) => b.parts - a.parts || b.cells - a.cells);
  return limit ? out.slice(0, limit) : out;
}
