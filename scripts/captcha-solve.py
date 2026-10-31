"""易盾滑块求解：读图算缺口 → 合成触摸拖拽。

前置：App 的 WebView 调试通道已转发到本机端口（adb forward tcp:9333
localabstract:webview_devtools_remote_<pid>），且登录页滑块已弹出。

登录页带 FLAG_SECURE，系统截图是黑的，所以只能走 WebView 自己的 CDP：
从 DOM 取背景图/拼图块原图算缺口，再用 Input.dispatchTouchEvent 拖。

用法：
    pixi run -e rev python scripts/captcha-solve.py          # 求解并拖动
    pixi run -e rev python scripts/captcha-solve.py --report  # 只报几何与缺口
"""

import io
import json
import random
import sys
import time
import urllib.request

import numpy as np
import websocket
from PIL import Image

PORT = 9333


class CDP:
    def __init__(self, port=PORT):
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
        page = next(t for t in targets if t["type"] == "page")
        self.ws = websocket.create_connection(
            f"ws://127.0.0.1:{port}/devtools/page/{page['id']}",
            timeout=30, suppress_origin=True)
        self._id = 0

    def cmd(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method,
                                 "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self._id:
                return r

    def js(self, expr):
        r = self.cmd("Runtime.evaluate",
                     {"expression": expr, "returnByValue": True})
        return r["result"]["result"].get("value")

    def close(self):
        self.ws.close()


def fetch(url):
    return urllib.request.urlopen(url, timeout=20).read()


def image_size(raw):
    im = Image.open(io.BytesIO(raw))
    return im.size


def gap_left_edge(bg_raw, piece_w):
    """返回缺口方块左边界的 x（背景图坐标）。

    缺口是半透明暗色覆盖，左右两条竖直边在列梯度上最突出。
    先取候选强边，再找相距约 piece_w 的成对边。
    """
    g = np.array(Image.open(io.BytesIO(bg_raw)).convert("RGB")).astype(float).mean(axis=2)
    band = g[25:105, :]
    energy = np.abs(np.diff(band, axis=1)).sum(axis=0)

    strong = [i for i in range(2, len(energy) - 2)
              if energy[i] == max(energy[i - 2:i + 3]) and energy[i] > energy.mean() * 2]
    best = None
    for i in strong:
        for j in strong:
            sep = j - i
            if not (piece_w - 16 <= sep <= piece_w + 6):
                continue
            score = energy[i] + energy[j]
            if best is None or score > best[0]:
                best = (score, i, j)
    if best is None:
        return None
    return best[1] + 1


def piece_content_left(piece_raw):
    """拼图块图里实际内容（alpha 不透明区）的左边界。"""
    a = np.array(Image.open(io.BytesIO(piece_raw)).convert("RGBA"))[:, :, 3]
    xs = np.where((a > 200).any(axis=0))[0]
    return int(xs.min())


def human_path(dx, steps=None):
    """带缓出与轻微抖动的拖拽轨迹，避免匀速直线。"""
    steps = steps or random.randint(26, 34)
    out = []
    for k in range(1, steps + 1):
        t = k / steps
        eased = 1 - (1 - t) ** 2.2          # 先快后慢
        x = dx * eased
        if k == steps:
            x = dx
        out.append(x)
    return out


def main():
    report_only = "--report" in sys.argv
    cdp = CDP()
    try:
        geo = cdp.js("""(() => {
            const bg = document.querySelector('.yidun_bg-img');
            const pc = document.querySelector('.yidun_jigsaw');
            const sl = document.querySelector('.yidun_slider');
            const r = e => e ? e.getBoundingClientRect().toJSON() : null;
            return JSON.stringify({
                bgSrc: bg && bg.src, pcSrc: pc && pc.src,
                bg: r(bg), pc: r(pc), slider: r(sl),
                vw: window.innerWidth, vh: window.innerHeight,
                dpr: window.devicePixelRatio,
            });
        })()""")
        if not geo:
            print("拿不到验证码 DOM，滑块可能未弹出")
            return 1
        g = json.loads(geo)
        print(f"viewport {g['vw']}x{g['vh']} dpr={g['dpr']}")
        print(f"bg rect {g['bg']}")
        print(f"pc rect {g['pc']}")
        print(f"slider rect {g['slider']}")
        if not (g["bgSrc"] and g["pcSrc"]):
            print("背景图或拼图块缺失，滑块可能已通过或未加载")
            return 1

        bg_raw = fetch(g["bgSrc"])
        pc_raw = fetch(g["pcSrc"])
        bw, bh = image_size(bg_raw)
        pw, ph = image_size(pc_raw)
        content_left = piece_content_left(pc_raw)
        print(f"背景图 {bw}x{bh}  拼图块 {pw}x{ph}  内容左边 {content_left}")

        left = gap_left_edge(bg_raw, pw)
        if left is None:
            print("缺口定位失败")
            return 1
        print(f"缺口左边界 x={left}")

        scale = g["bg"]["width"] / bw
        dx = (left - content_left) * scale
        print(f"缩放 {scale:.4f}  需拖动 {dx:.1f} CSS px")

        if report_only:
            return 0

        sl = g["slider"]
        x0 = sl["x"] + sl["width"] / 2
        y0 = sl["y"] + sl["height"] / 2
        path = human_path(dx)

        def touch(kind, x, y):
            pts = [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]
            cdp.cmd("Input.dispatchTouchEvent",
                    {"type": kind, "touchPoints": pts})

        touch("touchStart", x0, y0)
        time.sleep(random.uniform(0.08, 0.16))
        for i, off in enumerate(path):
            jitter = random.uniform(-1.5, 1.5) if i < len(path) - 1 else 0
            touch("touchMove", x0 + off, y0 + jitter)
            time.sleep(random.uniform(0.012, 0.032))
        time.sleep(random.uniform(0.10, 0.20))
        touch("touchEnd", x0 + dx, y0)

        time.sleep(3.0)
        state = cdp.js("""(() => {
            const t = document.querySelector('.yidun_tips__text');
            const f = document.querySelector('.yidun_control');
            return JSON.stringify({
                tip: t && t.textContent.trim(),
                cls: f && f.className,
                hasSlider: !!document.querySelector('.yidun_slider'),
            });
        })()""")
        print("结果:", state)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    sys.exit(main())
