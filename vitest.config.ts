import { defineConfig, Plugin } from 'vitest/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Custom plugin to load CSS as raw text (like esbuild's text loader)
const cssRawPlugin: Plugin = {
  name: 'css-raw',
  enforce: 'pre',
  transform(code: string, id: string) {
    // Handle CSS files with ?raw query parameter
    if (id.includes('.css?raw') || (id.endsWith('.css') && !code.includes('__vite__css'))) {
      const filePath = id.split('?')[0];
      try {
        const cssContent = readFileSync(filePath, 'utf-8');
        return {
          code: `export default ${JSON.stringify(cssContent)};`,
          map: null
        };
      } catch (e) {
        // File doesn't exist, return null to let Vite handle it
        return null;
      }
    }
    return null;
  }
};

export default defineConfig({
  plugins: [cssRawPlugin],

  test: {
    // Use happy-dom for fast DOM testing (faster than jsdom)
    environment: 'happy-dom',

    // Global setup
    setupFiles: ['./tests/setup.ts'],

    // Test patterns
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.snap.test.ts'
    ],

    // Exclude visual/e2e from default run
    exclude: [
      'tests/visual/**',
      'tests/e2e/**',
      'node_modules/**'
    ],

    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['media/**/*.ts'],
      exclude: [
        'media/**/*.test.ts',
        'media/**/*.d.ts'
      ]
    },

    // Snapshot settings
    snapshotFormat: {
      printBasicPrototype: false
    },

    // Globals
    globals: true
  },

  // esbuild for TypeScript
  esbuild: {
    target: 'es2020'
  },

  // Resolve aliases
  resolve: {
    alias: {
      '@': '/media',
      '@state': '/media/state',
      '@actors': '/media/actors',
      '@utils': '/media/utils'
    }
  }
});
