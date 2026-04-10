# GitHub Codespaces → EAS Dev Build Kurulum Rehberi

## 1. Codespaces Başlatma

Repo'yu GitHub'a push ettikten sonra:
```
Code → Codespaces → Create codespace on main
```

## 2. İlk Kurulum (otomatik — .devcontainer.json)

Codespace açıldığında `postCreateCommand` otomatik çalışır:
```bash
npm install
npm install -g eas-cli expo-cli
```

## 3. EAS Giriş

```bash
eas login
# Expo hesabın ile giriş yap
```

## 4. Development Build Tetikleme

### A) GitHub Actions ile (önerilen):
```
Actions → EAS Dev Build → Run workflow → android
```

### B) Codespaces terminalinden:
```bash
eas build --profile development --platform android
```

## 5. Dev Client Yükleme

EAS build tamamlandıktan sonra:
- EAS dashboard'dan APK'yı indir
- Fiziksel Android cihaza yükle

## 6. Metro Dev Server Başlatma

Codespaces'te:
```bash
npx expo start --dev-client
```

Port 8081 otomatik forwarded → cihazdan bağlan.

## Önemli: Secrets

GitHub repo → Settings → Secrets → Actions:
- `EXPO_TOKEN` → expo.dev → Account Settings → Access Tokens

## libtermexec Nitrogen Yeniden Üretme

Nitro spec değişirse:
```bash
cd libtermexec
npx nitro-codegen
```
Üretilen `nitrogen/generated/` dosyalarını commit et.
