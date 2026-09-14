#!/bin/sh
set -eu

NODE_VERSION=24.20.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
NODE_URL="https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CACHE_ROOT=${ZHIBIAN_LINUX_BUILD_CACHE:-"$PROJECT_ROOT/.linux-build"}
DOWNLOAD_ROOT="$CACHE_ROOT/downloads"
RUNTIME_ROOT="$CACHE_ROOT/node-v${NODE_VERSION}-linux-x64"
ARCHIVE_PATH="$DOWNLOAD_ROOT/$NODE_ARCHIVE"

case $CACHE_ROOT in
  ""|/|/usr|/etc|/var|/home) echo "FAIL: Linux 构建缓存目录不安全。" >&2; exit 2 ;;
esac

if [ -x "$RUNTIME_ROOT/bin/node" ] && [ "$("$RUNTIME_ROOT/bin/node" --version)" = "v$NODE_VERSION" ]; then
  printf 'Linux 构建 Node 已就绪：%s\n' "$RUNTIME_ROOT"
  exit 0
fi

if [ "${ZHIBIAN_BUILD_OFFLINE:-0}" = "1" ]; then
  echo "FAIL: 离线模式缺少已校验的 Node.js 构建运行时。" >&2
  exit 3
fi

command -v curl >/dev/null 2>&1 || { echo "FAIL: 首次准备构建缓存需要 curl。" >&2; exit 3; }
command -v sha256sum >/dev/null 2>&1 || { echo "FAIL: 缺少 sha256sum。" >&2; exit 3; }
command -v tar >/dev/null 2>&1 || { echo "FAIL: 缺少 tar。" >&2; exit 3; }

mkdir -p "$DOWNLOAD_ROOT"
if [ -f "$ARCHIVE_PATH" ]; then
  EXISTING_SHA=$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')
  if [ "$EXISTING_SHA" != "$NODE_SHA256" ]; then
    echo "已有 Node 归档哈希不匹配，拒绝复用。" >&2
    rm -f "$ARCHIVE_PATH"
  fi
fi

if [ ! -f "$ARCHIVE_PATH" ]; then
  PART_PATH="$ARCHIVE_PATH.part"
  rm -f "$PART_PATH"
  printf '下载固定版本 Node.js：%s\n' "$NODE_URL"
  curl --fail --location --retry 3 --output "$PART_PATH" "$NODE_URL"
  ACTUAL_SHA=$(sha256sum "$PART_PATH" | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$NODE_SHA256" ]; then
    rm -f "$PART_PATH"
    echo "FAIL: Node.js 归档 SHA-256 不匹配。" >&2
    exit 4
  fi
  mv "$PART_PATH" "$ARCHIVE_PATH"
fi

EXTRACT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-node-runtime.XXXXXX")
cleanup() {
  rm -rf "$EXTRACT_ROOT"
}
trap cleanup EXIT INT TERM

tar -xJf "$ARCHIVE_PATH" -C "$EXTRACT_ROOT"
[ -x "$EXTRACT_ROOT/node-v${NODE_VERSION}-linux-x64/bin/node" ] || { echo "FAIL: Node.js 归档布局无效。" >&2; exit 5; }
rm -rf "$RUNTIME_ROOT"
mv "$EXTRACT_ROOT/node-v${NODE_VERSION}-linux-x64" "$RUNTIME_ROOT"

cat > "$CACHE_ROOT/runtime-metadata.json" <<EOF
{
  "nodeVersion": "$NODE_VERSION",
  "artifact": "$NODE_ARCHIVE",
  "source": "$NODE_URL",
  "sha256": "$NODE_SHA256"
}
EOF

printf 'PASS: Linux 构建 Node 已下载、校验并解压。\n'
printf 'Node：%s\n' "$("$RUNTIME_ROOT/bin/node" --version)"
printf 'npm：%s\n' "$("$RUNTIME_ROOT/bin/node" "$RUNTIME_ROOT/lib/node_modules/npm/bin/npm-cli.js" --version)"
printf '目录：%s\n' "$RUNTIME_ROOT"
