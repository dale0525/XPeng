#!/usr/bin/env python3
"""验证一张易盾票据能否通过 drag/validate。

背景（2026-10-31 从 App 堆快照取证）：App 拖完滑块后先调
`POST https://apps-uc.xiaopeng.com/verification/app/v3/drag/validate`，
body 是 `{"sceneType":"SMS","mobile":...,"captchaId":...,"validate":"CN31_..."}`，
返回 `{"code":200,"data":{"valid":true}}` 后才调 `sms/code` 发码。

而 `sms/code` 的 body 只有 `{"mobile":...,"smsType":"11"}`，**不含票据**——
所以把票据塞进 `sms/code` 永远不会被校验，这就是长期卡在 12040106 的原因。

关键约束：易盾 validate 只能校验成功一次，重复校验必然返回不通过。所以每张
票据只能测一次，本脚本用完即标记。

用法：
    pixi run -e rev python scripts/check-ticket.py              # 用最新票据
    pixi run -e rev python scripts/check-ticket.py --ticket CN31_xxx
"""

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import uuid

import login as lgn
import probe
import selfclient

CAPTCHA_ID = 'f6c14777879d4a75b683b29be6709db6'
HOST = 'apps-uc.xiaopeng.com'
PATH = '/verification/app/v3/drag/validate'


def _call(path, body, xid=None, host=HOST):
    """发一条带完整 Xp-Authorization 信封的请求，返回 (json, cookies)。

    不能用 probe.signed()：那只做外层签名，而验证类接口要求信封里带
    内层 xpSign，否则一律 12110002。
    """
    di = selfclient.device_id()
    pool = selfclient.keys(di)
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Client'] = xp['Xp-Client'].replace(probe.DI, di)
    if xid:
        xp['Xp-Xid'] = xid
    inner = hmac.new(probe.SECRET.encode(),
                     probe.canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    plain = str(uuid.uuid4()) + base64.b64encode(
        json.dumps({'xpSign': inner}, separators=(',', ':')).encode()).decode()
    xp['Xp-Authorization'] = probe.build_auth(
        None, di, 3, pool[3], plain.encode(),
        version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(probe.SECRET.encode(),
                                  probe.canon('POST', body, hh).encode(),
                                  hashlib.sha256).hexdigest()
    raw = probe.http(host, path, hh, body, mtls=True)
    cookies = [ln.split(':', 1)[1].strip() for ln in raw.split('\r\n')
               if ln.lower().startswith('set-cookie:')]
    text = probe.dechunk(raw)
    if '}' not in text:
        raise RuntimeError(f'非 JSON 响应: {text[:200]}')
    return json.loads(text[:text.rindex('}') + 1]), cookies


def drag_validate(mobile, validate, xid):
    """提交票据给 drag/validate，返回 data.valid。"""
    body = json.dumps({
        'sceneType': 'SMS',
        'mobile': mobile,
        'captchaId': CAPTCHA_ID,
        'validate': validate,
    }, separators=(',', ':'))
    r, _ = _call(PATH, body, xid)
    if r.get('code') != 200:
        raise RuntimeError(f"drag/validate 失败: {r.get('code')} {r.get('msg')}")
    return (r.get('data') or {}).get('valid') is True


def main():
    ap = argparse.ArgumentParser(description='验证易盾票据是否有效')
    ap.add_argument('--mobile', default='19900001111')
    ap.add_argument('--ticket', help='票据内容，缺省读 /tmp/last_validate.txt')
    a = ap.parse_args()

    if a.ticket:
        ticket = a.ticket.strip()
    else:
        try:
            ticket = open('/tmp/last_validate.txt').read().strip()
        except FileNotFoundError:
            print('没有票据：先用 scripts/login-ui.py 拖一张，或用 --ticket 指定')
            return 1
    if not ticket:
        print('票据为空')
        return 1
    print(f'票据 len={len(ticket)} 前缀={ticket[:16]}')

    # drag/validate 需要一个会话；先建一个（这一步的 12040101 是预期的）
    base = json.dumps({'mobile': a.mobile, 'smsType': lgn.SMS_TYPE},
                      separators=(',', ':'))
    _, cookies = _call('/verification/app/v5/sms/code', base)
    xid = lgn._xid_of(cookies)
    if not xid:
        print('建会话失败，没拿到 XP-Xid')
        return 1
    print(f'会话 xid={xid}')

    ok = drag_validate(a.mobile, ticket, xid)
    print(f'\n结果: {"通过 (valid=true)" if ok else "不通过 (valid=false)"}')
    if ok:
        print('票据有效，可以继续走 sms/code 发码')
    else:
        print('票据无效：可能已被消费（validate 只能用一次）或已过期')
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main())
