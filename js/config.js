/* ==========================================================================
   config.js —— 常量、四个单元（地域/地块/块区/地形）、调色、地形图例
   数据入口：js/data.js（由 tools/build_raster.py 生成，勿手改）
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
   覆盖 12 类：0海洋 1湖泊 2河流 3冰川 4森林 5草原 6荒漠 7沼泽 8滩涂 9盐沼 10农田 11绿洲
   形态 5 类：0无（水冰格）1平原 2丘陵 3高原 4山地
   打解包在 tools/terrain.py 的 pack()/unpack()；契约见 docs/adr/0007。 */
export const T_OCEAN = 0;             // 覆盖 0 ∧ 形态 0 —— **海洋恰好是字节 0**，判海陆仍只看它
export const T_PLAIN = (5 << 4) | 1;  // 「草原∧平原」的一个合法字节，只作"当前对象"占位
/* ⚠️ 下面四个是**覆盖码**，不是字节。要比对必须先 `字节 >> 4`（见 raster.js 的 TER_THIN 用法）。
   细线类（河、湖、冰川）降采样时必须保住，否则缩到全图整条消失；顺序即优先级。 */
export const C_OCEAN = 0, C_LAKE = 1, C_RIVER = 2, C_ICE = 3;
export const T_LAKE = C_LAKE, T_RIVER = C_RIVER, T_ICE = C_ICE;
export const TER_THIN = [C_RIVER, C_LAKE, C_ICE];


/* --------------------------------------------------------------------------
   四个单元。视图层与编辑层共用同一组对象，但**地形是只读的**（docs/adr/0001）：
   地形图由管线从 ETOPO 高程 + Copernicus LC100 土地覆盖算出，将来还要当规则层
   "基础地形代价"的来源 —— 让人用笔刷随手改模拟底数，一笔划过就会静默改掉行军耗时。
   于是地形只在**视图模式**里作为图例与占比出现；编辑模式里没有这个单元。

     layer  —— 它决定底图用哪一层着色（plot=地块层 / dist=块区层 / terrain=地形层）
     obj    —— 它的编辑对象（写在界面上，说明"改的是什么"）
     viewOnly —— true = 只读单元，编辑模式下不出现、没有笔刷
   -------------------------------------------------------------------------- */
export const UNITS = [
  { k: "domain",  n: "地域", layer: "plot",    obj: "地块",       tip: "点/拖：给光标下的地块指派地域" },
  { k: "plot",    n: "地块", layer: "plot",    obj: "栅格",       tip: "点/拖：把地块编码写进栅格" },
  { k: "block",   n: "块区", layer: "dist",    obj: "地块内的栅格", tip: "点/拖：在所属地块的范围内画块区" },
  { k: "terrain", n: "地形", layer: "terrain", obj: "（只读）",    tip: "地形由管线定稿，编辑器只读：这里只作图例与占比",
    viewOnly: true },
];
export const UNIT = {};
for (const u of UNITS) UNIT[u.k] = u;
export const unitOf = k => UNIT[k] || UNITS[1];
export const unitLabel = k => unitOf(k).n;
/* 能不能在编辑模式下当笔刷用（工单 §4.4 叫它 viewOnly） */
export const isEditable = k => !!(UNIT[k] && !UNIT[k].viewOnly);
export const EDIT_UNITS = UNITS.filter(u => !u.viewOnly);

export const MODES = [{ k: "view", n: "视图" }, { k: "edit", n: "编辑" }];

/* ---------------- 地形配色与图例（顺序即编码，由 js/data.js 给） ---------------- */
export const COVER_NAMES = DATA.cover_legend;       // 覆盖 12 类
export const FORM_NAMES = DATA.form_legend;         // 形态 5 类
/* 12 个**覆盖**的基础色。图上真正的颜色还叠形态与气候（雨林/针叶林/沙漠/戈壁/河谷农田…），
   由 data.js 的 display_classes 派生——色相由覆盖定、形态只调明暗，免得组合炸成一片糊。
   改色只需改 tools/display_class.py 的那张表，这里跟着它走。 */
export const TER_COLORS = [
  "#7fa6c4", "#6ea8d8", "#5b8fc7", "#eef4f8",
  "#5b8a52", "#b9c68a", "#cdbb96", "#8fa98a", "#b0ab94", "#a8ad92", "#e8e4a8", "#86c06a",
];
export const coverColor = c => TER_COLORS[c] || "#cccccc";
/* 显示类：把「覆盖 × 形态 × 气候」叠起来看的名字与颜色。
   表是有序的、`null` 通配，首命中生效；规则与配色同源于 tools/display_class.py。 */
export const DISPLAY_RULES = DATA.display_classes || [];
export const CLIMATE = DATA.climate_legend || { heat: [], moist: [], encoding: "" };
export function displayOf(cover, form, heat, moist) {
  for (const r of DISPLAY_RULES) {
    if (r.cover != null && r.cover !== cover) continue;
    if (r.form != null && r.form !== form) continue;
    if (r.heat != null && r.heat !== heat) continue;
    if (r.moist != null && r.moist !== moist) continue;
    return r;
  }
  return null;
}
export const terColor = (byte, kl) => {
  /* byte 是地形那个字节；kl = 该格的气候码（热量带×8+干湿），可选。
     给了气候就按「覆盖 × 形态 × 气候」派生色（森林因此分出雨林/针叶林…）；
     不给（图例、兜底路径）就用覆盖的基础色。 */
  const c = (byte | 0) >> 4, f = (byte | 0) & 15;
  if (kl != null && DISPLAY_RULES.length) {
    const r = displayOf(c, f, kl >> 3, kl & 7);
    if (r && r.c) return r.c;
  }
  return coverColor(c);
};
export const terName = byte => {
  const c = (byte | 0) >> 4, f = (byte | 0) & 15;
  const cn = COVER_NAMES[c] || `覆盖 ${c}`;
  return f ? `${cn}·${FORM_NAMES[f] || f}` : cn;
};



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
