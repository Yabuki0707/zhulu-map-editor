/* ==========================================================================
   main.js —— 启动装配：解码栅格 → 载入状态 → 绑定界面 → 首帧
   ========================================================================== */

import { DATA, W, H, NC, G, isEditable } from "./config.js";
import { decodeAll } from "./raster.js";
import { loadRef, REF } from "./refvec.js";
import { state, recount, repaintAll, peekLocal, applySnapshot, seedPlots,
         newPlot, newBlock, rebuildPlotColors,
         plotColorOf, purgeOldKeys, dropMeta, autosave, ID_MAX, getPlotCells, getCellsOf,
         getBlockCells, getCellsOfBlock,
         undo, redo, canUndo, canRedo, saveNow, componentsOf, splitComponent, scanParts } from "./state.js";
import { resize, fit, schedule, markOverlayDirty, draw, toCell, buildEdgesNow,
         centerOn, objectLine, cellReadout, viewSize } from "./render.js";
import { bindUI, renderLeft, renderInspector, renderStats, setMode, setUnit,
         setRadius, setPen, pickObject, toast, pickAt, newAtCurrent,
         createPlotAt, createBlockAt, saveToStaging, reportStaging,
         probeDraft, askDraft, roStats } from "./ui.js";
import { RO_LAYERS, RO_ORDER, isRoUnit, setRoView, RO_VIEW } from "./ro.js";
import { stamp, stampLine, commit } from "./paint.js";

async function init() {
  const note = document.getElementById("srcNote");
  if (note) note.textContent = `· ${W}×${H} · ${G.cell}°`;

  /* ---------------- 草稿探测与选择（工单 §4.6） ----------------
     必须在 decodeAll() **之前**：图层来源要在解码前定下来。
     探测失败（服务没挂载、直接开文件）一律**静默当没有草稿**——
     绝不能因为探测不到就让编辑器起不来。 */
  const draft = await probeDraft();
  const useDraft = draft ? await askDraft(draft) : false;
  if (useDraft) {
    /* 草稿里只有行政图的两层；地形与参考顶点**永远**读真源——
       地形是管线定稿，草稿里本来就没有它。 */
    DATA.plot_png = "/草稿/地块编码.png";
    DATA.dist_png = "/草稿/分区编码.png";
  }
  if (note) note.textContent = `· ${W}×${H} · ${G.cell}° · 读${useDraft ? "草稿" : "真源"}`;

  await decodeAll();
  const load = document.getElementById("load");
  if (load) load.remove();

  /* 先清旧版本的键，再读存档：换版后留下的旧键会一直占着浏览器配额（5 MB 上限） */
  const purged = purgeOldKeys();

  /* 本地增量套不套，看三者是否同底（工单 §4.6.5）：真源 base_tag ／ 本地存档 base ／
     草稿 based_on。本地存档存的是**改动格的目标值**（不是差值，见 state.js 的 snapshot），
     所以同底时套用是幂等的；不同底就是两次改动叠错，宁可不用。 */
  const snap = peekLocal();
  let applied = false, why;
  if (!snap) why = "种子台账";
  else if (snap.base !== DATA.base_tag) why = "存档与底图不匹配，已忽略";
  else if (useDraft && draft.based_on !== DATA.base_tag)
    why = `草稿基于旧底图（${draft.based_on || "?"}），本地增量没套用`;
  else { applySnapshot(snap); applied = true; }

  /* applied = 台账与像元都来自存档；否则回种子台账。
     这正是原先"没有存档 / 存档不匹配才种种子"的等价写法，草稿场景下多一条"不同底"。 */
  if (!applied) seedPlots();
  const sv = document.getElementById("saved");
  if (sv) sv.textContent = applied
    ? `读取存档（增量 ${(snap.pi || []).length + (snap.ti || []).length + (snap.di || []).length} 格）`
    : why;

  recount(); repaintAll(); buildEdgesNow(); markOverlayDirty();
  bindUI();
  /* 量画布尺寸（resize）与适应窗口（fit）必须放在 bindUI **之后**：
     bindUI 里的 restoreLayout 会把侧栏宽度从 localStorage 恢复回来，画布的 CSS 尺寸随之改变。
     先量后恢复的话，缓冲区按旧宽度分配、又被 CSS 拉伸到新宽度，而命中测试仍按旧宽度换算——
     症状是"选中的地块跑到光标东边，且越往右偏得越多"。 */
  resize(); fit();
  /* 单元用存档里恢复的那个（applySnapshot 已写好 state.unit）。
     地形是只读单元（docs/adr/0001）：存档若停在它上面，回编辑模式得先落到"地块"——
     否则会出现"当前笔刷 = 地形"却无处落笔的悬空态。 */
  if (!isEditable(state.unit)) state.unit = "plot";
  setMode("edit", true); setUnit(state.unit); setRadius(state.radius); setPen(true);
  renderLeft(); renderInspector(); renderStats();
  schedule(); draw();
  reportStaging();          // 现在生效的是草稿还是真源？问一句服务，在顶栏标出来

  /* 对外 API：供宿主页嵌入 / 自动化测试 */
  window.__editor = {
    state, DATA, G, W, H, NC, fit, schedule, markOverlayDirty, recount, repaintAll,
    toCell, resize, renderLeft, renderInspector, renderStats, setMode, setUnit,
    setRadius, setPen, pickObject, stamp, stampLine, commit, draw, centerOn,
    buildEdgesNow, seedPlots, toast, objectLine, cellReadout,
    undo, redo, canUndo, canRedo, saveNow, newPlot, newBlock,
    pickAt, newAtCurrent, createPlotAt, createBlockAt, componentsOf, splitComponent, scanParts,
    rebuildPlotColors, plotColorOf, viewSize, loadRef, REF,
    purgeOldKeys, dropMeta, autosave, ID_MAX, saveToStaging, reportStaging, isEditable,
    /* 只读自然层：层表、顺序、当前层、按层统计（自动化断言用，例如"寒带多少格"） */
    RO_LAYERS, RO_ORDER, isRoUnit, setRoView, roView: () => RO_VIEW, roStats,
    /* 统计结果的只读视图（手工验/自动化断言用；写操作仍只走上面的函数） */
    getPlotCells, getBlockCells, getCellsOf, getCellsOfBlock,
    /* 便捷断言用 */
    plotAt: i => state.plot[i], distAt: i => state.dist[i], terrAt: i => state.terr[i],
    setSel: (u, v) => { state.sel[u] = v; },
  };
  console.log("栅格编辑器就绪", { 栅格: `${W}×${H}`, 像元: NC,
    地块: Object.keys(state.plots).length, 单元: Object.keys(state.sel).length,
    清理旧键: purged });
}

init().catch(e => {
  window.__initError = String((e && e.stack) || e);
  let load = document.getElementById("load");
  if (!load) {
    load = document.createElement("div");
    load.className = "load"; load.id = "load";
    document.querySelector("main").appendChild(load);
  }
  load.textContent = "载入失败：" + (e && e.message ? e.message : e);
  console.error(e);
});
