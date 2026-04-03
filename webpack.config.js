//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: [
    { vscode: 'commonjs vscode' },
    { '@signalapp/sqlcipher': 'commonjs @signalapp/sqlcipher' },  // Native N-API module
    // WASM tokenizer — resolve to co-located copy in dist/wasm/
    ({ request }, callback) => {
      if (request === 'deepseek-moby-wasm') {
        return callback(null, 'commonjs ./wasm/deepseek_moby_wasm.js');
      }
      callback();
    }
  ],
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        // Compressed vocabularies for WASM tokenizer (per-model)
        {
          from: 'packages/moby-wasm/assets/vocabs/',
          to: 'assets/vocabs/'
        },
        // WASM module (JS glue + binary) — vsce can't follow file: symlinks
        {
          from: 'packages/moby-wasm/pkg/deepseek_moby_wasm.js',
          to: 'wasm/deepseek_moby_wasm.js'
        },
        {
          from: 'packages/moby-wasm/pkg/deepseek_moby_wasm_bg.wasm',
          to: 'wasm/deepseek_moby_wasm_bg.wasm'
        }
      ]
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = config;
