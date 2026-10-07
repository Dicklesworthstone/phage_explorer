# Measured host-range evidence

The **Measured host-range evidence** workbench is at the top of the web
**Cocktail Compatibility Matrix** overlay (Alt+K). It imports categorical,
strain-level assay observations independently of the curated genome database.
The older annotation-based compatibility heuristic remains below it and does
not supply observations, fill missing cells, or affect measured coverage.

## Import and inspect

Import CSV, TSV or a saved experiment JSON, or paste CSV/TSV. The exact header is:

```csv
phage_id,host_id,assay,condition,replicate,outcome,source
```

Assay is `plaque` or `spot`; outcome is `positive`, `negative` or `indeterminate`.
Use exact strain identifiers, not a species label representing several strains.
Supply enough condition/source detail to identify the assay context and original
record. The software does not verify the supplied labels or experimental design.
A duplicate phage/strain/assay/condition/source/replicate tuple is rejected even
when the repeated outcome agrees. Different source labels do not prove independent
replication; the user must establish that independence from the original records.

Select the assay/condition pair, minimum replicate count, candidate phages and
target strains. Cells preserve six distinct states: positive, negative, mixed,
indeterminate, insufficient and untested. Contradictory determinate observations
are mixed regardless of their relative counts. Any indeterminate observation
prevents a non-mixed cell from being accepted as positive or negative. Missing
cells are untested, not negative. Select a cell to inspect its contributing rows.

Manual selection reports supported, all-negative and unresolved target strains.
The optional deterministic greedy selector adds the phage with the largest new
positive coverage, with lexical ID tie-breaking. It stops when there is no gain
or the requested size is reached. It is not a proven optimal selection and does
not infer mixture compatibility, antagonism, clinical efficacy or safety.
Spot coverage describes reported clearing, not proof of productive infection.

## Terminal and source-checkout workflow

The same implementation is available through the lazy terminal launcher:

```sh
bun packages/tui/src/index.tsx host-range inspect --input observations.csv
bun packages/tui/src/index.tsx host-range analyze --input observations.csv \
  --assay plaque --condition 'Recorded condition' --min-replicates 2 \
  --select phage-a --output experiment.json
bun packages/tui/src/index.tsx host-range replay --input experiment.json
```

A binary compiled from this source also accepts `phage-explorer host-range`.
These source changes do not publish or replace an existing released binary.
`bun scripts/host-range.ts` calls the same command implementation directly.
Use `--help` for repeated `--phage`/`--host` filters, explicit `--greedy`, selection
size and synthetic provenance. Analysis requires explicit assay and condition.
Without `--select` or `--greedy`, no phage is selected automatically. Replay
refuses analysis overrides and uses the saved settings. No command opens Ink,
loads a genome catalog or makes a network request.

## Export and replay

Export JSON retains the complete imported observations, original source labels,
provenance, query, manual/current selection, and maximum greedy-selection size.
The browser and CLI accept the same `categorical-host-range-v1` experiment.
Every result is recomputed from these inputs. Saved result fields are ignored,
not authenticated: replay is not a signature check or independent verification
of an assay. Retain the original experimental records separately.

Browser work is held in component memory only. Export before closing the overlay
or page; there is no automatic upload or persistent browser save. Edits invalidate
old results, and a late file read cannot replace newer input. Terminal exports
use exclusive creation and owner-only permissions; existing files, including
symlinks, are never overwritten. Input files are bounded regular UTF-8 files.

Bounds are 2 MB UTF-8 input/output, 5000 observations, 128 phages, 256 strains,
64 assay/condition pairs, 1–100 minimum replicates and 1–10 greedy selections.
Large browser matrices are paginated, and an export exceeding the import bound
is refused rather than producing a file that cannot be restored.

## Regression entry points

```sh
bun test packages/core/src/analysis/host-range-evidence.test.ts packages/tui/src/host-range-cli.test.ts
bun run lint
bun run typecheck:all
bun run check:scripts
bun run build:web
cd packages/web
bunx playwright test --project=chromium --workers=1 e2e/host-range-evidence.e2e.ts
```

The focused GitHub workflow runs these gates. Tests use explicitly synthetic
observations, independent expected cell/coverage results, adversarial file reads,
and a terminal → browser → terminal experiment round trip. Their results are
software-conformance evidence, not empirical validation of the submitted assays.
