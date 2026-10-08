/* ==========================================================================
   config.js —— 常量、三个**可编辑**单元（地域/地块/块区）、调色、图例
   数据入口：js/data.js（由 tools/build_raster.py 生成，勿手改）
   只读自然层（地形/气候）不在这里：它们由 js/ro.js 的 `RO_LAYERS` 描述、并**注册**进来
   （见下面的 registerUnits）——加一层只改 ro.js 那张表，本文件一行不用动。
   ========================================================================== */

import { RASTER_DATA } from "./data.js";

export const DATA = RASTER_DATA;
export const G = DATA.grid;
export const W = G.w, H = G.h, NC = W * H;

/* 本机存储键：统一前缀 + 版本号。带版本是因为换版后数据格式会变，
   旧键必须能一眼认出来、并在启动时清掉（见 state.js 的 purgeOldKeys）。 */
export const LS_PREFIX = "zhulu.raster.";
export const LS_KEY = LS_PREFIX + "editor.v3";     // v3：加入块区层
export const LAY_KEY = LS_PREFIX + "layout.v3";
export const LS_HELP = LS_PREFIX + "help.v3";

/* 笔刷半径（格）：1 = 单格；上限 50（默认格 0.0625° × 50 ≈ 347 km） */
export const R_MIN = 1, R_MAX = 50, R_DEF = 4;      // R_DEF = 启动默认半径（index.html 的初始 SVG 也标 4）
/* ---- 地形字节（v3）：**一个字节 = 覆盖(高 4 位) × 16 + 形态(低 4 位)** ----
   覆盖 12 类：0海洋 1湖泊 2河流 3冰川 4森林 5草原 6荒漠 7沼泽 8滩涂 9盐沼 10草甸 11绿洲
   形态 4 类：0平原 1丘陵 2高原 3山地（海洋格写 0 当 don't-care）
   打解包在 tools/terrain.py 的 pack()/unpack()；契约见 docs/adr/0007。 */
export const T_OCEAN = 0;             // 覆盖 0 ∧ 形态 0 —— **海洋恰好是字节 0**，判海陆仍只看它
/* ⚠️ 下面四个是**覆盖码**，不是字节。要比对必须先 `字节 >> 4`（见 raster.js 的地形金字塔用法）。
   细线类（河、湖、冰川）降采样时必须保住，否则缩到全图整条消失；顺序即优先级。 */
export const C_OCEAN = 0, C_LAKE = 1, C_RIVER = 2, C_ICE = 3;
export const T_LAKE = C_LAKE, T_RIVER = C_RIVER, T_ICE = C_ICE;
export const TER_THIN = [C_RIVER, C_LAKE, C_ICE];


/* --------------------------------------------------------------------------
   **单元**：编辑层能碰的只有三个（地域 / 地块 / 块区），全是行政图上的东西。
   自然层（地形 / 气候）是**产品层**、管线定稿，编辑器只能看（docs/adr/0001、0006、0007），
   所以它们**不在这里**——由 js/ro.js 的 `RO_LAYERS` 描述，并在模块载入时经
   `registerUnits()` 注册进来。于是「加一层自然层」= 在 ro.js 那张表里加一个描述物件：
   按钮、左栏面板、右栏检视器、配色、统计口径全从它派生，本文件与 ui.js 一行不动。

   （2026-10-09 之前这里手写着五个单元，地形混在行政里、气候根本没有入口；加一层要同时改
   config / ui / render / index.html 四处，那是"按单元硬编码"。地理区层同日裁掉，见 ADR 0006。）

     k        —— 单元键（也是按钮的 data-unit）
     n        —— 界面上显示的名字
     layer    —— 底图用哪一层着色（plot=地块层 / dist=块区层 / 自然层由 ro.js 给）
     obj      —— 它的编辑对象（写在界面上，说明"改的是什么"）
     viewOnly —— true = 只读单元，编辑模式下不出现、没有笔刷
   -------------------------------------------------------------------------- */
export const UNITS = [
  { k: "domain",  n: "地域", layer: "plot",    obj: "地块",       tip: "点/拖：给光标下的地块指派地域",
    group: "行政" },
  { k: "plot",    n: "地块", layer: "plot",    obj: "栅格",       tip: "点/拖：把地块编码写进栅格",
    group: "行政" },
  { k: "block",   n: "块区", layer: "dist",    obj: "地块内的栅格", tip: "点/拖：在所属地块的范围内画块区",
    group: "行政" },
];
/* ⚠️ **null 原型**：单元名是从存档/键盘/按钮来的字符串，而 `UNIT["constructor"]` 在普通对象上
   会命中 `Object.prototype`（真值）——于是 `isEditable("constructor")` 为真、编辑器会把当前单元
   设成一个"看着像存在"的单元，随后 `UNIT[unit].tip` 是 undefined、底图两层都不画。
   用空原型把这一整类原型链误判关掉（`UNIT["toString"]` 同理）。 */
export const UNIT = Object.create(null);
for (const u of UNITS) UNIT[u.k] = u;
/* 只读自然层注册口。**在调用时读 UNIT**，所以注册晚于本文件载入也没关系
   （模块图里 ro.js 依赖 config.js，一定在它之后求值）。 */
export function registerUnits(list) {
  for (const u of list) if (u && u.k && !UNIT[u.k]) { UNIT[u.k] = u; UNITS.push(u); }
}
export const unitOf = k => UNIT[k] || UNITS[1];
export const unitLabel = k => unitOf(k).n;
/* 能不能在编辑模式下当笔刷用（工单 §4.4 叫它 viewOnly） */
export const isEditable = k => !!(UNIT[k] && !UNIT[k].viewOnly);
/* ⚠️ 在 config 载入时求值 → 只含三个可编辑单元；自然层天然不在其中（它们本来就是只读的） */
export const EDIT_UNITS = UNITS.filter(u => !u.viewOnly);

export const MODES = [{ k: "view", n: "视图" }, { k: "edit", n: "编辑" }];

/* ---------------- 地形配色与图例（顺序即编码，由 js/data.js 给） ---------------- */
export const COVER_NAMES = DATA.cover_legend;       // 覆盖 12 类
export const FORM_NAMES = DATA.form_legend;         // 形态 4 类
/* 12 个**覆盖**的基础色：只当"覆盖族"的锚（图例里那 12 条占比、以及没有气候层时的兜底）。
   图上真正的颜色是**显示类**的颜色，由 data.js 的 display_classes 给，一处也不在这里重复。
   改色只需改 tools/display_class.py 的 PAINT，这里跟着它走。 */
export const TER_COLORS = [
  "#7fa6c4", "#6ea8d8", "#5b8fc7", "#eef4f8",
  "#5b8a52", "#b9c68a", "#cdbb96", "#8fa98a", "#b0ab94", "#a8ad92", "#e8e4a8", "#86c06a",
];
export const coverColor = c => TER_COLORS[c] || "#cccccc";
/* --------------------------------------------------------------------------
   **显示类 = 覆盖 × 形态 × 气候 的组合 = 地形**（v4，2026-10-09 统一口径）。

   `display_classes` 是 60 类以内的名字与颜色（`[{n, c}]`），`display_lut` 是**组合 → 类下标**
   的查表：`((覆盖×4 + 形态) × 32) + 码`，码 = 热量带 × 8 + 干湿，**干湿为 0 时整条码归零**
   （那 2 位是 don't-care）。1536 项覆盖全部组合，所以查表**永远命中**。

   为什么不再用"有序规则表"：规则表要**扫**（940 万格的统计循环里就是 940 万次 × 31 条），
   而且"被前面通配规则吃掉的具体规则"从代码上根本看不出来。名字现在是 Python 侧的
   **按轴词表**（全函数），这里只是它的成品查表 —— 名字与配色的唯一出处是
   `tools/display_class.py`，本文件与 ro.js 都不许再拼一份。
   -------------------------------------------------------------------------- */
export const DISPLAY_CLASSES = DATA.display_classes || [];
export const DISPLAY_LUT = DATA.display_lut || [];
export const DISPLAY_ENCODING = DATA.display_encoding || "";
export const CLIMATE = DATA.climate_legend || { heat: [], moist: [], encoding: "" };
/* 一格 → 类下标（-1 = 查不到，只可能因为 data.js 是旧版或被截断；`bucketLabel` 会显示成灰行）。
   ⚠️ 参数是**地形字节 + 气候码**，不是四个轴：调用点手上本来就是这两样（state.terr / climData）。 */
export function displayIndexOf(byte, code) {
  const c = (byte | 0) >> 4, f = (byte | 0) & 15, k = (code | 0) & 31;
  return DISPLAY_LUT[((c << 2) | f) * 32 + ((k & 7) === 0 ? 0 : k)] ?? -1;
}
export function displayOf(byte, code) {
  const i = displayIndexOf(byte, code);
  return i < 0 ? null : DISPLAY_CLASSES[i];
}
export const terColor = (byte, kl) => {
  /* byte 是地形那个字节；kl = 该格的气候码（热量带×8+干湿），可选。
     给了气候就是**显示类**的颜色（森林因此分出雨林/针叶林…）；
     不给（覆盖占比条、兜底路径）就用覆盖的基础色。 */
  if (kl != null && DISPLAY_LUT.length) {
    const r = displayOf(byte, kl);
    if (r && r.c) return r.c;
  }
  return coverColor((byte | 0) >> 4);
};
/* ---- 气候层着色：热量带定色相、干湿定浓淡（干=浅、湿=深）----
   寒带（干湿码 0）单独一色：它跟热量带无关，是"极地"这件事本身。
   海洋格在气候视图里**仍然画海洋色**——海洋的气候码无意义（见 build_raster 的注释）。 */
const HEAT_HUE = [22, 62, 100, 196];                    // 热带 → 亚寒带
const MOIST_S = [0, 26, 33, 42, 49, 55, 60, 66];
const MOIST_L = [78, 76, 72, 67, 62, 57, 53, 48];
export const climateColor = code => {
  const h = (code | 0) >> 3, m = (code | 0) & 7;
  if (m === 0) return "#c9d5dd";                        // 寒带（也吸收"无气候数据"）
  return `hsl(${HEAT_HUE[h] ?? 100} ${MOIST_S[m]}% ${MOIST_L[m]}%)`;
};
/* 只读自然层的**当前预览层**（"terrain" | "climate" | …）与它的一格取色 `roColor(字节, 气候码)`
   都搬到了 js/ro.js —— 那里的 `RO_LAYERS` 才是"一层自然层是什么"的唯一出处。
   本文件只提供纯色函数（coverColor / terColor / climateColor），不含任何具体自然层的知识。
   （原先这里还有个 `terName(字节)` 把"覆盖·形态"拼成一个词给界面用；两处界面现在都走
   ro.js 的 `cellFields`——它还要报热量带/干湿/显示类，见 render.js 的左下角读数。） */

/* ---------------- 地域 / 地块配色 ---------------- */
export const GEO_INDEX = {}; DATA.palette.forEach((g, i) => GEO_INDEX[g.geo] = i);
export const DOM = DATA.domains;
const DOM_I = DOM.map((d, i) => DOM.filter((x, j) => j < i && x.g === d.g).length);
export const COLOR = DOM.map((d, i) => {
  const gi = GEO_INDEX[d.g] ?? 0, k = DOM_I[i];
  return `hsl(${((gi * 53 + k * 137.508) % 360).toFixed(0)} ${44 + (k + gi) % 3 * 7}% ${74 - (k + gi) % 4 * 5}%)`;
});
export const UNASSIGNED = "#c9c2ae";
/* --------------------------------------------------------------------------
   地块配色：按**相邻关系**涂色，不再按编码散列。
   散列的问题是"色相差得远、明度却都差不多"，相邻两块容易糊在一起。
   这套 12 色 = 6 个色相族（间隔 60°）× 明暗两档（L 50% / 76%，交替出现）。
   在 Lab 空间量过：两两最小 ΔE = 20.1，且离海洋底色 #7fa6c4 至少 ΔE = 20.2。
   （上一套最小 ΔE 只有 8.2、离海洋 7.4，画到全图就是一片分不开的粉彩。）
   再由 state.js 做贪心图着色（Welsh–Powell）：**相邻地块一定不同色**。
   -------------------------------------------------------------------------- */
export const PLOT_PALETTE = [
  "#baba45", "#45ba45", "#45baba", "#4545ba", "#ba45ba", "#ba4545",
  "#dedea6", "#a6dea6", "#a6dede", "#a6a6de", "#dea6de", "#dea6a6",
];
export const PLOT_PALETTE_DARK = PLOT_PALETTE.map(c => c);   // 轮廓线用同色系的深版（当前直接描黑）
/* 兜底：调色板还没算出来（或地块没有邻居信息）时按编码散开 */
export const plotColorFallback = id => `hsl(${(id * 137.508) % 360} ${40 + id % 3 * 8}% ${72 - id % 4 * 6}%)`;
export const plotColor = plotColorFallback;
/* 按块区编码散开（块区视图用）；未归属地块的块区用灰 */
export const blockColor = id => `hsl(${(id * 97.31 + 24) % 360} ${34 + id % 4 * 6}% ${68 - id % 3 * 7}%)`;

const rgbCache = new Map();
export function toRgb(str) {
  /* 兜底：颜色来源出岔子时退成中性灰，别让一处配色错误把整个 init 拖垮
     （曾经发生过：调色板存的是下标而不是颜色串，(5).match 直接抛错） */
  if (typeof str !== "string") return [201, 194, 174];
  if (rgbCache.has(str)) return rgbCache.get(str);
  let out = [201, 194, 174];
  const m = str.match(/hsl\((\d+(?:\.\d+)?)\s+(\d+)%\s+(\d+)%\)/);
  if (m) {
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
    const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))))); };
    out = [f(0), f(8), f(4)];
  } else if (str[0] === "#") {
    out = [parseInt(str.slice(1, 3), 16), parseInt(str.slice(3, 5), 16), parseInt(str.slice(5, 7), 16)];
  }
  rgbCache.set(str, out); return out;
}

/* 已指派地域 → 不透明（颜色准）；未指派 → 半透明（地形透出） */
export const ALPHA_ASSIGNED = 255, ALPHA_FREE = 120, ALPHA_PLOTMODE = 234;
export const ALPHA_BLOCK = 232;

/* 单元格面积（km²）：用纬度中值处的经度收缩做粗估 */
export const cellKm2 = lat => G.cell * 111.32 * G.cell * 111.32 * Math.cos(lat * Math.PI / 180);
export const rowLat = y => G.lat1 - (y + 0.5) * G.cell;
