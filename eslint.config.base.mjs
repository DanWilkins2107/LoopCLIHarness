import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Stryker sandbox copies: not source, and their copied config cannot resolve
  // this file from inside the sandbox.
  { ignores: ['**/.stryker-tmp/'] },
  tseslint.configs.recommended,
  {
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
);
