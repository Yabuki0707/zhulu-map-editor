/* ==========================================================================
   ro.js —— **只读自然层**（样式 / 覆盖 / 形态 / 气候）的统一描述与渲染

   为什么单独一个模块（2026-10-09）：只读层原来在 ui.js 里是**按单元硬编码**的——
   `renderTerrainPanel` / `renderClimatePanel` / `inspTerrain` 各写一遍，取色又在 raster.js 里
   按 RO_VIEW 分叉。第二层已经要写三份，第三层就是屎山。现在**一层的全部知识都在这张表里**：

       k / n / tip / group      单元元数据（注册进 config 的 UNIT，顶栏按钮由它生成）
       title / sub              左栏抬头与副标题
       rgb(字节, 气候码)        一格的取色 —— 满分辨率画布与金字塔都走它
       bucket(字节, 气候码)     一格记进哪个统计桶（-1 = 不计入）
       oceanBucket()            海洋格记进哪个桶（-1 = 不计入；见 buildRoStats 的口径）
       bucketCount()            桶的个数
       bucketLabel(桶号)        桶 → {名字, 颜色}
       panel(stats)             左栏那张图（简单层用共享的 roListPanel，气候用 4×7 网格）
       legendNote()             面板开头那一行口径说明
       note(stats)              面板脚注（说明口径）
       insp(stats)              右栏检视器正文

   加第三层 = 在这张表里加一个描述物件 + 在 `RO_ORDER` 里加个键。**别的文件一行不动。**
   `buildRoStats` 一次遍历喂所有层；`roColor` 是唯一的取色口径。

   只读的依据是 `docs/adr/0001`：自然层是管线定稿的产品层，将来还要当规则层「基础地形代价」
   的来源——让人用笔刷随手改模拟底数，一笔划过就会静默改掉行军损耗。
   ========================================================================== */

import { COVER_NAMES, FORM_NAMES, coverColor, formColor, terColor, toRgb, climateColor,
         DISPLAY_CLASSES, DISPLAY_LUT, DISPLAY_ENCODING, displayIndexOf, CLIMATE,
         C_OCEAN, C_SEAICE, registerUnits } from "./config.js";

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
  /* 开头一行口径说明（`legendNote`）：这一列到底是什么。地形那一层靠它把
     "地形 = 覆盖 × 形态 × 气候 = 显示类"这句话摆在图例正上方，别处不必再解释一遍。 */
  return `<div class="mut" style="padding:6px 9px 2px;font-size:10.5px">${layer.legendNote()}</div>`
    + body + `<div class="mut" style="padding:6px 9px;font-size:10.5px">${layer.note(stats)}</div>`;
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
  const c = (byte | 0) >> 3, f = (byte | 0) & 7;
  const ocean = c === 0;
  const k = (code | 0) & 31, h = k >> 3, m = k & 7;
  const polar = !ocean && m === 0;                       // 干湿 0 = 寒带
  /* 显示类**一律查表**（v4）：寒带格以前也被跳过，于是"苔原/寒沼"这些格在读数里
     只写成"草原·平原"这种拼凑名 —— 明明有正经名字。现在只有 data.js 缺项才回退。 */
  const di = displayIndexOf(byte, code);
  return {
    ocean, polar,
    cover: COVER_NAMES[c] || `覆盖 ${c}`,
    form: FORM_NAMES[f] || `形态 ${f}`,
    heat: (ocean || polar) ? "—" : (CLIMATE.heat[h] || "?"),
    moist: ocean ? "—" : (CLIMATE.moist[m] || "?"),
    display: di >= 0 ? DISPLAY_CLASSES[di].n
      : (ocean ? "海洋" : `${COVER_NAMES[c] || "覆盖" + c}·${FORM_NAMES[f] || f}`),
  };
}

/* ================================================================ 统计（一次遍历喂所有层） */
/* 为什么一次遍历：940 万格的循环，每层各跑一遍就是几秒。
   口径四条，写在这里一次说清：
     · **海洋要不要算，由层自己答**（`oceanBucket()`）：样式层要 —— 海洋是它的一个正经显示类
       （占全图 68.3%），图例里少了它，与页脚读数、与图上的颜色都对不上；
       形态层与气候层都不要 —— 那边"海洋/海冰"根本没有那两位可言（实测过，见下）。
     · **覆盖直方图 `byCover` 含海洋**：海洋是覆盖 0，占全图 68.3%，是最大的一类——
       检视器里"各覆盖占比"少掉它就是错的（本条是被子代理验收抓出来的）。
     · **`land` 与 `byForm` 都不含「海冰」**：海冰（覆盖 16，726,135 格）是**冻住的海面**，
       不是陆地 —— 它的形态位与气候码都是 don't-care（管线侧对海冰也只有一个恒名）。
       算进 `land` 会让"陆地"凭空多出 72.6 万格（7.7%），算进形态会让"平原"多出同样多。
     · **形态直方图只算陆地**：海洋格的形态位是 don't-care（恒 0）。所以三张表的**分母不同**，
       各自标明。 */
/* 「那两位对它是 don't-care」的三个覆盖：海洋（0）与海冰（16）。判据只此一处，
   形态层、气候层都调它 —— 别在层描述里各写一遍 `>> 3 === 0`（海冰会被漏掉）。 */
export const noAxis = byte => {
  const c = (byte | 0) >> 3;
  return c === C_OCEAN || c === C_SEAICE;
};
export function buildRoStats(terr, clim) {
  const N = terr.length;
  const by = {}, byCover = new Int32Array(COVER_NAMES.length), byForm = new Int32Array(16);
  let land = 0;
  for (const k of RO_ORDER) by[k] = new Int32Array(RO_LAYERS[k].bucketCount());
  /* 热循环里别做属性查找：把每层的 bucket() 与它的桶数组先取出来（944 万格 × 每层一次调用）。 */
  const keys = RO_ORDER, fns = keys.map(k => RO_LAYERS[k].bucket), arrs = keys.map(k => by[k]);
  /* 海洋格（占全图 68.3%）**单独一条路**：要不要它、记进哪个桶，由各层自己的 `oceanBucket()`
     说了算（见层描述里的说明）。让它走下面那趟每层一次的调用，光是 645 万格的重复查表实测
     就要多花 0.35 s。 */
  const ocean = keys.map(k => [by[k], RO_LAYERS[k].oceanBucket()]).filter(p => p[1] >= 0);
  for (let i = 0; i < N; i++) {
    const b = terr[i], c = b >> 3;
    byCover[c]++;
    if (c === C_OCEAN) {
      for (let n = 0; n < ocean.length; n++) ocean[n][0][ocean[n][1]]++;
      continue;
    }
    const code = (clim[i] || 0) & 31;
    for (let n = 0; n < fns.length; n++) {
      const j = fns[n](b, code);
      if (j >= 0) arrs[n][j]++;
    }
    if (c === C_SEAICE) continue;                 // 海冰：不是陆地，也没有形态
    land++;
    byForm[b & 7]++;
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

/* ---- 地形：覆盖 × 形态 × 气候 = **显示类**（名字与配色来自 data.js 的 display_classes） ----
   「地形即显示类」：这一层对外只有一套名字——查 `display_lut`。覆盖与形态是**存储**口径
   （一个字节的两个半字节），只在检视器的两张占比条里单独露面。 */
/* ---- 覆盖：只画"地表是什么"那一轴（v9，2026-10-10）----
   需求方要「视图增加覆盖与样式两种模式」：**这一层就是"覆盖"模式**，
   「样式」那一层（原「地形」，显示类）就是"样式"模式。按 `ro.js` 自己的规矩——一层的全部知识
   在这张表里、别的文件一行不动——**加一层只读层**是最省的做法：顶栏按钮、左栏图例、右栏检视器、
   统计全部由既有的机制派生，`ui.js`/`render.js`/`config.js` 一行都不用改。
   ⚠️ 与「样式」层的差别只有**取色与分桶口径**：这里按**覆盖码**上色（20 类，看地表是什么），
   那里按**显示类**上色（88 类，看地形叫什么）。字节是同一张图（覆盖在高 5 位）。 */
const COVER_LAYER = {
  k: "cover", n: "覆盖", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 同其它自然层：都画在 terCanvas 上
  tip: "覆盖 = 地表长着什么（高 5 位）；不带气候与形态",
  title: "覆盖",
  sub: "只读（地表是什么；这是「样式」之外的另一种看法）",
  rgb: byte => toRgb(coverColor((byte | 0) >> 3)),
  bucketCount: () => COVER_NAMES.length,
  bucket: byte => (byte | 0) >> 3,
  /* 海洋也是覆盖（码 0），要算进来 —— 与形态/气候层正好相反。 */
  oceanBucket: () => 0,
  bucketLabel: i => ({ n: COVER_NAMES[i] || `覆盖 ${i}`, c: coverColor(i) }),
  panel: s => roListPanel(COVER_LAYER, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格（**不含海冰**）。百分比以**全图**为分母，`
    + `海洋也在内。这一层只答一件事：**地表是什么**（覆盖）。冷暖干湿看「气候」层，`
    + `平陡看「形态」层；把三者合起来查表才是「样式」层那 88 个名字。`,
  legendNote: () => `<b>覆盖</b>：一个字节的<b>高 5 位</b>，${COVER_NAMES.length} 类 —— 只看地表是什么，`
    + `不带气候。要"名字"（热带沙漠／高原戈壁／亚寒带密林…）请看<b>样式</b>层。`,
  insp: s => `
    <dl class="kv">
      <dt>状态</dt><dd><span class="pill">只读</span> 管线定稿（docs/adr/0001）</dd>
      <dt>编码</dt><dd>高 5 位 = 覆盖（${COVER_NAMES.length} 类，v9 起；<code>字节 &gt;&gt; 3</code>）；
        低 3 位 = 形态（4 类，只占 2 位）</dd>
      <dt>与「样式」层的差别</dt><dd>同一张图、同一批字节，只是**取色与分桶**不同：
        这里按覆盖码上色（${COVER_NAMES.length} 类），那里按显示类上色（${DISPLAY_CLASSES.length} 类）。</dd>
    </dl>
    <div class="sec-h">各覆盖占比（分母是全图）</div>
    <div class="bars">${COVER_NAMES.map((n, i) => bar(n, s.byCover[i] || 0, s.cells, coverColor(i))).join("")}</div>
    <div class="sec-h">各形态占比（分母是陆地，不含海洋与海冰——那两位对它们没有意义）</div>
    <div class="bars">${FORM_NAMES.map((n, i) => bar(n, s.byForm[i] || 0, s.land, "#c2ab7e")).join("")}</div>`,
};

/* ---- 形态：只画"地是平的还是陡的"那一轴（2026-10-10 加）----
   由来说白了：需求方要"覆盖与样式两种模式"。「样式」那一层画的是**三个轴合成的显示类**，
   于是"哪一片是山地"在图上散成十几种颜色（山地密林／山地草原／山地草甸／山地盐漠…），
   一眼看不出山系。这一层只读**一个字节的低 3 位**（`字节 & 7`）：平原／丘陵／高原／山地，
   一个颜色一类 —— 山地门槛 350 m 那次调整（`docs/adr/0013`）看的就是这一层。
   ⚠️ **海洋与海冰不判形态**（那一位是 don't-care，恒 0）：画它们自己的水色、也不进统计桶 ——
   否则"平原"会凭空多出 645 万＋72.6 万格。判据统一在 `noAxis()`。 */
const FORM_LAYER = {
  k: "form", n: "形态", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 同其它自然层：都画在 terCanvas 上
  tip: "形态 = 地是平的还是陡的（低 3 位）；不带覆盖与气候",
  title: "形态",
  sub: "只读（平原／丘陵／高原／山地，看的是起伏与海拔）",
  rgb: byte => {
    const b = byte | 0;
    return toRgb(noAxis(b) ? coverColor(b >> 3) : formColor(b & 7));
  },
  bucketCount: () => FORM_NAMES.length,
  bucket: byte => (noAxis(byte) ? -1 : ((byte | 0) & 7)),
  oceanBucket: () => -1,                  // 海洋没有形态可言（与气候层同理）
  bucketLabel: i => ({ n: FORM_NAMES[i] || `形态 ${i}`, c: formColor(i) }),
  panel: s => roListPanel(FORM_LAYER, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格（**不含海冰**：它没有形态）。`
    + `百分比以**全图**为分母，所以四行加起来不到 100%。判据只有高程与格内起伏两条：`
    + `起伏 &gt; 350 m 山地、&gt; 120 m 丘陵、海拔 &gt; 1200 m 且起伏 ≤ 350 m 高原，其余平原`
    + `（docs/adr/0013）。它**不是**"地形"：地表长着什么请看「覆盖」层。`,
  legendNote: () => `<b>形态</b>：一个字节的<b>低 3 位</b>，4 类 —— 只看平陡（起伏 ＋ 海拔），`
    + `不看地表长什么、也不看冷暖。海洋与海冰没有这一位（恒 0，画水色）。`,
  insp: s => `
    <dl class="kv">
      <dt>状态</dt><dd><span class="pill">只读</span> 管线定稿（docs/adr/0001、0013）</dd>
      <dt>编码</dt><dd>低 3 位 = 形态（4 类，只用 0–3；<code>字节 &amp; 7</code>）；
        高 5 位是覆盖 —— 两个轴谁也不吃谁（docs/adr/0007）</dd>
      <dt>判据</dt><dd>起伏 &gt; 350 m → 山地；&gt; 120 m → 丘陵；海拔 &gt; 1200 m 且
        起伏 ≤ 350 m → 高原；其余平原</dd>
      <dt>改法</dt><dd class="mut" style="font-size:11px">编辑器改不了它：形态由 ETOPO 高程与
        格内起伏算出（<code>地图/栅格地形数据生成器/terrain.py</code> 的 <code>landform()</code>）。
        发现错格只能改门槛并重跑生成。</dd>
    </dl>
    <div class="sec-h">各形态占比（分母是陆地，不含海洋与海冰）</div>
    <div class="bars">${FORM_NAMES.map((n, i) => bar(n, s.by.form[i] || 0, s.land, formColor(i))).join("")}</div>`,
};

/* ---- 样式（原「地形」）：覆盖 × 形态 × 气候 = **显示类**（名字与配色来自 data.js） ----
   「地形即显示类」：这一层对外只有一套名字——查 `display_lut`。覆盖与形态是**存储**口径
   （一个字节的两个半字节），只在检视器的两张占比条里单独露面。
   ⚠️ **2026-10-10 改名**：需求方要「覆盖与样式两种模式」，随后又问"视图层咋没加样式"——
   说明他们认的是**顶栏那个按钮上的名字**，而这一层一直叫「地形」。改叫**「样式」**
   （`k` 仍是 `"terrain"`：本地存档、键盘 `4` 号位、`ui.js` 的回落值一个都不动）。
   语义也对：**地形是那三个轴本身，样式是它们合成出来的样子**（88 个显示类，一格一名一色）。 */
const TERRAIN = {
  k: "terrain", n: "样式", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 底图用哪一层着色（render.js 的 draw() 读它；
                                          // 四个自然层都画在 terCanvas 上，所以同值）
  tip: "样式 = 地形怎么画：覆盖 × 形态 × 气候 查表得到的显示类（88 类）；管线定稿",
  title: "样式",
  sub: "地形样式 = 显示类 · 只读（覆盖 × 形态 × 气候 的组合）",
  /* 配色是 data.js 那张 display_classes（每类一色），这里只负责把字节+气候码查成颜色 */
  rgb: (byte, code) => toRgb(terColor(byte, code)),
  bucketCount: () => DISPLAY_CLASSES.length + 1,        // 末桶 = 查不到（data.js 旧版/被截断）
  bucket: (byte, code) => {
    const i = displayIndexOf(byte, code);
    return i < 0 ? DISPLAY_CLASSES.length : i;
  },
  /* 海洋格记进哪个桶：它也是**一类显示类**（占全图 68.3%），图例里必须有这一行 ——
     否则鼠标悬在海上时页脚写着"显示类 海洋"，图例里却找不到它。
     （气候层正好相反：海洋的气候码无意义，返回 -1。） */
  oceanBucket: () => {
    const i = displayIndexOf(0, 0);
    return i < 0 ? DISPLAY_CLASSES.length : i;
  },
  bucketLabel: i => i === DISPLAY_CLASSES.length
    ? { n: "（未匹配：display_lut 缺项）", c: "#cccccc" }
    : { n: DISPLAY_CLASSES[i].n, c: DISPLAY_CLASSES[i].c },
  panel: s => roListPanel(TERRAIN, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格（**不含海冰** —— 它是冻住的海面，
    见顶上的统计口径）。百分比以**全图**为分母，海洋也在内
    （${(s.by.terrain[0] / s.cells * 100).toFixed(1)}% —— 它也是一类显示类）。名字是
    「覆盖 × 形态 × 气候」当场查出来的**显示类**，也就是地形在这一格的**样式**；底图里只存覆盖
    （高 5 位）与形态（低 3 位），气候另存一张图（见 docs/adr/0006、0007、0014）。发现错格只能改
    管线的分类规则并重跑，编辑器改不了它。`,
  legendNote: () => `<b>样式 = 覆盖 × 形态 × 气候 = 显示类</b>：一格一个名字、一格一个颜色`
    + `（${DISPLAY_CLASSES.length} 类，任意两类色差 ΔE ≥ 9）。下面是实际出现的类，按格数排。`
    + `看单根轴请切「覆盖」「形态」「气候」。`,
  insp: s => `
    <dl class="kv">
      <dt>状态</dt><dd><span class="pill">只读</span> 地形样式由管线定稿（docs/adr/0001）</dd>
      <dt>编码</dt><dd>一个字节 = 覆盖（高 5 位）× 8 + 形态（低 3 位）；气候另存一张图</dd>
      <dt>显示类</dt><dd>${DISPLAY_CLASSES.length} 类：名字由 地图/栅格地形数据生成器/display_class.py 的按轴
        词表算，编辑器按 <code>display_lut</code> 查表（${DISPLAY_LUT.length} 个组合全覆盖）<br>
        <span class="mut" style="font-size:11px">${DISPLAY_ENCODING}</span></dd>
      <dt>改法</dt><dd class="mut" style="font-size:11px">编辑器改不了地形：它是 ETOPO 高程 ＋
        Copernicus 土地覆盖算出来的模拟底数，将来要做规则层「基础地形代价」的来源。
        发现错格只能改管线的分类规则（<code>地图/栅格地形数据生成器/terrain.py</code>）并重跑生成。</dd>
    </dl>
    <div class="sec-h">各覆盖占比（**存储**口径：${COVER_NAMES.length} 类，分母是全图）</div>
    <div class="bars">${COVER_NAMES.map((n, i) => bar(n, s.byCover[i] || 0, s.cells, coverColor(i))).join("")}</div>
    <div class="sec-h">各形态占比（分母是陆地，不含海洋与海冰——那两位对它们没有意义）</div>
    <div class="bars">${FORM_NAMES.map((n, i) => bar(n, s.byForm[i] || 0, s.land, "#c2ab7e")).join("")}</div>`,
};

/* ---- 气候：热量带 × 干湿（柯本两轴） ---- */
const CLIMATE_LAYER = {
  k: "climate", n: "气候", group: "自然", viewOnly: true, obj: "（只读）",
  layer: "terrain",                       // 同其它自然层：画在 terCanvas 上
  tip: "气候 = 热量带 × 干湿，管线定稿（柯本）；这里看两轴交叉与占比",
  title: "气候",
  sub: "热量带 × 干湿 · 只读（柯本）",
  /* 海洋与海冰在气候视图里**仍画自己的水色**——它们的气候码无意义（见 生成.py 的注释） */
  rgb: (byte, code) => {
    const b = byte | 0;
    return toRgb(noAxis(b) ? coverColor(b >> 3) : climateColor(code));
  },
  bucketCount: () => 32,
  /* 海洋与海冰返回 -1：这一层里它们的气候码无意义（恒 0），算进"寒带"是错的
     —— 那会让寒带凭空多出 645 万＋72.6 万格。样式层不一样：那边「海洋」是个正经显示类，
     所以要算（见 buildRoStats 的说明）。判据统一在 `noAxis()`。 */
  bucket: (byte, code) => (noAxis(byte) ? -1 : ((code | 0) & 31)),
  oceanBucket: () => -1,
  bucketLabel: code => {
    const h = code >> 3, m = code & 7;
    return { n: m === 0 ? "寒带" : `${CLIMATE.heat[h] || "?"}·${CLIMATE.moist[m] || "?"}`,
             c: climateColor(code) };
  },
  panel: s => climateGrid(CLIMATE_LAYER, s),
  note: s => `陆地 ${(s.land / 1e6).toFixed(2)}M 格（**不含海冰**）。码 = 热量带 × 8 + 干湿；
    **寒带不占热量带那一轴**——它是干湿的 0 码（所以读气候要先读干湿）。**B 组按纬度补过一刀**
    （BWh/BSh 在回归线外算亚热带）。见 docs/adr/0006。`,
  legendNote: () => `热量带 × 干湿（码 = 热量带 × 8 + 干湿）。<b>寒带不占热量带那一轴</b>——`
    + `它是干湿的 0 码，单独一行。`,
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
          改口径要动 <code>地图/栅格地形数据生成器/climate.py</code> 的两轴映射并重跑生成，编辑器改不了它。</dd>
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
  let html = `<div class="mut" style="padding:6px 9px 2px;font-size:10.5px">${layer.legendNote()}
    陆地 ${(stats.land / 1e6).toFixed(2)}M 格。</div>`;
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

/* 顺序即顶栏按钮的顺序（也决定 `,` / `.` 在自然层之间的切换次序）：
   样式（＝需求方的"样式"模式，三个轴合成的显示类）／覆盖（＝"覆盖"模式）／形态／气候 ——
   后三层是**单根轴**的视图（覆盖 5 位、形态 3 位、气候 8 位），一眼看"是哪一轴出了错"。
   键盘 `4` `5` `6` `7` 依次对应（见 ui.js 的 /^[4-9]$/ 那一支）。 */
export const RO_ORDER = ["terrain", "cover", "form", "climate"];
/* null 原型：层名同样来自存档/键盘，`RO_LAYERS["constructor"]` 在普通对象上是真值
   （见 config.js 的 UNIT 注释）。 */
export const RO_LAYERS = Object.assign(Object.create(null),
  { terrain: TERRAIN, cover: COVER_LAYER, form: FORM_LAYER, climate: CLIMATE_LAYER });
export const RO_KEYS = RO_ORDER.slice();
export const roLayer = k => RO_LAYERS[k] || RO_LAYERS[RO_ORDER[0]];

/* 注册进 config 的单元表：顶栏按钮、setUnit、检视器抬头都从 UNIT 查。 */
registerUnits(RO_ORDER.map(k => RO_LAYERS[k]));
