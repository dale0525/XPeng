#!/usr/bin/env python3
"""把仓库里的真实身份信息替换成假值。

真值**不在本文件**（本文件入版本库），只在 `work/scrub-values.txt` 里，
该文件在 `.gitignore` 内。每行 `真值==>假值`。

用法：
    pixi run -e rev python scripts/scrub-identity.py --rules    # 给 filter-repo 用
    pixi run -e rev python scripts/scrub-identity.py --tree     # 就地改工作区
    pixi run -e rev python scripts/scrub-identity.py --check    # 只报不改，非零退出=有残留

新增一类要脱敏的值时，往 `work/scrub-values.txt` 追加一行即可。
"""

import os
import subprocess
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VALUES = os.path.join(_ROOT, 'work', 'scrub-values.txt')

# 扫工作区时跳过：依赖、构建产物、逆向素材、私密目录
SKIP_DIRS = {
    '.git', 'node_modules', 'work', '.pixi', '.tools', '.sdk',
    'build', '.gradle', 'Pods', '__pycache__',
}


def pairs():
    """真值→假值对，**长值在前**：先换完整设备指纹，再换它的 8 位前缀，
    否则前缀先命中会把长值切碎。"""
    if not os.path.exists(VALUES):
        sys.exit(f'缺少 {VALUES}；见本文件头部说明。')
    out = []
    for line in open(VALUES, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '==>' not in line:
            continue
        real, _, fake = line.partition('==>')
        if real and real != fake:
            out.append((real, fake))
    out.sort(key=lambda p: len(p[0]), reverse=True)
    return out


def _walk():
    for root, dirs, files in os.walk(_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            yield os.path.join(root, name)


def _read(path):
    try:
        return open(path, encoding='utf-8').read()
    except (UnicodeDecodeError, OSError):
        return None


def tree(apply):
    """改（或只报）工作区文件。返回命中数。"""
    ps = pairs()
    hits = 0
    for path in _walk():
        text = _read(path)
        if text is None:
            continue
        new = text
        for real, fake in ps:
            new = new.replace(real, fake)
        if new == text:
            continue
        hits += 1
        rel = os.path.relpath(path, _ROOT)
        print(('已脱敏 ' if apply else '有残留 ') + rel)
        if apply:
            open(path, 'w', encoding='utf-8').write(new)
    return hits


def history(apply):
    """扫（或重写）全部 git 历史。返回命中提交数。"""
    if not os.path.isdir(os.path.join(_ROOT, '.git')):
        sys.exit('不是 git 仓库')
    revs = subprocess.run(
        ['git', 'rev-list', '--all'], cwd=_ROOT,
        capture_output=True, text=True, check=True,
    ).stdout.split()
    ps = pairs()
    hit_revs = set()
    for rev in revs:
        for real, _ in ps:
            r = subprocess.run(
                ['git', 'grep', '-l', '-F', real, rev, '--'],
                cwd=_ROOT, capture_output=True, text=True,
            )
            if r.stdout.strip():
                hit_revs.add(rev)
                break
    if apply and hit_revs:
        rule_path = os.path.join(_ROOT, 'work', 'scrub-rules.txt')
        with open(rule_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(f'{r}==>{fk}' for r, fk in ps) + '\n')
        subprocess.run(
            ['git', 'filter-repo', '--force', '--replace-text', rule_path],
            cwd=_ROOT, check=True,
        )
    return len(hit_revs)


if __name__ == '__main__':
    args = set(sys.argv[1:])
    if '--rules' in args:
        print('\n'.join(f'{r}==>{f}' for r, f in pairs()))
    elif '--tree' in args:
        n = tree(apply=True)
        print(f'# {n} 个文件已脱敏', file=sys.stderr)
    elif '--history' in args:
        n = history(apply=False)
        print(f'# {n} 个提交含真值', file=sys.stderr)
        sys.exit(1 if n else 0)
    elif '--check' in args:
        n = tree(apply=False)
        h = history(apply=False)
        print(f'# 工作区 {n} 个文件、历史 {h} 个提交含真值', file=sys.stderr)
        sys.exit(1 if (n or h) else 0)
    else:
        print(__doc__)
        sys.exit(1)
