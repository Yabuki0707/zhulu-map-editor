/* ==========================================================================
   paint.js —— 笔刷：圆形范围（半径 1..50）、笔/橡皮、四个单元的编辑行为
     地域：改"光标下地块"的归属（编辑对象 = 地块）
     地块：把地块编码写进栅格（编辑对象 = 栅格）
     块区：在"所属地块"的范围内把块区编码写进栅格（编辑对象 = 地块内的栅格）
     地形：把地形编码写进栅格（编辑对象 = 栅格）

   **海底不可落笔**：地形层的「海洋」就是海陆口径（陆地 = NE 陆地 ∪ 湖泊 ∪ 冰川区），
   地块层在构建期已按它裁过。若放手让人在海上涂地块，口径当场破掉；所以四个单元
   一律跳过 `地形 == 海洋` 的像元，并在一次手势结束时把跳过数报出来（不静默）。
   ========================================================================== */

import { W, H, T_OCEAN } from "./config.js";
import { flushAll } from "./raster.js";
import { state, beginGesture, endGesture, writeAll, autosave,
         setPlotDomain, setBlockOwner, brushRadius, KIND } from "./state.js";
import { schedule, markOverlayDirty } from "./render.js";

/* 被规则挡掉的格数：一次手势结束时由 UI 取走并提示（否则用户只看到"没画上"） */
let skippedOcean = 0, skippedCross = 0;
export const takeSkipped = () => {
  const r = { ocean: skippedOcean, cross: skippedCross };
  skippedOcean = 0; skippedCross = 0;
  return r;
};

/* 半径内的格子（含圆心）
   r = 1 → 单格；覆盖判定 hypot <= r - 0.5，于是 r = 2 → 3×3，r = 50 → 99×99 的圆 */
export function forEachInBrush(i, fn) {
  if (i < 0) return 0;
  const rad = brushRadius() - 0.5;
  const cx = i % W, cy = (i - cx) / W;
  const rr = Math.ceil(rad);
  let n = 0;
  const y0 = Math.max(0, cy - rr), y1 = Math.min(H - 1, cy + rr);
  const x0 = Math.max(0, cx - rr), x1 = Math.min(W - 1, cx + rr);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy, row = y * W;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy > rad * rad) continue;
      fn(row + x); n++;
    }
  }
  return n;
}

/* 涂一格：按当前单元与笔/橡皮形态写值 */
function paintOne(k, pen) {
  const unit = state.unit;
  /* 地形是只读单元（docs/adr/0001）：地形图是管线算出来的模拟底数，编辑器一格都不许改。
     拦在**最底层**——就算 UI 上哪里漏了（快捷键、存档恢复的旧 unit），也写不进去。 */
  if (unit === "terrain") return;
  if (state.terr[k] === T_OCEAN) {                          // 海底：口径来自底图，不动
    if (unit !== "domain") skippedOcean++;                  // 地域单元本来就没有地块可指
    return;
  }
  const g = beginGesture();
  if (unit === "plot") {
    const val = pen ? state.sel.plot : 0;
    if (!pen && !state.plot[k]) return;
    if (pen && !val) return;                                  // 没选地块：不写
    if (state.plot[k] === val) return;
    g.idx.push(k); g.kind.push(KIND.plot); g.from.push(state.plot[k]); g.to.push(val);
    state.plot[k] = val;
  } else if (unit === "block") {
    const pid = state.plot[k];
    if (!pid) return;                                         // 无地块 → 块区无处可挂
    const bid = state.sel.block;
    if (pen) {
      if (!bid) return;                                       // 没选块区：不写
      const b = state.blocks[bid];
      if (!b) return;
      if (!b.p) setBlockOwner(bid, pid);                       // 首笔落地：块区认领该地块
      else if (b.p !== pid) { skippedCross++; return; }         // 跨地块：跳过（收笔时提示）
      if (state.dist[k] === bid) return;
      g.idx.push(k); g.kind.push(KIND.dist); g.from.push(state.dist[k]); g.to.push(bid);
      state.dist[k] = bid;
    } else {
      if (!state.dist[k]) return;
      g.idx.push(k); g.kind.push(KIND.dist); g.from.push(state.dist[k]); g.to.push(0);
      state.dist[k] = 0;
    }
  } else {
    /* 地域：编辑对象是"地块"，不是像元 —— 一段拖拽只记一次元数据改动 */
    const dom = pen ? state.sel.domain : -1;
    const id = state.plot[k];
    if (!id) return;
    const p = state.plots[id];
    if ((p ? p.d : -1) === dom) return;
    setPlotDomain(id, dom);
    return;
  }
  writeAll(k);
}

/* 一次落笔：圆形范围 + 笔/橡皮。只回写**这一笔覆盖的矩形**——
   原先回写的是「整段手势的累积包围盒」，一次长拖拽会对"从头涂到现在"的区域
   反复做 6 次 putImageData，越拖越慢（上传量按拖拽长度平方增长）。 */
export function stamp(i, pen) {
  if (i < 0) return 0;
  const n = forEachInBrush(i, k => paintOne(k, pen !== undefined ? pen : state.pen));
  if (n) {
    const rr = Math.ceil(brushRadius() - 0.5);
    const cx = i % W, cy = (i - cx) / W;
    flushAll([Math.max(0, cx - rr), Math.max(0, cy - rr),
              Math.min(W, cx + rr + 1), Math.min(H, cy + rr + 1)]);
    /* 手势进行中就打一次"待保存"的招呼：autosave 自带 5 s 死线，
       所以按住不松手的长拖拽也会中途落盘，不会攒到松手那一下才写。 */
    autosave();
  }
  if (state.unit === "domain") markOverlayDirty();
  state.dirty = true; schedule();
  return n;
}

/* 拖拽插值：两格之间按半径步长补点，快速拖动也不断线 */
export function stampLine(from, to, pen) {
  if (from < 0 || to < 0) return;
  const x0 = from % W, y0 = (from - x0) / W, x1 = to % W, y1 = (to - x1) / W;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, (brushRadius() - 0.5) * 0.6);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let s = 1; s <= n; s++) {
    const t = s / n;
    stamp(Math.round(y0 + (y1 - y0) * t) * W + Math.round(x0 + (x1 - x0) * t), pen);
  }
}

export function commit(onCommit) {
  endGesture(onCommit);
  markOverlayDirty();
}
