#!/usr/bin/env bash
# =============================================================================
# build-quickjs-wasm.sh
# libtermexec — QuickJS → WASM (WASI target) Build Script
#
# Gereksinimler:
#   • wasi-sdk 21+ (https://github.com/WebAssembly/wasi-sdk/releases)
#   • curl
#   • macOS veya Linux
#
# Kullanım:
#   chmod +x build-quickjs-wasm.sh
#   ./build-quickjs-wasm.sh
#
# Çıktı:
#   build/quickjs.wasm   → Xcode projesine eklenecek binary
#
# wasi-sdk kurulum (macOS):
#   brew install wasi-sdk
#   # veya:
#   curl -LO https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-21/wasi-sdk-21.0-macos.tar.gz
#   tar xf wasi-sdk-21.0-macos.tar.gz
#   export WASI_SDK_PATH=$(pwd)/wasi-sdk-21.0
# =============================================================================

set -euo pipefail

# ─── Yapılandırma ─────────────────────────────────────────────────────────────

QUICKJS_VERSION="2024-01-13"
QUICKJS_URL="https://bellard.org/quickjs/quickjs-${QUICKJS_VERSION}.tar.xz"
QUICKJS_DIR="quickjs-${QUICKJS_VERSION}"

BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)/build"
OUT_WASM="${BUILD_DIR}/quickjs.wasm"
IOS_RESOURCES="$(cd "$(dirname "$0")/.." && pwd)/ios/resources"

# wasi-sdk konumu (WASI_SDK_PATH env var yoksa tahmin et)
if [ -z "${WASI_SDK_PATH:-}" ]; then
    if [ -d "/opt/wasi-sdk" ]; then
        WASI_SDK_PATH="/opt/wasi-sdk"
    elif [ -d "/usr/local/wasi-sdk" ]; then
        WASI_SDK_PATH="/usr/local/wasi-sdk"
    elif command -v brew &>/dev/null; then
        WASI_SDK_PATH="$(brew --prefix)/opt/wasi-sdk"
    else
        echo "❌ WASI_SDK_PATH bulunamadı."
        echo "   Kurun: https://github.com/WebAssembly/wasi-sdk/releases"
        exit 1
    fi
fi

CLANG="${WASI_SDK_PATH}/bin/clang"
SYSROOT="${WASI_SDK_PATH}/share/wasi-sysroot"

# ─── Kontroller ───────────────────────────────────────────────────────────────

echo "🔍 wasi-sdk: ${WASI_SDK_PATH}"
if [ ! -f "$CLANG" ]; then
    echo "❌ ${CLANG} bulunamadı. WASI_SDK_PATH doğru mu?"
    exit 1
fi

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

# ─── QuickJS kaynak indirme ───────────────────────────────────────────────────

if [ ! -d "${QUICKJS_DIR}" ]; then
    echo "📥 QuickJS ${QUICKJS_VERSION} indiriliyor..."
    curl -L --progress-bar "${QUICKJS_URL}" -o "quickjs.tar.xz"
    tar xf quickjs.tar.xz
    rm quickjs.tar.xz
    echo "✅ Kaynak hazır: ${QUICKJS_DIR}"
else
    echo "✅ QuickJS kaynak mevcut (${QUICKJS_DIR})"
fi

cd "${QUICKJS_DIR}"

# ─── WASI uyumluluk yaması ────────────────────────────────────────────────────
# QuickJS bazı POSIX fonksiyonlarını kullanır, WASI'de yoktur.
# Minimal stub'lar ekliyoruz.

cat > wasi_compat.c << 'WASI_COMPAT'
/* wasi_compat.c — QuickJS için WASI stub fonksiyonlar */
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* QuickJS dinamik yükleme (WASI'de yok) */
void* dlopen(const char* path, int flags) { return NULL; }
void* dlsym(void* handle, const char* symbol) { return NULL; }
int   dlclose(void* handle) { return 0; }
char* dlerror(void) { return "dlopen not supported on WASI"; }

/* QuickJS os modülü için stub'lar */
int setrlimit(int resource, const void* rlim) { return -1; }
int getrlimit(int resource, void* rlim) { return -1; }
int sigaction(int signum, const void* act, void* oldact) { return 0; }
int kill(int pid, int sig) { return -1; }
int getpid(void) { return 1; }
int fork(void) { return -1; }
int execvp(const char* file, char* const argv[]) { return -1; }
int waitpid(int pid, int* status, int options) { return -1; }
int pipe(int pipefd[2]) { return -1; }

/* Zaman fonksiyonları (wasm3'te ayrı implement edildi ama QuickJS doğrudan çağırabilir) */
int gettimeofday(void* tv, void* tz) { return 0; }
WASI_COMPAT

echo "✅ WASI uyumluluk stub'ları hazır"

# ─── Derleme ──────────────────────────────────────────────────────────────────

echo "🔨 Derleniyor → quickjs.wasm (bu birkaç dakika sürebilir)..."

SOURCES=(
    quickjs.c
    libregexp.c
    libunicode.c
    cutils.c
    quickjs-libc.c    # REPL, file I/O, timer
    qjs.c             # main() — REPL entry point
    wasi_compat.c     # WASI stub'lar
)

# Eksik dosyaları kontrol et
for src in "${SOURCES[@]}"; do
    if [[ "$src" == "wasi_compat.c" ]]; then continue; fi
    if [ ! -f "$src" ]; then
        echo "❌ Kaynak dosya bulunamadı: $src (QuickJS ${QUICKJS_VERSION} uyumsuz olabilir)"
        exit 1
    fi
done

"${CLANG}" \
    --target=wasm32-wasi \
    --sysroot="${SYSROOT}" \
    -O2 \
    -flto \
    -Wno-implicit-function-declaration \
    -Wno-int-conversion \
    -D_WASI_EMULATED_SIGNAL \
    -DCONFIG_BIGNUM=1 \
    -DCONFIG_VERSION="\"${QUICKJS_VERSION}\"" \
    -DCONFIG_CC="\"clang\"" \
    -DCONFIG_PREFIX="\"/\"" \
    -DJS_STRICT_NAN_BOXING=1 \
    -Wl,--export-dynamic \
    -Wl,--allow-undefined \
    -Wl,-z,stack-size=$((512 * 1024)) \
    -o "${OUT_WASM}" \
    "${SOURCES[@]}"

# ─── Optimizasyon (wasm-opt varsa) ───────────────────────────────────────────

if command -v wasm-opt &>/dev/null; then
    echo "✨ wasm-opt ile optimize ediliyor..."
    OPT_WASM="${OUT_WASM%.wasm}_opt.wasm"
    wasm-opt -O3 --strip-debug --strip-producers \
        "${OUT_WASM}" -o "${OPT_WASM}"
    mv "${OPT_WASM}" "${OUT_WASM}"
    echo "✅ Optimize edildi"
fi

# ─── Kopyala ──────────────────────────────────────────────────────────────────

SIZE=$(wc -c < "${OUT_WASM}" | tr -d ' ')
SIZE_KB=$((SIZE / 1024))
echo ""
echo "✅ Başarılı! quickjs.wasm → ${SIZE_KB} KB"
echo ""

mkdir -p "${IOS_RESOURCES}"
cp "${OUT_WASM}" "${IOS_RESOURCES}/quickjs.wasm"
echo "📦 Kopyalandı: ${IOS_RESOURCES}/quickjs.wasm"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Sonraki adım: Xcode'a ekle"
echo ""
echo "  1. Xcode'da proje navigator'ı aç"
echo "  2. ios/resources/quickjs.wasm dosyasını sürükle"
echo "  3. 'Copy items if needed' ✓"
echo "  4. Target → Build Phases → Copy Bundle Resources"
echo "     'quickjs.wasm' listede olmalı"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
