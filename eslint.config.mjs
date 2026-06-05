import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const browserGlobals = {
  ...globals.browser,
};

const nodeGlobals = {
  ...globals.node,
  ...globals.browser,
  AbortController: "readonly",
  Blob: "readonly",
  DOMException: "readonly",
  fetch: "readonly",
};

const sharedMaintainabilityRules = {
  complexity: ["warn", { max: 24 }],
  "max-depth": ["warn", 5],
  "max-lines-per-function": [
    "warn",
    {
      max: 180,
      skipBlankLines: true,
      skipComments: true,
      IIFEs: true,
    },
  ],
  "no-console": "off",
  "no-duplicate-imports": "error",
  "no-redeclare": "off",
  "no-useless-assignment": "warn",
  "no-unused-vars": [
    "warn",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
  "preserve-caught-error": "warn",
};

export default [
  {
    ignores: [
      ".claude/**",
      "dist-next/**",
      "node_modules/**",
      "output/**",
      "playwright-report/**",
      "test-results/**",
      "next/public/geo/**",
      "scripts/geo-source/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["next/src/**/*.{ts,tsx}", "vite.config.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: browserGlobals,
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: "module",
    },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...sharedMaintainabilityRules,
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["*.js", "playwright*.config.js", "scripts/**/*.js", "tests-node/**/*.js", "tests-react/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "commonjs",
    },
    rules: {
      ...sharedMaintainabilityRules,
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
