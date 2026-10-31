#!/usr/bin/env python3
"""手机号登录：发码 → 校验验证码 → 换 token → 落盘。

链路（全部在同一个 ``Xp-Xid`` 会话里）：

1. ``POST /verification/app/v5/sms/code``        发短信，响应下发 ``XP-Xid``
2. ``POST /verification/app/v3/sms/validate``    校验验证码，把通过状态写进会话
3. ``POST /sso/app/v5/smsLogin``                 只带 mobile，从会话取状态换 token

**为什么验证码不能直接交给 smsLogin**：实测只传 ``mobile`` 时 smsLogin 也返回
``12001402 短信验证码错误``，而不是「code 不能为空」；换 ``code``/``smsCode``/
``verifyCode`` 三种字段名结果一致。而 ``sms/validate`` 缺字段时会明确报
``code不能为空``/``smsType不能为空``。即验证码由 sms/validate 消化，smsLogin
只认会话状态。

**滑块**：发码那一步需要易盾票据，本脚本不做——票据绑定服务端会话与轨迹风控，
脚本生成的轨迹过不了。拿到票据的方式是让官方 App 发码，再把 ``XP-Xid`` 与
验证码喂进来（见 ``--xid``）。

用法：
    # 官方 App 已发码，从抓包或 App 拿到 xid 与验证码
    pixi run -e rev python scripts/login.py --xid <uuid> --code 1234

    # 自研侧直接发码（需要预先拿到易盾票据 validate）
    pixi run -e rev python scripts/login.py --validate <票据>
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import probe  # noqa: E402
import selfclient  # noqa: E402

ROOT = os.path.dirname(_HERE)
LIVE = os.path.join(ROOT, 'work/live')
UC = 'apps-uc.xiaopeng.com'

SMS_TYPE = '11'  # 登录场景；服务端对 1/2/11/21/31 不校验取值，只要求非空


def _call(path, body, xid=None):
    """带双层签名的 POST，返回 (json, set_cookie 列表)。"""
    di = selfclient.device_id()
    pool = selfclient.keys(di)
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Client'] = xp['Xp-Client'].replace(probe.DI, di)
    if xid:
        xp['Xp-Xid'] = xid
    inner = hmac.new(probe.SECRET.encode(), probe.canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    plain = (str(uuid.uuid4())
             + base64.b64encode(json.dumps({'xpSign': inner},
                                           separators=(',', ':')).encode()).decode())
    xp['Xp-Authorization'] = probe.build_auth(
        None, di, 3, pool[3], plain.encode(), version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(probe.SECRET.encode(),
                                  probe.canon('POST', body, hh).encode(),
                                  hashlib.sha256).hexdigest()
    raw = probe.http(UC, path, hh, body, mtls=True)
    cookies = [line.split(':', 1)[1].strip()
               for line in raw.split('\r\n')
               if line.lower().startswith('set-cookie:')]
    s = probe.dechunk(raw)
    return json.loads(s[:s.rindex('}') + 1]), cookies


def _xid_of(cookies):
    for c in cookies:
        name, _, rest = c.partition('=')
        if name.strip().lower().endswith('xid'):
            return rest.split(';')[0].strip()
    return None


def send_code(mobile, validate=None):
    """发短信，返回会话 xid。validate 为易盾票据时一并提交。

    带票据时必须两步走：服务端只在**已有会话**的请求里才校验票据。首个请求
    没有 ``XP-Xid``，无论票据真假一律 ``12040101 拖动滑块验证码``；先用一次
    无票据请求拿到 xid（该响应照样下发 cookie），再带 xid + 票据重试。
    """
    base = {'mobile': mobile, 'smsType': SMS_TYPE}

    if not validate:
        r, cookies = _call('/verification/app/v5/sms/code', json.dumps(base))
        if r.get('code') != 200:
            raise RuntimeError(f"发码失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
        xid = _xid_of(cookies)
        if not xid:
            raise RuntimeError('发码成功但响应里没有 XP-Xid，无法继续')
        return xid

    # 第一步：拿会话。预期 12040101（还没票据），但 cookie 会下发。
    _, cookies = _call('/verification/app/v5/sms/code', json.dumps(base))
    xid = _xid_of(cookies)
    if not xid:
        raise RuntimeError('发码接口没有下发 XP-Xid，无法建立会话')

    # 第二步：带票据 + 会话，服务端这才真正校验票据。
    body = dict(base, validate=validate)
    r, cookies2 = _call('/verification/app/v5/sms/code', json.dumps(body), xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"发码失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    return _xid_of(cookies2) or xid


def verify_code(mobile, code, xid):
    """校验验证码；通过后状态记在服务端会话里。"""
    r, _ = _call('/verification/app/v3/sms/validate',
                 json.dumps({'mobile': mobile, 'smsType': SMS_TYPE, 'code': code}),
                 xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"验证码校验失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    return r.get('data')


def login(mobile, xid):
    """换 token。返回 (accessToken, refreshToken)。"""
    r, _ = _call('/sso/app/v5/smsLogin', json.dumps({'mobile': mobile}), xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"登录失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    d = r['data']
    return d['accessToken'], d['refreshToken']


def save(at, rt):
    os.makedirs(LIVE, exist_ok=True)
    atp, rtp = os.path.join(LIVE, 'access_token.txt'), os.path.join(LIVE, 'refresh_token.txt')
    open(atp, 'w').write(at)
    open(rtp, 'w').write(rt)
    os.chmod(atp, 0o600)
    os.chmod(rtp, 0o600)
    open(atp + '.ts', 'w').write(str(int(time.time())))


def main():
    ap = argparse.ArgumentParser(description='手机号登录拿 token')
    ap.add_argument('--mobile', default='13000000000')
    ap.add_argument('--code', help='短信验证码')
    ap.add_argument('--xid', help='发码会话的 XP-Xid（官方 App 发码时拿到）')
    ap.add_argument('--validate', help='易盾票据；给了就由本脚本发码')
    a = ap.parse_args()

    xid = a.xid
    if not xid:
        if not a.validate:
            ap.error('要么给 --xid（复用官方 App 的发码会话），要么给 --validate 自行发码')
        xid = send_code(a.mobile, a.validate)
        print(f'已发码  xid={xid}')
    if not a.code:
        print(f'下一步：拿到验证码后重跑 --xid {xid} --code <验证码>')
        return 0

    verify_code(a.mobile, a.code, xid)
    print('验证码通过')
    at, rt = login(a.mobile, xid)
    save(at, rt)
    print(f'登录成功  AT 尾={at[-16:]}  RT 尾={rt[-16:]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
