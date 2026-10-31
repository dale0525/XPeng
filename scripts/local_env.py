"""本地私密配置：从环境变量或 work/local.env 读取。

仓库是公开的，所以客户端 secret、设备指纹、UID、VIN 都不入版本库。
`work/` 整个目录已在 .gitignore 里，把真实值写进 `work/local.env` 即可：

    XP_SECRET=<官方客户端签名 secret>
    XP_DI=<设备指纹 di>
    XP_UID=<账号 uid>
    XP_VIN=<车辆 VIN>

这些值怎么取得见 docs/research/xpeng-app-teardown.md §2.2 与 §2.6。
"""

import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PATH = os.path.join(_ROOT, 'work', 'local.env')


def get(name, default=None):
    """读一个配置项；缺失且没给默认值时抛错，避免用空 secret 签出一堆无效请求。"""
    v = os.environ.get(name)
    if v:
        return v
    if os.path.exists(_PATH):
        for line in open(_PATH, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, val = line.partition('=')
            if k.strip() == name:
                return val.strip()
    if default is not None:
        return default
    raise RuntimeError(
        f'缺少配置 {name}：写进 {_PATH} 或设为环境变量。取值方法见 '
        'docs/research/xpeng-app-teardown.md §2.2')
