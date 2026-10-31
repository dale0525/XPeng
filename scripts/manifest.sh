#!/usr/bin/env bash
# 汇总清单与体积构成：权限、组件数、native 库与 assets 大小排行。
# 需先执行 pixi run decompile。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEC="$ROOT/work/apk/decode"
MAN="$DEC/AndroidManifest.xml"

[[ -f "$MAN" ]] || { echo "缺少 $MAN，先跑 pixi run decompile" >&2; exit 1; }

echo "== 组件数 =="
for tag in activity service receiver provider; do
  printf '%-10s %s\n' "$tag" "$(grep -c "<$tag[ >]" "$MAN" || true)"
done

echo
echo "== 权限数 =="
grep -c '<uses-permission' "$MAN" || true

echo
echo "== native 库 Top 15 =="
find "$DEC/lib" -name '*.so' -type f -exec du -k {} + 2>/dev/null |
  sort -rn | head -15 | awk '{printf "%8.1f MB  %s\n", $1/1024, $2}'

echo
echo "== assets Top 10 =="
du -k "$DEC/assets"/* 2>/dev/null | sort -rn | head -10 |
  awk '{printf "%8.1f MB  %s\n", $1/1024, $2}'

echo
echo "== 总体积 =="
du -sh "$DEC/lib" "$DEC/assets" "$DEC/res" 2>/dev/null
