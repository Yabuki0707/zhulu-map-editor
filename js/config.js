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
export const T_OCEAN = 0;                            // 地形「海洋」编码 —— 海陆口径的唯一判据
export const T_PLAIN = 9;                            // 地形「平原」编码（橡皮的复原值）


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

/* ---------------- 地形配色与图例（图例顺序即编码，由 js/data.js 给） ---------------- */
export const TER_NAMES = DATA.terrain_legend;
/* 16 类地形的配色：编码次序见 tools/terrain.py 的 LEGEND
   0 海洋 1 湖泊 2 河流 3 冰川 4 沙漠 5 裸地 6 高原 7 山地 8 丘陵 9 平原
   10 针叶林 11 阔叶林 12 雨林 13 草原 14 沼泽 15 苔原
   三档绿（针叶/阔叶/雨林）与海洋底色 #7fa6c4 明度差得开，缩到全图也不会和海水混成一片。 */
export const TER_COLORS = [
  "#7fa6c4", "#6ea8d8", "#5b8fc7", "#eef4f8", "#e3cf9a", "#cdbb96", "#c2ab7e", "#a98a62",
  "#c8b98f", "#cfe0a8", "#4f7a4a", "#6f9c4a", "#2f6b3a", "#b9c68a", "#8fa98a", "#b8c4b0",
];
export const terColor = t => TER_COLORS[t] || "#cccccc";
export const terName = t => TER_NAMES[t] || `地形 ${t}`;



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
