#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
用法：
  prepare-git-toolchain.sh --output <全新目录>
  prepare-git-toolchain.sh --replace-project-toolchain

脚本只读取当前 Linux 的 Git、动态库、模板和许可证，不联网、不调用 apt/yum、无需 root。
EOF
  exit 2
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
PROJECT_TOOLCHAIN="$PROJECT_ROOT/resources/toolchains/git-linux-x64"
MODE=output
OUTPUT_ROOT=""

case ${1:-} in
  --output)
    [ "$#" -eq 2 ] || usage
    OUTPUT_ROOT=$2
    ;;
  --replace-project-toolchain)
    [ "$#" -eq 1 ] || usage
    MODE=replace
    OUTPUT_ROOT=$PROJECT_TOOLCHAIN
    ;;
  *) usage ;;
esac

[ "$(uname -s)" = Linux ] || { echo "FAIL: 只能在 Linux/UOS 上制作 Linux Git 工具链。" >&2; exit 3; }
[ "$(uname -m)" = x86_64 ] || { echo "FAIL: 当前阶段只接受 x86_64。" >&2; exit 3; }
GIT_SOURCE=$(command -v git || true)
[ -n "$GIT_SOURCE" ] && [ -f "$GIT_SOURCE" ] || { echo "FAIL: 构建机没有可读取的 Git。" >&2; exit 4; }
command -v ldd >/dev/null 2>&1 || { echo "FAIL: 缺少 ldd，无法审计动态依赖。" >&2; exit 4; }
command -v sha256sum >/dev/null 2>&1 || { echo "FAIL: 缺少 sha256sum。" >&2; exit 4; }

if [ "$MODE" = output ]; then
  case $OUTPUT_ROOT in
    ""|/|/usr|/etc|/var|/home) echo "FAIL: 输出目录不安全。" >&2; exit 5 ;;
  esac
  if [ -e "$OUTPUT_ROOT" ]; then
    echo "FAIL: --output 必须指向不存在的全新目录：$OUTPUT_ROOT" >&2
    exit 5
  fi
else
  [ -f "$PROJECT_ROOT/package.json" ] || { echo "FAIL: 项目根目录校验失败。" >&2; exit 5; }
  [ -f "$PROJECT_TOOLCHAIN/metadata.json" ] || { echo "FAIL: 项目工具链占位目录校验失败。" >&2; exit 5; }
fi

STAGE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-git-toolchain.XXXXXX")
SMOKE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-git-smoke.XXXXXX")
cleanup() {
  rm -rf "$STAGE_ROOT" "$SMOKE_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$STAGE_ROOT/bin" "$STAGE_ROOT/lib" "$STAGE_ROOT/libexec/git-core" "$STAGE_ROOT/share/git-core/templates"
cp -L "$GIT_SOURCE" "$STAGE_ROOT/bin/git"
chmod 0755 "$STAGE_ROOT/bin/git"

TEMPLATE_SOURCE=""
for candidate in /usr/share/git-core/templates "$(dirname "$(git --exec-path)")/share/git-core/templates"; do
  if [ -d "$candidate" ]; then TEMPLATE_SOURCE=$candidate; break; fi
done
[ -n "$TEMPLATE_SOURCE" ] || { echo "FAIL: 找不到 Git templates。" >&2; exit 6; }
cp -a "$TEMPLATE_SOURCE/." "$STAGE_ROOT/share/git-core/templates/"

LICENSE_SOURCE=""
for candidate in /usr/share/doc/git/copyright /usr/share/licenses/git/COPYING /usr/share/licenses/git/LICENSE; do
  if [ -f "$candidate" ]; then LICENSE_SOURCE=$candidate; break; fi
done
[ -n "$LICENSE_SOURCE" ] || { echo "FAIL: 找不到可归档的 Git 许可证/版权文件。" >&2; exit 6; }
cp -L "$LICENSE_SOURCE" "$STAGE_ROOT/LICENSE.txt"

SYSTEM_LIBRARIES=""
LDD_REPORT="$SMOKE_ROOT/ldd.txt"
ldd "$GIT_SOURCE" > "$LDD_REPORT"
while IFS= read -r line; do
  set -- $line
  LIB_PATH=""
  if [ "${2:-}" = "=>" ] && [ -f "${3:-}" ]; then
    LIB_PATH=$3
  elif [ -f "${1:-}" ]; then
    LIB_PATH=$1
  fi
  [ -n "$LIB_PATH" ] || continue
  LIB_NAME=$(basename "$LIB_PATH")
  case $LIB_NAME in
    libc.so.*|ld-linux*.so.*)
      SYSTEM_LIBRARIES="$SYSTEM_LIBRARIES $LIB_NAME"
      ;;
    *)
      cp -L "$LIB_PATH" "$STAGE_ROOT/lib/$LIB_NAME"
      ;;
  esac
done < "$LDD_REPORT"

OS_PRETTY=unknown
OS_ID=unknown
OS_VERSION=unknown
if [ -r /etc/os-release ]; then
  . /etc/os-release
  OS_PRETTY=${PRETTY_NAME:-unknown}
  OS_ID=${ID:-unknown}
  OS_VERSION=${VERSION_ID:-unknown}
fi
GLIBC=$(ldd --version 2>&1 | sed -n '1p')
GIT_VERSION=$("$STAGE_ROOT/bin/git" --version | sed 's/^git version //')
GIT_SHA256=$(sha256sum "$STAGE_ROOT/bin/git" | awk '{print $1}')
VERIFIED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

if command -v dpkg-query >/dev/null 2>&1; then
  PACKAGE_RECORD=$(dpkg-query -W -f='git ${Version} ${Architecture}' git 2>/dev/null || printf 'git unknown')
elif command -v rpm >/dev/null 2>&1; then
  PACKAGE_RECORD=$(rpm -q --qf 'git %{VERSION}-%{RELEASE} %{ARCH}' git 2>/dev/null || printf 'git unknown')
else
  PACKAGE_RECORD="git unknown-package-manager"
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g'
}

array_from_words() {
  FIRST=true
  for item in $1; do
    if [ "$FIRST" = true ]; then FIRST=false; else printf ', '; fi
    printf '"%s"' "$(json_escape "$item")"
  done
}

BUNDLED_LIBRARIES=""
for library in "$STAGE_ROOT"/lib/*; do
  [ -f "$library" ] || continue
  BUNDLED_LIBRARIES="$BUNDLED_LIBRARIES $(basename "$library")"
done

cat > "$STAGE_ROOT/metadata.json" <<EOF
{
  "name": "Git",
  "target": "linux-x64",
  "status": "ready",
  "version": "$(json_escape "$GIT_VERSION")",
  "source": "system-package:$(json_escape "$PACKAGE_RECORD")",
  "gitSha256": "$GIT_SHA256",
  "licenseFile": "LICENSE.txt",
  "requiredFiles": [
    "bin/git",
    "libexec/git-core",
    "share/git-core/templates",
    "LICENSE.txt"
  ],
  "linkage": "glibc-system-loader+bundled-non-glibc-libraries",
  "bundledLibraries": [$(array_from_words "$BUNDLED_LIBRARIES")],
  "systemLibraries": [$(array_from_words "$SYSTEM_LIBRARIES")],
  "packageRecord": "$(json_escape "$PACKAGE_RECORD")",
  "verifiedAt": "$VERIFIED_AT",
  "certifiedSystem": "$(json_escape "$OS_PRETTY ($OS_ID $OS_VERSION; $GLIBC)")"
}
EOF

mkdir -p "$SMOKE_ROOT/home" "$SMOKE_ROOT/tmp" "$SMOKE_ROOT/repo"
run_git() {
  env -i \
    PATH="$STAGE_ROOT/bin:$STAGE_ROOT/libexec/git-core" \
    HOME="$SMOKE_ROOT/home" \
    XDG_CONFIG_HOME="$SMOKE_ROOT/home/.config" \
    TMPDIR="$SMOKE_ROOT/tmp" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    GIT_EXEC_PATH="$STAGE_ROOT/libexec/git-core" \
    GIT_TEMPLATE_DIR="$STAGE_ROOT/share/git-core/templates" \
    LD_LIBRARY_PATH="$STAGE_ROOT/lib" \
    LC_ALL=C \
    "$STAGE_ROOT/bin/git" -c core.hooksPath=/dev/null -c protocol.allow=never "$@"
}

run_git --version >/dev/null
cd "$SMOKE_ROOT/repo"
run_git init --initial-branch=main . >/dev/null
printf 'zhibian linux git smoke\n' > room.txt
run_git add --all -- .
run_git -c user.name='千万间 Roomillion' -c user.email=workbench@local.invalid commit --no-gpg-sign -m initial >/dev/null
COMMIT_ID=$(run_git rev-parse HEAD)
printf 'changed\n' > room.txt
run_git restore --source="$COMMIT_ID" --worktree -- room.txt
grep -q 'zhibian linux git smoke' room.txt || { echo "FAIL: 内置 Git 恢复冒烟失败。" >&2; exit 7; }

if [ "$MODE" = replace ]; then
  rm -rf \
    "$PROJECT_TOOLCHAIN/bin" \
    "$PROJECT_TOOLCHAIN/lib" \
    "$PROJECT_TOOLCHAIN/lib64" \
    "$PROJECT_TOOLCHAIN/libexec" \
    "$PROJECT_TOOLCHAIN/share" \
    "$PROJECT_TOOLCHAIN/LICENSE.txt" \
    "$PROJECT_TOOLCHAIN/metadata.json"
  cp -a "$STAGE_ROOT/." "$PROJECT_TOOLCHAIN/"
  FINAL_ROOT=$PROJECT_TOOLCHAIN
else
  mkdir -p "$(dirname "$OUTPUT_ROOT")"
  mv "$STAGE_ROOT" "$OUTPUT_ROOT"
  STAGE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-git-finished.XXXXXX")
  FINAL_ROOT=$OUTPUT_ROOT
fi

printf 'PASS: Linux Git 工具链已制作并通过空环境本地历史冒烟。\n'
printf '输出目录：%s\n' "$FINAL_ROOT"
printf 'Git：%s\n' "$GIT_VERSION"
printf 'SHA-256：%s\n' "$GIT_SHA256"
printf '注意：只代表 %s 的构建基线，仍需在指定 UOS 实机认证。\n' "$OS_PRETTY"
