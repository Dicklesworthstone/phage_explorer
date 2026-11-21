# Dependency upgrade log

Date: 2026-10-04. Project: Phage Explorer. Runtime/package manager: Bun.

## Qualification baseline

The exact v1.5.0 archive passed 1,546 tests, ESLint and both TypeScript checks
through RCH. Main at 681924cf passed 2,735 tests with two failing provenance
affordance assertions on the same worker. Those assertions identified the
calculation-details affordance missing from the replacement codon-selection
overlay; it has been restored. A new chronology test also needed a definite
assertion message for the installed Node type definitions.

Frozen installs on another worker had broken isolated dependency links, so
that worker's missing-package failures are excluded from source qualification.
The original repository and the exact-tag archive remain separate from the
candidate qualification snapshot. Updates below are tested individually.

## Updates

Live discovery found 39 distinct direct dependencies; explicit WebGPU types add
one development dependency. Runtime/type pairs and
renderer/toolchain bindings are qualified together where their APIs require it.

- `@types/bun`: locked 1.4.0 to 1.4.2. Bun 1.4 type definitions match the
  qualification runtime. Full unit suite and ESLint/root/web typechecks passed
  after the isolated update. A cancellation fixture now explicitly checks its
  release callback is initialized before invoking it.

- typescript-eslint: 8.68.0 to 8.71.0; supported ESLint 10 and TypeScript <6.1 peers confirmed. https://typescript-eslint.io/users/dependency-versions/ Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- eslint: 9.39.5 to 10.12.0; existing flat config is supported; no new lint failures. https://eslint.org/docs/latest/use/migrate-to-10.0.0 Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- TypeScript: 5.9.3 to 6.0.3 in both manifests. Version 7 uses a compiler API
  outside the supported typescript-eslint range; 6.0.3 is the latest compatible
  version. Updated the deprecation settings and made the root Bun types explicit.
  Removed an unreachable duplicate search fallback diagnosed by the new compiler.
  Frozen install, ESLint and both typechecks passed. Two serial full-suite runs
  each passed all 2,738 tests with the original 30-second per-test limit; an
  earlier database-gzip producer timeout occurred during overlapping build work.
  [Supported compiler versions](https://typescript-eslint.io/users/dependency-versions/)
  and [TypeScript 6 changes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).

- immer: qualified 11.1.21; https://github.com/immerjs/immer/releases/tag/v11.1.21 Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- @tanstack/react-query: qualified 5.104.1; https://github.com/TanStack/query/releases/tag/%40tanstack/react-query%405.104.1 Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- drizzle-orm: qualified 0.45.3; https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.3 Affected-package unit suite (packages/db-runtime, packages/db-schema, packages/data-pipeline), ESLint and root/web typechecks passed after this isolated update.

- @vercel/analytics: qualified 2.0.1; https://github.com/vercel/analytics/releases Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- @vercel/speed-insights: qualified 2.0.0; https://github.com/vercel/speed-insights/releases Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- web-vitals: qualified 6.2.2; https://github.com/GoogleChrome/web-vitals/releases Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- sharp: qualified 0.35.5; https://sharp.pixelplumbing.com/changelog/ Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- `@vercel/og` 1.0.3 passed the affected web suite and static checks, but a
  supplemental real module-load check failed: the published bundle initializes
  HarfBuzz without shipping `hb.wasm`. This unused developer dependency is retained
  at exact 1.0.1 after real PNG rendering passed; a range would admit the broken
  versions again.
  [Upstream packaging defect](https://github.com/vercel/satori/issues/801).

- vite-plugin-pwa: qualified 2.0.0; https://github.com/vite-pwa/vite-plugin-pwa/releases Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- Pako 3.0.2: uses built-in types; legacyHash preserves scientific compression metrics, confirmed against eight independent Pako 2 byte streams. Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- @vercel/og: exact 1.0.1 passes consumed PNG rendering and delayed initialization; 1.0.3 is held for the published missing-WASM defect (upstream satori#801). Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- React/React DOM/types 19.3.0: aligned public API tuple; https://react.dev/blog/2026/09/09/react-19-3. Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- Ink 8.0.0: uses upstream duplicate-frame key fix; numeric terminal-dimension checks retain pipe behavior and resize listeners; React19.3/reconciler0.34 tuple. Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- Three 0.186.1/types0.186.0: public zoom controls use inverse scales; actual camera-direction/inverse check passed. Explicit @webgpu/types0.1.74 replaces the removed implicit ambient types. https://github.com/mrdoob/three.js/wiki/Migration-Guide Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- Vite 8.3.2: native Rolldown chunk-group API preserves existing labels/worker naming; actual production web/database/service-worker build passed. https://vite.dev/guide/migration.html Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- React Vite plugin 6.1.1: compatible with qualified Vite8 and existing react() configuration; actual production build passed. https://github.com/vitejs/vite-plugin-react/releases Affected-package unit suite (packages/web/src), ESLint and root/web typechecks passed after this isolated update.

- Playwright and @playwright/test 1.63.0: affected web tests, lint and root/web
  typechecks passed; matching Chromium 153 and a real production catalog/private
  GenBank bundle roundtrip passed on the remote qualification worker.
  [Playwright 1.63 changes](https://playwright.dev/docs/release-notes#version-163).

- wasm-pack 0.15.0: full2741 tests, lint/root/web typechecks and actual CLI version passed through RCH. Default builds retain committed baseline/SIMD artifacts. Optional regeneration/verifier contract remains disclosed in issue #6; regeneration and new numerical outputs were not claimed. https://github.com/wasm-bindgen/wasm-pack/releases/tag/v0.15.0 Full unit suite, ESLint and root/web typechecks passed after this isolated update.

- @huggingface/transformers exact4.3.0: unused JS developer package; real native backend import/pipeline/tokenizer exports and delayed exit passed, plus full2741 tests and lint/root/web typechecks. No model inference or Python ESM2 pin changes. https://github.com/huggingface/transformers.js/releases/tag/4.3.0 Full unit suite, ESLint and root/web typechecks passed after this isolated update.

## Combined release qualification

All retained updates together passed 2,741 unit tests, ESLint and both TypeScript
checks through RCH. The actual standalone build passed version checks and six
scientific worker/command tests. All project scripts passed the configured Bun
transpilation check.

The web build harness now explicitly supplies `NODE_ENV=production` to Vite.
Bun's test runner otherwise supplies `NODE_ENV=test`, which removes the
production-only service-worker registration branch. The corrected fresh web
build passed. Eight real browser journeys passed with no failures or skips:
private genome bundle roundtrip, repeat and ambiguity worker oracles, joined-CDS
and GC-skew exports, plus service-worker installation, user-controlled update
and rejection of stale database responses. The worker checks assert a real
WASM backend; they do not establish every scientific workflow or GPU path.

A fresh dependency audit still reports brace-expansion, fast-uri and
serialize-javascript in pre-existing development/build dependency paths.
[Issue #7](https://github.com/Dicklesworthstone/phage_explorer/issues/7) records
the exact versions, advisories, reachability review and qualification needed for
compatible transitive patch updates. This is not a zero-advisory audit.

---

## 2026-11-21 Dependency Refresh (v1.9.0)

Runtime/package manager: Bun 1.4.5 (Linux x64 qualification host). Updated in isolated logical groups, verifying `bun run check` (ESLint, root + web `tsc --noEmit`, keyboard sync, script transpilation, bead closures, comparison gates), affected package test suites, and `NODE_ENV=production bun run build:web` after each group:

- **Vite & React plugin**: `vite` `8.3.2 -> 8.3.8`, `@vitejs/plugin-react` `6.1.1 -> 6.3.0`. Eliminates 6 Vite/`launch-editor` advisories (including 1 high-severity Windows `launch-editor` CVE). Production web + PWA build and Bundle Budget Gate pass.
- **Lint & type definitions**: `@types/bun` `1.4.2 -> 1.4.5`, `@types/react-dom` `^19.3.0` (added to root devDependencies matching root `react-dom` and web workspace), `eslint` `10.12.0 -> 10.15.0`, `typescript-eslint` `8.71.1 -> 8.73.0`.
- **Core / DB / State / Runtime**: `pako` `3.0.2 -> 3.0.3`, `drizzle-orm` `0.45.3 -> 0.45.4`, `zustand` `5.0.15 -> 5.1.0`, `immer` `11.1.21 -> 11.2.10`, `react` & `react-dom` `19.3.0 -> 19.3.1`, `@tanstack/react-query` `5.104.1 -> 5.108.2`, `@vercel/speed-insights` `2.0.0 -> 2.1.0`, `web-vitals` `6.2.2 -> 6.2.3`.
- **Browser SQLite**: `sql.js` `1.14.2 -> 1.17.0` (`packages/web`). Real SQLite WASM + shipped `phage.db` tests and production web build pass.
- **3D Renderer**: `three` `0.186.1 -> 0.187.0`, `@types/three` `0.186.0 -> 0.187.0`. Visualization tests and production web build pass.
- **Dev Tooling & Transitive Refresh**: `playwright` & `@playwright/test` `1.64.0 -> 1.65.1`, `wasm-pack` `0.15.0 -> 0.15.1`, `@huggingface/transformers` `4.3.0 -> 4.3.2` (module-load export smoke verified), plus `bun update` transitive lockfile refresh (`fast-uri` `3.1.8 -> 3.1.9`, `serialize-javascript` `7.1.2 -> 7.1.4`, `brace-expansion` `2.1.7 -> 5.0.13` / `2.1.8`).
- **Held**:
  - `typescript` at `^6.0.3` (`7.0.2` is outside `typescript-eslint@8.73.0` peer range `>=4.8.4 <6.1.0`).
  - `@vercel/og` at exact `1.0.1` (`1.0.3` remains affected by upstream `vercel/satori#801` missing `hb.wasm`).
- **Security audit**: Reduced from 14 advisories (1 high, 9 moderate, 4 low) to 3 dev/build-tool-only moderate advisories (`glob@11.1.0` and `minimatch` under `workbox-build`/`eslint`, and `satori@0.29.0` under unused `@vercel/og@1.0.1`).
