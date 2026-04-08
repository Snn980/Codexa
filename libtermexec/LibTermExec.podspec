require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "LibTermExec"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/codexa/libtermexec"
  s.license      = "MIT"
  s.authors      = { "Codexa" => "dev@codexa.app" }

  s.platforms    = { :ios => "16.0" }
  s.source       = { :git => ".", :tag => "#{s.version}" }

  # ─── Swift + C kaynak dosyaları ─────────────────────────────────────────────
  s.source_files = [
    "ios/**/*.{swift,h,c,m,mm,cpp}",
  ]

  # ─── wasm3 C bridge header — Swift'e görünür olmalı ────────────────────────
  s.public_header_files = [
    "ios/wasm3/TermExecWasm.h",
  ]

  # ─── Swift versiyonu ────────────────────────────────────────────────────────
  s.swift_version = "5.9"

  # ─── Nitrogen autolinking ───────────────────────────────────────────────────
  load "nitrogen/generated/ios/LibTermExec+autolinking.rb"
  add_nitrogen_files(s)

  # ─── Bağımlılıklar ──────────────────────────────────────────────────────────
  s.dependency "React-Core"
  s.dependency "react-native-nitro-modules"

  # wasm3 — saf C WASM interpreter, JIT yok, App Store uyumlu
  s.dependency "wasm3", "~> 0.5"

  # ─── Build ayarları ─────────────────────────────────────────────────────────
  s.pod_target_xcconfig = {
    # C++ 20 (Nitrogen requirement)
    "CLANG_CXX_LANGUAGE_STANDARD"  => "c++20",
    # Swift ↔ C++ bridge
    "SWIFT_OBJC_INTEROP_MODE"       => "objcxx",
    # Module tanımı
    "DEFINES_MODULE"                => "YES",
    # wasm3 header'ları bul
    "HEADER_SEARCH_PATHS"           => "$(PODS_ROOT)/wasm3/source",
    # wasm3 için gerekli
    "GCC_PREPROCESSOR_DEFINITIONS"  => "$(inherited) d_m3HasWASI=1",
    # Foamy flags (Nitro)
    "OTHER_CFLAGS"                  => "$(inherited) -DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1",
  }

  # ─── Bundle kaynaklar (WASM binary) ─────────────────────────────────────────
  # quickjs.wasm — iOS terminal shell
  # Bundle'a eklemek için uygulamanın Xcode projesine ayrıca eklenmesi gerekir.
  # Alternatif: s.resource_bundles ile dağıtılabilir.
  # s.resources = ["ios/resources/quickjs.wasm"]
end
