const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'build/**', 'dist/**', 'desktop/**', 'server/public/vendor/**'] },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
  { files: ['server/public/assets/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser } } },
];
