#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
用法：build-generic-preview.sh --toolchain <已准备的 git-linux-x64 目录> [--offline] [--appimage]

首次运行会下载并校验固定 Node.js、npm 依赖、Linux Electron 和构建工具到 .linux-build/。
之后可以加 --offline 复用缓存。构建过程不安装系统包、不需要 root。
EOF
  exit 2
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
TOOLCHAIN_ROOT=""
OFFLINE=false
WITH_APPIMAGE=false

while [ "$#" -gt 0 ]; do
  case $1 in
    --toolchain)
      [ "$#" -ge 2 ] || usage
      TOOLCHAIN_ROOT=$2
      shift 2
      ;;
    --offline) OFFLINE=true; shift ;;
    --appimage) WITH_APPIMAGE=true; shift ;;
    *) usage ;;
  esac
done

[ -n "$TOOLCHAIN_ROOT" ] || usage
TOOLCHAIN_ROOT=$(CDPATH= cd -- "$TOOLCHAIN_ROOT" && pwd)
[ -x "$TOOLCHAIN_ROOT/bin/git" ] || { echo "FAIL: 工具链缺少可执行 bin/git。" >&2; exit 3; }
grep -q '"status": "ready"' "$TOOLCHAIN_ROOT/metadata.json" || { echo "FAIL: 工具链 metadata.status 不是 ready。" >&2; exit 3; }

if [ "$OFFLINE" = true ]; then
  export ZHIBIAN_BUILD_OFFLINE=1
fi
sh "$SCRIPT_DIR/bootstrap-build-runtime.sh"

NODE_VERSION=24.20.0
CACHE_ROOT=${ZHIBIAN_LINUX_BUILD_CACHE:-"$PROJECT_ROOT/.linux-build"}
NODE_ROOT="$CACHE_ROOT/node-v${NODE_VERSION}-linux-x64"
NPM_CACHE="$CACHE_ROOT/npm-cache"
ELECTRON_CACHE="$CACHE_ROOT/electron-cache"
ELECTRON_BUILDER_CACHE="$CACHE_ROOT/electron-builder-cache"
ELECTRON_DIST_ARCHIVE="$CACHE_ROOT/electron-v44.0.0-linux-x64-dist.tar.xz"
WORK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-linux-build.XXXXXX")
SOURCE_ROOT="$WORK_ROOT/source"
DESTINATION="$PROJECT_ROOT/release/linux"

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$SOURCE_ROOT" "$NPM_CACHE" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"
(
  cd "$PROJECT_ROOT"
  tar \
    --exclude='./.git' \
    --exclude='./docs' \
    --exclude='./node_modules' \
    --exclude='./release' \
    --exclude='./.linux-build' \
    --exclude='./.npm-cache' \
    --exclude='./.electron-cache' \
    -cf - .
) | (
  cd "$SOURCE_ROOT"
  tar -xf -
)
[ -f "$SOURCE_ROOT/package-lock.json" ] || { echo "FAIL: 构建源码复制失败。" >&2; exit 4; }

rm -rf "$SOURCE_ROOT/resources/toolchains/git-linux-x64"
mkdir -p "$SOURCE_ROOT/resources/toolchains/git-linux-x64"
cp -a "$TOOLCHAIN_ROOT/." "$SOURCE_ROOT/resources/toolchains/git-linux-x64/"

export PATH="$NODE_ROOT/bin:/usr/bin:/bin"
export npm_config_cache="$NPM_CACHE"
export ELECTRON_CACHE="$ELECTRON_CACHE"
export ELECTRON_BUILDER_CACHE="$ELECTRON_BUILDER_CACHE"
export ELECTRON_MIRROR=${ELECTRON_MIRROR:-"https://npmmirror.com/mirrors/electron/"}
if [ "$OFFLINE" = true ]; then
  export npm_config_offline=true
  export ELECTRON_MIRROR="http://127.0.0.1:9/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="http://127.0.0.1:9/electron-builder/"
fi

cd "$SOURCE_ROOT"
if [ "$OFFLINE" = true ]; then
  npm ci --offline --no-audit --no-fund
else
  npm ci --prefer-offline --no-audit --no-fund
fi

if [ ! -x node_modules/electron/dist/electron ]; then
  if [ -f "$ELECTRON_DIST_ARCHIVE" ]; then
    mkdir -p node_modules/electron/dist
    tar -xJf "$ELECTRON_DIST_ARCHIVE" -C node_modules/electron/dist
  elif [ "$OFFLINE" = true ]; then
    echo "FAIL: 离线缓存缺少 Linux Electron 展开包；请先不加 --offline 完成一次在线缓存。" >&2
    exit 4
  else
    node node_modules/electron/install.js
    [ -x node_modules/electron/dist/electron ] || { echo "FAIL: Electron 安装脚本没有生成 Linux dist。" >&2; exit 4; }
    ELECTRON_ARCHIVE_PART="$ELECTRON_DIST_ARCHIVE.part"
    rm -f "$ELECTRON_ARCHIVE_PART"
    tar -cJf "$ELECTRON_ARCHIVE_PART" -C node_modules/electron/dist .
    mv "$ELECTRON_ARCHIVE_PART" "$ELECTRON_DIST_ARCHIVE"
  fi
fi
[ "$(sed -n '1p' node_modules/electron/dist/version)" = "44.0.0" ] || { echo "FAIL: Linux Electron dist 版本不匹配。" >&2; exit 4; }
# npm 11 may defer Electron's install script. The cached archive contains the
# complete dist directory, so restore the small launcher marker explicitly.
printf 'electron' > node_modules/electron/path.txt
export ELECTRON_OVERRIDE_DIST_PATH="$SOURCE_ROOT/node_modules/electron/dist"

npm run verify:linux-toolchain
npm run build:resources
npm test

if [ "$WITH_APPIMAGE" = true ]; then
  node node_modules/electron-builder/cli.js --linux dir tar.xz AppImage --x64 --config build/electron-builder.linux.cjs --publish never
else
  node node_modules/electron-builder/cli.js --linux dir tar.xz --x64 --config build/electron-builder.linux.cjs --publish never
fi

[ -x "$SOURCE_ROOT/release/linux/linux-unpacked/roomillion" ] || { echo "FAIL: Linux 解包版不存在。" >&2; exit 5; }
case $DESTINATION in
  "$PROJECT_ROOT/release/linux") ;;
  *) echo "FAIL: 发布目录校验失败。" >&2; exit 5 ;;
esac
rm -rf "$DESTINATION"
mkdir -p "$DESTINATION"
cp -a "$SOURCE_ROOT/release/linux/." "$DESTINATION/"

sh "$SCRIPT_DIR/collect-system-profile.sh" "$DESTINATION/build-system-profile.json"
(
  cd "$DESTINATION"
  find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 -r sha256sum > SHA256SUMS.txt
)

printf 'PASS: generic-linux-x64 技术预览构建完成。\n'
printf '输出：%s\n' "$DESTINATION"
printf '说明：这不是 UOS 认证结论，必须在目标 UOS 上继续运行离线冒烟。\n'
