import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Type-aware linting. */
export default tseslint.config(
  {
    ignores: ["out/**", "media/**", "node_modules/**"],
  },

  {
    files: ["**/*.mjs", "**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },

  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./webview/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowNullableBoolean: true },
      ],
    },
  },
);
