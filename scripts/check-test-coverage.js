#!/usr/bin/env node
/**
 * check-test-coverage.js — quick drift detector.
 *
 * Walks src/ and media/ for production .ts files, then checks whether a
 * matching test file exists under tests/. Reports any modules that have
 * NO test file at all. This catches the most basic gap — "we shipped a
 * new module and forgot to add tests" — without needing actual coverage
 * instrumentation.
 *
 * Run: `npm run test:audit`
 *
 * What this script does NOT detect:
 *   - Tests that mock so much they don't actually validate behavior.
 *   - Files with a test that only covers a tiny fraction.
 *   - Snapshot tests without intentional review.
 *
 * For real coverage numbers, run `npm run test:unit:coverage`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOTS = [
  { src: 'src', testRoot: 'tests/unit' },
  { src: 'media/actors', testRoot: 'tests/actors' },
  { src: 'media/events', testRoot: 'tests/events' },
  { src: 'media/state', testRoot: 'tests/unit/state' },
];

// Files we don't expect to have direct tests — index files, type-only
// modules, glue code where a test would be over-engineered. Add to this
// list deliberately, with a one-line reason. Don't blanket-ignore.
const IGNORE_PATHS = new Set([
  'src/extension.ts',                     // VS Code activation harness — tested via dev host
  'src/extension-api.ts',                 // public API surface, types only
  'src/types.ts',                         // type aliases
  'src/providers/types.ts',               // type aliases
  'src/events/types.ts',                  // type aliases
  'src/capabilities/types.ts',            // type aliases
  'src/utils/httpClient.ts',              // thin axios wrapper
  'src/utils/logger.ts',                  // singleton logger; tested via use sites
  'src/tracing/index.ts',                 // re-export
  'src/events/index.ts',                  // re-export
  'src/clients/searxngTemplates.ts',      // static templates
  'src/clients/webSearchProvider.ts',     // interface-only definition
  'src/events/EventTypes.ts',             // type aliases for the event log
  'src/events/SqlJsWrapper.ts',           // thin SQLCipher adapter — exercised by EventStore tests
  'media/state/ModalShadowActor.ts',      // base class — exercised by every Modal*Actor test
  'media/state/PopupShadowActor.ts',      // base class — exercised by every popup actor test
]);

// Suffix-strip rules. e.g., src/foo.ts → tests/unit/foo.test.ts
function expectedTestPath(srcRoot, testRoot, srcFile) {
  const rel = path.relative(srcRoot, srcFile);
  const withoutExt = rel.replace(/\.ts$/, '');
  return path.join(testRoot, `${withoutExt}.test.ts`);
}

// Some modules are large enough that we split their tests across multiple
// files (e.g., chatProvider.lifecycle.test.ts + chatProvider.queuing.test.ts).
// Treat any sibling file matching `<name>.<anything>.test.ts` as coverage too.
function hasSiblingTestVariant(expectedTestAbs) {
  const dir = path.dirname(expectedTestAbs);
  if (!fs.existsSync(dir)) return false;
  const baseWithExt = path.basename(expectedTestAbs);                // foo.test.ts
  const stem = baseWithExt.replace(/\.test\.ts$/, '');                // foo
  const variantPattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.[^/]+\\.test\\.ts$`);
  return fs.readdirSync(dir).some(f => variantPattern.test(f));
}

// File-name patterns we never expect to have direct tests:
//   - index.ts: barrel re-exports
//   - shadowStyles.ts / styles.ts / styles/index.ts: CSS-as-template-string
//   - types.ts: type aliases only (no runtime behavior)
const NOISE_PATTERNS = [
  /\bindex\.ts$/,
  /(?:shadow)?[Ss]tyles\.ts$/,
  /\bstyles\/index\.ts$/,
  /\btypes\.ts$/,
];

function isNoise(rel) {
  return NOISE_PATTERNS.some(p => p.test(rel));
}

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip noise dirs.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

function checkRoot({ src, testRoot }) {
  const srcAbs = path.join(ROOT, src);
  const testAbs = path.join(ROOT, testRoot);
  if (!fs.existsSync(srcAbs)) return { covered: 0, uncovered: [] };
  const covered = [];
  const uncovered = [];
  for (const file of walk(srcAbs)) {
    const rel = path.relative(ROOT, file);
    if (IGNORE_PATHS.has(rel) || isNoise(rel)) continue;
    const expected = expectedTestPath(srcAbs, testAbs, file);
    if (fs.existsSync(expected) || hasSiblingTestVariant(expected)) {
      covered.push(rel);
    } else {
      uncovered.push(rel);
    }
  }
  return { src, testRoot, covered: covered.length, uncovered };
}

const results = SRC_ROOTS.map(checkRoot);

let totalUncovered = 0;
console.log('');
console.log('  Test coverage audit');
console.log('  ───────────────────');
for (const r of results) {
  const total = r.covered + r.uncovered.length;
  console.log('');
  console.log(`  ${r.src} → ${r.testRoot}: ${r.covered}/${total} files have a matching test`);
  if (r.uncovered.length > 0) {
    console.log('  Uncovered:');
    for (const f of r.uncovered) {
      console.log(`    - ${f}`);
    }
    totalUncovered += r.uncovered.length;
  }
}
console.log('');
if (totalUncovered === 0) {
  console.log(`  ✓ Every production module has at least one test file.`);
  process.exit(0);
} else {
  console.log(`  ${totalUncovered} module(s) without a matching test file.`);
  console.log(`  (Note: this script only detects "no test file at all". Coverage of`);
  console.log(`   individual functions/branches needs \`npm run test:unit:coverage\`.)`);
  process.exit(0); // intentionally non-fatal — this is a report, not a gate
}
