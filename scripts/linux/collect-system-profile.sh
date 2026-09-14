#!/bin/sh
set -eu

OUTPUT_PATH=${1:-""}

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g;s/\t/\\t/g'
}

bool_json() {
  if "$@"; then printf 'true'; else printf 'false'; fi
}

has_fuse2_library() {
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  test -e /lib/x86_64-linux-gnu/libfuse.so.2 || test -e /usr/lib/x86_64-linux-gnu/libfuse.so.2
}

OS_ID=unknown
OS_VERSION=unknown
OS_PRETTY=unknown
if [ -r /etc/os-release ]; then
  . /etc/os-release
  OS_ID=${ID:-unknown}
  OS_VERSION=${VERSION_ID:-unknown}
  OS_PRETTY=${PRETTY_NAME:-unknown}
fi

KERNEL=$(uname -sr)
ARCH=$(uname -m)
GLIBC=$(ldd --version 2>&1 | sed -n '1p')
CREATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
DESKTOP=${XDG_CURRENT_DESKTOP:-unknown}
SESSION_TYPE=${XDG_SESSION_TYPE:-unknown}
USERNS_VALUE=unknown
if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  USERNS_VALUE=$(sed -n '1p' /proc/sys/kernel/unprivileged_userns_clone)
fi

if command -v dpkg-query >/dev/null 2>&1; then
  PACKAGE_MANAGER=dpkg
elif command -v rpm >/dev/null 2>&1; then
  PACKAGE_MANAGER=rpm
else
  PACKAGE_MANAGER=unknown
fi

PROFILE_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/zhibian-profile.XXXXXX")
cleanup() {
  rm -rf "$PROFILE_TEMP"
}
trap cleanup EXIT INT TERM

touch "$PROFILE_TEMP/CaseProbe"
if [ -e "$PROFILE_TEMP/caseprobe" ]; then
  CASE_SENSITIVE=false
else
  CASE_SENSITIVE=true
fi

emit_profile() {
  cat <<EOF
{
  "kind": "zhibian-linux-system-profile",
  "formatVersion": "0.1",
  "createdAt": "$(json_escape "$CREATED_AT")",
  "os": {
    "id": "$(json_escape "$OS_ID")",
    "versionId": "$(json_escape "$OS_VERSION")",
    "prettyName": "$(json_escape "$OS_PRETTY")"
  },
  "kernel": "$(json_escape "$KERNEL")",
  "arch": "$(json_escape "$ARCH")",
  "glibc": "$(json_escape "$GLIBC")",
  "desktop": "$(json_escape "$DESKTOP")",
  "sessionType": "$(json_escape "$SESSION_TYPE")",
  "packageManager": "$(json_escape "$PACKAGE_MANAGER")",
  "capabilities": {
    "fuseDevice": $(bool_json test -e /dev/fuse),
    "fusermount": $(bool_json sh -c 'command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1'),
    "fuse2Library": $(bool_json has_fuse2_library),
    "unprivilegedUserNamespaces": "$(json_escape "$USERNS_VALUE")",
    "caseSensitiveFileSystem": $CASE_SENSITIVE,
    "runningAsRoot": $(bool_json test "$(id -u)" -eq 0)
  },
  "privacy": {
    "hostnameCollected": false,
    "usernameCollected": false,
    "networkAddressCollected": false
  }
}
EOF
}

if [ -n "$OUTPUT_PATH" ]; then
  umask 077
  emit_profile > "$OUTPUT_PATH"
  printf '系统画像已写入：%s\n' "$OUTPUT_PATH" >&2
else
  emit_profile
fi
