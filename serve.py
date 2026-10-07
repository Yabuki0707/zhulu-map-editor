# -*- coding: utf-8 -*-
"""编辑器的本地服务：带 no-store 的静态服务 + **虚拟挂载** + **受限 POST**。

用法： python serve.py [端口]     默认 8770；该端口被占用时自动往后找（8771、8772…）

它不再是纯静态服务，原因见 `docs/adr/0002`：图只有一份真源
（`地图/地图数据/栅格/`），编辑器不能持有副本。于是：

    GET  /数据/<文件>   → 栅格/<文件>（唯一真源）
    GET  /草稿/<文件>   → 待合入/<文件>（编辑器启动时探测草稿、以及用户选"用草稿继续"时读它）
    GET  /保存/状态     → JSON：待合入/ 里现在有哪几件
    POST /保存          → body 为 JSON {"base_tag":…, "files":{文件名: dataURL | 对象}}，
                          一律落进 待合入/，**只允许白名单里的三个文件**

白名单在 `tools/mapdata.py` 的 `STAGING_FILES`。地形编码.png 与 参考顶点.bin 不在里面——
地形图是管线从 ETOPO + LC100 算出来的、将来要做规则层的"基础地形代价"来源，
让人一笔划过改掉模拟底数是不能接受的（见 `docs/adr/0001`）。

服务根仍是 `地图编辑器/`，所以网址依然是 `/index.html`——挂载必须是**虚拟路径映射**，
而不是把服务根上移（上移会让网址变成 `/地图编辑器/index.html`）。
"""
import base64, http.server, json, os, sys, urllib.parse, webbrowser

# Windows 控制台默认 GBK，直接 print 中文会 UnicodeEncodeError 崩掉服务
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))                 # game/
sys.path.insert(0, os.path.join(ROOT, "tools"))
# 路径与白名单的唯一出处是 tools/mapdata.py —— 抄一份在这里就是又造了一个会分叉的源头
from mapdata import RASTER as DATA_DIR, STAGING as STAGING_DIR, STAGING_FILES, URL_PREFIX

SAVE_PREFIX = "/保存"
DRAFT_PREFIX = "/草稿/"
MAX_TRIES = 20
MAX_BODY = 64 * 1024 * 1024          # 单次上传上限；栅格 PNG 目前 < 1 MB


def _draft(name: str) -> str | None:
    """草稿里有没有这一件（只认白名单，免得 /草稿/ 变成任意读）。"""
    if name not in STAGING_FILES:
        return None
    p = os.path.join(STAGING_DIR, name)
    return p if os.path.isfile(p) else None


def _has_git(path: str) -> bool:
    """路径里有没有 `.git` 这一段。

    SimpleHTTPRequestHandler 只挡 `../`，**会照样把 `.git/` 吐出去**——编辑器目录
    加了 git 之后，`GET /.git/config` 就是 200（实测过），而 `.git/config` 里可能有
    remote 与凭据，`.git/objects` 更是整个历史。服务虽然只绑 127.0.0.1，
    但本机任何进程、任何网页都能打它。

    比较前先把每段结尾的「空格与点」去掉——Windows 的文件 API 会把 `.git.` / `.git `
    归一成 `.git`，不处理就是一条绕过。
    """
    for seg in path.replace("\\", "/").split("/"):
        if seg.rstrip(" .").lower() == ".git":
            return True
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *a):
        # 只记写操作，读不刷屏
        if self.command == "POST":
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    # ---------------- 读：/数据/ 走真源，/草稿/ 走待合入；其余静态 ----------------
    def translate_path(self, path):
        # **先 unquote 再比前缀**：中文文件名在请求里是百分号编码的，
        # 拿编码后的串去跟前缀比永远不相等（本轮踩过的坑）。
        p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
        if _has_git(p):
            # 静态服务会老实把 .git/ 发出去（见 _has_git 的说明）——一律当作不存在
            return os.path.join(STAGING_DIR, "__不存在__")
        if p.startswith(DRAFT_PREFIX):
            name = p[len(DRAFT_PREFIX):]
            if "/" in name or "\\" in name or name in ("", ".", ".."):
                return os.path.join(STAGING_DIR, "__不存在__")     # 不许穿越
            return _draft(name) or os.path.join(STAGING_DIR, "__草稿里没有__")
        if p.startswith(URL_PREFIX):
            name = p[len(URL_PREFIX):]
            if "/" in name or "\\" in name or name in ("", ".", ".."):
                return os.path.join(DATA_DIR, "__不存在__")
            return os.path.join(DATA_DIR, name)
        return super().translate_path(path)

    def do_GET(self):
        p = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if p == SAVE_PREFIX + "/状态":
            body = json.dumps({"待合入": [n for n in STAGING_FILES if _draft(n)],
                               "目录": STAGING_DIR}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    # ---------------- 写：POST /保存，body 为 JSON，只落 待合入/ ----------------
    def do_POST(self):
        p = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if p.rstrip("/") != SAVE_PREFIX:
            return self._json(400, {"错误": f"只接受 POST {SAVE_PREFIX}"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {"错误": f"Content-Length 不可用或超限（{n}）"})
        try:
            body = json.loads(self.rfile.read(n))
            files = body["files"]
            if not isinstance(files, dict):
                raise ValueError("files 得是对象")
        except Exception as e:
            return self._json(400, {"错误": f"body 不是期望的 JSON：{e}"})

        # 任何其他文件名 / 路径 → 400
        bad = [k for k in files if k not in STAGING_FILES]
        if bad:
            return self._json(400, {"错误": f"只允许写这三个文件，收到 {bad}",
                                    "白名单": list(STAGING_FILES),
                                    "说明": "地形与参考顶点由管线定稿，编辑器不许改"})
        os.makedirs(STAGING_DIR, exist_ok=True)
        written = []
        try:
            for name, val in files.items():
                dst = os.path.join(STAGING_DIR, name)
                tmp = dst + ".part"
                if name.endswith(".png"):
                    # "data:image/png;base64,…"
                    head, _, b64 = str(val).partition(",")
                    if "base64" not in head:
                        raise ValueError(f"{name} 不是 data:…;base64 形式")
                    blob = base64.b64decode(b64)
                    with open(tmp, "wb") as f:
                        f.write(blob)
                else:
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(val, f, ensure_ascii=False, separators=(",", ":"))
                    blob = None
                os.replace(tmp, dst)                 # 原子落盘，不留半截文件
                written.append({"文件": name, "字节": os.path.getsize(dst)})
        except Exception as e:
            return self._json(500, {"错误": f"写入失败：{e}", "已写": written})
        return self._json(200, {"已写": written, "目录": STAGING_DIR})

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def bind(port):
    """绑上就返回 httpd（构造时即已 listen），被占用则返回 None。"""
    try:
        return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        return None


def main():
    try:
        want = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    except ValueError:
        print(f"  端口得是个数字，收到的是 {sys.argv[1]!r}")
        return 2
    os.chdir(HERE)

    httpd = None
    for p in range(want, min(65536, want + MAX_TRIES)):
        httpd = bind(p)
        if httpd:
            break
    if httpd is None:
        print(f"  起服务失败：{want}–{want + MAX_TRIES - 1} 全被占用，换个端口再试：python serve.py 9000")
        return 1

    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/index.html"
    print("  《逐鹿》栅格地图编辑器（模块版）")
    if port != want:
        print(f"  注意：{want} 已被占用（多半是已经开着一个编辑器），这次改用 {port}")
    print(f"  {url}")
    print(f"  真源 {os.path.relpath(DATA_DIR, ROOT)} ｜ 草稿 {os.path.relpath(STAGING_DIR, ROOT)}")
    staged = [n for n in STAGING_FILES if _draft(n)]
    print(f"  待合入：" + ("、".join(staged) if staged else "（空）"))
    print("  浏览器没自己打开就手动访问上面这个地址；关闭本窗口即停止。")
    sys.stdout.flush()

    # 先 listen 再开浏览器。反过来写的话，浏览器会赶在 socket 就绪之前去访问，
    # 撞上"拒绝连接"——用户看到的是浏览器错误页，还以为启动器坏了。
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        with httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
