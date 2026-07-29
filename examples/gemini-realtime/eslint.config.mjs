import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ["dist/**"],
    },
    {
        languageOptions: {
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Off: eslint indent fights editor/TS formatting (esp. switch/case). Use editor tabSize=4.
            "indent": "off",
            "@typescript-eslint/consistent-type-imports": ["error", {
                prefer: "type-imports",
                fixStyle: "separate-type-imports",
            }],
        },
    }
);
