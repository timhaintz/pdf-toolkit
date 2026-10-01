const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    { ignores: ['out/**', 'node_modules/**'] },
    ...tsPlugin.configs['flat/recommended'].map(config => ({
        ...config,
        files: ['src/**/*.ts']
    })),
    {
        files: ['src/**/*.ts'],
        rules: {
            // VS Code interface methods receive arguments they may not need.
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
        }
    }
];
