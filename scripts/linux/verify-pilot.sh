#!/bin/sh
set -eu

APP_PATH=${1:-"./roomillion"}
EXPECTED_SHA256=${2:-""}
REPORT_DESTINATION=${3:-""}
SMOKE_GL_MODE=${ZHIBIAN_SMOKE_GL_MODE:-hardware}

if [ ! -f "$APP_PATH" ] || [ ! -x "$APP_PATH" ]; then
  echo "FAIL: 找不到可执行的千万间 Roomillion：$APP_PATH" >&2
  exit 2
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL: 请使用普通用户运行验收，不要使用 root。" >&2
  exit 2
fi

if [ -n "$EXPECTED_SHA256" ]; then
  ACTUAL_SHA256=$(sha256sum "$APP_PATH" | awk '{print $1}')
  if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "FAIL: SHA-256 不匹配。" >&2
    exit 3
  fi
fi

PILOT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-pilot.XXXXXX")
REPORT_PATH="$PILOT_ROOT/smoke-report.json"
EMPTY_PATH="$PILOT_ROOT/empty-path"
mkdir "$EMPTY_PATH"
RM_BIN=$(command -v rm)
MKDIR_BIN=$(command -v mkdir)
CP_BIN=$(command -v cp)
DIRNAME_BIN=$(command -v dirname)

if [ -n "$REPORT_DESTINATION" ]; then
  case $REPORT_DESTINATION in
    *.json) ;;
    *) echo "FAIL: 持久化报告必须使用 .json 扩展名。" >&2; exit 2 ;;
  esac
  if [ -e "$REPORT_DESTINATION" ]; then
    echo "FAIL: 持久化报告已存在，拒绝覆盖：$REPORT_DESTINATION" >&2
    exit 2
  fi
fi

cleanup() {
  "$RM_BIN" -rf "$PILOT_ROOT"
}
trap cleanup EXIT INT TERM

OLD_PATH=${PATH:-""}
PATH="$EMPTY_PATH"
export PATH
HOME="$PILOT_ROOT/home"
XDG_CONFIG_HOME="$PILOT_ROOT/config"
XDG_CACHE_HOME="$PILOT_ROOT/cache"
ZHIBIAN_SMOKE_REPORT_PATH="$REPORT_PATH"
export HOME XDG_CONFIG_HOME XDG_CACHE_HOME ZHIBIAN_SMOKE_REPORT_PATH

run_smoke() {
  if [ "$SMOKE_GL_MODE" = "swiftshader" ]; then
    "$1" --smoke --offline-audit --use-angle=swiftshader --enable-unsafe-swiftshader
  else
    "$1" --smoke --offline-audit
  fi
}

if run_smoke "$APP_PATH"; then
  :
elif [ "${APP_PATH##*.}" = "AppImage" ]; then
  echo "INFO: FUSE 启动不可用，改用 AppImage 临时解包运行。" >&2
  APPIMAGE_ROOT="$PILOT_ROOT/appimage"
  "$RM_BIN" -rf "$APPIMAGE_ROOT"
  "$MKDIR_BIN" "$APPIMAGE_ROOT"
  (
    cd "$APPIMAGE_ROOT"
    "$APP_PATH" --appimage-extract > "$PILOT_ROOT/appimage-extract.log"
  )
  APPDIR="$APPIMAGE_ROOT/squashfs-root"
  export APPDIR
  run_smoke "$APPDIR/roomillion"
else
  exit 7
fi

PATH=$OLD_PATH
export PATH
if [ ! -f "$REPORT_PATH" ]; then
  echo "FAIL: 工作台没有生成机器可读冒烟报告。" >&2
  exit 4
fi
if ! grep -Eq '"result"[[:space:]]*:[[:space:]]*"PASS"' "$REPORT_PATH"; then
  echo "FAIL: 冒烟报告未通过。" >&2
  exit 5
fi
if ! grep -Eq '"networkAttempts"[[:space:]]*:[[:space:]]*0' "$REPORT_PATH"; then
  echo "FAIL: 离线审计发现出站网络尝试。" >&2
  exit 6
fi
if [ -n "$REPORT_DESTINATION" ]; then
  "$MKDIR_BIN" -p "$("$DIRNAME_BIN" "$REPORT_DESTINATION")"
  "$CP_BIN" "$REPORT_PATH" "$REPORT_DESTINATION"
  echo "验收报告已保存：$REPORT_DESTINATION"
fi

echo "PASS: 普通用户、空 PATH、离线审计验收通过。"
if [ "$SMOKE_GL_MODE" = "swiftshader" ]; then
  echo "说明：本次使用 SwiftShader，仅证明软件渲染路径；不替代目标 Linux/UOS 的 GPU 实机验收。"
fi
