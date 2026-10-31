#!/usr/bin/env python3
"""自研登录界面：把易盾滑块弹给真人拖，拖完自动走完登录。

为什么不做自动化滑块：易盾的风控看的是轨迹。用 CDP 合成触摸事件拖出来的
票据（即使客户端 result=true、531 B）会被服务端判失败。真人拖的轨迹天然
合法，所以正确做法是自研客户端自己弹滑块、由人操作，而不是脚本代劳。

流程（全程在同一个 XP-Xid 会话里）：
  1. 页面加载易盾 H5 SDK，弹滑块
  2. 用户拖动 → onVerify 拿到 validate → POST /api/validate
  3. 服务端调 sms/code（带 validate）→ 下发短信、拿到 XP-Xid
  4. 页面输入验证码 → POST /api/code
  5. 服务端调 sms/validate 校验 → smsLogin 换 token → 落盘

用法：
    pixi run -e rev python scripts/login-ui.py
    # 浏览器打开 http://127.0.0.1:8765
"""

import argparse
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import login as lgn  # noqa: E402

CAPTCHA_ID = 'f6c14777879d4a75b683b29be6709db6'

STATE = {'mobile': None, 'xid': None, 'at': None, 'verified': False}

PAGE = """<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鹏汽车 · 手机号登录</title>
<script src="https://cstaticdun.126.net/load.min.js"></script>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.6 -apple-system,"PingFang SC",sans-serif; background:#eef1f6; color:#1a1a1a; }
  .card { width:360px; padding:28px 24px; background:#fff; border-radius:16px;
          box-shadow:0 8px 32px rgba(0,0,0,.08); }
  h1 { margin:0 0 6px; font-size:19px; }
  .sub { margin:0 0 20px; color:#8a8f99; font-size:13px; }
  button { width:100%; padding:13px; border:0; border-radius:10px; background:#111;
           color:#fff; font-size:15px; cursor:pointer; }
  button:disabled { background:#c9ced6; cursor:default; }
  input { width:100%; box-sizing:border-box; padding:13px; margin-bottom:12px;
          border:1px solid #e2e5ea; border-radius:10px; font-size:17px;
          letter-spacing:4px; text-align:center; }
  #msg { margin-top:14px; font-size:13px; color:#8a8f99; min-height:20px; }
  #msg.err { color:#d93025; }
  #msg.ok { color:#1a7f37; }
  .hide { display:none; }
  #captcha { margin-top:16px; }
</style></head>
<body><div class="card">
  <h1>手机号登录</h1>
  <p class="sub">验证码将发送至 <b id="ph">—</b></p>

  <div id="step1">
    <button id="go">开始验证</button>
    <div id="captcha"></div>
  </div>

  <div id="step2" class="hide">
    <input id="code" inputmode="numeric" maxlength="6" placeholder="验证码" autocomplete="one-time-code">
    <button id="submit">登录</button>
  </div>

  <div id="step3" class="hide">
    <p class="sub" style="margin:16px 0 10px">第二道滑块：验证码已通过，请再拖一次</p>
    <button id="go2">拖动第二道滑块</button>
    <div id="captcha2"></div>
  </div>

  <div id="msg"></div>
</div>
<script>
const msg = (t, k) => { const e = document.getElementById('msg');
  e.textContent = t; e.className = k || ''; };
let inst = null;
let inst2 = null;

document.getElementById('ph').textContent = window.PHONE || '';

fetch('/api/state').then(r => r.json()).then(s => {
  if (s.mobile) document.getElementById('ph').textContent = s.mobile;
  if (s.xid) { document.getElementById('step1').classList.add('hide');
               document.getElementById('step2').classList.remove('hide'); }
});

initNECaptcha({
  captchaId: '%CAPTCHA_ID%',
  element: '#captcha',
  mode: 'popup',
  width: '329px',
  onVerify: async (err, data) => {
    if (err) { msg('滑块出错：' + (err.message || JSON.stringify(err)), 'err'); return; }
    msg('滑块通过，正在发送短信…');
    try {
      const r = await fetch('/api/validate', { method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ validate: data.validate }) });
      const j = await r.json();
      if (!j.ok) { msg('发码失败：' + j.error, 'err'); return; }
      document.getElementById('step1').classList.add('hide');
      document.getElementById('step2').classList.remove('hide');
      document.getElementById('code').focus();
      msg('验证码已发送，请查收短信', 'ok');
    } catch (e) { msg('请求失败：' + e, 'err'); }
  }
}, (instance) => {
  inst = instance;
  msg('点击「开始验证」弹出滑块');
});

document.getElementById('go').onclick = () => {
  if (!inst) { msg('滑块尚未就绪，请稍候', 'err'); return; }
  msg('请拖动滑块');
  inst.popUp();
};

document.getElementById('submit').onclick = async () => {
  const code = document.getElementById('code').value.trim();
  if (!code) { msg('请输入验证码', 'err'); return; }
  const b = document.getElementById('submit');
  b.disabled = true; msg('正在校验验证码…');
  try {
    const r = await fetch('/api/code', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!j.ok) { msg('登录失败：' + j.error, 'err'); b.disabled = false; return; }
    if (j.need_drag) {
      msg('验证码通过，请拖第二道滑块', 'ok');
      document.getElementById('step2').classList.add('hide');
      document.getElementById('step3').classList.remove('hide');
      return;
    }
    msg('登录成功，token 已保存（AT 尾 ' + j.tail + '）', 'ok');
    b.textContent = '已登录';
  } catch (e) { msg('请求失败：' + e, 'err'); b.disabled = false; }
};

// 第二道滑块：验证码已通过的同一会话上提交票据
initNECaptcha({
  captchaId: '%CAPTCHA_ID%',
  element: '#captcha2',
  mode: 'popup',
  width: '329px',
  onVerify: async (err, data) => {
    if (err) { msg('第二道滑块出错：' + (err.message || JSON.stringify(err)), 'err'); return; }
    msg('正在提交第二道滑块票据…');
    try {
      const r = await fetch('/api/drag2', { method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ validate: data.validate }) });
      const j = await r.json();
      const detail = (j.trials || []).join(' | ');
      if (!j.ok) { msg('换 token 失败：' + j.error + (detail ? '  [' + detail + ']' : ''), 'err'); return; }
      msg('登录成功，token 已保存（AT 尾 ' + j.tail + '）', 'ok');
    } catch (e) { msg('请求失败：' + e, 'err'); }
  }
}, (instance) => { inst2 = instance; });

document.getElementById('go2').onclick = () => {
  if (!inst2) { msg('第二道滑块尚未就绪，请稍候', 'err'); return; }
  msg('请拖动第二道滑块');
  inst2.popUp();
};
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path == '/api/state':
            return self._json({'mobile': STATE['mobile'], 'xid': STATE['xid']})
        if self.path in ('/', '/index.html'):
            html = PAGE.replace('%CAPTCHA_ID%', CAPTCHA_ID)
            body = html.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        try:
            if self.path == '/api/validate':
                v = (self._body().get('validate') or '').strip()
                if not v:
                    return self._json({'ok': False, 'error': '没有拿到 validate'})
                open('/tmp/last_validate.txt', 'w').write(v)
                print(f'  收到票据 len={len(v)} 前缀={v[:20]}')
                # 票据一次性：直接交给 send_code 走完「建会话 → drag/validate → 发码」，
                # 成功即已下发短信，失败则这张票据已被消费，必须重新拖。
                try:
                    xid = lgn.send_code(STATE['mobile'], v)
                except RuntimeError as e:
                    return self._json({'ok': False, 'error': str(e)})
                STATE['xid'] = xid
                print(f'  已发码  xid={xid}')
                return self._json({'ok': True})

            if self.path == '/api/code':
                code = (self._body().get('code') or '').strip()
                if not STATE['xid']:
                    return self._json({'ok': False, 'error': '还没有发码会话，请重新拖动滑块'})
                try:
                    lgn.verify_code(STATE['mobile'], code, STATE['xid'])
                except RuntimeError as e:
                    return self._json({'ok': False, 'error': str(e)})
                # 验证码已过，进入第二道滑块。此前的票据（第一道用过的）已消费，
                # 所以这里不重试 login：直接把会话交回页面，让用户拖第二道滑块。
                STATE['verified'] = True
                print(f'  验证码通过，等待第二道滑块  xid={STATE["xid"]}')
                return self._json({'ok': True, 'need_drag': True})

            if self.path == '/api/drag2':
                # 第二道滑块：在「验证码已通过」的会话上试真票据。
                v = (self._body().get('validate') or '').strip()
                if not v:
                    return self._json({'ok': False, 'error': '没有拿到 validate'})
                if not STATE['verified']:
                    return self._json({'ok': False, 'error': '验证码还没通过，先填验证码'})
                trials, data = lgn.try_second_drag(STATE['mobile'], STATE['xid'], v)
                for t in trials:
                    print(f'    {t}')
                if not data:
                    # 全部假设失败：把最后一次的真实错误码带上，便于取证
                    return self._json({'ok': False,
                                       'error': trials[-1] if trials else '无尝试',
                                       'trials': trials})
                # 原始响应 + 同次密钥池先落盘，解不开时才有东西可诊断。
                # sData 一次性、密钥池每次请求都变，事后补不回来。
                try:
                    dump = {k: v for k, v in data.items() if k != '_keypool'}
                    pool = data.get('_keypool') or {}
                    dump['_keypool_hex'] = {str(k): v.hex() for k, v in pool.items()}
                    with open('/tmp/last_smslogin.json', 'w') as f:
                        json.dump(dump, f, ensure_ascii=False)
                    print(f'  原始响应已存 /tmp/last_smslogin.json'
                          f'（含密钥池 {len(pool)} 槽）')
                except Exception as e:
                    print(f'  ⚠ 原始响应落盘失败: {type(e).__name__}: {e}')
                at, rt = lgn.tokens_of(data)
                if not at:
                    return self._json({'ok': False,
                                       'error': '返回 200 但没有 accessToken（sData 也解不出）',
                                       'trials': trials,
                                       'keys': sorted(data.keys())})
                lgn.save(at, rt, uid=data.get('_uid'))
                STATE['at'] = at
                print(f'  登录成功  AT 尾={at[-16:]}')
                return self._json({'ok': True, 'tail': at[-16:], 'trials': trials})

            self.send_error(404)
        except Exception as e:  # noqa: BLE001
            self._json({'ok': False, 'error': f'{type(e).__name__}: {e}'}, 500)

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser(description='自研登录界面（滑块由人拖）')
    ap.add_argument('--mobile', default='13000000000')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    a = ap.parse_args()
    STATE['mobile'] = a.mobile

    srv = HTTPServer(('127.0.0.1', a.port), Handler)
    url = f'http://127.0.0.1:{a.port}'
    print(f'登录页: {url}')
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已退出')
    return 0


if __name__ == '__main__':
    sys.exit(main())
