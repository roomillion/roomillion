#!/bin/sh
set -eu

VERSION=0.3.0-alpha.1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
RELEASE_ROOT="$PROJECT_ROOT/release"
SOURCE_VECTOR="$RELEASE_ROOT/migration/windows-source"
KIT_NAME="Roomillion-${VERSION}-UOS-x64-Acceptance-Kit"
STAGE_ROOT="$RELEASE_ROOT/$KIT_NAME"
ARCHIVE_PATH="$RELEASE_ROOT/${KIT_NAME}.tar.xz"
ARCHIVE_PART="$ARCHIVE_PATH.part"
ARCHIVE_SHA_PATH="$ARCHIVE_PATH.sha256"
LINUX_RELEASE="$RELEASE_ROOT/linux"
APP_ARCHIVE="Roomillion-${VERSION}-linux-x64.tar.xz"
APPIMAGE="Roomillion-${VERSION}-x86_64.AppImage"

case $STAGE_ROOT in
  "$RELEASE_ROOT"/*) ;;
  *) echo "FAIL: 验收包暂存目录超出 release。" >&2; exit 2 ;;
esac

for required in \
  "$LINUX_RELEASE/$APP_ARCHIVE" \
  "$LINUX_RELEASE/$APPIMAGE" \
  "$SOURCE_VECTOR/vector.json" \
  "$SOURCE_VECTOR/migration-room.room" \
  "$SOURCE_VECTOR/migration-data.zdata"; do
  [ -f "$required" ] || { echo "FAIL: 缺少验收包输入：$required" >&2; exit 3; }
done

rm -rf "$STAGE_ROOT"
rm -f "$ARCHIVE_PATH" "$ARCHIVE_PART" "$ARCHIVE_SHA_PATH"
mkdir -p "$STAGE_ROOT/artifacts" "$STAGE_ROOT/vectors/windows-source" "$STAGE_ROOT/tools" "$STAGE_ROOT/compliance" "$STAGE_ROOT/docs"

cp "$LINUX_RELEASE/$APP_ARCHIVE" "$STAGE_ROOT/artifacts/"
cp "$LINUX_RELEASE/$APPIMAGE" "$STAGE_ROOT/artifacts/"
cp "$SOURCE_VECTOR/vector.json" "$SOURCE_VECTOR/migration-room.room" "$SOURCE_VECTOR/migration-data.zdata" "$STAGE_ROOT/vectors/windows-source/"
cp "$PROJECT_ROOT/pilot/uos/README.md" "$STAGE_ROOT/README.md"
cp "$PROJECT_ROOT/pilot/uos/人工验收清单.md" "$STAGE_ROOT/人工验收清单.md"
cp "$PROJECT_ROOT/pilot/uos/run-uos-acceptance.sh" "$STAGE_ROOT/run-uos-acceptance.sh"
cp "$PROJECT_ROOT/scripts/linux/collect-system-profile.sh" "$PROJECT_ROOT/scripts/linux/verify-pilot.sh" "$STAGE_ROOT/tools/"
cp "$PROJECT_ROOT/resources/compliance/THIRD-PARTY-NOTICES.md" "$PROJECT_ROOT/resources/compliance/sbom.cdx.json" "$STAGE_ROOT/compliance/"
cp "$PROJECT_ROOT/docs/15-阶段三-UOS-Linux-x64技术验证计划.md" "$PROJECT_ROOT/docs/16-0.3阶段三实施记录.md" "$STAGE_ROOT/docs/"
chmod 0755 "$STAGE_ROOT/run-uos-acceptance.sh" "$STAGE_ROOT/tools/collect-system-profile.sh" "$STAGE_ROOT/tools/verify-pilot.sh" "$STAGE_ROOT/artifacts/$APPIMAGE"

(
  cd "$STAGE_ROOT"
  find . -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
)
(
  cd "$RELEASE_ROOT"
  tar -cJf "$ARCHIVE_PART" "$KIT_NAME"
)
mv "$ARCHIVE_PART" "$ARCHIVE_PATH"
(
  cd "$RELEASE_ROOT"
  sha256sum "${KIT_NAME}.tar.xz" > "${KIT_NAME}.tar.xz.sha256"
)

printf 'PASS: UOS x64 离线验收包已生成。\n'
printf '目录：%s\n' "$STAGE_ROOT"
printf '归档：%s\n' "$ARCHIVE_PATH"
printf 'SHA-256：%s\n' "$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
