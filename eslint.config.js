const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: ['node_modules/**', 'coverage/**', '_animation_debug_bundle/**'],
  },
  ...expoConfig,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
