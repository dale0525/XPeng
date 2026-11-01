#!/usr/bin/env python3
"""把 work/local.env 与 work/certs/ 里的客户端身份写进 TS 源码。

这些是**客户端身份**（见 docs/research/xpeng-app-teardown.md §2.2 与 §3.1），
不是用户凭据：服务端靠它们判断「这是小鹏 App 在说话」。仓库是公开的，所以真实值
只落在 gitignore 的 generated/ 目录，构建前生成一次。

用法：
    pixi run -e rev python scripts/gen-secrets.py
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import local_env  # noqa: E402

ROOT = os.path.dirname(_HERE)
OUT_DIR = os.path.join(ROOT, 'packages/protocol/src/generated')

SECRET_TEMPLATE = '''// 由 scripts/gen-secrets.py 生成，不入版本库。
export const APP_SECRET = {secret!r};
'''

CERT_TEMPLATE = '''// 由 scripts/gen-secrets.py 生成，不入版本库。
// 登录主机 apps-uc.xiaopeng.com 强制 mTLS，无客户端证书直接 400。
export const CLIENT_CERT_PEM = {cert!r};

export const CLIENT_KEY_PEM = {key!r};
'''


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    secret = local_env.get('XP_SECRET')
    with open(os.path.join(OUT_DIR, 'secrets.ts'), 'w', encoding='utf-8') as f:
        f.write(SECRET_TEMPLATE.format(secret=secret))
    print(f'secrets.ts：secret {len(secret)} 字符')

    with open(os.path.join(ROOT, 'work/certs/client-cert-0.pem'), encoding='utf-8') as f:
        cert = f.read()
    with open(os.path.join(ROOT, 'work/certs/client-key.pem'), encoding='utf-8') as f:
        key = f.read()
    with open(os.path.join(OUT_DIR, 'clientCert.ts'), 'w', encoding='utf-8') as f:
        f.write(CERT_TEMPLATE.format(cert=cert, key=key))
    print(f'clientCert.ts：证书 {len(cert)} 字符，私钥 {len(key)} 字符')
    return 0


if __name__ == '__main__':
    sys.exit(main())
