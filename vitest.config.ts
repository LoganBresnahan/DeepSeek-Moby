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
    // Measures both extension-side (`src/`) and webview (`media/`)
    // since each has unit tests under `tests/unit/`. CLI variant: `npm run
    // test:unit:coverage`. Reports go to `coverage/` (lcov for CI, html for
    // local browsing, text for quick stdout review).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'media/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Type-only / static / barrel files where coverage is meaningless.
        'src/types.ts',
        'src/extension-api.ts',
        'src/events/EventTypes.ts',
        'src/clients/searxngTemplates.ts',
        'src/clients/webSearchProvider.ts',
        'src/**/types.ts',
        'src/tracing/index.ts',
        'src/events/index.ts',
        'media/**/shadowStyles.ts',
        'media/**/styles.ts',
        'media/**/styles/index.ts'
      ]
    },

    // The suite has ~2000 tests across ~60 files. The pre-existing OOM
    // (CLAUDE.md) traced back to `vi.resetModules()` being called in a
    // global per-test `beforeEach` hook, which churned ~2000 module
    // graphs through v8 and left uncollected contexts behind. With that
    // hook removed (see tests/setup.ts), the default heap is sufficient
    // again. Knobs we keep:
    //   - `pool: 'forks'` (process-isolated) over 'threads' so v8 fully
    //     releases memory between files.
    //   - `isolate: true` re-inits the module graph per file so module
    //     singletons (Logger, TraceCollector, etc.) don't accumulate.
    pool: 'forks',
    isolate: true,

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
      '@utils': '/media/utils',
      // Mock VS Code API for extension-side tests
      'vscode': resolve(__dirname, 'tests/__mocks__/vscode.ts')
    }
  }
});
