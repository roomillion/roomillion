# AGENTS.md

千万间 Roomillion is an offline-first, cross-platform Electron desktop workbench (Windows x64 MVP + generic Linux x64 preview) where AI generates sandboxed "rooms" (mini-apps) from `.room` packages. Docs, UI text, and user-facing strings are Simplified Chinese; commit messages have been English.

## Layout

- `src/main/` — Electron main process. Plain CommonJS `.cjs` services (no TypeScript, no bundler). Entry `src/main/index.cjs`.
- `src/preload/` — `workbench-preload.cjs` (workbench UI) and `room-preload.cjs` (per-room sandbox bridge).
- `src/renderer/` — workbench UI: plain JS/HTML/CSS (`app.js`, `index.html`, `styles.css`).
- `test/` — `node:test` suites, one `<topic>.test.cjs` per service.
- `docs/` — numbered Chinese design/decision docs (00–54). README.md has a navigation table; consult the relevant doc before changing a subsystem.
- `examples/` — sources for the seven public example rooms; packed into `resources/examples/*.room` by build scripts.
- `resources/` — mostly generated (`resources/examples/*.room`, `resources/room-modules/`, `resources/compliance/`); `resources/toolchains/mingit` is committed. Do not hand-edit generated output.
- `build/` — electron-builder configs (portable, portable-folder, installer, linux); `build/generated/` is generated.
- `scripts/` — build/smoke/version scripts (`.cjs` + PowerShell for splash/pilot kit; `scripts/linux/` shell for Linux builds).
- `release/` — gitignored packaging output.

## Commands

Requires Node.js 22+. Dev host is Windows; `.ps1` scripts run via `powershell.exe`.

```sh
npm ci --cache .npm-cache        # README's install form (project-local cache)
npm run build:resources          # builds room-modules + compliance + example .room files; needed before test/start
npm start                        # electron . (prestart runs build:resources)
npm test                         # node --test on test/*.test.cjs
node --test test/room-package.test.cjs   # focused single-file run
npm run smoke                    # headless app smoke; also smoke:safe-storage, smoke:mimo-agent, ...
npm run release:portable         # official Windows release: bumps version, rebuilds, tests, packages
npm run build:portable-folder    # same-version portable ZIP (no version bump)
```

CI (`.github/workflows/test.yml`): `npm ci` → `npm run build:resources` → `npm test` on windows-latest / Node 22.

## Conventions

- All process code is CommonJS `.cjs` with `"use strict"` and `node:`-prefixed builtins. Do not introduce TypeScript or a bundler without checking docs first.
- Tests use `node:test` + `node:assert/strict`, fake data only, and temp dirs. New interfaces need param validation, permission/room-isolation coverage, and failure test cases (CONTRIBUTING.md).
- Line endings enforced by `.gitattributes`: JS/CJS/JSON/MD/HTML/CSS/SH are LF; PS1/CMD are CRLF; `*.room`/`*.zdata` are binary.
- Update `CHANGELOG.md` (`未发布` section) for user-visible changes.

## Architecture boundaries (do not bypass)

- Rooms are untrusted: they never get direct filesystem, key, or OS access — everything goes through the capability broker / controlled IPC in `src/main/ipc.cjs` and the preload bridges. Don't add a path that lets a room read system files or secrets.
- Rooms cannot install npm packages at runtime and cannot load modules absent from the fixed official catalog (`src/main/room-module-catalog.cjs`, 39 pinned, license-registered modules bundled offline by `scripts/build-room-modules.cjs` into `resources/room-modules/`).
- Room packaging is "shared layer first": deps provided by the workbench are referenced, not copied; out-of-catalog deps must ship in the room's `embedded/` with exact versions and licenses (docs/19).
- API keys are system-encrypted and never exposed to rooms; AI access goes through the AI gateway (docs/29, docs/31 for the network switch).

## Gotchas

- `npm test` and `npm start` need `npm run build:resources` first — several tests read generated `resources/`.
- Version discipline (docs/28, docs/47): pre-release bumps `0.3.0-alpha.N → N+1` via `npm run version:next` / `release:portable`. Never hand-add suffixes like "fixed" or dates to artifact names; artifacts always use `release/Roomillion-<version>-...` standard names.
- Only the seven public example rooms (`examples/`) may be committed; new public examples must update the catalog, packaging list (`package.json` `extraResources`), and regression tests. Unpublished examples, user data, and `.room` packages must not enter the repo.
- Third-party deps: keep exact pinned versions; adding/changing one requires its license registration (catalog metadata / `scripts/third-party-licenses.cjs` / `resources/compliance/`, see LICENSE-REVIEW.md). Code is Apache-2.0; don't relicense third-party material.
- Windows artifacts are unsigned; the Linux toolchain must be provided via `resources/toolchains` (never system Git/Bun). macOS is not buildable yet (runtime supports only win32-x64 / linux-x64).

## Read before touching sensitive areas

- Room package/runtime spec: `docs/03-房间包与运行时规范.md`
- Overall architecture: `docs/02-总体技术架构.md`
- Dependency packing policy: `docs/19-v1房间依赖打包策略.md`
- Agent harness: `docs/51-alpha39完整房间Agent-Harness.md`, `docs/26-room-app-v1自由房间Harness实施记录.md`
- Release checklist: `docs/47-GitHub发布检查清单.md`
