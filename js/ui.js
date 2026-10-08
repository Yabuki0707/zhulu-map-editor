/* ==========================================================================
   ui.js —— 界面：模式/单元、SVG 笔刷控件、左右面板、检视器、导入导出、键鼠
   视图层与编辑层共用同一组对象：左栏列出"当前单元"的对象，点选即选中；
   编辑模式下选中的对象就是笔刷对象。

   **只读自然层（地形 / 气候）的知识不在这里**：它们由 js/ro.js 的 `RO_LAYERS` 描述，
   本文件只留三条通用路径 —— 顶栏按钮由表生成、左栏面板调 `layer.panel(stats)`、
   右栏检视器调 `layer.insp(stats)`。所以"加一层自然层"不用碰这个文件（2026-10-09 抽的）。
   ========================================================================== */

import { DATA, G, W, NC, DOM, COLOR, UNASSIGNED,
         UNIT, R_MIN, R_MAX, R_DEF, LAY_KEY, LS_HELP, T_OCEAN, blockColor, rowLat,
         isEditable } from "./config.js";
import { RO_KEYS, RO_ORDER, roLayer, isRoUnit, esc, buildRoStats,
         setRoView, RO_VIEW, cellFields } from "./ro.js";
import { BASE, idCanvas, flushAll, climData } from "./raster.js";
import { loadRef, REF } from "./refvec.js";
import { state, recount, getCellsOf, getPlotCells, getCellsOfBlock, getBlockCells, repaintAll, repaintPlotLayer, newPlot, newBlock, componentsOf, splitComponent, scanParts, setPlotDomain, setPlotName, setBlockOwner, setBlockName, undo, redo, saveNow, autosave, snapshot, applySnapshot, seedPlots, clearSave, dropMeta, ID_MAX, domCells, cellsWithPlot, cellsWithBlock, blockStrays, touched, beginGesture, writeAll, repaintTerrain } from "./state.js";
import { cv, resize, fit, FIT, schedule, markOverlayDirty, setSpace, setCursorText,
         viewSize, toCell, centerOn, anchorCell, buildEdgesNow, dropOutlineCache,
         markEdgesDirty, dropRefPathCache } from "./render.js";
import { stamp, stampLine, commit, takeSkipped } from "./paint.js";

const $ = id => document.getElementById(id);
const isField = el => !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" ||
                               el.tagName === "TEXTAREA" || el.isContentEditable);

/* ---------------- 轻提示 ---------------- */
let toastTimer = 0;
export function toast(msg, ms) {
  const el = $("toast"); if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || 1800);
}

/* ---------------- 模式（视图 / 编辑） ---------------- */
/* 自然层是**只读**单元（docs/adr/0001）：编辑模式里没有它们。
   两个口径都要收紧，缺一个就会留下"当前笔刷 = 地形"却无处落笔的悬空态：
     ① `coerceUnit` 把**当前单元**推到合法值；
     ② `syncRoButtons` 把**按钮**连分隔符一起藏起来（不是只藏地形那一个——
        气候原来漏了，于是编辑模式下还能点进一个只读层）。 */
function coerceUnit() {
  if (state.mode === "edit" && !isEditable(state.unit)) { state.unit = "plot"; return true; }
  return false;
}
function syncUnitButtons() {
  document.querySelectorAll("#unitSeg button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.unit === state.unit)));
}
/* 只读层的按钮（含组间分隔符）只在**视图模式**下出现 */
function syncRoButtons() {
  const edit = state.mode === "edit";
  for (const k of RO_KEYS) {
    const b = document.querySelector(`#unitSeg button[data-unit="${k}"]`);
    if (b) b.hidden = edit;
  }
  const sep = document.getElementById("roSep");
  if (sep) sep.hidden = edit;
}
export function setMode(m, silent) {
  state.mode = m;
  document.querySelectorAll("#modeSeg button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  syncRoButtons();
  if (coerceUnit()) { repaintPlotLayer(); syncUnitButtons(); }
  cv.style.cursor = m === "view" ? "grab" : (state.pen ? "crosshair" : "cell");
  $("hint").textContent = m === "view"
    ? "视图：拖拽平移 · 滚轮缩放 · 左右键都可点选对象 · 顶栏右侧可切自然层（只读）"
    : UNIT[state.unit].tip + " · " + (state.pen ? "笔" : "橡皮") + " · 右键选中";
  $("brushbox").style.opacity = m === "edit" ? "1" : ".5";
  markOverlayDirty();
  if (!silent) { renderLeft(); renderInspector(); }
  state.dirty = true; schedule();
}

/* ---------------- 单元（三个可编辑的 + 若干只读自然层） ---------------- */
export function setUnit(u) {
  if (!UNIT[u]) return;
  if (!isEditable(u) && state.mode === "edit") {
    const L = roLayer(u);
    toast(`${L.n}只读：${L.tip}（切到视图模式看；编辑模式里没有自然层）`, 3400);
    return;
  }
  state.unit = u;
  /* 底图着色切到当前层。⚠️ **离开只读层时要切回地形**：`want` 不能只在只读层上算——
     否则看过一次「气候」之后切回地块/块区，底图会一直留着气候配色（地块层是半透明的），
     而唯一能把它切回来的动作是再点一次「地形」。所以非只读单元一律 want = "terrain"。 */
  const want = isRoUnit(u) ? u : "terrain";
  if (RO_VIEW !== want) { setRoView(want); repaintTerrain(); }
  searchText = "";
  syncUnitButtons();
  repaintPlotLayer();                       // 地块层着色口径随单元变（边界线不受影响，不必重建）
  setMode(state.mode, true);
  renderLeft(); renderInspector(); markOverlayDirty(); schedule();
}

/* ---------------- 半径 / 笔与橡皮 ---------------- */
const RS = { x0: 9, x1: 123, w: 114 };
export function setRadius(v) {
  /* v 可能是 undefined/NaN（启动时 state.radius 还没定、或滑杆还没被拖过）：
     NaN 会穿过后面的 Math.max/Math.min，半径变 NaN → 笔刷范围为空、一格都涂不上 */
  const n = Math.round(v);
  state.radius = Number.isFinite(n) ? Math.max(R_MIN, Math.min(R_MAX, n)) : R_DEF;
  const t = (state.radius - R_MIN) / (R_MAX - R_MIN);
  const cx = RS.x0 + t * RS.w;
  const f = $("rFill"), k = $("rKnob"), d = $("rDot"), s = $("rslider");
  if (f) f.setAttribute("width", String(Math.max(0, cx - RS.x0)));
  if (k) k.setAttribute("cx", String(cx));
  if (d) d.setAttribute("cx", String(cx));
  if (s) s.setAttribute("aria-valuenow", String(state.radius));
  const lbl = $("brushVal"); if (lbl) lbl.textContent = String(state.radius);
  state.dirty = true; schedule();
}
export function setPen(on) {
  state.pen = !!on;
  const box = $("pentog");
  if (box) {
    box.dataset.pen = state.pen ? "1" : "0";
    box.querySelectorAll("button[data-pen]").forEach(b =>
      b.setAttribute("aria-checked", String((b.dataset.pen === "1") === state.pen)));
  }
  if (state.mode === "edit") cv.style.cursor = state.pen ? "crosshair" : "cell";
  setMode(state.mode, true);
}

/* ---------------- 选中对象（视图层＝选中；编辑层＝笔刷） ---------------- */
export function pickObject(unit, id, jump) {
  if (!UNIT[unit]) return;
  state.sel[unit] = id;
  if (state.unit !== unit) setUnit(unit);            // 换单元会连左右栏一起重渲染
  else { syncLeftSel(); renderInspector(); markOverlayDirty(); schedule(); }
  if (jump) { const c = anchorCell(unit, id); if (c >= 0) centerOn(c); }
}
export const plotNameOf = id => (id && state.plots[id] ? state.plots[id].n : `地块 ${id}`);

/* ================================================================ 新建
   不再有二级菜单：按**当前单元**决定新建什么，落点是"已选中的那一格"（右键选中）。
     单元 = 地块 → 新建地块，选中那一格归它
     单元 = 块区 → 新建块区，需先选中地块，且选中那格必须在该地块内
     单元 = 地域 → 不可新建（地域是设计层固定的 93 个）
     单元 = 任意只读自然层 → 不可新建（管线定稿，见 docs/adr/0001）
   没选落点或落点不合规时，提示"先去选中"。 */
export function newAtCurrent() {
  const u = state.unit;
  if (u === "domain") return toast("地域不可新建：地域是设计层固定的 93 个，用「地域」单元把地块指派进去", 2800);
  /* ⚠️ 这一条必须**拦住所有只读层**，不能只写 terrain：漏了 climate 的话，在气候视图里
     点「＋ 新建」会一路落到 `createBlockAt`，凭空建出一个块区（改的是行政层！）。 */
  if (isRoUnit(u)) {
    const L = roLayer(u);
    return toast(`${L.n}不可新建：${L.tip}。它是管线定稿的产品层，编辑器只读（docs/adr/0001）`, 3000);
  }
  const cell = state.selCell;
  if (cell < 0) return toast(u === "block"
    ? "先用右键在选中的地块内选一格作为落点"
    : "先用右键在地图上选一格，作为新地块的落点", 2800);
  return u === "plot" ? createPlotAt(cell) : createBlockAt(cell);
}
/* 在某一格上建地块：那一格立刻归它 */
export function createPlotAt(cell) {
  if (state.terr[cell] === T_OCEAN) {
    toast("海面上不能建地块：这一格的地形是「海洋」", 2800);
    return 0;
  }
  const id = newPlot(`新地块 ${state.nextId}`);
  if (!id) {
    toast(`地块编码已达上限 ${ID_MAX}：编码写在 PNG 的 R/G 通道（16 位），`
        + `再涨下去两个地块会写进同一格、互相覆盖且不报错。先合并或删掉一些地块。`, 3600);
    return 0;
  }
  addCellTo(cell, "plot", id);
  state.sel.plot = id; state.selCell = cell;
  commit(() => { recount(); refreshLeftCounts(); renderStats(); autosave(setSaved); });
  repaintPlotLayer(); markEdgesDirty();
  setUnit("plot");
  toast(`已建地块 ${id}：选中那一格已归它，继续用笔刷往外涂`, 2800);
  return id;
}
/* 在某一格上建块区：要求该格在"当前选中的地块"内 */
export function createBlockAt(cell) {
  const host = state.sel.plot;
  if (!host) { toast("先选中一个地块：右键点一格即可", 2800); return 0; }
  if (state.terr[cell] === T_OCEAN) {
    toast("海面上不能建块区：这一格的地形是「海洋」", 2800);
    return 0;
  }
  if (state.plot[cell] !== host) {
    const p = state.plot[cell];
    toast(`落点不在「${plotNameOf(host)}」内（这里是 ${p ? plotNameOf(p) : "无地块"}），换一格再选`, 2800);
    return 0;
  }
  const bid = newBlock(`新块区 ${state.nextBid}`, host);
  if (!bid) {
    toast(`块区编码已达上限 ${ID_MAX}：编码写在 PNG 的 R/G 通道（16 位）。先合并或删掉一些块区。`, 3600);
    return 0;
  }
  addCellTo(cell, "block", bid);
  state.sel.block = bid;
  commit(() => { recount(); refreshLeftCounts(); renderStats(); autosave(setSaved); });
  markEdgesDirty();
  setUnit("block");
  toast(`已建块区 ${bid}：挂在「${plotNameOf(host)}」下，选中那一格已归它`, 2800);
  return bid;
}
/* 把一个像元写给某个地块 / 块区（记进当前手势，可撤销） */
function addCellTo(k, kind, id) {
  const g = beginGesture();
  if (kind === "plot") {
    g.idx.push(k); g.kind.push(0); g.from.push(state.plot[k]); g.to.push(id);
    state.plot[k] = id;
  } else {
    g.idx.push(k); g.kind.push(2); g.from.push(state.dist[k]); g.to.push(id);
    state.dist[k] = id;
  }
  g.meta.push({ obj: kind === "plot" ? "plot" : "block", id, from: null,
                to: Object.assign({}, kind === "plot" ? state.plots[id] : state.blocks[id]) });
  touched.add(k); writeAll(k);
}

/* --------------------------------------------------------------------------
   右键 = 选中（不再当橡皮）。选中什么由**当前单元**决定：
     地域 → 选中该格所属的【地块】（地域的编辑对象本来就是地块）
     地块 → 选中该【栅格】，并把该格所属地块设为当前地块
     块区 → 选中该【栅格】，同时带上该格的地块与块区
     自然层（地形/气候）→ 不可选中（只读底图，没有"选中某个地形"这回事）
   选中的那一格记进 state.selCell，新建对象时以它为落点。
   quiet = 右键按住连续拾取时用：只做轻量更新（高亮 + 清单高亮），
   右栏检视器与统计留到松手那一下再整体重建——否则每换一格就要为全部地块生成一遍下拉选项。
   -------------------------------------------------------------------------- */
export function pickAt(i, quiet) {
  const u = state.unit;
  if (isRoUnit(u)) return;                            // 只读自然层没有"选中某个对象"这回事
  if (i < 0) { state.selCell = -1; markOverlayDirty(); schedule(); return; }
  state.selCell = i; state.curCell = i;
  const pid = state.plot[i], bid = state.dist[i];
  if (u === "domain") {
    if (!pid) { toast("这一格没有地块", 1400); return; }
    state.sel.domain = state.plots[pid] ? state.plots[pid].d : -1;
    state.sel.plot = pid;
    state.hover.domain = state.sel.domain;
    toast(`选中地块 ${pid} ${plotNameOf(pid)}`, 1600);
  } else if (u === "plot") {
    /* 地块单元的编辑对象就是地块，右键也选地块（选中栅格只是顺手记下落点） */
    if (!pid) { toast("这一格没有地块（要新建就点「＋ 新建」）", 1600); return; }
    state.sel.plot = pid;
    state.hover.plot = pid;
    toast(`选中地块 ${pid} ${plotNameOf(pid)}`, 1600);
  } else {
    state.sel.plot = pid;
    state.sel.block = bid;
    state.hover.block = bid;
    toast(`选中栅格：地块 ${pid ? pid + " " + plotNameOf(pid) : "无"} ｜ 块区 ${bid || "无"}`, 1700);
  }
  syncLeftSel();
  if (!quiet) { renderInspector(); renderStats(); }
  markOverlayDirty(); schedule();
}



/* ================================================================ 左栏 */
const leftBody = $("leftBody"), leftTitle = $("leftTitle"), leftSub = $("leftSub"), leftAct = $("leftAct");
let countRefs = new Map(), rowRefs = new Map(), searchText = "", leftSelKey = null;
let leftKind = "plot";

export function renderLeft() {
  leftKind = state.unit;
  const act = $("leftAct");
  if (act) act.title = state.unit === "plot" ? "新建地块：落点 = 右键选中的那一格"
    : state.unit === "block" ? "新建块区：落点须在选中地块内（右键选）"
    : isRoUnit(state.unit) ? `${roLayer(state.unit).n}只读：管线定稿，不可新建`
    : "地域不可新建（设计层固定）";
  countRefs = new Map(); rowRefs = new Map(); leftSelKey = null;   // 面板换了 DOM，选中态缓存作废
  if (leftKind === "domain") return renderDomainPanel();
  if (leftKind === "plot") return renderPlotPanel();
  if (leftKind === "block") return renderBlockPanel();
  return renderRoPanel(leftKind);                 // 只读自然层（地形 / 气候 / …）
}
export function refreshLeftCounts() {
  const free = cellsWithPlot - domCells.reduce((a, b) => a + b, 0);
  for (const [id, el] of countRefs) {
    /* 三个单元各自的口径：地域 → 该域已指派的像元数；块区 → 块区像元数；地块 → 地块像元数。
       地域这里曾错走 getPlotCells()[id]，于是每一行显示的是"同号地块"的像元数
       （齐鲁域(1) 显示 0.3k = 地块 1 安庆市的 259 格）。 */
    const n = id === -1 ? free
      : leftKind === "domain" ? (domCells[id] || 0)
      : leftKind === "block" ? (getBlockCells()[id] || 0) : (getPlotCells()[id] || 0);
    el.textContent = n ? (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k") : "";
  }
  const tot = $("leftSub");
  if (tot) tot.textContent = leftSubText();
}
function leftSubText() {
  if (leftKind === "domain") return `${DOM.length} 域 · 已指派 ${(domCells.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)}M 格`;
  if (leftKind === "plot") return `${Object.keys(state.plots).length} 块 · ${(cellsWithPlot / 1e6).toFixed(2)}M 格`;
  if (leftKind === "block") return `${Object.keys(state.blocks).length} 个 · ${(cellsWithBlock / 1e6).toFixed(2)}M 格`;
  return roLayer(leftKind).sub;                 // 只读自然层自己给副标题
}
function syncLeftSel() {
  const cur = state.sel[leftKind];
  const key = leftKind + "|" + cur;
  if (key === leftSelKey) return;      // 同一对象重复调用（右键连续拾取）不必再翻一遍上千行 DOM
  leftSelKey = key;
  for (const [id, el] of rowRefs) el.classList.toggle("on", +id === cur);
}
/* — 地域 — */
function renderDomainPanel() {
  leftTitle.textContent = "地域";
  leftSub.textContent = leftSubText();
  const q = searchText.trim();
  let html = `<div class="searchwrap"><input type="search" id="q" placeholder="搜索地域 / 地缘…" value="${q.replace(/"/g, "&quot;")}"></div>`;
  for (let gi = 0; gi < DATA.palette.length; gi++) {
    const g = DATA.palette[gi];
    const hits = [];
    for (let i = 0; i < DOM.length; i++) {
      const d = DOM[i];
      if (d.g !== g.geo) continue;
      if (q && !(d.d.includes(q) || g.geo.includes(q))) continue;
      hits.push(i);
    }
    if (!hits.length) continue;
    const open = q ? " open" : (g.geo === "汉地" ? " open" : "");
    html += `<details class="geo"${open}><summary><span>${g.geo}</span><span class="cnt" data-geo="${g.geo}"></span></summary>`;
    for (const i of hits) {
      const d = DOM[i];
      html += `<div class="row" data-id="${i}"><span class="sw" style="background:${COLOR[i]}"></span>`
            + `<span class="nm">${d.d}</span><span class="n" data-cnt="${i}"></span></div>`;
    }
    html += `</details>`;
  }
  html += `<div class="row lv0" data-id="-1"><span class="sw" style="background:${UNASSIGNED}"></span>`
        + `<span class="nm mut">（未指派）</span><span class="n" data-cnt="-1"></span></div>`;
  leftBody.innerHTML = html;
  afterPanelRender();
}
/* — 地块 — */
function renderPlotPanel() {
  leftTitle.textContent = "地块";
  leftSub.textContent = leftSubText();
  const q = searchText.trim().toLowerCase();
  const ids = Object.keys(state.plots).map(Number).sort((a, b) => a - b);
  const pc = getPlotCells();
  const rows = [];
  for (const id of ids) {
    const p = state.plots[id], nm = p.n || `地块 ${id}`;
    if (q && !(nm.toLowerCase().includes(q) || String(id) === q)) continue;
    rows.push({ id, nm, n: pc[id] || 0, d: p.d });
  }
  const blanks = rows.filter(r => !r.n).length;
  leftBody.innerHTML = `<div class="searchwrap"><input type="search" id="q" placeholder="搜索地块（名称 / 编码）…" value="${q.replace(/"/g, "&quot;")}"></div>`
    + (blanks ? `<div class="mut" style="padding:0 9px 4px;font-size:10.5px">其中 ${blanks} 个还没有像元（种子台账里的小单元，需要手动画出来）</div>` : "")
    + (rows.length ? rows.map(r =>
        `<div class="row" data-id="${r.id}"><span class="sw" style="background:${
          r.d >= 0 ? COLOR[r.d] : UNASSIGNED}"></span><span class="nm">${esc(r.nm)}</span>`
        + `<span class="n" data-cnt="${r.id}"></span>`
        + (r.n ? `<span class="tag">${r.id}</span>` : `<span class="tag">空</span>`)
        + `</div>`).join("")
      : `<div class="empty">没有匹配的地块。</div>`);
  afterPanelRender();
}
/* — 块区 — */
function renderBlockPanel() {
  leftTitle.textContent = "块区";
  leftSub.textContent = leftSubText();
  const q = searchText.trim().toLowerCase();
  const ids = Object.keys(state.blocks).map(Number).sort((a, b) => a - b);
  let rows = ids.filter(id => {
    const b = state.blocks[id];
    return !q || (b.n || "").toLowerCase().includes(q) || String(id) === q;
  });
  /* 块区底稿一进来就是**几千个**（中华＝县）。一次渲染几千行会把界面卡住几秒，
     所以只画前 200 行，并在下面写明"还有多少没显示、用搜索找"。 */
  const ROW_CAP = 200;
  const hidden = Math.max(0, rows.length - ROW_CAP);
  rows = rows.slice(0, ROW_CAP);
  leftBody.innerHTML = `<div class="searchwrap"><input type="search" id="q" placeholder="搜索块区…" value="${q.replace(/"/g, "&quot;")}"></div>`
    + (rows.length ? rows.map(id => {
        const b = state.blocks[id], stray = b.p ? blockStrays(id) : 0;
        const owner = b.p ? (state.plots[b.p] ? state.plots[b.p].n : "地块 " + b.p) : "未挂地块";
        return `<div class="row${stray ? " warn" : ""}" data-id="${id}">`
          + `<span class="sw" style="background:${b.p ? blockColor(id) : "#a9a396"}"></span>`
          + `<span class="nm">${esc(b.n || "块区 " + id)}<br><span class="mut" style="font-size:10.5px">${esc(owner)}</span></span>`
          + `<span class="n" data-cnt="${id}"></span>`
          + (stray ? `<span class="tag">越界 ${stray}</span>` : "") + `</div>`;
      }).join("") + (hidden ? `<div class="empty">还有 ${hidden} 个未显示（搜索可缩小范围）</div>` : "")
      : `<div class="empty">还没有块区。点右上「＋ 新建」，再在地图上涂。</div>`);
  afterPanelRender();
}
/* — 只读自然层（地形 / 气候 / …；docs/adr/0001）—
   本文件对只读层**只知道三件事**：调 `layer.panel(stats)` 出左栏、调 `layer.insp(stats)`
   出右栏、用 `layer.n / .sub` 出抬头。层自己的名字、配色、统计口径、脚注全在 ro.js 那张表。
   面板与检视器共用**同一份统计**：一次遍历（940 万格）喂所有层，缓存 600 ms——
   renderLeft 会被悬停/涂改/选中频繁触发，而这些数只与只读层有关、与编辑无关。 */
let _roStats = null, _roStatsAt = 0;
export function roStats() {
  const now = Date.now();
  if (_roStats && now - _roStatsAt < 600) return _roStats;
  _roStats = buildRoStats(state.terr, climData);
  _roStatsAt = now;
  return _roStats;
}

function renderRoPanel(k) {
  const layer = roLayer(k);
  leftTitle.textContent = layer.title;
  leftSub.textContent = layer.sub;
  leftBody.innerHTML = layer.panel(roStats());
}

function afterPanelRender() {
  rowRefs = new Map();
  leftBody.querySelectorAll(".row").forEach(el => {
    const id = +el.dataset.id;
    rowRefs.set(id, el);
    const c = el.querySelector(".n");
    if (c) countRefs.set(id === -1 ? -1 : id, c);
  });
  const q = $("q");
  if (q) {
    const apply = val => {
      searchText = val;
      const pos = q.selectionStart;
      renderLeft();
      const nq = $("q");
      if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
    };
    /* 组字期间不重渲染：重建 <input> 会打断中文输入法（拼音还没上屏就被清掉），
       于是"搜索地块名"用拼音根本打不进去。等 compositionend 再按最终值渲染一次。 */
    let composing = false;
    q.addEventListener("compositionstart", () => { composing = true; });
    q.addEventListener("compositionend", () => { composing = false; apply(q.value); });
    q.oninput = e => { if (composing || e.isComposing) return; apply(q.value); };
  }
  /* 地域分组计数 */
  leftBody.querySelectorAll(".cnt").forEach(el => {
    const g = el.dataset.geo; let t = 0;
    DOM.forEach((x, i) => { if (x.g === g) t += domCells[i]; });
    el.textContent = t ? (t / 1e3).toFixed(0) + "k" : "";
  });
  refreshLeftCounts();
  syncLeftSel();
}
/* ⚠️ `esc` 不在这里定义：它由 js/ro.js 导出（只读层的面板与检视器也要转义，
   两处各写一份迟早分叉）。原先这里有一份 `const esc`，与 import 撞名会**整个模块图报错**。 */

/* ================================================================ 右栏检视 */
const inspEl = $("insp"), inspTitle = $("inspTitle"), inspSub = $("inspSub");
export function renderInspector() {
  const u = state.unit;
  /* 只读自然层的抬头不写"编辑对象"——它没有编辑对象（docs/adr/0001） */
  inspTitle.textContent = isRoUnit(u)
    ? `${roLayer(u).n}（只读）`
    : UNIT[u].n + "（编辑对象：" + UNIT[u].obj + "）";
  inspSub.textContent = isRoUnit(u) ? "统计与口径" : (state.mode === "edit" ? "当前笔刷" : "当前选中");
  if (isRoUnit(u)) return inspRo(u);
  if (u === "domain") return inspDomain();
  if (u === "plot") return inspPlot();
  if (u === "block") return inspBlock();
  return inspDomain();
}
/* 只读自然层的右栏：全部交给层自己的 `insp(stats)`（ro.js），本文件不认识"地形"或"气候" */
function inspRo(k) {
  inspEl.innerHTML = roLayer(k).insp(roStats());
}
const kmPerCell = y => G.cell * 111.32;
/* 估面积：按地块/块区的像元抽样，用所在纬度的余弦修正（够用） */
function areaOfMap(map, id) {
  const arr = map.get(+id); if (!arr || !arr.length) return 0;
  const step = Math.max(1, Math.floor(arr.length / 200));
  let sum = 0, n = 0;
  for (let i = 0; i < arr.length; i += step) {
    const y = Math.floor(arr[i] / W), k = kmPerCell(y);
    sum += k * k * Math.cos(rowLat(y) * Math.PI / 180);
    n++;
  }
  return n ? sum / n * arr.length : 0;
}
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n.toLocaleString();
/* 右键选中的那一格（新建对象的落点）——在检视器里报一下，免得不知道选在哪。
   自然那一半走 ro.js 的 `cellFields`：覆盖 · 形态 ｜ 热量带 · 干湿 ｜ 显示类。 */
function selCellRow() {
  const i = state.selCell;
  if (i < 0) return `<dt>选中栅格</dt><dd class="mut" style="font-size:11px">右键点地图选一格</dd>`;
  const x = i % W, y = (i - x) / W, pid = state.plot[i], bid = state.dist[i];
  const f = cellFields(state.terr[i], climData[i]);
  return `<dt>选中栅格</dt><dd>格 ${x},${y} ｜ 地块 ${pid ? pid + " " + esc(plotNameOf(pid)) : "无"}`
       + ` ｜ 块区 ${bid || "无"}<br>${esc(f.cover)}·${esc(f.form)} ｜ `
       + `${esc(f.heat)}·${esc(f.moist)} ｜ <b>${esc(f.display)}</b></dd>`;
}

function inspPlot() {
  const id = state.sel.plot;
  if (!id || !state.plots[id]) {
    /* 渲染只读：选中的地块在别处没了（撤销一次"新建/拆分"、导入存档）时，
       不要凭 id 现编一条台账出来 —— 那会让人对着一个不存在的对象改名、改地域。 */
    if (id) state.sel.plot = 0;
    inspEl.innerHTML = id
      ? `<div class="empty">地块 ${id} 的台账已不存在（可能被撤销，或被导入的存档覆盖）。</div>`
      : `<div class="empty">还没有选中地块。用「＋ 新建」建一个，或点地图上的地块。</div>`;
    return;
  }
  const p = state.plots[id];
  const cells = getPlotCells()[id] || 0;
  const owned = Object.keys(state.blocks).filter(b => state.blocks[b].p === id);
  const opts = DOM.map((d, k) => `<option value="${k}"${k === p.d ? " selected" : ""}>${esc(d.g)} · ${esc(d.d)}</option>`).join("");
  inspEl.innerHTML = `
    <dl class="kv">
      <dt>编码</dt><dd>${id}</dd>
      <dt>名称</dt><dd><input type="text" id="pName" value="${esc(p.n || "")}" style="width:100%"></dd>
      <dt>地域</dt><dd><select id="pDom" style="width:100%"><option value="-1"${p.d < 0 ? " selected" : ""}>（未指派）</option>${opts}</select></dd>
      <dt>像元</dt><dd>${fmt(cells)} 格 ｜ ≈ ${Math.round(areaOfMap(getCellsOf(), id)).toLocaleString()} km²</dd>
      <dt>块区</dt><dd>${owned.length ? owned.length + " 个" : "—"}</dd>
      ${selCellRow()}
      ${partsHTML("plot", id, cells)}
    </dl>
    <div class="acts">
      <button class="tb" id="aSet">设为笔刷</button>
      <button class="tb" id="aGo">跳过去</button>
      <button class="tb" id="aClear">清空编码</button>
      <button class="tb" id="aDrop">删掉台账</button>
    </div>`;
  bindPartsActions("plot", id);
  $("pName").onchange = e => { setPlotName(id, e.target.value); autosave(setSaved); };
  $("pDom").onchange = e => {
    setPlotDomain(id, +e.target.value); recount(); refreshLeftCounts(); renderInspector();
    markOverlayDirty(); autosave(setSaved);
  };
  $("aSet").onclick = () => { state.sel.plot = id; syncLeftSel(); toast(`笔刷 = 地块 ${id}`); };
  $("aGo").onclick = () => { const c = anchorCell("plot", id); if (c >= 0) { centerOn(c); schedule(); } else toast("这个地块还没有像元"); };
  $("aClear").onclick = () => { clearCells("plot", id); };
  $("aDrop").onclick = () => {
    if (cells) return toast("先「清空编码」再删台账");
    /* 走手势 → 进撤销栈（applyMeta 认 `to = null` 为删除，撤销能把记录原样还原）。
       原先直接 delete，是唯一一个不可撤销的写操作。 */
    beginGesture();
    dropMeta("plot", id);
    state.sel.plot = 0;
    commit(() => { recount(); refreshLeftCounts(); renderStats(); autosave(setSaved); });
    renderLeft(); renderInspector();
    toast(`已删掉地块 ${id} 的台账（Ctrl+Z 可撤销）`, 2200);
  };
}
function inspBlock() {
  const id = state.sel.block;
  if (!id) {
    inspEl.innerHTML = `<div class="empty">还没有选中块区。点右上「＋ 新建」建一个，再在地图上涂（只能涂在它所属地块内）。</div>`;
    return;
  }
  const b = state.blocks[id];
  if (!b) {
    /* 渲染只读：这个块区在别处被删（导入存档、撤销）后，原先这里会"没有记录就建一条"，
       于是凭空造回一个空块区 —— 删不掉的幽灵。查不到就报出来并清掉选中。 */
    state.sel.block = 0;
    inspEl.innerHTML = `<div class="empty">块区 ${id} 已不存在（可能被撤销，或被导入的存档覆盖）。</div>`;
    return;
  }
  const cells = getBlockCells()[id] || 0;
  const stray = b.p ? blockStrays(id) : 0;
  const curPlot = state.curCell >= 0 ? state.plot[state.curCell] : 0;
  const opts = Object.keys(state.plots).map(Number).sort((a, c) => a - c)
    .map(pid => `<option value="${pid}"${pid === b.p ? " selected" : ""}>${pid} · ${esc(state.plots[pid].n)}</option>`).join("");
  inspEl.innerHTML = `
    <dl class="kv">
      <dt>编码</dt><dd>${id}</dd>
      <dt>名称</dt><dd><input type="text" id="bName" value="${esc(b.n || "")}" style="width:100%"></dd>
      <dt>所属地块</dt><dd><select id="bOwner" style="width:100%"><option value="0"${!b.p ? " selected" : ""}>（未挂地块）</option>${opts}</select></dd>
      <dt>像元</dt><dd>${fmt(cells)} 格 ｜ ≈ ${Math.round(areaOfMap(getCellsOfBlock(), id)).toLocaleString()} km²</dd>
      <dt>越界</dt><dd>${stray ? `<span style="color:var(--accent)">${stray} 格不在所属地块内</span>` : "无"}</dd>
      ${selCellRow()}
      ${partsHTML("block", id, cells)}
    </dl>
    <div class="acts">
      <button class="tb" id="bSet">设为笔刷</button>
      <button class="tb" id="bGo">跳过去</button>
      <button class="tb" id="bHere" ${curPlot ? "" : "disabled"}>用光标下的地块</button>
      <button class="tb" id="bFix" ${stray ? "" : "disabled"}>修正越界</button>
      <button class="tb" id="bClear">清空编码</button>
      <button class="tb" id="bDrop">删掉块区</button>
    </div>`;
  bindPartsActions("block", id);
  $("bName").onchange = e => { setBlockName(id, e.target.value); renderLeft(); autosave(setSaved); };
  $("bOwner").onchange = e => { setBlockOwner(id, +e.target.value); renderLeft(); renderInspector(); autosave(setSaved); };
  $("bSet").onclick = () => { state.sel.block = id; syncLeftSel(); toast(`笔刷 = 块区 ${id}`); };
  $("bGo").onclick = () => { const c = anchorCell("block", id); if (c >= 0) { centerOn(c); schedule(); } else toast("这个块区还没有像元"); };
  $("bHere").onclick = () => { setBlockOwner(id, curPlot); renderLeft(); renderInspector(); toast("已把块区挂到光标下的地块"); };
  $("bFix").onclick = () => { fixStrays(id); };
  $("bClear").onclick = () => { clearCells("dist", id); };
  $("bDrop").onclick = () => {
    if (cells) return toast("先「清空编码」再删");
    beginGesture();
    dropMeta("block", id);
    state.sel.block = 0;
    commit(() => { recount(); refreshLeftCounts(); renderStats(); autosave(setSaved); });
    renderLeft(); renderInspector();
    toast(`已删掉块区 ${id}（Ctrl+Z 可撤销）`, 2200);
  };
}
function inspDomain() {
  const i = state.sel.domain;
  /* 下标可能越界（换过地域清单、手工改过存档 → 存档里留着 ≥93 的编号）：
     越界时取 DOM[i] 会抛，domCells[i] 是 undefined（fmt 也会抛），两处都能让
     右栏整块卡住 —— 画面还在、面板不再更新，最难查。越界一律按"未指派"渲染。 */
  const ok = i >= 0 && i < DOM.length;
  const plots = [];
  for (const [pid, arr] of getCellsOf()) {
    const p = state.plots[pid];
    if (p && p.d === i) plots.push([pid, arr.length]);
  }
  plots.sort((a, b) => b[1] - a[1]);
  const total = ok ? (domCells[i] || 0) : (cellsWithPlot - domCells.reduce((a, b) => a + b, 0));
  inspEl.innerHTML = `
    <dl class="kv">
      <dt>地域</dt><dd>${ok ? `<span class="pill"><span class="sw" style="background:${COLOR[i]}"></span>${esc(DOM[i].g)} · ${esc(DOM[i].d)}</span>` : "（未指派）"}</dd>
      <dt>地块数</dt><dd>${plots.length}</dd>
      <dt>像元</dt><dd>${fmt(total)} 格</dd>
    </dl>
    <div class="acts">
      <button class="tb" id="dSet" ${ok ? "" : "disabled"}>设为笔刷</button>
      <button class="tb" id="dGo" ${plots.length ? "" : "disabled"}>跳到首个地块</button>
    </div>
    <div class="sec-h">本域地块（按像元数）</div>
    <div class="bars">${plots.slice(0, 60).map(([pid, n]) =>
      `<div class="bar" data-pid="${pid}" style="cursor:pointer"><i style="background:${
        state.plots[pid].d >= 0 ? COLOR[state.plots[pid].d] : UNASSIGNED}"></i>`
      + `<span>${esc(state.plots[pid].n)}</span><span class="v">${fmt(n)}</span></div>`).join("")
      || `<div class="empty">（空）</div>`}</div>`;
  if (ok) $("dSet").onclick = () => { state.sel.domain = i; toast(`笔刷 = 地域 ${DOM[i].d}`); };
  if (plots.length) $("dGo").onclick = () => { const c = anchorCell("domain", i); if (c >= 0) { centerOn(c, Math.max(state.view.s, FIT() * 8)); schedule(); } };
  inspEl.querySelectorAll(".bar[data-pid]").forEach(el => el.onclick = () => pickObject("plot", +el.dataset.pid, true));
}
/* ---------------- 清空 / 修正（都走撤销栈） ---------------- */
function clearCells(kind, id) {
  const map = kind === "plot" ? getCellsOf() : getCellsOfBlock();
  const arr = map.get(+id);
  if (!arr || !arr.length) return;
  const g = beginGesture();
  for (let n = 0; n < arr.length; n++) {
    const k = arr[n];
    if (kind === "plot") {
      g.idx.push(k); g.kind.push(0); g.from.push(state.plot[k]); g.to.push(0); state.plot[k] = 0;
    } else {
      g.idx.push(k); g.kind.push(2); g.from.push(state.dist[k]); g.to.push(0); state.dist[k] = 0;
    }
    touched.add(k);
  }
  repaintAll(); commit(() => { buildEdgesNow(); recount(); autosave(setSaved); });
  renderLeft(); renderInspector(); renderStats(); markOverlayDirty(); schedule();
  toast(`已清空 ${arr.length} 格`);
}
function fixStrays(id) {
  const b = state.blocks[id]; if (!b || !b.p) return;
  const arr = getCellsOfBlock().get(+id); if (!arr) return;
  const g = beginGesture();
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i];
    if (state.plot[k] === b.p) continue;
    g.idx.push(k); g.kind.push(2); g.from.push(state.dist[k]); g.to.push(0);
    state.dist[k] = 0; touched.add(k); n++;
  }
  repaintAll(); commit(() => { buildEdgesNow(); recount(); autosave(setSaved); });
  renderLeft(); renderInspector(); renderStats(); markOverlayDirty(); schedule();
  toast(n ? `已清掉 ${n} 格越界像元` : "没有越界像元");
}

/* ---------------- 连通块（飞地）面板 ---------------- */
function partsHTML(kind, id, cells) {
  if (!cells) return "";
  const comps = cells > 1 ? componentsOf(kind, id) : [];
  const head = comps.length > 1
    ? `<dt>连通块</dt><dd><b style="color:var(--accent)">${comps.length} 块</b>（主体 ${fmt(comps[0].length)} 格）</dd>`
    : `<dt>连通块</dt><dd>1 块（连通）</dd>`;
  if (comps.length < 2) return head;
  return head + `<div class="sec-h">碎块 / 飞地（不连通）</div><div class="bars">`
    + comps.slice(1, 24).map((c, n) =>
        `<div class="bar"><i style="background:#c8b98f"></i><span>第 ${n + 2} 块</span>`
        + `<span class="v">${fmt(c.length)} 格</span>`
        + `<button class="tb" data-goc="${n + 1}" title="跳到这一块">看</button>`
        + `<button class="tb" data-cut="${n + 1}" title="把这一块拆成新的${kind === "block" ? "块区" : "地块"}">拆出</button></div>`
      ).join("") + (comps.length > 24 ? `<div class="mut">…另有 ${comps.length - 24} 块</div>` : "")
    + `</div>`;
}
function bindPartsActions(kind, id) {
  inspEl.querySelectorAll("[data-goc]").forEach(el => el.onclick = () => {
    const c = componentsOf(kind, id)[+el.dataset.goc];
    if (c && c.length) { centerOn(c[0], Math.max(state.view.s, FIT() * 8)); schedule(); }
  });
  inspEl.querySelectorAll("[data-cut]").forEach(el => el.onclick = () => {
    const idx = +el.dataset.cut;
    const base = kind === "block" ? (state.blocks[id] ? state.blocks[id].n : "块区 " + id) : plotNameOf(id);
    const newId = splitComponent(kind, id, idx, `${base}·碎块`);
    if (!newId) return toast(`拆不出来：这一块不连通，或编码已达上限 ${ID_MAX}`, 2800);
    recount(); repaintAll(); buildEdgesNow(); dropOutlineCache();
    renderLeft(); renderInspector(); renderStats(); markOverlayDirty(); autosave(setSaved);
    toast(`已把碎块拆成新的${kind === "block" ? "块区" : "地块"} ${newId}`, 2400);
  });
}
/* ---------------- 全图飞地 / 多连通块扫描 ---------------- */
export function blankPlots() {
  const pc = getPlotCells();
  return Object.keys(state.plots).map(Number).filter(id => !pc[id]).sort((a, b) => a - b);
}
function showPartsReport() {
  toast("正在扫描连通块…", 1200);
  setTimeout(() => {
    const rows = scanParts(400);
    const blanks = blankPlots();
    const old = document.querySelector(".report"); if (old) old.remove();
    const box = document.createElement("div");
    box.className = "report";
    box.innerHTML = `<button class="x" title="关闭">✕</button>
      <h4>多连通块：${rows.length} 个对象${rows.length >= 400 ? "（只列前 400）" : ""}</h4>
      <div class="mut" style="margin-bottom:6px">海岛、真实飞地都会是多块——这里只报事实，拆不拆由你定。</div>
      <div class="rlist">` + (rows.length ? rows.map(r => {
        const nm = r.kind === "block"
          ? (state.blocks[r.id] ? state.blocks[r.id].n : `块区 ${r.id}`)
          : plotNameOf(r.id);
        return `<div class="rrow"><span class="nm">${r.kind === "block" ? "块区" : "地块"} ${r.id} · ${esc(nm)}</span>`
             + `<span class="mut">${r.parts} 块 / ${fmt(r.cells)} 格</span>`
             + `<button class="tb" data-jump="${r.kind}:${r.id}">看</button></div>`;
      }).join("") : `<div class="empty">没有多连通块的对象。</div>`) + `</div>
      <h4 style="margin-top:8px">零像元台账：${blanks.length} 个</h4>
      <div class="mut" style="margin-bottom:6px">种子台账里有、但栅格里一格都没落到的地块（小单元落在格心之间）。要就“设为笔刷”手动画出来，不要可以删掉台账。</div>
      <div class="rlist" style="max-height:34%">` + (blanks.length ? blanks.slice(0, 200).map(id =>
        `<div class="rrow"><span class="nm">地块 ${id} · ${esc(plotNameOf(id))}</span>`
        + `<button class="tb" data-brush="${id}">设为笔刷</button></div>`).join("")
        + (blanks.length > 200 ? `<div class="mut">…另有 ${blanks.length - 200} 个</div>` : "")
        : `<div class="empty">没有零像元台账。</div>`) + `</div>`;
    box.querySelector(".x").onclick = () => box.remove();
    box.querySelectorAll("[data-jump]").forEach(el => el.onclick = () => {
      const [k, sid] = el.dataset.jump.split(":");
      const id = +sid;
      pickObject(k, id);
      const c = anchorCell(k, id);
      if (c >= 0) centerOn(c, Math.max(state.view.s, FIT() * 8));
      box.remove();
      renderInspector();
      toast("右栏可看这一对象的各碎块并逐个拆出");
    });
    box.querySelectorAll("[data-brush]").forEach(el => el.onclick = () => {
      const id = +el.dataset.brush;
      pickObject("plot", id, true);
      toast(`笔刷 = 地块 ${id}，在地图上涂出它的范围`);
    });
    document.querySelector("main").appendChild(box);
  }, 40);
}

/* ---------------- 统计 ---------------- */
export function renderStats() {
  const el = $("fStat");
  if (el) el.textContent = `地块 ${Object.keys(state.plots).length} ｜ 块区 ${Object.keys(state.blocks).length}`
    + ` ｜ 有地块像元 ${(cellsWithPlot / 1e6).toFixed(2)}M / ${(NC / 1e6).toFixed(2)}M`
    + ` ｜ 已改 ${touched.size}`;
}

/* ---------------- 导入导出 ---------------- */
function download(name, href, revoke) {
  const a = document.createElement("a"); a.href = href; a.download = name; a.click();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 8000);
}
const today = () => new Date().toISOString().slice(0, 10);
const csv = rows => "\ufeff" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
const closeMenu = () => { $("menu").open = false; };
/* ⋯ 下拉：顶栏是 overflow:hidden，绝对定位的下拉会被裁掉（点了什么都看不见）。
   CSS 已改成 position:fixed，这里在打开时按按钮的实际位置给坐标；
   并补上"点外面 / 改窗口大小"自动收起（原生 <details> 不会自己收）。 */
function bindMenu() {
  const el = $("menu");
  const place = () => {
    const body = el.querySelector(".menuBody"), sum = el.querySelector("summary");
    if (!body || !sum) return;
    const r = sum.getBoundingClientRect();
    body.style.right = Math.max(6, window.innerWidth - r.right) + "px";
    body.style.top = Math.round(r.bottom + 5) + "px";
  };
  el.addEventListener("toggle", () => { if (el.open) place(); });
  document.addEventListener("click", e => { if (el.open && !el.contains(e.target)) el.open = false; });
  window.addEventListener("resize", () => { if (el.open) el.open = false; });
}
/* ---------------- 存到待合入目录（docs/adr/0001 · 0002；工单 §3.1 · §4.3） ----------------
   行政图（地块 / 块区 / 地域）改完**不直接写真源**，而是 POST 给本地服务，落进
   `地图/待合入/`；再由 `tools/import_editor.py` 校验后合入 `地图数据/栅格/`。
   地形不在其中——它是管线从高程与土地覆盖算出来的模拟底数，不许被人一笔划掉。

   与「保存进度」（localStorage 增量）分工不同：那个是防浏览器崩溃的会话恢复，**不动**；
   这个是"我改完了，交给管线"的正式交付。 */
/* 草稿台账：只记**语义**（名称 / 归属 / 地域），几何在两张 PNG 里。
   字段名与工单 §3.1 对齐：based_on / saved_at / plots / districts。 */
function editorLedger() {
  const plots = Object.keys(state.plots).map(Number).sort((a, b) => a - b).map(id => {
    const p = state.plots[id];
    return { id, name: p.n || "", domain: (p.d >= 0 && DOM[p.d]) ? DOM[p.d].d : "" };
  });
  const g2l = blockLocals();
  const districts = Object.keys(state.blocks).map(Number).sort((a, b) => a - b).map(id => {
    const b = state.blocks[id];
    return { id, name: b.n || "", plot: b.p || 0, local: g2l.get(id) || 0 };
  });
  return { based_on: DATA.base_tag, saved_at: new Date().toISOString(), plots, districts };
}

/* 全局块区 id → **地块内的局部序号**（v3，见 docs/adr/0007）。
   先取真源发好的号；编辑器**新建**的块（真源里没有）在同一地块内接着往下发，
   否则它们导出时会被写成 0 —— 也就是"新建的块区一存就没了"。
   局部序号是"地块内的第几个"，栅格只存它；全局 id 仍是编辑器的内部语言。 */
export function blockLocals() {
  const g2l = new Map(), next = new Map();
  for (const b of (DATA.districts || [])) {
    g2l.set(b.id, b.local);
    next.set(b.plot, Math.max(next.get(b.plot) || 0, b.local));
  }
  for (const id of Object.keys(state.blocks).map(Number).sort((a, b) => a - b)) {
    if (g2l.has(id)) continue;
    const plot = (state.blocks[id] && state.blocks[id].p) || 0;
    if (!plot) continue;                       // 未挂地块的块区不写进栅格（渲染成灰）
    const l = (next.get(plot) || 0) + 1;
    next.set(plot, l);
    g2l.set(id, l);
  }
  return g2l;
}

/* 导出分区编码：栅格存的是**地块内的局部序号**（v3），而编辑器内部用**全局 id**。
   这里按台账的 (plot, local) 折回去——导入端（tools/import_editor.py）拿到局部序号后
   用同一张表还原，因此"块区必落在其地块内"这条仍然成立。 */
function distLocalPng() {
  const g2l = blockLocals();
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const im = c.createImageData(W, H), d = im.data;
  for (let i = 0, j = 0; i < NC; i++, j += 4) {
    const v = g2l.get(state.dist[i]) || 0;
    d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
  }
  c.putImageData(im, 0, 0);
  return cv.toDataURL("image/png");
}

export async function saveToStaging() {
  closeMenu();
  flushAll();                                  // 把内存里的 TypedArray 刷进各画布，再取图
  try {
    const r = await fetch("/保存", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tag: DATA.base_tag, files: {
        "地块编码.png": idCanvas.toDataURL("image/png"),
        "分区编码.png": distLocalPng(),
        "台账.json": editorLedger(),
      } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j["错误"] || (r.status + " " + r.statusText));
    const kb = (j["已写"] || []).map(x => `${x["文件"]} ${(x["字节"] / 1024).toFixed(0)}KB`).join("｜");
    toast(`已存到 地图/待合入/：${kb}`, 3600);
    setSaved("已存草稿");
    reportStaging();
  } catch (e) {
    toast(`存草稿失败：${e.message}。要从 启动编辑器.bat 起服务才有落地的地方`, 5200);
  }
}

/* 启动时探测草稿：404 或网络失败一律**静默当没有**——
   服务没挂载（比如直接开文件）时不能让编辑器起不来。 */
export async function probeDraft() {
  try {
    const r = await fetch("/草稿/台账.json");
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.plots) ? j : null;
  } catch (e) { return null; }
}

/* 「检测到未合入的草稿，用哪一份？」——工单 §4.6 要的是明确选择，不是隐式覆盖 */
export function askDraft(draft) {
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "report";
    const when = draft.saved_at ? String(draft.saved_at).replace("T", " ").slice(0, 19) : "时间未知";
    box.innerHTML = `<h4>检测到未合入的草稿</h4>
      <div class="mut" style="margin:6px 0 10px">存于 ${esc(when)} ｜ 基于底图 ${esc(draft.based_on || "?")}
      ｜ 地块 ${(draft.plots || []).length} 个</div>
      <div class="mut" style="margin-bottom:10px">草稿还没合入真源。选「用草稿继续」接着改它；
      选「从正式版开始」就丢掉草稿改真源（草稿文件不会被删，仍可手工合入）。</div>
      <div class="acts">
        <button class="tb" id="dUse">用草稿继续</button>
        <button class="tb" id="dFresh">从正式版开始</button>
      </div>`;
    const close = v => { box.remove(); resolve(v); };
    box.querySelector("#dUse").onclick = () => close(true);
    box.querySelector("#dFresh").onclick = () => close(false);
    document.querySelector("main").appendChild(box);
  });
}

/* 顶栏标记：待合入/ 里现在有几件（纯信息；用哪一份是启动时选的） */
export async function reportStaging() {
  const el = $("staged");
  if (!el) return;
  try {
    const j = await (await fetch("/保存/状态")).json();
    const n = (j["待合入"] || []).length;
    el.textContent = n ? `待合入 ${n} 件` : "";
    el.title = n ? `地图/待合入/ 里有 ${n} 件草稿，等 tools/import_editor.py 合入：`
                   + j["待合入"].join("、") : "待合入/ 是空的";
    el.hidden = !n;
  } catch (e) { el.hidden = true; }
}

function bindExports() {
  $("save").onclick = () => { saveNow(setSaved); closeMenu(); };
  $("stage").onclick = () => { saveToStaging(); };
  $("expPng").onclick = () => { flushAll(); download(`地块编码-${today()}.png`, idCanvas.toDataURL("image/png")); closeMenu(); };
  $("expDis").onclick = () => { flushAll(); download(`块区编码-${today()}.png`, distLocalPng()); closeMenu(); };
  /* 「导出地形 PNG」已按 docs/adr/0001 去掉：地形图是管线定稿，编辑器不产出它 */
  $("expLed").onclick = () => {
    const pc = getPlotCells(), rows = [["id", "名称", "地缘", "地域", "像元数", "估面积km²"]];
    for (const id of Object.keys(state.plots).sort((a, b) => a - b)) {
      const p = state.plots[id], c = pc[id] || 0;
      rows.push([id, p.n, p.g >= 0 ? DATA.palette[p.g].geo : "", p.d >= 0 ? DOM[p.d].d : "", c,
                 Math.round(areaOfMap(getCellsOf(), +id))]);
    }
    download(`地块台账-${today()}.csv`, URL.createObjectURL(new Blob([csv(rows)], { type: "text/csv" })), true);
    closeMenu();
  };
  $("expBLed").onclick = () => {
    const bc = getBlockCells(), rows = [["id", "名称", "所属地块", "像元数", "越界像元", "估面积km²"]];
    for (const id of Object.keys(state.blocks).sort((a, b) => a - b)) {
      const b = state.blocks[id];
      rows.push([id, b.n, b.p ? (state.plots[b.p] ? state.plots[b.p].n : b.p) : "", bc[id] || 0,
                 b.p ? blockStrays(+id) : 0, Math.round(areaOfMap(getCellsOfBlock(), +id))]);
    }
    download(`块区台账-${today()}.csv`, URL.createObjectURL(new Blob([csv(rows)], { type: "text/csv" })), true);
    closeMenu();
  };
  $("expJson").onclick = () => {
    download(`栅格存档-${today()}.json`,
             URL.createObjectURL(new Blob([JSON.stringify(snapshot())], { type: "application/json" })), true);
    closeMenu();
  };
  $("importBtn").onclick = () => $("fileIn").click();
  $("fileIn").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d.pi) throw new Error("格式不符（缺 pi）");
        applySnapshot(d); recount(); repaintAll(); buildEdgesNow(); markOverlayDirty();
        renderLeft(); renderInspector(); renderStats(); schedule();
        setSaved("已导入");
      } catch (err) { alert("导入失败：" + err.message); }
    };
    r.readAsText(f); e.target.value = ""; closeMenu();
  };
  $("chkParts").onclick = () => { closeMenu(); showPartsReport(); };
  $("resetBtn").onclick = () => {
    if (!confirm("清空本地增量存档，恢复种子台账？地图上的涂改会一起丢掉。")) return;
    clearSave(); state.plots = {};
    /* 复位要连块区层一起回到**基线**（不是清成 0）：底图里的分区编码.png 若已有内容，
       清成 0 会把它抹掉，而且因为 touched 被清空，这次抹除还进不了增量存档 */
    state.plot.set(BASE.plot); state.terr.set(BASE.terr); state.dist.set(BASE.dist);
    touched.clear(); state.hist = []; state.histAt = -1;
    seedPlots();
    /* 选中态回到起点：只读自然层的选中值没有意义，一律归 0（不再写死 terrain 那个键） */
    const sel = { domain: 0, plot: state.sel.plot, block: 0 };
    for (const k of RO_KEYS) sel[k] = 0;
    state.sel = sel;
    recount(); repaintAll(); buildEdgesNow(); renderLeft(); renderInspector(); renderStats();
    markOverlayDirty(); schedule(); setSaved("已清空");
  };
}

/* ---------------- 帮助浮层 ---------------- */
function bindHelp() {
  const main = document.querySelector("main");
  let box = null;
  const close = () => { if (box) { box.remove(); box = null; } };
  window.__toggleHelp = () => {
    if (box) return close();
    box = document.createElement("div");
    box.className = "help";
    box.innerHTML = `<button class="x" title="关闭">✕</button>
      <b>两种模式</b><span class="sec"><kbd>V</kbd> 视图（拖拽平移 · 滚轮缩放 · 点选看明细）<br>
      <kbd>E</kbd> 编辑（左键涂抹 · <b>右键选中</b> · <kbd>空格</kbd>/中键平移）</span>
      <span class="sec"><b>右键选中什么</b>由单元决定：<b>地域</b>→选中光标下的<b>地块</b>；<b>地块/块区</b>→选中那一<b>栅格</b>；<b>自然层</b>（地形/气候）→不可选中（只读，没有"选中某个地形"这回事）</span>
      <span class="sec"><b>三个可编辑单元</b>（行政图；视图层／编辑层共用）<br>
      <kbd>1</kbd> 地域 → 编辑对象是<b>地块</b>（拖过一片即改其归属）<br>
      <kbd>2</kbd> 地块 → 编辑对象是<b>栅格</b>（写入地块编码）<br>
      <kbd>3</kbd> 块区 → 编辑对象是<b>所属地块内的栅格</b></span>
      <span class="sec"><b>两个只读自然层</b>（<b>只在视图模式</b>出现；编辑模式下单元条上根本没有它们）<br>
      <kbd>4</kbd> 地形 → 一个字节 = <b>覆盖</b>（高 4 位）× 16 + <b>形态</b>（低 4 位）；左栏按<b>显示类</b>统计<br>
      <kbd>5</kbd> 气候 → 一个字节 = <b>热量带</b> × 8 + <b>干湿</b>；左栏是两轴交叉表<br>
      两者都由管线定稿、编辑器一格都不许改（<code>docs/adr/0001</code>）；
      底图着色随当前层切换，页脚读数一次报全：覆盖 ｜ 形态 ｜ 热量带 ｜ 干湿 ｜ <b>显示类</b></span>
      <span class="sec"><b>笔与橡皮</b><kbd>B</kbd> 笔 · <kbd>X</kbd> 橡皮 · 半径 <kbd>[</kbd> <kbd>]</kbd> 或拖顶栏滑杆（1–50 格）<br><b>右键</b> = 选中（拾取）光标下的对象；按住右键拖动可连续拾取</span>
      <span class="sec"><b>图层</b><kbd>T</kbd> 地形底图 · <kbd>R</kbd> 参考层（**矢量顶点**：唐 741 州面 ＋ 现代单元边界；放大到 12 倍显示顶点） · <kbd>P</kbd> 地块线 · <kbd>K</kbd> 块区线</span>
      <span class="sec"><b>海底不可落笔</b>「海洋」就是海陆口径（陆地 = NE 陆地 ∪ 湖泊 ∪ 冰川），地块层在构建期已按它裁过。
      在地形为「海洋」的格子上涂地块/块区/地形一律跳过，并弹提示报跳过格数 —— 这样"地块压在海上"不可能再发生</span>
      <span class="sec"><b>新建</b>「＋ 新建」按当前单元建：<b>地块</b>→以选中那格为种子；<b>块区</b>→落点须在选中地块内；<b>地域与自然层</b>不可新建。没选栅格会提示先右键选一格</span><span class="sec"><b>清单</b><kbd>,</kbd> <kbd>.</kbd> 上一个／下一个对象（自然层上则是切换层）· <kbd>F</kbd> 适应窗口 · <kbd>Esc</kbd> 取消落点／取消选中</span>
      <span class="sec"><b>撤销</b><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>，一次拖拽 = 一步</span>
      <span class="sec"><b>存档</b>自动保存（只存增量，防崩溃）· <b>保存到待合入</b>才是正式交付：写进 <code>地图/待合入/</code>，再由 <code>tools/import_editor.py</code> 合入真源<br>导出/导入在右上 <b>⋯</b></span>`;
    box.querySelector(".x").onclick = close;
    main.appendChild(box);
  };
  $("helpBtn").onclick = () => window.__toggleHelp();
}

/* ---------------- 侧栏宽度可拖 ---------------- */
function bindSplitter(elId, cssVar, min, max, invert) {
  const el = $(elId);
  el.addEventListener("mousedown", e => {
    e.preventDefault();
    const startX = e.clientX;
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || min;
    const move = ev => {
      const v = Math.max(min, Math.min(max, cur + (ev.clientX - startX) * (invert ? -1 : 1)));
      document.documentElement.style.setProperty(cssVar, v + "px");
      resize(); schedule();
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      const cs = getComputedStyle(document.documentElement);
      try { localStorage.setItem(LAY_KEY, JSON.stringify({ side: cs.getPropertyValue("--side").trim(), insp: cs.getPropertyValue("--insp").trim() })); } catch (err) { /* 忽略 */ }
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
}
function restoreLayout() {
  try {
    const d = JSON.parse(localStorage.getItem(LAY_KEY) || "{}");
    if (d.side) document.documentElement.style.setProperty("--side", d.side);
    if (d.insp) document.documentElement.style.setProperty("--insp", d.insp);
  } catch (e) { /* 忽略 */ }
}

/* ================================================================ 键鼠 */
function bindRadiusSlider() {
  const s = $("rslider");
  const fromX = e => {
    const r = s.getBoundingClientRect();
    const t = (e.clientX - r.left) / r.width * 132;                 // → viewBox 坐标
    return R_MIN + (Math.max(RS.x0, Math.min(RS.x1, t)) - RS.x0) / RS.w * (R_MAX - R_MIN);
  };
  let dragging = false;
  s.addEventListener("pointerdown", e => {
    dragging = true; s.setPointerCapture(e.pointerId);
    setRadius(fromX(e)); e.preventDefault();
  });
  s.addEventListener("pointermove", e => { if (dragging) setRadius(fromX(e)); });
  const stop = e => { dragging = false; try { s.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } };
  s.addEventListener("pointerup", stop);
  s.addEventListener("pointercancel", stop);
  s.addEventListener("wheel", e => { e.preventDefault(); setRadius(state.radius + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  s.addEventListener("keydown", e => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d) return;
    e.preventDefault(); setRadius(state.radius + d * (e.shiftKey ? 5 : 1));
  });
}
function buildTicks() {
  const g = $("rTicks"); if (!g) return;
  let html = "";
  for (const v of [1, 10, 20, 30, 40, 50]) {
    const t = (v - R_MIN) / (R_MAX - R_MIN), x = 9 + t * 114;
    html += `<rect x="${(x - 0.5).toFixed(1)}" y="16.5" width="1" height="3" rx="0.5"></rect>`;
  }
  g.innerHTML = html;
}

function bindInput() {
  let drag = null, space = false, lastCell = -1, downAt = null, painted = false;
  const cvPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  cv.addEventListener("mousedown", e => {
    const [sx, sy] = cvPos(e);
    downAt = [sx, sy]; painted = false;
    if (e.button === 1 || space) { drag = { mode: "pan", sx, sy, vx: state.view.x, vy: state.view.y }; return; }
    const i = toCell(sx, sy);
    if (e.button === 2) {                 // 右键 = 选中（按住拖可连续选中）
      drag = { mode: "pick" };
      lastCell = i;
      pickAt(i);
      return;
    }
    if (state.mode === "view") { drag = { mode: "pan", sx, sy, vx: state.view.x, vy: state.view.y }; return; }
    if (i < 0) return;
    guard();
    drag = { mode: "paint" };              // 少了这行，按住拖拽只会涂到第一格
    lastCell = i; painted = true;
    stamp(i, state.pen);
  });
  /* 落笔前的守则：没选对象就提示，别让工具"默默不灵" */
  function guard() {
    const u = state.unit;
    if (u === "plot" && !state.sel.plot) toast("先在地块清单里选一个地块，或点「＋ 新建」");
    if (u === "block" && !state.sel.block) toast("先在块区清单里选一个块区，或点「＋ 新建」");
  }
  window.addEventListener("mousemove", e => {
    const [sx, sy] = cvPos(e);
    const [VW, VH] = viewSize();
    const i = (sx < 0 || sy < 0 || sx > VW || sy > VH) ? -1 : toCell(sx, sy);
    const changed = i !== state.curCell;
    state.curCell = i;
    if (i >= 0) {
      const x = i % W, y = (i - x) / W;
      setCursorText(`${(G.lon0 + (x + 0.5) * G.cell).toFixed(2)}E ${(G.lat1 - (y + 0.5) * G.cell).toFixed(2)}N`);
      const u = state.unit;
      const hov = u === "plot" ? state.plot[i] : u === "block" ? state.dist[i]
                : u === "domain" ? (state.plots[state.plot[i]] ? state.plots[state.plot[i]].d : -1)
                : state.terr[i];
      if (state.hover[u] !== hov) { state.hover[u] = hov; markOverlayDirty(); }
    } else if (changed) {
      state.hover[state.unit] = state.unit === "domain" ? -1 : 0;   // 离开地图：清掉悬停高亮
      markOverlayDirty();
    }
    if (!drag) { if (changed) { state.dirty = true; schedule(); } return; }
    if (drag.mode === "pan") {
      state.view.x = drag.vx + (sx - drag.sx); state.view.y = drag.vy + (sy - drag.sy);
      state.dirty = true; schedule(); return;
    }
    if (drag.mode === "pick") {                    // 右键按住拖动：连续拾取
      if (i >= 0 && i !== lastCell) { lastCell = i; pickAt(i, true); }
      return;
    }
    if (i < 0) return;
    if (i !== lastCell) { stampLine(lastCell, i, state.pen); lastCell = i; painted = true; }
  });
  window.addEventListener("mouseup", e => {
    const was = drag;
    drag = null; lastCell = -1;
    if (was && was.mode === "pick") { renderInspector(); renderStats(); }   // 拾取期间是轻量的，松手这一下补全右栏
    if (state.mode === "view" && was && was.mode === "pan" && downAt && !painted) {
      const [sx, sy] = cvPos(e);
      if (Math.hypot(sx - downAt[0], sy - downAt[1]) < 4) pickAt(toCell(sx, sy));   // 视作"点选"
    }
    if (painted && state.mode === "edit") {
      commit(() => {
        recount(); refreshLeftCounts(); renderStats(); autosave(setSaved);
        /* 涂改同时改了两样东西：①边界掩膜（地块线 P / 块区线 K 画的是它）；
           ②地块之间的邻接关系（"相邻必不同"的配色由它算）。原先只在「新建/清空/
           拆分/导入/重置」里重建，涂抹之后不重建 —— 于是边界线是旧的、配色可能
           出现相邻同色。这里补上（markEdgesDirty 自带 300 ms 防抖，长拖拽只扫一次）。 */
        markEdgesDirty();
      });
      const sk = takeSkipped();
      if (sk.ocean || sk.cross) {
        const parts = [];
        if (sk.ocean) parts.push(`跳过海面 ${sk.ocean} 格（海陆口径来自底图，编辑器不改）`);
        if (sk.cross) parts.push(`跳过越出所属地块 ${sk.cross} 格`);
        toast(parts.join("；"), 2600);
      }
      renderInspector();
    }
    downAt = null; painted = false;
  });
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const [sx, sy] = cvPos(e);
    const f = Math.pow(0.9988, e.deltaY);
    const ns = Math.max(FIT() * 0.9, Math.min(60, state.view.s * f));
    state.view.x = sx - (sx - state.view.x) * ns / state.view.s;
    state.view.y = sy - (sy - state.view.y) * ns / state.view.s;
    state.view.s = ns; state.dirty = true; schedule();
  }, { passive: false });

  window.addEventListener("keydown", e => {
    const field = isField(e.target);
    if (e.code === "Space") {
      if (field) return;
      space = true; setSpace(true); e.preventDefault(); return;
    }
    if (field) { if (e.key === "Escape") e.target.blur(); return; }   // 输入框里不抢快捷键
    const k = e.key.toLowerCase(), meta = e.ctrlKey || e.metaKey;
    if (meta && k === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(setSaved); refreshAll(); return; }
    if (meta && k === "y") { e.preventDefault(); redo(setSaved); refreshAll(); return; }
    if (meta && k === "s") { e.preventDefault(); saveNow(setSaved); return; }
    if (meta) return;
    if (k === "escape") {
      if ($("menu").open) { $("menu").open = false; return; }
      if (document.querySelector(".report")) { document.querySelector(".report").remove(); return; }
      /* 取消选中：地域归 -1（含"未指派"），其余归 0。只读自然层没有选中这回事，
         但它的键也要清（`state.sel[state.unit]` 写 undefined 会让 syncLeftSel 比中 null）。 */
      state.sel[state.unit] = state.unit === "domain" ? -1 : 0;
      state.selCell = -1;          // 落点一起取消（帮助里写的是"Esc 取消落点／取消选中"）
      syncLeftSel(); renderInspector(); markOverlayDirty(); schedule(); return;
    }
    if (k === "f") { fit(); schedule(); return; }
    if (k === "v") { setMode("view"); return; }
    if (k === "e") { setMode("edit"); return; }
    if (k === "b") { setPen(true); return; }
    if (k === "x") { setPen(false); return; }
    if (k === "h" || k === "?") { window.__toggleHelp && window.__toggleHelp(); return; }
    if (k === "1") { setUnit("domain"); return; }
    if (k === "2") { setUnit("plot"); return; }
    if (k === "3") { setUnit("block"); return; }
    /* 4 / 5… 依 RO_ORDER 轮到只读自然层（编辑模式下 setUnit 会拦下并提示去视图模式） */
    if (/^[4-9]$/.test(k)) {
      const ro = RO_ORDER[+k - 4];
      if (ro) { setUnit(ro); return; }
    }
    if (k === "t") { $("ovTer").click(); return; }
    if (k === "r") { $("ovRef").click(); return; }
    if (k === "p") { $("ovEdge").click(); return; }
    if (k === "k") { $("ovBEdge").click(); return; }
    if (k === "[" || k === "]") { setRadius(state.radius + (k === "]" ? 1 : -1)); return; }
    if (k === "," || k === ".") { stepObject(k === "." ? 1 : -1); return; }
  });
  window.addEventListener("keyup", e => { if (e.code === "Space") { space = false; setSpace(false); state.dirty = true; schedule(); } });
  window.addEventListener("resize", () => { resize(); schedule(); });
  /* 画布尺寸还会因为别的原因变（拖分隔条、恢复保存的侧栏宽度、浏览器缩放、开关 DevTools）：
     漏量一次就变成"缓冲区被 CSS 拉伸、命中测试按旧尺寸算"，点哪儿都偏。盯住画布本身最稳。 */
  if (window.ResizeObserver) new ResizeObserver(() => { resize(); schedule(); }).observe(cv);
}
/* , / . —— 前后切换：
   行政单元在**自己的清单**里走一个对象；只读自然层没有"对象"，就切**层**
   （地形 ⇄ 气候），这也让"顶栏可切自然层"多一条键盘路径。 */
function stepObject(d) {
  const u = state.unit;
  if (isRoUnit(u)) {
    const i = RO_ORDER.indexOf(u);
    const nxt = RO_ORDER[((i < 0 ? 0 : i) + d + RO_ORDER.length) % RO_ORDER.length];
    setUnit(nxt);
    return;
  }
  const list = u === "domain" ? DOM.map((x, i) => i)
    : u === "plot" ? Object.keys(state.plots).map(Number).sort((a, b) => a - b)
    : Object.keys(state.blocks).map(Number).sort((a, b) => a - b);
  if (!list.length) return;
  const cur = list.indexOf(state.sel[u]);
  const nxt = list[((cur < 0 ? (d > 0 ? -1 : 0) : cur) + d + list.length) % list.length];
  pickObject(u, nxt);
  const el = rowRefs.get(nxt);
  if (el) { el.scrollIntoView({ block: "nearest" }); }
}

/* ================================================================ 装配 */
const setSaved = t => { const el = $("saved"); if (el) el.textContent = t; };
function refreshAll() {
  /* renderLeft 会把左栏的计数一并刷新（afterPanelRender → refreshLeftCounts）；
     撤销/重做可能改回地块名与地域，左栏的分色与名字也得跟着变 */
  recount(); renderLeft(); renderInspector(); renderStats();
  markOverlayDirty(); schedule();
}
/* 只读自然层的顶栏按钮**由 ro.js 的表生成**（index.html 里只留一个空槽与分隔符）。
   加一层 = 表里加一条 → 按钮自己就出来了。 */
function buildRoButtons() {
  const box = document.getElementById("roBtns");
  if (!box) return;
  box.innerHTML = RO_ORDER.map((k, i) => {
    const L = roLayer(k);
    return `<button data-unit="${k}" title="${esc(L.n)}（只读）· ${esc(L.tip)}（${i + 4}）">`
      + `${esc(L.n)}</button>`;
  }).join("");
  box.querySelectorAll("button").forEach(b => b.onclick = () => setUnit(b.dataset.unit));
  syncRoButtons();
}
export function bindUI() {
  /* 模式 / 单元 —— 先造只读层的按钮，再统一挂事件（顺序反了那几个按钮就没有 onclick） */
  buildRoButtons();
  document.querySelectorAll("#modeSeg button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll("#unitSeg button").forEach(b => {
    if (!b.dataset.unit) return;
    if (!b.onclick) b.onclick = () => setUnit(b.dataset.unit);
  });
  /* 笔 / 橡皮 */
  $("pentog").querySelectorAll("button[data-pen]").forEach(b =>
    b.onclick = () => setPen(b.dataset.pen === "1"));
  /* 半径 */
  buildTicks(); bindRadiusSlider(); setRadius(state.radius);
  /* 图层 */
  const tog = (id, key) => {
    const el = $(id);
    el.setAttribute("aria-pressed", String(state[key]));
    el.onclick = () => {
      state[key] = !state[key];
      el.setAttribute("aria-pressed", String(state[key]));
      if (key === "showRef" && state.showRef && !REF.ready) {
        /* 参考层是矢量数据（参考顶点.bin），第一次打开时才取；取不到只提示，底图照旧 */
        loadRef().then(() => {
          if (REF.failed) toast("参考顶点层载入失败：取不到 data/参考顶点.bin", 2600);
          else {
            dropRefPathCache();
            toast(`参考顶点：${REF.n} 环 / ${(REF.bytes / 1048576).toFixed(2)} MB（放大到 12 倍显示顶点）`, 2400);
          }
          state.dirty = true; schedule();
        });
      }
      state.dirty = true; schedule();
    };
  };
  tog("ovTer", "showTerrain"); tog("ovRef", "showRef");
  tog("ovEdge", "showEdge"); tog("ovBEdge", "showBEdge");
  /* 左栏动作：一个「＋ 新建」按钮，按当前单元决定新建什么（落点 = 已选中的那一格） */
  $("leftAct").onclick = () => newAtCurrent();
  /* 左栏点选（事件委托） */
  leftBody.addEventListener("click", e => {
    const row = e.target.closest(".row"); if (!row) return;
    const id = +row.dataset.id;
    if (leftKind === "domain") pickObject("domain", id);
    else if (leftKind === "plot") pickObject("plot", id);
    else if (leftKind === "block") pickObject("block", id);
  });
  /* 撤销 / 重做 / 适应 / 帮助 */
  $("undo").onclick = () => { undo(setSaved); refreshAll(); };
  $("redo").onclick = () => { redo(setSaved); refreshAll(); };
  $("fit").onclick = () => { fit(); schedule(); };
  bindHelp(); bindMenu(); bindExports(); bindInput();
  bindSplitter("sp1", "--side", 180, 560, false);
  bindSplitter("sp2", "--insp", 200, 620, true);
  restoreLayout();
  if (!localStorage.getItem(LS_HELP)) { try { localStorage.setItem(LS_HELP, "1"); } catch (e) { /* 忽略 */ } $("helpBtn").click(); }
}
