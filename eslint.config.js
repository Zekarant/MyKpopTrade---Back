const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = defineConfig(
  {
    name: 'app/files-to-ignore',
    // Fichiers produits (build, couverture) ou déposés par l'application.
    ignores: ['dist/**', 'coverage/**', 'logs/**', 'uploads/**', 'secure_storage/**']
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    name: 'app/node',
    languageOptions: { globals: globals.node },
    rules: {
      // Un `_` marque un paramètre imposé par une signature (middleware Express, interface).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      // `declare global { namespace Express }` est la seule façon d'augmenter les types d'Express.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }]
    }
  },

  {
    name: 'app/tests',
    files: ['**/__tests__/**', 'src/tests/**'],
    languageOptions: { globals: globals.jest }
  },

  {
    name: 'app/commonjs-config',
    // Fichiers de configuration en CommonJS (package « type: commonjs »).
    files: ['*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
