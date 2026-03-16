// .detoxrc.js
// § 27 — maxWorkers:1 (simülatör paralel çalışmayı desteklemez)
//
// Çözülen sorunlar:
//   - Detox config dosya adı .detoxrc-1.js → standart .detoxrc.js
//   - Emulator modeli hardcoded → env değişkeni ile override edilebilir
//   - waitFor timeout sabit → DETOX_TIMEOUT env ile CI'da ayarlanabilir

/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';

const SIMULATOR_MODEL   = process.env.DETOX_IOS_SIMULATOR  || 'iPhone 15 Pro';
const ANDROID_AVD       = process.env.DETOX_ANDROID_AVD    || 'Pixel_7_API_34';
const SETUP_TIMEOUT     = Number(process.env.DETOX_SETUP_TIMEOUT) || 120_000;

/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      $0: 'jest',
      config: 'e2e/jest.config.js',
    },
    jest: {
      setupTimeout: SETUP_TIMEOUT,
    },
  },

  apps: {
    'ios.debug': {
      type: 'ios.app',
      binaryPath:
        'ios/build/Build/Products/Debug-iphonesimulator/MobileAIIDE.app',
      build:
        'xcodebuild' +
        ' -workspace ios/MobileAIIDE.xcworkspace' +
        ' -scheme MobileAIIDE' +
        ' -configuration Debug' +
        ' -sdk iphonesimulator' +
        ' -derivedDataPath ios/build',
    },
    'ios.release': {
      type: 'ios.app',
      binaryPath:
        'ios/build/Build/Products/Release-iphonesimulator/MobileAIIDE.app',
      build:
        'xcodebuild' +
        ' -workspace ios/MobileAIIDE.xcworkspace' +
        ' -scheme MobileAIIDE' +
        ' -configuration Release' +
        ' -sdk iphonesimulator' +
        ' -derivedDataPath ios/build',
    },
    'android.debug': {
      type: 'android.apk',
      binaryPath:
        'android/app/build/outputs/apk/debug/app-debug.apk',
      build:
        'cd android && ./gradlew assembleDebug assembleAndroidTest' +
        ' -DtestBuildType=debug',
      reversePorts: [8081],
    },
    'android.release': {
      type: 'android.apk',
      binaryPath:
        'android/app/build/outputs/apk/release/app-release.apk',
      build:
        'cd android && ./gradlew assembleRelease assembleAndroidTest' +
        ' -DtestBuildType=release',
    },
  },

  devices: {
    simulator: {
      type: 'ios.simulator',
      device: { type: SIMULATOR_MODEL },
    },
    emulator: {
      type: 'android.emulator',
      device: { avdName: ANDROID_AVD },
      gpuMode: 'off',
    },
  },

  configurations: {
    'ios.sim.debug': {
      device: 'simulator',
      app:    'ios.debug',
    },
    'ios.sim.release': {
      device: 'simulator',
      app:    'ios.release',
    },
    'android.emu.debug': {
      device: 'emulator',
      app:    'android.debug',
    },
    'android.emu.release': {
      device: 'emulator',
      app:    'android.release',
    },
  },
};
