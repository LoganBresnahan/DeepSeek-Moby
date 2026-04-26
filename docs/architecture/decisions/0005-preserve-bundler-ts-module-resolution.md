# 0005. TypeScript module resolution: preserve + bundler

**Status:** Accepted
**Date:** 2026-04-26

## Context

TypeScript 7.0 will drop `moduleResolution: "node"` (now labeled `node10`). At runtime this project is bundled through webpack with `libraryTarget: 'commonjs2'` — TypeScript is only used for type-checking and is not the resolution engine for emitted output.

The project structure:

| Layer | Tool | Purpose |
|-------|------|---------|
| Type-checking | `tsc` | Validate types, read `package.json` exports |
| Transformation | `ts-loader` → webpack | Resolve and bundle modules |
| Output | webpack `commonjs2` | Produce VS Code extension entry (`dist/extension.js`) |

Because VS Code extensions must load via `require()` and are not ESM-aware, the output target is locked to CommonJS. But this constraint applies to webpack's output, not to TypeScript's `module` setting — webpack's `libraryTarget` controls output format independently.

The current settings (`module: "commonjs"` + `moduleResolution: "node"` with `ignoreDeprecations: "5.0"`) suppress TS 5.x deprecation warnings but will stop working in TS 7.0.

`@signalapp/sqlcipher` is a native N-API addon (binary `.node`) declared as a webpack external. It has no bearing on module resolution — TypeScript sees only its `.d.ts` types, which resolve normally.

## Decision

Migrate to `module: "preserve"` + `moduleResolution: "bundler"`. Drop the `ignoreDeprecations` field entirely.

- **`module: "preserve"`** — TypeScript leaves `import`/`export` statements untouched in emitted output. webpack's ts-loader handles all transformation, making downward emit behavior irrelevant.
- **`moduleResolution: "bundler"`** — TypeScript resolves modules the way a bundler (webpack, esbuild) would: it understands `package.json` `"exports"` fields and does not require file extensions on relative paths. This is the resolution strategy TypeScript recommends for bundler-based projects.

## Alternatives considered

### A. Suppress the deprecation: `"ignoreDeprecations": "6.0"`

Keep `module: "commonjs"` + `moduleResolution: "node"` and suppress the TS 7.0 deprecation with a higher ignore value.

Rejected. This would need to be bumped again at TS 8.0, and TS may remove the option entirely at some point. Kicking the can is not free — it delays adoption of `"exports"`-aware resolution, which becomes relevant for dependencies that adopt it.

### B. `module: "node16"` + `moduleResolution: "node16"`

Adopt Node.js's hybrid CJS/ESM resolution.

Rejected. This mode produces `.mts`/`.cts` output and requires downstream consumers (webpack config, VS Code extension host) to handle Node ESM/CJS interop. Added complexity with zero benefit — the project is bundled, not run directly by Node.

### C. `module: "commonjs"` + `moduleResolution: "bundler"`

Keep CJS module emit with bundler-style resolution.

Rejected because TypeScript does not support this combination — `bundler` resolution requires `module` to be `es2015`+, `preserve`, `node16`, or `nodenext`.

## Consequences

**Positive:**
- Eliminates the `ignoreDeprecations` workaround permanently.
- TypeScript's understanding of module resolution now matches webpack's actual behavior.
- `package.json` `"exports"`-aware resolution works for type-checking, matching what webpack does at bundle time.

**Negative / accepted costs:**
- The `module: "preserve"` setting is less common than `commonjs` or `esnext` — unfamiliar to contributors.
- No change in emitted output or runtime behavior. This is purely a type-checking configuration change.

**Follow-ups:**
- If `ts-loader` compatibility issues arise during compilation (`npm run compile`), validate the loader configuration. Expected to work without changes since `preserve` emits files with imports intact, which ts-loader handles identically to `esnext`.
