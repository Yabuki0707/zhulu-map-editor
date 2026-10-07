/* ==========================================================================
   refvec.js —— 参考层：**矢量顶点**（不是烧成栅格的掩膜）

   为什么不用栅格：掩膜是 8 位 PNG，1px 线缩小时会整片消失或闪烁，于是得再配一套
   mipmap 金字塔（buildRefMips / maskToCanvas）来兜；而且"顶点"在栅格里根本读不出来。
   矢量则相反：线宽按屏幕像素给（放大就变细，缩到全图也不会糊），放大到街道级能落出
   原始顶点——对着顶点改地块，本来就是这层的用途。

   数据（`data/参考顶点.bin`，小端）：
     "ZLRV1\0\0\0"  magic
     uint32 n_rings
     uint32 n_points
     uint32 off[n_rings + 1]    每个环在顶点表里的起止下标
     uint8  src[n_rings]        0 = 现代单元边界，1 = 唐 741 州面
     uint16 xy[n_points * 2]    格坐标 × 8（1/8 格 ≈ 1 km）交错的 x, y

   加载是**按需**的（第一次打开「参考」时才取），失败只提示、不影响底图。
   ========================================================================== */

import { DATA } from "./config.js";

export const REF = {
  ready: false, loading: false, failed: false,
  n: 0, off: null, src: null, xy: null, box: null,   // box = Float32Array(n*4)：每环包围盒
  bytes: 0,
};

const SUB = 8;                                        // 与 tools/refvec.py 的 SUB 一致

function parse(buf) {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== "ZLRV1\0\0\0") throw new Error("参考顶点数据魔数不符");
  const n = dv.getUint32(8, true), np = dv.getUint32(12, true);
  let o = 16;
  const off = new Uint32Array(buf.slice(o, o + (n + 1) * 4)); o += (n + 1) * 4;
  const src = new Uint8Array(buf.slice(o, o + n)); o += n;
  if ((n + 1) * 4 + n + np * 4 > buf.byteLength) throw new Error("参考顶点数据长度不足");
  const xy = new Uint16Array(buf.slice(o, o + np * 4));
  /* 每环包围盒：画的时候按视野筛环，否则每帧都要走 30 万个顶点 */
  const box = new Float32Array(n * 4);
  for (let r = 0; r < n; r++) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = off[r]; i < off[r + 1]; i++) {
      const x = xy[i * 2] / SUB, y = xy[i * 2 + 1] / SUB;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    box[r * 4] = x0; box[r * 4 + 1] = y0; box[r * 4 + 2] = x1; box[r * 4 + 3] = y1;
  }
  Object.assign(REF, { ready: true, n, off, src, xy, box, bytes: buf.byteLength });
  return REF;
}

export async function loadRef() {
  if (REF.ready || REF.loading) return REF;
  if (!DATA.ref_vec) { REF.failed = true; return REF; }
  REF.loading = true;
  try {
    const res = await fetch(DATA.ref_vec);
    if (!res.ok) throw new Error("HTTP " + res.status);
    parse(await res.arrayBuffer());
  } catch (e) {
    /* 退一步用 XHR（个别环境对 fetch 的 data:/http: 有限制时兜一下） */
    try {
      const buf = await new Promise((res, rej) => {
        const x = new XMLHttpRequest();
        x.open("GET", DATA.ref_vec, true);
        x.responseType = "arraybuffer";
        x.onload = () => (x.status === 0 || x.status === 200 ? res(x.response) : rej(new Error("HTTP " + x.status)));
        x.onerror = () => rej(new Error("XHR 失败"));
        x.send();
      });
      parse(buf);
    } catch (e2) {
      REF.failed = true;
      console.warn("参考顶点层载入失败", e, e2);
    }
  } finally {
    REF.loading = false;
  }
  return REF;
}
