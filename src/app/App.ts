/**
 * src/app/App.ts — @/app/App barrel
 *
 * App.tsx kök dizinde (proje root) tanımlı.
 * tsconfig paths: "@/*" → "./src/*" olduğundan
 * @/app/App → src/app/App.ts buraya gelir.
 *
 * Bu dosya root App.tsx'teki public API'yi re-export eder.
 */
export { useAppContext } from "../../App";
export type { default as AppComponent } from "../../App";
