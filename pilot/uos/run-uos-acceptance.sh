#!/bin/sh
set -eu

KIT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(sed -n '1p' "$KIT_ROOT/VERSION")
[ -n "$VERSION" ] || { echo "FAIL: 验收包缺少版本信息。" >&2; exit 2; }
OUTPUT_ROOT=""

usage() {
  echo "用法：sh run-uos-acceptance.sh [--output <全新结果目录>]" >&2
  exit 2
}

if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = "--output" ] || usage
  OUTPUT_ROOT=$2
fi

[ "$(id -u)" -ne 0 ] || { echo "FAIL: 请用普通用户验收，不要使用 root。" >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo "FAIL: 系统缺少 sha256sum。" >&2; exit 2; }
command -v tar >/dev/null 2>&1 || { echo "FAIL: 系统缺少 tar。" >&2; exit 2; }

if [ -z "$OUTPUT_ROOT" ]; then
  OUTPUT_ROOT="$KIT_ROOT/results-$(date -u '+%Y%m%dT%H%M%SZ')"
fi
case $OUTPUT_ROOT in
  ""|/|/usr|/etc|/var|/home) echo "FAIL: 结果目录不安全。" >&2; exit 2 ;;
esac
if [ -e "$OUTPUT_ROOT" ]; then
  echo "FAIL: 结果目录必须不存在：$OUTPUT_ROOT" >&2
  exit 2
fi

ARCHIVE_NAME="Roomillion-${VERSION}-linux-x64.tar.xz"
APPIMAGE_NAME="Roomillion-${VERSION}-x86_64.AppImage"
UNPACKED_NAME="Roomillion-${VERSION}-linux-x64"
WORK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-uos-acceptance.XXXXXX")
RM_BIN=$(command -v rm)
ENV_BIN=$(command -v env)

cleanup() {
  "$RM_BIN" -rf "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$OUTPUT_ROOT" "$WORK_ROOT/app" "$WORK_ROOT/migration-home" "$WORK_ROOT/migration-tmp" "$WORK_ROOT/empty-path"
(
  cd "$KIT_ROOT"
  sha256sum -c SHA256SUMS.txt
)

cp "$KIT_ROOT/人工验收清单.md" "$OUTPUT_ROOT/人工验收清单.md"
"$KIT_ROOT/tools/collect-system-profile.sh" "$OUTPUT_ROOT/system-profile.json"
tar -xJf "$KIT_ROOT/artifacts/$ARCHIVE_NAME" -C "$WORK_ROOT/app"

APP_ROOT="$WORK_ROOT/app/$UNPACKED_NAME"
APP_PATH="$APP_ROOT/roomillion"
APPIMAGE_PATH="$KIT_ROOT/artifacts/$APPIMAGE_NAME"
[ -x "$APP_PATH" ] || { echo "FAIL: 解压目录版缺少可执行文件。" >&2; exit 3; }
[ -x "$APPIMAGE_PATH" ] || { echo "FAIL: AppImage 不可执行。" >&2; exit 3; }

"$KIT_ROOT/tools/verify-pilot.sh" "$APP_PATH" "" "$OUTPUT_ROOT/directory-smoke.json"
"$KIT_ROOT/tools/verify-pilot.sh" "$APPIMAGE_PATH" "" "$OUTPUT_ROOT/appimage-smoke.json"

MIGRATION_SCRIPT="$APP_ROOT/resources/app.asar/src/main/migration-cli.cjs"
"$ENV_BIN" -i \
  PATH="$WORK_ROOT/empty-path" \
  HOME="$WORK_ROOT/migration-home" \
  XDG_CONFIG_HOME="$WORK_ROOT/migration-home/config" \
  XDG_CACHE_HOME="$WORK_ROOT/migration-home/cache" \
  TMPDIR="$WORK_ROOT/migration-tmp" \
  LANG=C.UTF-8 \
  ELECTRON_RUN_AS_NODE=1 \
  "$APP_PATH" "$MIGRATION_SCRIPT" target \
  --input "$KIT_ROOT/vectors/windows-source" \
  --output "$OUTPUT_ROOT/migration-return"

grep -Eq '"result"[[:space:]]*:[[:space:]]*"PASS"' "$OUTPUT_ROOT/migration-return/target-report.json" || {
  echo "FAIL: 跨平台迁移报告未通过。" >&2
  exit 4
}

cat > "$OUTPUT_ROOT/automated-summary.json" <<EOF
{
  "kind": "zhibian-uos-acceptance-summary",
  "formatVersion": "0.1",
  "result": "AUTOMATED_PASS",
  "createdAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "appVersion": "$VERSION",
  "checks": {
    "kitIntegrity": "PASS",
    "directorySmoke": "PASS",
    "appImageSmoke": "PASS",
    "windowsToLinuxMigration": "PASS"
  },
  "networkAttempts": 0,
  "requiresManualChecklist": true,
  "returnVector": "migration-return"
}
EOF

printf '\nPASS: 自动 UOS/Linux x64 验收已完成。\n'
printf '结果目录：%s\n' "$OUTPUT_ROOT"
printf '请完成“人工验收清单.md”，并把整个结果目录复制回 Windows 执行回迁校验。\n'
