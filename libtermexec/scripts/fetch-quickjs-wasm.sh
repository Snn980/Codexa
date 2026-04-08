#!/usr/bin/env bash
# =============================================================================
# fetch-quickjs-wasm.sh
# libtermexec — Hazır quickjs.wasm İndir
#
# wasi-sdk kurmak istemiyorsanız bu script'i kullanın.
# Bilinen WASI uyumlu QuickJS binary kaynaklarından indirir.
#
# Kullanım:
#   chmod +x fetch-quickjs-wasm.sh
#   ./fetch-quickjs-wasm.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_RESOURCES="${SCRIPT_DIR}/../ios/resources"
OUT="${IOS_RESOURCES}/quickjs.wasm"

mkdir -p "${IOS_RESOURCES}"

# ─── Kaynak 1: wasmer-pack / wapm.io quickjs ─────────────────────────────────
# QuickJS WASM → WASI target, Bellard'ın QuickJS 2021-03-27
WAPM_URL="https://registry-cdn.wapm.io/contents/saghul/quickjs/0.0.3/build/qjs.wasm"

# ─── Kaynak 2: nicowillis/quickjs-wasm GitHub ────────────────────────────────
GITHUB_URL="https://github.com/nicowillis/quickjs-wasm/releases/download/v2021.03.27/quickjs.wasm"

# ─── Kaynak 3: vmware-labs/webassembly-language-runtimes ─────────────────────
VMW_URL="https://github.com/vmware-labs/webassembly-language-runtimes/releases/latest/download/quickjs.wasm"

download_from() {
    local url="$1"
    local label="$2"
    echo "📥 Deneniyor: ${label}..."
    if curl -fsSL --progress-bar -o "${OUT}" "${url}" 2>/dev/null; then
        # Magic bytes kontrol (WASM: \0asm)
        magic=$(xxd -l 4 -p "${OUT}" 2>/dev/null || od -A n -N 4 -t x1 "${OUT}" | tr -d ' ')
        if [[ "$magic" == "0061736d" ]] || [[ "$magic" == "00 61 73 6d" ]]; then
            size=$(wc -c < "${OUT}" | tr -d ' ')
            echo "✅ İndirildi (${label}) — $((size/1024)) KB"
            return 0
        else
            echo "⚠️  WASM değil, atlanıyor..."
            rm -f "${OUT}"
        fi
    fi
    return 1
}

# Sırayla dene
if download_from "${VMW_URL}"   "vmware-labs/webassembly-language-runtimes"; then :
elif download_from "${GITHUB_URL}" "nicowillis/quickjs-wasm"; then :
elif download_from "${WAPM_URL}"   "wapm.io/quickjs"; then :
else
    echo ""
    echo "❌ Tüm kaynaklar başarısız."
    echo ""
    echo "Manuel yöntem:"
    echo "  1. Tarayıcıda şunu aç:"
    echo "     https://wapm.io/saghul/quickjs"
    echo "  2. 'Download' → qjs.wasm indir"
    echo "  3. Yeniden adlandır: quickjs.wasm"
    echo "  4. Kopyala: ${IOS_RESOURCES}/quickjs.wasm"
    echo ""
    echo "  veya wasi-sdk ile kendiniz derleyin:"
    echo "  ./build-quickjs-wasm.sh"
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ quickjs.wasm → ${OUT}"
echo ""
echo "  Sonraki adım: Xcode'a ekle"
echo "  ios/resources/quickjs.wasm → Copy Bundle Resources"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
