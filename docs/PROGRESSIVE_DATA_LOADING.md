# Catalog-first browser datasets

The browser database hook accepts the existing version-2 monolithic SQLite
manifest and the publisher's version-3 `per-phage-sqlite-v1` manifest at the
same `phage.db.manifest.json` address. Version 2 delegates to the existing loader;
version 3 opens the catalog and loads individual genome databases on demand.
An invalid version-3 deployment never silently falls back to downloading an old
monolithic database.

## Publish and use

Build the deployable catalog-first application from the committed annotated input:

```sh
bun run build:web:progressive
bun run preview:web
```

Vercel uses the same progressive build command. Automatic Git deployment remains
disabled by the existing repository configuration; this does not deploy a site.
The builder opens `packages/web/public/phage.db` read-only, stages a new immutable
generation alongside copies of unrelated public assets, and passes that staging
directory to the existing Vite/PWA build. It verifies all referenced files before
and after bundling. Source files, source manifests, and the terminal release DB
are not overwritten. The stage excludes old shards, the legacy monolith/gzip,
and SQLite sidecars; missing canonical input is an error, not permission to use
the repository-root intermediate. Temporary staging is retained in the system
temporary directory, including after failure; no cleanup of source files occurs.

`bun run build:web` and development `prepare:db` retain the version-2 layout for
legacy-reader and existing snapshot/update tests. Use the explicit progressive
command for the Vercel layout. Both use the same application and layout-aware
loader, not separate browser implementations. No dependency or lockfile changes
are needed for publication.

Use the existing publisher with an explicit source database:

```sh
bun scripts/build-progressive-web-db.ts \
  --source packages/web/public/phage.db --output /path/to/staged-public-assets
```

Deploy the manifest and every referenced immutable `phage-data/` artifact together
with a browser build containing this consumer. Clean builds emit only the current
generation. For uninterrupted rolling updates, retain older referenced artifacts
at the serving origin/CDN; an open old-version client otherwise must reload to
fetch a changed, previously uncached shard. A hash in a URL is not server-side
retention. Vercel gives shards immutable cache headers and the manifest revalidation
headers, but this does not create a cross-deployment artifact archive.
The publisher writes the manifest only after the artifact and row-conservation
checks succeed. No source database is modified. Invoking the progressive build
creates a staged dataset; it does not change release binaries or publish a site.

`useDatabaseQuery` creates the layout-aware loader. The resulting repository has
the existing `PhageRepository` interface, so shared-link ordering, local-genome
composition, analysis overlays, and explicit neighbor prefetch use the same API.
Catalog list/search/length/reference queries do not load genome shards. Full
records, genes, sequences, annotations, models and embeddings use the selected
genome's shard, not empty catalog tables. Global atlas requests use projection
pages; single-genome atlas requests use that genome's shard.

## Integrity and lifetime

The manifest's identity covers the catalog, all artifact descriptors, ownership,
and atlas page order. Every network or cached artifact is checked for exact byte
length and SHA-256 before SQL opening or JSON interpretation. Catalog IDs and
lengths must match the manifest, and every opened shard must contain exactly its
catalog owner. A truncated sequence window is an error, not an empty result.
Atlas rows are checked for identity, model, finite coordinates and complete count.
These checks establish internal content consistency, not source authenticity or
biological validation of annotations and embeddings.

Concurrent reads of one genome share a load. A SQL handle stays leased through
its query, and only idle handles are evicted. In-flight reservations count against
the SQLite residency budget. Failed loads release reservations and can be retried.
Closing a loader-owned repository aborts active downloads, wakes admission waiters, and prevents
late responses from becoming accepted results. Already-running queries release
their handles on completion rather than having their database freed underneath them.

The default residency budget is 64 MiB, including the catalog and reserved/loaded
serialized SQLite artifacts. A catalog plus any single genome must fit. This is
NOT a bound on total JavaScript or WebAssembly heap, which also includes decoded
rows, strings, engine allocations and copies. Global atlas requests separately
allow at most 64 MiB of serialized pages and fail rather than return partial data;
select a single genome when the global projection exceeds that budget.

## Offline use and updates

Verified artifacts use the existing 128 MiB FIFO Cache Storage budget. The current
catalog is pinned. Open SQL handles have a separate least-recently-used policy.
The manifest pointer uses a separate cache so artifact eviction cannot mistake it
for an invalid data artifact. A replacement catalog is verified and opened before
its manifest pointer is committed. The previous catalog remains pinned during
that replacement, including when the new manifest write fails.

Only previously fetched genomes/projection pages are available offline. Missing
known-genome data fail explicitly instead of becoming empty annotation results.
Storage failure preserves verified in-memory use but reports offline storage as
unavailable. Forced refresh requires a successful manifest download and durable
catalog/pointer persistence; it does not accept a cached manifest or HTTP 304 as
fresh-download success. An open repository remains bound to one dataset version;
reload constructs a replacement rather than relabeling existing results.

## Verification entry points

```sh
bun test packages/web/src/db/progressive-data.test.ts \
  packages/web/src/db/ProgressivePhageRepository.test.ts \
  packages/web/src/db/ProgressiveSqlite.integration.test.ts \
  packages/web/src/db/ProgressiveBuild.test.ts
bun run typecheck:all
bun run build:web:progressive
cd packages/web
bunx playwright test --project=chromium-pwa --workers=1 e2e/progressive-pwa.e2e.ts
```

The repository/loader tests inject adapters to test routing, budgets, ownership,
cancellation, replayed cache reads and refresh failures. The integration tests use
the native publisher and actual sql.js repository over synthetic SQLite data,
including annotations, float-vector blobs, cross-chunk sequences and offline
reopening. The production-publication tests exercise actual SQLite and filesystem
output, including missing/corrupt artifacts and source preservation. The progressive
PWA journeys serve the real built app and the exact production publisher's dataset
on an isolated origin, checking selective loading, offline reuse, and corrupt
catalog refusal. They do not replace the existing version-2 PWA/update tests.
Production cold/warm performance measurement remains a separate acceptance check;
no startup-speed or Lighthouse score is implied by these conformance tests.

## Shared browser readers and safe refresh

`useDatabaseQuery` uses one `DatabaseSession` per QueryClient and database URL.
Live SQLite handles are not cached as ordinary React Query result objects:
query-cache lifetime cannot safely be combined with individual hook cleanup.
Use the hook's explicit `load()` and `reload()` functions rather than generic
query invalidation. `load()` joins current work or reuses the accepted snapshot;
`enabled: false` does not start a load but still observes an already shared one.
`reload()` owns a forced-download operation, including its single retry. Concurrent
refresh callers await the same operation; a normal load cannot downgrade it.

The hook returns borrowed, version-fixed repositories. Calling their `close()`
is intentionally a no-op: only the shared session may close its loader. Unmounting
one reader leaves the others usable. Final unsubscribe schedules release on the
next task so immediate React StrictMode reattachment can reuse the same work.
A later remount opens a new snapshot, reusing verified persistent data where
available, rather than returning a previously closed SQLite object.

On refresh, old snapshots remain open until readers commit the replacement and
in-flight queries finish. Nested offline verification/preparation receives the
same protection. A failed refresh leaves the previous repository usable and
reports the error and failed-update status. Failed/retired loaders cannot replace
current progress. Borrowed neighbor prefetch is best-effort; an uncached offline
neighbor or retired warmup does not fail the selected genome. Explicit requests
for unavailable genome data still reject, and prefetch success is not evidence
of offline completeness.

Run the focused ownership tests with:

```sh
bun test packages/web/src/db/DatabaseSession.test.ts
```

`e2e/database-session.e2e.ts` supplies a two-reader view under real React StrictMode
and QueryClient, using the production hook, loader, sql.js and dataset publisher.
It covers partial unmount, full remount with cache reuse, corrupt replacement,
and coalesced successful refresh using an explicitly mutated private test snapshot.
It does not replace repositories with fixture implementations. The spec starts
its own Vite server; an explicit base URL disables the unrelated preview server:

```sh
cd packages/web
PLAYWRIGHT_BASE_URL=http://127.0.0.1 bunx playwright test \
  --project=chromium --workers=1 e2e/database-session.e2e.ts
```

Unit-adapter execution, installed-library browser execution, native Bun, and full
workspace/build results are distinct checks. These tests imply no measured
startup improvement or independent scientific validation.
