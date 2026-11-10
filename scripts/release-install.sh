#!/usr/bin/env bash
# Builds signed release APKs (phone + watch) with the local release key and
# installs them over the running apps (same key: in place, settings kept).
#   scripts/release-install.sh [phone-adb-serial] [watch-adb-serial]
# The key and its password live in ~/.faceclaw-release (outside the repo).
# Run from Git Bash on Windows; the phone and watch need adb over Wi-Fi or USB.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYDIR="$(cygpath -m "$USERPROFILE" 2>/dev/null || echo "$HOME")/.faceclaw-release"
KS="$KEYDIR/faceclaw-release.jks"
PW="$(cat "$KEYDIR/keystore-password.txt")"
PHONE="${1:-192.168.1.82:5555}"
WATCH="${2:-192.168.1.83:44245}"
[ -f build_paths.sh ] && source ./build_paths.sh
# Git Bash: build_paths.sh gives Windows paths; put adb on PATH in POSIX form
if [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  PATH="$(cygpath -u "$LOCALAPPDATA")/Android/Sdk/platform-tools:$PATH"
fi
command -v adb >/dev/null || { echo "adb not found" >&2; exit 1; }

mkdir -p dist
echo "=== phone"
npx nativescript build android --release --key-store-path "$KS" --key-store-password "$PW" \
  --key-store-alias faceclaw --key-store-alias-password "$PW" --copy-to dist/Faceclaw-release.apk > build-release.log 2>&1 \
  || { tail -30 build-release.log; exit 1; }
echo "=== watch"
(cd wear && ./gradlew :app:assembleRelease -q \
  -Pandroid.injected.signing.store.file="$KS" -Pandroid.injected.signing.store.password="$PW" \
  -Pandroid.injected.signing.key.alias=faceclaw -Pandroid.injected.signing.key.password="$PW")

echo "=== install"
adb connect "$PHONE" >/dev/null 2>&1 || true
adb -s "$PHONE" install -r -g dist/Faceclaw-release.apk
adb -s "$PHONE" shell monkey -p com.faceclaw.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
if adb connect "$WATCH" >/dev/null 2>&1 && adb -s "$WATCH" get-state >/dev/null 2>&1; then
  adb -s "$WATCH" install -r -g wear/app/build/outputs/apk/release/app-release.apk
else
  echo "watch $WATCH not reachable; skipped"
fi
