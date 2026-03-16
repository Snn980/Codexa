# Platform Uyumluluk Matrisi — Mobile AI IDE

**Son güncelleme:** Mart 2026  
**Stack:** Expo SDK 52 / React Native 0.74 / Hermes  
**Kural referansı:** Decisions.md § 78

---

## Android Sürüm Dağılımı (Mart 2026)

| Sürüm | API | Pazar Payı | Destek | Notlar |
|---|---|---|---|---|
| Android 16 | 36 | %7.5 | ✅ | targetSdk = 36; edge-to-edge zorunlu, opt-out YOK |
| Android 15 | 35 | %20.7 | ✅ | En yaygın sürüm; edge-to-edge enforce (opt-out vardı) |
| Android 14 | 34 | %12 | ✅ | READ_MEDIA_VISUAL_USER_SELECTED → LIMITED status |
| Android 13 | 33 | %14 | ✅ | POST_NOTIFICATIONS runtime izni zorunlu |
| Android 12 | 31/32 | %12 | ✅ | minSdkVersion = 24 ile desteklenir |
| Android 11 | 30 | %13.7 | ✅ | ⚠️ BackgroundFetch güvenilir değil; foreground indirme önerilir |
| Android 10 | 29 | %7.8 | ✅ | minSdk 24 kapsar, checkMultiple normal çalışır |
| Android 7–9 | 24–28 | %12 | ✅ | minSdkVersion = 24 alt sınır |
| Android 6 ve altı | ≤23 | — | ❌ | RN 0.74 minSdk 23 gerektirir; Expo SDK 52 minSdk 24 önerir |

**Kaynak:** Google Android Distribution Dashboard (Aralık 2025), AppBrain Mart 2026, TelemetryDeck Şubat 2026

### minSdkVersion Kararı: 24 (Android 7)

Android 11'i (API 30) düşürmek %13.7 kullanıcıyı kaybettirir; developer-tool hedef
kitlesinde bu oran daha düşük olabilir. Şu anki **minSdkVersion = 24** kararı korunur.

Android 11 desteğini düşürmek istenirse: `app.json`'da `minSdkVersion: 31` yapın ve
`PermissionGate.ts`'deki `< 33` guard'larını kaldırın. Bu değişiklik pazar payını
yaklaşık **%35 daha fazla** Android sürümünü gerektirir ama bazı eski API özel
durumlarını temizler.

---

## iOS Sürüm Dağılımı (Mart 2026)

| Sürüm | Pazar Payı | Destek | Notlar |
|---|---|---|---|
| iOS 26 (= iOS 19) | %76 | ✅ | Apple, iOS 19'u Eylül 2025'te iOS 26 olarak yeniden adlandırdı |
| iOS 18 | %19 | ✅ | deploymentTarget 15.1 kapsar |
| iOS 17 | %3 | ✅ | deploymentTarget 15.1 kapsar |
| iOS 16 | %2 | ✅ | deploymentTarget 15.1 kapsar |
| iOS 15 | %1 | ✅ | **deploymentTarget minimum sınırı = 15.1** |
| iOS 14 ve altı | — | ❌ | DROPPED — Expo SDK 52 minimum |

**Kaynak:** TelemetryDeck Şubat 2026, iosref.com Mart 2026

### iOS 26 Önemli Notlar

- iOS 26, yalnızca bir isimlendirme değişikliği değildir — Liquid Glass adında yeni
  bir UI dil sistemi getirir. Mevcut RN uygulamaları değişiklik yapmadan çalışır.
- BGProcessingTask, BGTaskScheduler API'si değişmedi — `iOSBGProcessingTask.ts` korunur.
- `deploymentTarget: "15.1"` iPhone 8 (A11 Bionic) ve üzerini destekler.

---

## Build Yapılandırması (app.json)

```json
"expo-build-properties": {
  "android": {
    "compileSdkVersion": 36,
    "targetSdkVersion":  36,
    "minSdkVersion":     24,
    "edgeToEdgeEnabled": true
  },
  "ios": {
    "deploymentTarget": "15.1"
  }
}
```

---

## Edge-to-Edge (Android 15/16) — Kritik

### Sorun

| Android | targetSdk | Edge-to-Edge | Opt-Out |
|---|---|---|---|
| 14 ve altı | herhangi | Yok | — |
| 15 | 35 | Zorunlu | `windowOptOutEdgeToEdgeEnforcement=true` |
| 16 | 36 | Zorunlu | **YOK** — opt-out devre dışı |

Android 16 ile `StatusBar.setBackgroundColor()` ve `translucent` prop artık hiçbir
etkisi yoktur. Sistem statusbar her zaman saydam olur.

### Projedeki Durum: ✅ HAZIR

Tüm ekranlar `useSafeAreaInsets()` kullanmaktadır (react-native-safe-area-context).
`SafeAreaProvider` `AppNavigator.tsx`'te kök seviyede uygulanmıştır.

```
AppNavigator
└── SafeAreaProvider          ← ✅ kök
    └── NavigationContainer
        └── TabNavigator
            ├── TerminalScreen   → useSafeAreaInsets() ✅
            ├── EditorScreen     → useSafeAreaInsets() ✅
            ├── ModelsScreen     → useSafeAreaInsets() ✅
            ├── SettingsScreen   → useSafeAreaInsets() ✅
            └── AIChatScreenV2   → useSafeAreaInsets() ✅
```

`react-native`'in built-in `<SafeAreaView>` bileşeni RN 0.81 ile deprecated
olmuştur. Projede **kullanılmamaktadır** — `useSafeAreaInsets` tercih edilmiştir.

### Predictive Back Gesture (Android 16)

Android 16 ile `onBackPressed()` çağrılmaz; `BackHandler` API çalışmaya devam eder.

```typescript
// ✅ Doğru — BackHandler çalışmaya devam eder
BackHandler.addEventListener('hardwareBackPress', handler);

// ❌ Yanlış — Android 16'da çalışmaz
// Activity.onBackPressed() override (native kod)
```

---

## Background Task

### Mevcut Durum (Expo SDK 52)

| Platform | Çözüm | Güvenilirlik |
|---|---|---|
| iOS 16+ | BGProcessingTask (`iOSBGProcessingTask.ts`) | ✅ Yüksek |
| Android 12+ | expo-background-fetch (JobScheduler) | 🟡 Orta (şarjda güvenilir) |
| Android 11 | expo-background-fetch | 🔴 Düşük (OS agresif kısıtlar) |

### SDK 53 Geçiş Planı (expo-background-task)

`BackgroundModelDownload.ts`'te migration path hazır. Geçiş için:

```typescript
// SDK 52 (aktif):
import * as BackgroundFetch from 'expo-background-fetch';

// SDK 53+ (geçiş):
// import * as BackgroundTask from 'expo-background-task';
// const BackgroundFetch = BackgroundTask; // API uyumlu
```

`expo-background-task` Android'de WorkManager kullanır.
Android 15/16'da BackgroundFetch'den çok daha güvenilir çalışır.

---

## İzin Matrisi (PermissionGate.ts § 78)

| İzin | Android ≤ 32 | Android 33+ | iOS 16+ |
|---|---|---|---|
| camera | CAMERA | CAMERA | CAMERA |
| microphone | RECORD_AUDIO | RECORD_AUDIO | MICROPHONE |
| storage | READ_EXTERNAL_STORAGE | READ_MEDIA_IMAGES | PHOTO_LIBRARY |
| photoLibrary | READ_EXTERNAL_STORAGE | READ_MEDIA_IMAGES | PHOTO_LIBRARY_ADD_ONLY |
| notifications | *(auto granted)* | POST_NOTIFICATIONS | NOTIFICATIONS |

**Android 14+ (API 34+) kısmi fotoğraf erişimi:**
Kullanıcı "Belirli öğeler"i seçerse `LIMITED` döner. `isPermissionGrantedOrLimited()`
fonksiyonu `granted` ve `limited`'ı eşdeğer kabul eder. Tam kütüphane erişimi için
`openAppSettings()` ile kullanıcı yönlendirilir.

---

## Crypto / WASM Uyumu

| API | Android 11+ | Android 12+ | iOS 16+ |
|---|---|---|---|
| `crypto.subtle.digest` | ✅ WebCrypto | ✅ | ✅ |
| `crypto.randomUUID` | ✅ fallback | ✅ native | ✅ native |
| QuickJS WASM (128MB limit) | ✅ | ✅ | ✅ |
| `SharedArrayBuffer` | Web-only | Web-only | Web-only |

---

## Test Edilmesi Gereken Cihaz Kombinasyonları

| Öncelik | Cihaz | OS | Senaryo |
|---|---|---|---|
| 🔴 P1 | Samsung Galaxy A55 | Android 15 | Edge-to-edge, POST_NOTIFICATIONS |
| 🔴 P1 | Google Pixel 9 | Android 16 | Edge-to-edge zorunlu, predictive back |
| 🔴 P1 | iPhone 16 | iOS 26 | BGProcessingTask, Liquid Glass UI |
| 🟡 P2 | Samsung Galaxy A35 | Android 14 | Kısmi fotoğraf erişimi (LIMITED) |
| 🟡 P2 | iPhone 13 | iOS 18 | BGProcessingTask, normal UI |
| 🟢 P3 | Samsung Galaxy A14 | Android 11 | BackgroundFetch kısıtları |
| 🟢 P3 | iPhone SE (3rd) | iOS 15 | deploymentTarget minimum (15.1) |

---

## Expo SDK Yol Haritası

| SDK | RN | Android target | iOS minimum | Önemli Değişiklik |
|---|---|---|---|---|
| **52 (aktif)** | 0.74 | 35 | 15.1 | New Arch opt-in |
| 53 | 0.79 | 35 | 15.1 | New Arch default; expo-background-task; edge-to-edge opt-in |
| **54 (önerilen)** | 0.81 | **36** | 16.0 | (16.0'a yükseltilmesi önerilir) | Edge-to-edge zorunlu; iOS 26 Liquid Glass; Legacy Arch son sürüm |
| 55 | 0.82 | 36 | ≥16.0 (beklenen) | Legacy Arch kaldırılır |
