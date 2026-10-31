import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    // NFR-M-01: engine tidak boleh bergantung pada VS Code
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'packages/core harus murni (NFR-M-01).' }] }]
    }
  }
);
