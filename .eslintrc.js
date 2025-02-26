// @flow
module.exports = {
  env: {
    browser: true,
    es6: true,
    es2020: true,
    node: true,
  },
  parser: '@babel/eslint-parser',
  plugins: ['@babel', 'react', 'flowtype', 'import', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:flowtype/recommended',
    // This works with the prettier plugin, this needs to be at the end always.
    // Replace it with the "prettier" config if we remove the plugin.
    'plugin:prettier/recommended',
  ],
  parserOptions: {
    ecmaVersion: '2017',
    ecmaFeatures: {
      experimentalObjectRestSpread: true,
      jsx: true,
    },
    sourceType: 'module',
  },
  rules: {
    // Plugin rules:
    'import/no-duplicates': 'error',
    'import/no-unresolved': 'error',
    'import/named': 'error',
    'react/button-has-type': 'error',
    'react/no-access-state-in-setstate': 'error',
    'react/no-danger': 'error',
    'react/no-did-mount-set-state': 'error',
    'react/no-did-update-set-state': 'error',
    'react/no-will-update-set-state': 'error',
    'react/no-redundant-should-component-update': 'error',
    'react/no-this-in-sfc': 'error',
    'react/no-typos': 'error',
    // Flow provides enough coverage over the prop types, and there can be errors
    // with some of the more complicated Flow types.
    'react/prop-types': 'off',
    'react/jsx-curly-brace-presence': [
      'error',
      { props: 'never', children: 'never' },
    ],
    // `no-unused-prop-types` is buggy when we use destructuring parameters in
    // functions as it misunderstands them as functional components.
    // See https://github.com/yannickcr/eslint-plugin-react/issues/1561
    // 'react/no-unused-prop-types': 'error',
    'react/no-unused-state': 'error',
    'react/jsx-no-bind': 'error',
    'flowtype/require-valid-file-annotation': [
      'error',
      'always',
      { annotationStyle: 'line' },
    ],
    // no-dupe-keys crashes with recent eslint. See
    // https://github.com/gajus/eslint-plugin-flowtype/pull/266 and
    // https://github.com/gajus/eslint-plugin-flowtype/pull/302
    // 'flowtype/no-dupe-keys': 'error',

    // overriding recommended rules
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // possible errors
    'array-callback-return': 'error',
    'consistent-return': 'error',
    curly: 'error',
    'default-case': 'error',
    'dot-notation': 'error',
    eqeqeq: 'error',
    'for-direction': 'error',
    'no-alert': 'error',
    'no-caller': 'error',
    'no-eval': 'error',
    'no-extend-native': 'error',
    'no-extra-bind': 'error',
    'no-extra-label': 'error',
    'no-implied-eval': 'error',
    // We use the version from the babel plugin so that `this` in a function
    // class property doesn't give a false positive.
    '@babel/no-invalid-this': 'error',
    'no-return-await': 'error',
    'no-self-compare': 'error',
    'no-throw-literal': 'error',
    'no-unmodified-loop-condition': 'error',
    // We use the version from the flowtype plugin so that flow assertions don't
    // output an error.
    'flowtype/no-unused-expressions': 'error',
    // The Object type and Function type aren't particularly useful, and usually hide
    // type errors. It also blocks a migration to TypeScript. Disable this rule if
    // using the Object or Function as generic type bounds.
    'flowtype/no-weak-types': [
      'error',
      {
        any: false,
        Object: true,
        Function: true,
      },
    ],
    'flowtype/no-existential-type': 'error',
    'no-useless-call': 'error',
    'no-useless-computed-key': 'error',
    'no-useless-concat': 'error',
    'no-useless-constructor': 'error',
    'no-useless-rename': 'error',
    'no-useless-return': 'error',
    'no-var': 'error',
    'no-void': 'error',
    'no-with': 'error',
    'prefer-const': 'error',
    'prefer-promise-reject-errors': 'error',
    'prefer-rest-params': 'error',
    'prefer-spread': 'error',
    'no-else-return': 'error',
    'no-nested-ternary': 'error',
  },
  // This property is specified both here in addition to the command line in
  // package.json.
  // The reason is that the property only warns but the command line option
  // outputs errors, but the property is useful so that we have the information
  // directly in editors.
  reportUnusedDisableDirectives: true,
  settings: {
    react: {
      pragma: 'React',
      version: '15.0',
      flowVersion: '0.63.1',
    },
    'import/resolver': {
      alias: {
        map: [
          ['firefox-profiler', './src'],
          ['firefox-profiler-res', './res'],
        ],
        extensions: ['.js', '.jpg'],
      },
    },
  },
  globals: {
    AVAILABLE_STAGING_LOCALES: true,
  },
};
