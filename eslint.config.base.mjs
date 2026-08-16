import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Leftover Stryker sandbox copies otherwise crash eslint on the copied config.
  { ignores: ['**/.stryker-tmp/'] },
  tseslint.configs.recommended,
  {
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
);
