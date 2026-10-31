#!/usr/bin/env bash
# 把逆向工具下载到仓库内 .tools/，并固定版本。
# 走 pixi 环境里的 curl / unzip / java，不依赖系统目录。
set -euo pipefail

JADX_VERSION="${JADX_VERSION:-1.5.6}"
APKTOOL_VERSION="${APKTOOL_VERSION:-3.0.3}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"

if [ ! -x "$TOOLS/jadx/bin/jadx" ]; then
  echo "==> jadx $JADX_VERSION"
  curl -fL --retry 3 -o "$TOOLS/jadx.zip" \
    "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip"
  unzip -oq "$TOOLS/jadx.zip" -d "$TOOLS/jadx"
  rm -f "$TOOLS/jadx.zip"
  chmod +x "$TOOLS/jadx/bin/jadx" "$TOOLS/jadx/bin/jadx-gui" 2>/dev/null || true
else
  echo "==> jadx 已存在，跳过"
fi

if [ ! -f "$TOOLS/apktool.jar" ]; then
  echo "==> apktool $APKTOOL_VERSION"
  curl -fL --retry 3 -o "$TOOLS/apktool.jar" \
    "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar"
else
  echo "==> apktool 已存在，跳过"
fi

echo "==> 完成"
java -version 2>&1 | head -1
"$TOOLS/jadx/bin/jadx" --version
