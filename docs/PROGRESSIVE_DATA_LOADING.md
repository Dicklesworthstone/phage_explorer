# Catalog-first browser datasets

The browser database hook accepts the existing version-2 monolithic SQLite
manifest and the publisher's version-3 `per-phage-sqlite-v1` manifest at the
same `phage.db.manifest.json` address. Version 2 delegates to the existing loader;
version 3 opens the catalog and loads individual genome databases on demand.
An invalid version-3 deployment never silently falls back to downloading an old
monolithic database.

## Publish and use

Use the existing publisher with an explicit source database:

```sh
bun scripts/build-progressive-web-db.ts \
  --source packages/web/public/phage.db --output /path/to/staged-public-assets
```

Deploy the manifest and every referenced immutable `phage-data/` artifact together
with a browser build containing this consumer. Keep artifacts referenced by older
published manifests available for clients that still have those versions open.
The publisher writes the manifest only after the artifact and row-conservation
checks succeed. No source database is modified. The browser integration does not
change release binaries, regenerate the production dataset, or publish a site.

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
Closing a repository aborts active downloads, wakes admission waiters, and prevents
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
  packages/web/src/db/ProgressiveSqlite.integration.test.ts
bun run typecheck:all
bun run build:web
```

The repository/loader tests inject adapters to test routing, budgets, ownership,
cancellation, replayed cache reads and refresh failures. The integration tests use
the native publisher and actual sql.js repository over synthetic SQLite data,
including annotations, float-vector blobs, cross-chunk sequences and offline
reopening. Browser/PWA journeys and production cold/warm performance measurement
remain separate acceptance checks; no startup-speed or Lighthouse score is implied
by these conformance tests.
