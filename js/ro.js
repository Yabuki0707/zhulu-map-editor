/* ==========================================================================
   ro.js —— **只读自然层**（地形 / 气候）的统一描述与渲染

   为什么单独一个模块（2026-10-09）：只读层原来在 ui.js 里是**按单元硬编码**的——
   `renderTerrainPanel` / `renderClimatePanel` / `inspTerrain` 各写一遍，取色又在 raster.js 里
   按 RO_VIEW 分叉。第二层已经要写三份，第三层就是屎山。现在**一层的全部知识都在这张表里**：

       k / n / tip / group      单元元数据（注册进 config 的 UNIT，顶栏按钮由它生成）
       title / sub              左栏抬头与副标题
       rgb(字节, 气候码)        一格的取色 —— 满分辨率画布与金字塔都走它
       bucket(字节, 气候码)     一格记进哪个统计桶（-1 = 不计入）
       bucketCount()            桶的个数
       bucketLabel(桶号)        桶 → {名字, 颜色}
       panel(stats)             左栏那张图（简单层用共享的 roListPanel，气候用 4×7 网格）
       note(stats)              面板脚注（说明口径）
       insp(stats)              右栏检视器正文

   加第三层 = 在这张表里加一个描述物件 + 在 `RO_ORDER` 里加个键。**别的文件一行不动。**
   `buildRoStats` 一次遍历喂所有层；`roColor` 是唯一的取色口径。

   只读的依据是 `docs/adr/0001`：自然层是管线定稿的产品层，将来还要当规则层「基础地形代价」
   的来源——让人用笔刷随手改模拟底数，一笔划过就会静默改掉行军损耗。
   ========================================================================== */

import { COVER_NAMES, FORM_NAMES, coverColor, terColor, toRgb, climateColor,
         DISPLAY_RULES, displayIndexOf, CLIMATE, registerUnits } from "./config.js";

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (n, N) => N ? n / N * 100 : 0;
const fmtPct = (n, N) => pct(n, N) >= 0.04 ? pct(n, N).toFixed(2) + "%" : "—";

/* ================================================================ 当前预览层 */
/* 放在这里（不放 config）是因为 raster.js 与 state.js 都要读它，而它们都 import 本模块；
   config.js 只提供纯色函数，不认识任何具体自然层。
   `RO_VIEW` 是 **let 导出**：ESM 的实时绑定让 `import { RO_VIEW }` 的那一方看到 setRoView
   改过的新值（所以读取方照旧直接 `RO_VIEW`，不必写成函数调用）。 */
export let RO_VIEW = "terrain";
export const setRoView = v => { RO_VIEW = RO_LAYERS[v] ? v : RO_ORDER[0]; };
export const isRoUnit = k => !!RO_LAYERS[k];

/* ================================================================ 共享图表：一行一名 */
/* 任何"一格 → 一个桶"的层都能拿它当左栏面板。 */
export function roListPanel(layer, stats) {
  const rows = roRows(layer, stats);
  const body = rows.map(([n, v, c]) =>
      `<div class="row lv0" style="cursor:default">`
      + `<span class="sw" style="background:${c || "#cccccc"}"></span>`
      + `<span class="nm">${esc(n)}</span>`
      + `<span class="n">${pct(v, stats.cells).toFixed(2)}%</span></div>`).join("");
  return body + `<div class="mut" style="padding:6px 9px;font-size:10.5px">${layer.note(stats)}</div>`;
}
/* 桶 → [名字, 格数, 颜色]，按格数降序。同名桶（如"荒漠草原"的两档干湿）合并成一行。 */
export function roRows(layer, stats) {
  const by = stats.by[layer.k];
  if (!by) return [];
  const rows = [], seen = new Set();
  for (let i = 0; i < by.length; i++) {
    const lab = layer.bucketLabel(i);
    if (!lab || seen.has(lab.n)) continue;
    seen.add(lab.n);
    let v = 0;
    for (let j = i; j < by.length; j++) {
      const l2 = layer.bucketLabel(j);
      if (l2 && l2.n === lab.n) v += by[j];
    }
    if (v) rows.push([lab.n, v, lab.c]);
  }
  return rows.sort((a, b) => b[1] - a[1]);
}

/* ================================================================ 一格的读数 */
/* 脚注与悬停贴共用。**寒带格不报热量带**：干湿码 0 时那 2 位是 don't-care，直接读出来就是
   "热带"（code 0 → heat 0），25 万格极地会被写成"热带·寒带"——所以 heat 给 "—"。
   海洋格则连干湿都没有（气候码无意义），用 `ocean` 标记单独判，别拿 `heat === "—"` 当海陆判据
   （寒带格现在也是 "—"）。 */
export function cellFields(byte, code) {
  const c = (byte | 0) >> 4, f = (byte | 0) & 15;
  const ocean = c === 0;
  const k = (code | 0) & 31, h = k >> 3, m = k & 7;
  const polar = !ocean && m === 0;                       // 干湿 0 = 寒带
  const di = (ocean || polar) ? -1 : displayIndexOf(c, f, h, m);
  return {
    ocean, polar,
    cover: COVER_NAMES[c] || `覆盖 ${c}`,
    form: FORM_NAMES[f] || `形态 ${f}`,
    heat: (ocean || polar) ? "—" : (CLIMATE.heat[h] || "?"),
    moist: ocean ? "—" : (CLIMATE.moist[m] || "?"),
    display: ocean ? "海洋"
      : (di < 0 ? `${COVER_NAMES[c]}·${FORM_NAMES[f]}` : DISPLAY_RULES[di].n),
  };
}

/* ================================================================ 统计（一次遍历喂所有层） */
/* 为什么一次遍历：940 万格的循环，每层各跑一遍就是几秒。
   口径有三条，写在这里一次说清：
     · **海洋不进显示类/气候桶**：它的气候码恒为 0，混进气候层会让"寒带"凭空多出
       6,400 万格（实测过）；显示类里它也只是"海洋"一行，没有信息量。
     · **覆盖直方图 `byCover` 含海洋**：海洋是覆盖 0，占全图 68.3%，是最大的一类——
       检视器里"各覆盖占比"少掉它就是错的（本条是被子代理验收抓出来的）。
     · **形态直方图 `byForm` 只算陆地**：海洋格的形态位是 don't-care（恒 0），
       算进去会让"平原"凭空多出 6,449,237 格。所以两张表的**分母不同**，各自标明。 */
export function buildRoStats(terr, clim) {
  const N = terr.length;
  const by = {}, byCover = new Int32Array(16), byForm = new Int32Array(16);
  let land = 0;
  for (const k of RO_ORDER) by[k] = new Int32Array(RO_LAYERS[k].bucketCount());
  for (let i = 0; i < N; i++) {
    const b = terr[i], c = b >> 4;
    byCover[c]++;
    if (c === 0) continue;                          // 海洋：到此为止（见上面三条口径）
    land++;
    byForm[b & 15]++;
    const code = (clim[i] || 0) & 31;
    for (const k of RO_ORDER) {
      const bid = RO_LAYERS[k].bucket(b, code);
      if (bid >= 0) by[k][bid]++;
    }
  }
  return { land, cells: N, by, byCover, byForm };
}

/* ================================================================ 取色（底图着色） */
/* 一格的 RGB。`rgbOf(key, …)` 是**指定层**的取色（底下 940 万像素那趟循环要用它逐格算），
   `roColor` 是**当前层**的取色（单格重画用）。两者是同一个口径，别在别处再写一份。 */
export const rgbOf = (key, byte, code) => RO_LAYERS[key].rgb(byte | 0, (code | 0) & 31);
export const roColor = (byte, code) => rgbOf(RO_VIEW, byte, code);

/* ================================================================ 层描述表 */
const bar = (n, v, N, c) =>
  `<div class="bar"><i style="background:${c}"></i><span>${esc(n)}</span>`
  + `<span class="v">${fmtPct(v, N)}</span></div>`;

/* ---- 地形：覆盖 × 形态 × 气候 → 显示类（名字与配色来自 data.js 的 display_classes） ---- */
const TERRAIN = {
  k: "terrain", n: "地形", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 底图用哪一层着色（render.js 的 draw() 读它；
                                          // 两个只读层都画在 terCanvas 上，所以同值）
  tip: "地形 = 覆盖(高 4 位) × 形态(低 4 位)，管线定稿；这里按**显示类**统计",
  title: "地形",
  sub: "显示类 · 只读（覆盖 × 形态 × 气候）",
  /* 色相由覆盖定、形态与气候只改名字——真正的配色是 data.js 那张有序规则表 */
  rgb: (byte, code) => toRgb(terColor(byte, code)),
  bucketCount: () => DISPLAY_RULES.length + 1,          // 末桶 = 没落到任何规则（断言里不该有）
  bucket: (byte, code) => {
    const i = displayIndexOf(byte >> 4, byte & 15, code >> 3, code & 7);
    return i < 0 ? DISPLAY_RULES.length : i;
  },
  bucketLabel: i => i === DISPLAY_RULES.length
    ? { n: "（未匹配：显示类规则表漏了）", c: "#cccccc" }
    : { n: DISPLAY_RULES[i].n, c: DISPLAY_RULES[i].c },
  panel: s => roListPanel(TERRAIN, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格（百分比以全图为分母）。名字是「覆盖 × 形态 ×
    气候」当场算出来的**显示类**；底图里只存覆盖（高 4 位）与形态（低 4 位）——见
    docs/adr/0006、0007。发现错格只能改管线的分类规则并重跑，编辑器改不了它。`,
  legendNote: () => "覆盖 × 形态（显示类是覆盖 × 形态 × 气候派生出来的）",
  insp: s => `
    <dl class="kv">
      <dt>状态</dt><dd><span class="pill">只读</span> 地形由管线定稿（docs/adr/0001）</dd>
      <dt>编码</dt><dd>一个字节 = 覆盖（高 4 位）× 16 + 形态（低 4 位）</dd>
      <dt>显示类</dt><dd>${DISPLAY_RULES.length} 条规则（覆盖 × 形态 × 气候，有序首命中）</dd>
      <dt>改法</dt><dd class="mut" style="font-size:11px">编辑器改不了地形：它是 ETOPO 高程 ＋
        Copernicus 土地覆盖算出来的模拟底数，将来要做规则层「基础地形代价」的来源。
        发现错格只能改管线的分类规则（<code>tools/terrain.py</code>）并重跑生成。</dd>
    </dl>
    <div class="sec-h">各覆盖占比（原始覆盖码，分母是全图）</div>
    <div class="bars">${COVER_NAMES.map((n, i) => bar(n, s.byCover[i] || 0, s.cells, coverColor(i))).join("")}</div>
    <div class="sec-h">各形态占比（分母是陆地——海洋格的形态位是 don't-care）</div>
    <div class="bars">${FORM_NAMES.map((n, i) => bar(n, s.byForm[i] || 0, s.land, "#c2ab7e")).join("")}</div>`,
};

/* ---- 气候：热量带 × 干湿（柯本两轴） ---- */
const CLIMATE_LAYER = {
  k: "climate", n: "气候", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 同地形：画在 terCanvas 上（见上面 TERRAIN.layer 的说明）
  tip: "气候 = 热量带 × 干湿，管线定稿（柯本）；这里看两轴交叉与占比",
  title: "气候",
  sub: "热量带 × 干湿 · 只读（柯本）",
  /* 海洋格在气候视图里**仍画海洋色**——海洋的气候码无意义（见 build_raster 的注释） */
  rgb: (byte, code) => toRgb((byte >> 4) === 0 ? coverColor(0) : climateColor(code)),
  bucketCount: () => 32,
  bucket: (byte, code) => code,
  bucketLabel: code => {
    const h = code >> 3, m = code & 7;
    return { n: m === 0 ? "寒带" : `${CLIMATE.heat[h] || "?"}·${CLIMATE.moist[m] || "?"}`,
             c: climateColor(code) };
  },
  panel: s => climateGrid(CLIMATE_LAYER, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格。码 = 热量带 × 8 + 干湿；**寒带不占热量带
    那一轴**——它是干湿的 0 码（所以读气候要先读干湿）。**B 组按纬度补过一刀**
    （BWh/BSh 在回归线外算亚热带）。见 docs/adr/0006。`,
  legendNote: () => "热量带 × 干湿（码 = 热量带 × 8 + 干湿）",
  insp: s => {
    const H = CLIMATE.heat || [], M = CLIMATE.moist || [];
    const heat = new Array(H.length).fill(0), moist = new Array(M.length).fill(0);
    for (let code = 0; code < 32; code++) {
      const v = s.by.climate[code] || 0;
      if (!v) continue;
      const m = code & 7;
      /* ⚠️ 干湿码 0 = 寒带，它**不占热量带那一轴**（那 2 位的值是 don't-care）。
         不排掉它，code 0 会被算进 heat[0] = 热带：寒带 20 万格凭空加在热带头上，
         而同一屏里还单列着一行「寒带」，等于数了两遍。它也不进干湿那一轴（那不是干湿）。 */
      if (m !== 0) {
        heat[code >> 3] += v;
        moist[m] += v;
      }
    }
    return `
      <dl class="kv">
        <dt>状态</dt><dd><span class="pill">只读</span> 气候由管线定稿（docs/adr/0001）</dd>
        <dt>编码</dt><dd>一个字节 = 热量带 × 8 + 干湿（0..31）</dd>
        <dt>改法</dt><dd class="mut" style="font-size:11px">数据是柯本气候分类（Beck et al. 2023）。
          改口径要动 <code>tools/climate.py</code> 的两轴映射并重跑生成，编辑器改不了它。</dd>
      </dl>
      <div class="sec-h">热量带</div>
      <div class="bars">${heat.map((v, i) => bar(H[i] || i, v, s.cells, climateColor(i * 8 + 6))).join("")}</div>
      <div class="sec-h">干湿（寒带不在此轴）</div>
      <div class="bars">${moist.map((v, i) => (i === 0 ? "" : bar(M[i] || i, v, s.cells, climateColor(i)))).join("")}</div>`;
  },
};

/* 气候层的**两轴网格**：寒带单独一行（它不占热量带那一轴），下面是 4 × 7 的交叉表。 */
function climateGrid(layer, stats) {
  const H = CLIMATE.heat || [], M = CLIMATE.moist || [];
  const by = stats.by.climate, N = stats.cells;
  const cell = (h, m) => {
    const code = h * 8 + m, v = by[code] || 0;
    return `<span title="${esc(H[h] || "")}·${esc(M[m] || "")} ${v.toLocaleString()} 格"`
      + ` style="background:${climateColor(code)};height:19px;border-radius:3px;text-align:center;`
      + `line-height:19px;font-size:9.5px;color:#3a3a3a">${pct(v, N) >= 0.04 ? pct(v, N).toFixed(1) + "%" : ""}</span>`;
  };
  let html = `<div class="mut" style="padding:6px 9px 2px;font-size:10.5px">陆地 ${(stats.land / 1e6).toFixed(2)}M 格。
     <b>寒带</b>不占热量带那一轴——它是干湿的「寒带」，单独一行。</div>`;
  html += `<div style="display:grid;grid-template-columns:46px 1fr;gap:2px;padding:6px 9px 2px">`
    + `<span class="mut" style="font-size:10px;line-height:19px">寒带</span>`
    + `<span title="寒带 ${(by[0] || 0).toLocaleString()} 格" style="background:${climateColor(0)};`
    + `height:19px;border-radius:3px;text-align:center;line-height:19px;font-size:9.5px;color:#3a3a3a">`
    + `${pct(by[0] || 0, N) >= 0.04 ? pct(by[0] || 0, N).toFixed(2) + "%" : ""}</span></div>`;
  html += `<div style="display:grid;grid-template-columns:46px repeat(${M.length - 1},1fr);gap:2px;`
    + `padding:2px 9px 8px">`;
  html += `<span></span>` + M.slice(1).map(m =>
    `<span class="mut" style="font-size:9.5px;text-align:center;writing-mode:vertical-rl;`
    + `justify-self:center;height:34px">${esc(m)}</span>`).join("");
  for (let h = 0; h < H.length; h++) {
    html += `<span class="mut" style="font-size:10px;line-height:19px">${esc(H[h])}</span>`;
    for (let m = 1; m < M.length; m++) html += cell(h, m);
  }
  html += `</div>`;
  html += `<div class="mut" style="padding:0 9px 8px;font-size:10.5px">${layer.note(stats)}</div>`;
  return html;
}

/* 顺序即顶栏按钮的顺序（也决定 `,` / `.` 在只读层之间的切换次序） */
export const RO_ORDER = ["terrain", "climate"];
/* null 原型：层名同样来自存档/键盘，`RO_LAYERS["constructor"]` 在普通对象上是真值
   （见 config.js 的 UNIT 注释）。 */
export const RO_LAYERS = Object.assign(Object.create(null), { terrain: TERRAIN, climate: CLIMATE_LAYER });
export const RO_KEYS = RO_ORDER.slice();
export const roLayer = k => RO_LAYERS[k] || RO_LAYERS[RO_ORDER[0]];

/* 注册进 config 的单元表：顶栏按钮、setUnit、检视器抬头都从 UNIT 查。 */
registerUnits(RO_ORDER.map(k => RO_LAYERS[k]));
