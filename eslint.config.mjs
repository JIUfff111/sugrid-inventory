import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    ".next-sku-validation/**",
    ".next-experience/**",
    ".next-qa-build/**",
    "data/manual-sku-build/**",
    "docs/sku-catalog/02-research/_gapfill-2026-11-03/**",
    ".tmp/**",
    "out/**",
    "build/**",
    "tools/server-manager-desktop/dist/**",
    "tools/server-manager-desktop/src-tauri/target/**",
    "tools/server-manager-desktop/src-tauri/resources/inventory/**",
    "next-env.d.ts",
  ]),
  {
    // The project still contains legacy route handlers and effect patterns that
    // are valid at runtime but are rejected by the newest flat-config rules.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "prefer-const": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
