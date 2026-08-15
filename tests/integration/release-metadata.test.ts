/**
 * Release metadata consistency.
 *
 * Four artifacts carry or depend on the version, and nothing derives them from
 * each other:
 *
 *   package.json       what `vsce package` stamps on the VSIX
 *   package-lock.json  what `npm ci` installs against
 *   README.md          the Marketplace listing, rendered from the PACKAGED readme
 *   CHANGELOG.md       what users read to decide whether to upgrade
 *
 * At 0.9.0 three of the four disagreed: the lockfile still said 0.8.0 because
 * the bump edited package.json directly, and the README badge still said 0.7.0
 * — stale for TWO releases, because no gate looks at it. `/shipshape` checks
 * docs against *code*; nothing checked docs against the *version*.
 *
 * Same shape as the schema-examples parity test: two surfaces that must agree,
 * with no mechanism forcing them to.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf-8');

const pkg = JSON.parse(read('package.json'));
const version: string = pkg.version;

describe('release metadata agrees on the version', () => {
  it('package.json declares a semver version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('package-lock.json matches, in both places it records the version', () => {
    // `npm install --package-lock-only` is what syncs these. Editing
    // package.json by hand does not.
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.version).toBe(version);
    expect(lock.packages['']?.version).toBe(version);
  });

  it('the README badge matches', () => {
    // The Marketplace renders the README from the packaged VSIX, so a stale
    // badge is publicly visible for a whole release cycle and cannot be fixed
    // without republishing.
    const badge = read('README.md').match(/<h2 align="center">v(\d+\.\d+\.\d+)<\/h2>/);
    expect(badge, 'README version badge not found — did the header change shape?').not.toBeNull();
    expect(badge![1]).toBe(version);
  });

  it('CHANGELOG.md has an entry for this version', () => {
    // Guards the other direction: a bump that ships with no user-facing note.
    const changelog = read('CHANGELOG.md');
    expect(
      changelog.includes(`## [${version}]`),
      `CHANGELOG.md has no "## [${version}]" section`
    ).toBe(true);
  });

  it('the changelog entry is dated, and not before the previous release', () => {
    // A date typo is invisible to every other check. This caught 0.9.0's entry
    // carrying the date the work was done rather than the date it shipped.
    const dated = [...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)];
    expect(dated.length, 'no dated release headings found').toBeGreaterThan(1);
    expect(dated[0][1], 'newest dated entry is not the current version').toBe(version);
    expect(dated[0][2] >= dated[1][2], `${dated[0][2]} is before the previous release ${dated[1][2]}`).toBe(true);
  });

  it('the changelog entry sits above every older release', () => {
    // A released version listed below an older one means the entry was added
    // in the wrong place and readers see stale notes first.
    const headings = [...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1]);
    expect(headings[0]).toBe(version);
  });
});
