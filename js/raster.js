/* ==========================================================================
   raster.js —— 栅格图层：解码 PNG、图层画布与 ImageData、边界掩膜与金字塔
   只提供"像素容器"原语，不认识地块语义（配色与归属逻辑在 state.js）。
   编码：24 位 RGB，码 = R + G×256（0 = 无）—— canvas 会把 16 位灰度降成 8 位，故不用灰度。
   参考层不在这里：它是**矢量顶点**（js/refvec.js），不再烧成栅格掩膜，也不再有金字塔。
   ========================================================================== */

import { DATA, W, H, NC, TER_THIN } from "./config.js";
import { RO_VIEW, roColor } from "./ro.js";

/* ---------------- 图层画布（各一张，尺寸 = 栅格） ---------------- */
export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w === undefined ? W : w; c.height = h === undefined ? H : h;
  return c;
}
const readCtx = c => c.getContext("2d", { willReadFrequently: true });

export const plotCanvas = makeCanvas();      // 地块着色层
export const terCanvas  = makeCanvas();      // 地形着色层
export const distCanvas = makeCanvas();      // 块区着色层
export const edgeCanvas = makeCanvas();      // 地块边界掩膜
export const bedgeCanvas = makeCanvas();     // 块区边界掩膜
export const overlayCanvas = makeCanvas();   // 选中/悬停高亮层
export const idCanvas   = makeCanvas();      // 地块原始编码（导出用）
/* 这里原来还有两张"原始编码"画布（块区 distId / 地形 terRaw）：它们唯一的消费者是编辑器的
   「导出块区/地形 PNG」菜单，而导出块区改走 `distLocalPng()`（要先把全局 id 折成局部序号）、
   导出地形按 docs/adr/0001 早已删掉。没人读的 5.2M 像元画布 ×2（约 74 MB）留着，
   还要在**每格写入的热路径**里跟着刷一遍 —— 2026-10-09 随只读层重构一并删掉。 */

export const plotCtx = readCtx(plotCanvas);
export const terCtx  = readCtx(terCanvas);
export const distCtx = readCtx(distCanvas);
export const edgeCtx = readCtx(edgeCanvas);
export const bedgeCtx = readCtx(bedgeCanvas);
export const overlayCtx = readCtx(overlayCanvas);
export const idCtx = readCtx(idCanvas);

export const plotImg = plotCtx.createImageData(W, H);
export const terImg  = terCtx.createImageData(W, H);
export const distImg = distCtx.createImageData(W, H);
export const edgeImg = edgeCtx.createImageData(W, H);
export const bedgeImg = bedgeCtx.createImageData(W, H);
export const overlayImg = overlayCtx.createImageData(W, H);
export const idImg   = idCtx.createImageData(W, H);

/* ---------------- 栅格数据（TypedArray）与基准（存档增量以此为参照） ---------------- */
export const plotData = new Uint16Array(NC);
export const terrData = new Uint8Array(NC);
export const distData = new Uint16Array(NC);
/* 气候码层（热量带×8+干湿，0..31）。只用来给地形**派生显示色**——森林的四种绿靠它，
   而底图里存的仍是「覆盖 × 形态」两个半字节（ADR 0006、0007）。只读产品层，编辑器不写它。 */
export const climData = new Uint8Array(NC);

export const BASE = { plot: null, terr: null, dist: null };
export function freezeBase() {
  BASE.plot = plotData.slice(); BASE.terr = terrData.slice(); BASE.dist = distData.slice();
}

/* ---------------- 解码：把 PNG 读成数字，而不是当图看 ---------------- */
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("图层载入失败：" + String(src).slice(0, 48)));
    i.src = src;
  });
}
export async function decodeAll() {
  const off = makeCanvas();
  const c = off.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = false;
  const [pi, ti, di] = await Promise.all([
    loadImg(DATA.plot_png), loadImg(DATA.terrain_png),
    DATA.dist_png ? loadImg(DATA.dist_png) : Promise.resolve(null),
  ]);
  const ci = DATA.climate_png ? await loadImg(DATA.climate_png).catch(() => null) : null;
  c.drawImage(pi, 0, 0, W, H);
  const d1 = c.getImageData(0, 0, W, H).data;
  c.clearRect(0, 0, W, H); c.drawImage(ti, 0, 0, W, H);
  const d2 = c.getImageData(0, 0, W, H).data;
  c.clearRect(0, 0, W, H);
  if (di) c.drawImage(di, 0, 0, W, H);
  const d3 = di ? c.getImageData(0, 0, W, H).data : null;
  c.clearRect(0, 0, W, H);
  /* 气候层是 8 位灰度，canvas 会把它摊成 RGBA —— 取 R 通道即原值。
     缺它也不崩：显示色退回基础色（森林只有一种绿），其余功能不受影响。 */
  if (ci) c.drawImage(ci, 0, 0, W, H);
  const d4 = ci ? c.getImageData(0, 0, W, H).data : null;
  /* 分区编码.png 存的是**地块内的局部序号**（v3），而编辑器内部一律用**全局块区 id**
     （state.blocks 的键、导出、存档全是它）。这里当场换算一次，别的模块一行都不用改。
     键 = plot×256 + local；地块 ≤ 8191（13 位），所以表要开 (maxPlot+1)×256 那么长。 */
  let maxPlot = 0;
  for (const b of (DATA.districts || [])) if (b.plot > maxPlot) maxPlot = b.plot;
  const l2g = new Uint16Array((maxPlot + 1) * 256);
  for (const b of (DATA.districts || [])) l2g[(b.plot << 8) | b.local] = b.id;
  for (let i = 0, j = 0; i < NC; i++, j += 4) {
    plotData[i] = d1[j] | (d1[j + 1] << 8);
    terrData[i] = d2[j];
    if (d3) distData[i] = d3[j] ? l2g[(plotData[i] << 8) | d3[j]] : 0;
    if (d4) climData[i] = d4[j] & 31;
  }
  for (const ctx of [idCtx]) ctx.imageSmoothingEnabled = false;
  freezeBase();
}

/* ---------------- 回写画布 ---------------- */
export function putBox(ctx, img, b) {
  if (b) ctx.putImageData(img, 0, 0, b[0], b[1], b[2] - b[0], b[3] - b[1]);
  else ctx.putImageData(img, 0, 0);
}
export function flushAll(b) {
  putBox(plotCtx, plotImg, b); putBox(terCtx, terImg, b); putBox(distCtx, distImg, b);
  putBox(idCtx, idImg, b);
}

/* --------------------------------------------------------------------------
   掩膜金字塔（mipmap）：把 1px 宽的边界掩膜逐级 2×2「或」降采样。
   用处：缩小时若直接缩放第 0 级，1px 线会整片消失或闪烁；取一级"缩到
   每格 1~2 屏像素"的层来画，边界在任何缩放级别都稳定可见。
   （参考层不再走这里——它是矢量，画线由屏幕像素决定。）
   -------------------------------------------------------------------------- */
export function buildMips(src, w, h, maxLevel, orLevels = 1) {
  /* 第 1..orLevels 层用「任一子格置位」——1px 细线不会丢；
     更粗的层改成「至少两个子格置位」——否则边界会糊成一整片。 */
  const levels = [{ w, h, data: src }];
  let cw = w, ch = h, cur = src;
  for (let l = 1; l <= maxLevel; l++) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), nd = new Uint8Array(nw * nh);
    const need = l <= orLevels ? 1 : 2;
    for (let y = 0; y < nh; y++) {
      const r0 = (2 * y) * cw, r1 = Math.min(2 * y + 1, ch - 1) * cw;
      for (let x = 0; x < nw; x++) {
        const x0 = 2 * x, x1 = Math.min(2 * x + 1, cw - 1);
        const c = (cur[r0 + x0] ? 1 : 0) + (cur[r0 + x1] ? 1 : 0)
                + (cur[r1 + x0] ? 1 : 0) + (cur[r1 + x1] ? 1 : 0);
        nd[y * nw + x] = c >= need ? 255 : 0;
      }
    }
    levels.push({ w: nw, h: nh, data: nd });
    cw = nw; ch = nh; cur = nd;
  }
  return levels;
}

/* --------------------------------------------------------------------------
   地形层金字塔（mipmap）。与上面的掩膜金字塔同法，但降采样规则不一样：
   掩膜是布尔，这里是 16 个地形类，得决定每个 2×2 块取哪一类。

   · **细线类（河 / 湖 / 冰川）优先保住**：块里命中就取它（前两级「≥1 格」，
     更深一级「≥2 格」，与掩膜的 `need` 同思路——否则会一路膨胀成一片）。
   · 其余按**多数决**。

   为什么必须做：地形底图原本是满分辨率一次 blit，而 canvas 是
   `imageSmoothingEnabled=false`（最近邻点采样）。缩小时 1 格宽的河会被整片丢掉，
   屏幕上就是「长江断流」。数据侧已把河烧成 4 邻接连通（tools/build_raster.py 的
   burn_lines），但点采样照样会丢——两边都得治。

   地形**永远不变**（管线定稿、编辑器只读，docs/adr/0001），所以建一次就够，
   不需要失效逻辑。
   -------------------------------------------------------------------------- */
export let TER_MIPS = null;
export function buildTerrainMips(maxLevel = 3, thinLevels = 2) {
  const levels = [null];                       // 0 级直接用现成的 terCanvas，不在这里建
  let cw = W, ch = H, cur = terrData, curC = climData;
  for (let l = 1; l <= maxLevel; l++) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), nd = new Uint8Array(nw * nh);
    const ndc = new Uint8Array(nw * nh);         // 同级的**气候码**降采样，供派生显示色
    const need = l <= thinLevels ? 1 : 2;
    const cnt = new Uint8Array(256);            // 地形字节 0..196，按**字节**数

    const cntC = new Uint8Array(32);
    for (let y = 0; y < nh; y++) {
      const r0 = 2 * y * cw, r1 = Math.min(2 * y + 1, ch - 1) * cw;
      for (let x = 0; x < nw; x++) {
        const x0 = 2 * x, x1 = Math.min(2 * x + 1, cw - 1);
        const a = cur[r0 + x0], b = cur[r0 + x1], c = cur[r1 + x0], d = cur[r1 + x1];
        let thin = -1, nThin = 0;
        // ⚠️ TER_THIN 是**覆盖码**（v3），比的是字节的高 4 位；直接 `a === t` 会比不中，
        // 缩小时 1 格宽的河就整片消失（那正是当初做金字塔要解决的问题）。
        const cv = v => v >> 4;
        for (const t of TER_THIN) {                // TER_THIN 已按优先级排好
          if (cv(a) === t || cv(b) === t || cv(c) === t || cv(d) === t) {
            if (thin < 0) thin = t; nThin++;
          }
        }
        let pick;
        if (thin >= 0 && nThin >= need) {
          for (const v of [a, b, c, d]) if (cv(v) === thin) { pick = v; break; }
        } else {
          cnt[a]++; cnt[b]++; cnt[c]++; cnt[d]++;
          let best = a, bn = 0;
          for (let i = 0; i < cnt.length; i++) if (cnt[i] > bn) { bn = cnt[i]; best = i; }
          cnt[a] = cnt[b] = cnt[c] = cnt[d] = 0;
          pick = best;
        }
        nd[y * nw + x] = pick;
        /* 气候码取 2×2 的多数决（并列取先出现者）。它只影响配色，取众数足够稳。 */
        const ca = curC[r0 + x0], cb = curC[r0 + x1], cc = curC[r1 + x0], cd = curC[r1 + x1];
        cntC[ca]++; cntC[cb]++; cntC[cc]++; cntC[cd]++;
        let bc = ca, bnC = 0;
        for (let i = 0; i < 32; i++) if (cntC[i] > bnC) { bnC = cntC[i]; bc = i; }
        cntC[ca] = cntC[cb] = cntC[cc] = cntC[cd] = 0;
        ndc[y * nw + x] = bc;
      }
    }
    levels.push({ w: nw, h: nh, data: nd, clim: ndc });
    cw = nw; ch = nh; cur = nd; curC = ndc;
  }
  TER_MIPS = levels;
  return levels;
}
/* 金字塔某级 → 上色画布。**按"级 × 只读预览层"缓存**（自然层不变，缓存不必失效，
   只有切换 地形/气候 时才换一份——层与取色口径都在 js/ro.js 的 RO_LAYERS）。
   ⚠️ 千万别在这里按层名分叉取色：那正是 2026-10-09 抽掉的那坨"按单元硬编码"。 */
const terMipCanvases = new WeakMap();          // level → { [层名]: canvas }
export function terMipCanvas(level) {
  let slot = terMipCanvases.get(level);
  if (!slot) { slot = {}; terMipCanvases.set(level, slot); }
  if (slot[RO_VIEW]) return slot[RO_VIEW];
  const cv = makeCanvas(level.w, level.h);
  const c = cv.getContext("2d");
  const im = c.createImageData(level.w, level.h), d = im.data, s = level.data;
  const sc = level.clim;
  for (let i = 0, j = 0; i < s.length; i++, j += 4) {
    const rgb = roColor(s[i], sc ? sc[i] : 0);
    d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; d[j + 3] = 255;
  }
  c.putImageData(im, 0, 0);
  slot[RO_VIEW] = cv;
  return cv;
}

/* 掩膜 → 上色画布（按级缓存；掩膜变了用 invalidate 丢掉缓存） */
const mipCanvases = new WeakMap();
export function maskToCanvas(level, rgb, alpha) {
  let arr = mipCanvases.get(level);
  if (!arr) { arr = []; mipCanvases.set(level, arr); }
  const key = rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha;
  let hit = arr.find(x => x.key === key);
  if (hit) return hit.canvas;
  const cv = makeCanvas(level.w, level.h);
  const ctx = cv.getContext("2d");
  const im = ctx.createImageData(level.w, level.h), d = im.data, s = level.data;
  for (let i = 0, j = 0; i < s.length; i++, j += 4) {
    d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; d[j + 3] = s[i] ? alpha : 0;
  }
  ctx.putImageData(im, 0, 0);
  arr.push({ key, canvas: cv });
  return cv;
}

/* ---------------- 地块 / 块区 边界掩膜（id 变化处描 1px） ---------------- */
/* 第 0 级掩膜直接用这几张已经上色的画布画，省掉一次 5.2M 像素的 JS 上色循环
   （否则第一次缩放到 0.5~3 倍会卡一下）。金字塔更高层才现做现缓存。 */
export const EDGE_COLORS = { plot: [58, 48, 36, 190], dist: [40, 74, 92, 200] };
function buildEdgeData(src, dst, rgba) {
  dst.fill(0);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x, id = src[i];
      const r = (x + 1 < W) ? src[i + 1] : id, b = (y + 1 < H) ? src[i + W] : id;
      if (id === r && id === b) continue;
      if (!id && !r && !b) continue;                   // 海里的噪声不画
      const j = i * 4;
      dst[j] = rgba[0]; dst[j + 1] = rgba[1]; dst[j + 2] = rgba[2]; dst[j + 3] = rgba[3];
    }
  }
}
export function buildEdges(plotSrc, distSrc) {
  buildEdgeData(plotSrc, edgeImg.data, EDGE_COLORS.plot);
  edgeCtx.putImageData(edgeImg, 0, 0);
  if (distSrc) {
    buildEdgeData(distSrc, bedgeImg.data, EDGE_COLORS.dist);
    bedgeCtx.putImageData(bedgeImg, 0, 0);
  }
}
export let EDGE_MIPS = null, BEDGE_MIPS = null;
export function buildEdgeMips(plotSrc, distSrc, maxLevel = 4) {
  EDGE_MIPS = buildMips(edgeImg.data.slice(), W, H, maxLevel, 3);
  BEDGE_MIPS = distSrc ? buildMips(bedgeImg.data.slice(), W, H, maxLevel, 3) : null;
}
export const edgeMips = () => EDGE_MIPS;
export const bedgeMips = () => BEDGE_MIPS;
/* 掩膜的来源：0 级用已上色的画布，更高层用金字塔 */
export const levelZeroCanvas = kind =>
  kind === "plot" ? edgeCanvas : bedgeCanvas;
