# Profiles

## Implementation status (as of 2026-06-16)

**Status: not-started — plan never authored, feature never built.**

This file is an empty placeholder (0 bytes at `git show HEAD:docs/plans/profiles.md`); no design was ever written for a "profiles" feature, and there is nothing shipped to back it.

Shipped:
- Nothing. No profiles concept exists in the extension.

Not yet / differs:
- No `profile`-related settings or commands in `package.json` (grep for `profile` returns no matches).
- No source implements user/agent/config profiles. The only `profile` occurrences in code are unrelated: `powershell.exe -NoProfile` in `src/providers/drawingServer.ts:897`, and the dev-host launch flag `--profile=moby-dev` in `.vscode/launch.json:10` (an isolated VS Code Extension Development Host profile, see `CHANGELOG.md:95`) — neither is a Moby feature.
- If/when this feature is pursued, write the actual plan here first; this section is a placeholder note, not a design.
