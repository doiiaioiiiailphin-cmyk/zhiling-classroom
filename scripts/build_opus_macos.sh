#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-}"
if [[ "$(uname -s)" != "Darwin" || ( "$ARCH" != "arm64" && "$ARCH" != "x86_64" ) ]]; then
  echo "请在 macOS 上指定 arm64 或 x86_64 构建 Opus。" >&2
  exit 1
fi

VERSION="1.6.1"
SOURCE_URL="https://downloads.xiph.org/releases/opus/opus-${VERSION}.tar.gz"
SOURCE_SHA256="6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"
BUILD_ROOT="$ROOT/build/opus-macos"
OUTPUT="$BUILD_ROOT/$ARCH"
ARCHIVE="$BUILD_ROOT/opus-${VERSION}.tar.gz"
mkdir -p "$BUILD_ROOT"
WORK="$(mktemp -d "$BUILD_ROOT/work.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

verify_archive() {
  printf '%s  %s\n' "$SOURCE_SHA256" "$1" | shasum -a 256 -c - >/dev/null
}
if [[ ! -f "$ARCHIVE" ]] || ! verify_archive "$ARCHIVE"; then
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 "$SOURCE_URL" -o "$WORK/source.tar.gz"
  verify_archive "$WORK/source.tar.gz"
  mv -f "$WORK/source.tar.gz" "$ARCHIVE"
fi

tar -xzf "$ARCHIVE" -C "$WORK"
cd "$WORK/opus-${VERSION}"
SDK_PATH="$(xcrun --show-sdk-path)"
export SDKROOT="$SDK_PATH"
export MACOSX_DEPLOYMENT_TARGET=13.0
CC="$(xcrun --find clang)" \
  CFLAGS="-O2 -arch $ARCH -isysroot $SDK_PATH" \
  LDFLAGS="-arch $ARCH -isysroot $SDK_PATH" \
  ./configure \
  --prefix="$WORK/install" --disable-doc --disable-extra-programs --disable-static --enable-shared
make -j"$(sysctl -n hw.logicalcpu)"
make install

cp -L "$WORK/install/lib/libopus.dylib" "$WORK/libopus.dylib"
install_name_tool -id @rpath/libopus.dylib "$WORK/libopus.dylib"
lipo "$WORK/libopus.dylib" -verify_arch "$ARCH"
codesign --force --sign - "$WORK/libopus.dylib"
mkdir -p "$OUTPUT"
mv -f "$WORK/libopus.dylib" "$OUTPUT/libopus.dylib"
cp COPYING "$OUTPUT/COPYING"
printf 'Opus %s (%s, macOS 13.0+)\nSource %s\nSHA-256 %s\n' \
  "$VERSION" "$ARCH" "$SOURCE_URL" "$SOURCE_SHA256" > "$OUTPUT/ORIGIN.txt"
echo "Opus 已构建至 $OUTPUT"
