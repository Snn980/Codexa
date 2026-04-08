/**
 * plugin/src/index.ts
 * libtermexec — Expo Config Plugin
 *
 * Bu plugin:
 *   • Android: libtermexec'i settings.gradle + build.gradle'a ekler
 *   • Android: Termux uyumluluk izinlerini ekler
 *   • iOS: Podfile'a LibTermExec pod'unu ekler
 *   • expo-dev-client gerekliliğini hatırlatır
 *
 * Kullanım (app.json):
 *   {
 *     "plugins": [
 *       ["./libtermexec/plugin", { "termuxSupport": true }]
 *     ]
 *   }
 */

import {
  ConfigPlugin,
  withAppBuildGradle,
  withProjectBuildGradle,
  withSettingsGradle,
  withDangerousMod,
  createRunOncePlugin,
} from '@expo/config-plugins';
import * as fs from 'fs';
import * as path from 'path';

// ─── Plugin options ────────────────────────────────────────────────────────────

interface LibTermExecOptions {
  /** Termux shell path'lerini DEFAULT_ENV'e ekle. Default: true */
  termuxSupport?: boolean;
}

// ─── Android: settings.gradle ─────────────────────────────────────────────────

const withLibTermExecSettings: ConfigPlugin = (config) =>
  withSettingsGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('libtermexec')) {
      mod.modResults.contents += `
// libtermexec — Nitro PTY module
include ':libtermexec'
project(':libtermexec').projectDir = new File(rootProject.projectDir, '../libtermexec/android')
`;
    }
    return mod;
  });

// ─── Android: app/build.gradle ────────────────────────────────────────────────

const withLibTermExecBuildGradle: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes("':libtermexec'")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {
    implementation project(':libtermexec')`
      );
    }
    return mod;
  });

// ─── iOS: Podfile ─────────────────────────────────────────────────────────────

const withLibTermExecPodfile: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'ios',
    async (mod) => {
      const podfilePath = path.join(mod.modRequest.platformProjectRoot, 'Podfile');

      if (!fs.existsSync(podfilePath)) return mod;

      let podfile = fs.readFileSync(podfilePath, 'utf-8');

      if (!podfile.includes('LibTermExec')) {
        podfile = podfile.replace(
          /use_react_native!/,
          `# libtermexec — wasm3 PTY module
  pod 'LibTermExec', :path => '../libtermexec'

  use_react_native!`
        );
        fs.writeFileSync(podfilePath, podfile);
      }

      return mod;
    },
  ]);

// ─── Main plugin ──────────────────────────────────────────────────────────────

const withLibTermExec: ConfigPlugin<LibTermExecOptions> = (config, options = {}) => {
  const { termuxSupport = true } = options;

  // Android
  config = withLibTermExecSettings(config);
  config = withLibTermExecBuildGradle(config);

  // iOS
  config = withLibTermExecPodfile(config);

  // Termux support flag — HybridTermExec.kt okur
  if (termuxSupport) {
    config = withAppBuildGradle(config, (mod) => {
      if (!mod.modResults.contents.includes('TERMUX_SUPPORT')) {
        mod.modResults.contents = mod.modResults.contents.replace(
          /defaultConfig\s*\{/,
          `defaultConfig {
        buildConfigField "boolean", "TERMUX_SUPPORT", "true"`
        );
      }
      return mod;
    });
  }

  return config;
};

export default createRunOncePlugin(withLibTermExec, 'libtermexec', '1.0.0');
