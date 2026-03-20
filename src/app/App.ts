/**
 * src/app/App.ts — @/app/App barrel
 *
 * App.tsx kök dizinde (proje root) tanımlı.
 * tsconfig paths: "@/*" → "./src/*" olduğundan
 * @/app/App → src/app/App.ts buraya gelir.
 *
 * Bu dosya root App.tsx'teki public API'yi re-export eder.
 *
 * REFACTOR (SORUN-11): `default as AppComponent` kaldırıldı.
 * App.tsx'deki default export `function App()` olduğu için tüketiciler
 * `import App from "@/app/App"` yerine doğrudan `import App from "../../App"`
 * veya entry point'te `registerRootComponent(App)` kullanmalıdır.
 */
export { useAppContext } from "../../App";
