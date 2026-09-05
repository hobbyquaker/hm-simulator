'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'coverage/**'],
    },
    js.configs.recommended,
    prettier,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        },
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            sourceType: 'module',
        },
    },
];
