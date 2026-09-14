#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-toolchain-validation.XXXXXX")
PROFILE_PATH="$RUN_ROOT/system-profile.json"
TOOLCHAIN_ROOT="$RUN_ROOT/git-linux-x64"

cleanup() {
  rm -rf "$RUN_ROOT"
}
trap cleanup EXIT INT TERM

"$SCRIPT_DIR/collect-system-profile.sh" "$PROFILE_PATH"
"$SCRIPT_DIR/prepare-git-toolchain.sh" --output "$TOOLCHAIN_ROOT"

grep -q '"kind": "zhibian-linux-system-profile"' "$PROFILE_PATH"
grep -q '"hostnameCollected": false' "$PROFILE_PATH"
grep -q '"usernameCollected": false' "$PROFILE_PATH"
grep -q '"status": "ready"' "$TOOLCHAIN_ROOT/metadata.json"

EXPECTED_SHA256=$(sed -n 's/.*"gitSha256": "\([a-f0-9][a-f0-9]*\)".*/\1/p' "$TOOLCHAIN_ROOT/metadata.json")
ACTUAL_SHA256=$(sha256sum "$TOOLCHAIN_ROOT/bin/git" | awk '{print $1}')
[ -n "$EXPECTED_SHA256" ]
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ]

VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$TOOLCHAIN_ROOT/metadata.json" | sed -n '1p')
SYSTEM=$(sed -n 's/.*"certifiedSystem": "\([^"]*\)".*/\1/p' "$TOOLCHAIN_ROOT/metadata.json")
SIZE=$(du -sh "$TOOLCHAIN_ROOT" | awk '{print $1}')

printf 'PASS: 系统画像与 Linux Git 工具链制作闭环通过。\n'
printf 'Git：%s\n' "$VERSION"
printf 'SHA-256：%s\n' "$ACTUAL_SHA256"
printf '工具链大小：%s\n' "$SIZE"
printf '构建基线：%s\n' "$SYSTEM"
