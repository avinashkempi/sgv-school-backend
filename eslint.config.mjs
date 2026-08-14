import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: [
            "node_modules/",
            "dist/",
            "data/",
            "coverage/",
            "*.log"
        ]
    },
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.es2022,
                ...globals.commonjs
            },
            ecmaVersion: 2022
        },
        rules: {
            "no-unused-vars": [
                "warn",
                {
                    "argsIgnorePattern": "^_",
                    "varsIgnorePattern": "^_",
                    "caughtErrors": "none"
                }
            ],
            "no-empty": [
                "error",
                {
                    "allowEmptyCatch": true
                }
            ],
            "no-console": "off",
            "no-undef": "error"
        }
    }
];

