# Portable mosaic reference-similarity experiments

Mosaic Radar compares windows of a query against exact supplied reference
sequences using canonical DNA k-mer Jaccard overlap. It reports the unique closest
reference only when there is positive overlap above the chosen threshold. Tied
references, below-threshold overlap and unavailable k-mers have distinct states.

A reference switch describes a change in sampled similarity. It does not identify
a biological donor, a recombination event, a precise breakpoint or transfer age.
Jaccard values are neither alignment identity nor calibrated probabilities.

## Local inputs and terminal commands

Use the existing database-free research command from a source checkout:

```bash
bun run workflow mosaic-template > example-panel.json
bun run workflow inspect-mosaic --input example-panel.json
bun run workflow analyze-mosaic --input example-panel.json --k 3 --window 200 --step 100 --output example-analysis.json
bun run workflow replay-experiment --input example-analysis.json --output verified-analysis.json
bun run workflow replay-experiment --input example-analysis.json --format tsv --output verified-windows.tsv
```

The template is deliberately synthetic and keeps `source: "demo"` on every
sequence. Replace the actual sequences and attribution to describe your own input;
changing its source flag alone does not make it an observation.

The compiled executable exposes the same commands as
`phage-explorer workflow …`. It does not require a catalog, an installed Bun or a
source checkout. These commands use the already embedded research worker, which
is terminated on timeout or interruption. Successful analysis writes a
metadata-only report to stdout. `--output` exclusively creates a new file with
owner-only permissions; existing files and symlinks are refused. A failed final
disk write may leave a partial new file.

`analyze-mosaic` accepts `--k`, `--window`, `--step`, `--min-similarity`,
`--max-references` and `--top-n`. Defaults are 5, 2000, half the effective window,
0.05, 30 and 3. The historical kernel has a 200-base minimum window and a 100-base
minimum step; portable records store the effective settings. The step must not
exceed the window. `k` ranges from 1 through 16, and the similarity threshold from
0 through 1. Zero shared k-mers never produce a match, even at a zero threshold.

For source-offset-aware tables, choose a section when analyzing:

```bash
bun run workflow analyze-mosaic --input panel.json --format tsv --section windows --output windows.tsv
bun run workflow analyze-mosaic --input panel.json --format tsv --section segments --output segments.tsv
bun run workflow analyze-mosaic --input panel.json --format tsv --section switches --output switches.tsv
```

These are fresh computations. For a previously saved result, use
`replay-experiment` to verify its original inputs and settings; its TSV export is
the window table. JSON preserves all three result sections.

## Input contract and coverage

The version-1 `phage-explorer-mosaic-dataset` JSON has `name`, `query`,
`references` and `excludedReferences`. Each supplied sequence has:

| Field | Meaning |
| --- | --- |
| `id`, `label` | Unique stable identifier and unique display label, including across the query and exclusions |
| `accession` | Source accession or explicit `null` |
| `sequence` | Exact ungapped IUPAC DNA; original case is retained in the input identity |
| `source` | `local`, `catalog`, `external` or `demo` |
| `sourceDescription` | Attribution and scope of this supplied snapshot |
| `sourceReference`, `sourceLicense` | Source reference/license or explicit `null` when unavailable |
| `sourceLength`, `sourceStart` | Original source length and the zero-based start of the exact analyzed slice |

The analyzed slice must fit inside the declared source length. No missing bases
are synthesized. A complete sequence uses `sourceStart: 0` and a `sourceLength`
equal to its sequence length. Known candidates whose bases were not supplied go
in `excludedReferences` with `id`, `label`, `accession` and `reason`.

References are sorted by label before the explicit `maxReferences` selection.
Reordering a supplied panel therefore preserves experiment identity. Additional
supplied references omitted by that limit and candidates excluded before input
construction are recorded separately. A failed reference read is an exclusion,
not a biological nonmatch.

Only resolved A/C/G/T runs contribute k-mers. Ambiguous IUPAC bases keep their
coordinates but break the runs. Canonical encoding makes matches independent of
reference strand. Windows remain linear even when their source genome is
circular; this method does not infer circular-origin windows or normalize a
rearranged sequence into an alignment.

Window coordinates are zero-based and end-exclusive within the analyzed query
slice. TSV also includes source coordinates using `sourceStart`. Display segments
partition the query at midpoints between sampled window centers, so overlapping
windows do not double-count bases. Switch intervals retain the supporting-center
range and a separate navigation midpoint.

## Execution and replay

The browser and terminal viewers compute through owned workers. Changing query,
panel or parameters cancels obsolete work, and closing the viewer terminates its
worker. Terminal Mosaic Radar uses `e` to export the accepted experiment JSON and
`t` for the window TSV; the path prompt refuses overwrites. Exports capture the
accepted result, rather than relabelling it after later navigation.

A portable `AnalysisRecord` contains the input dataset once, exact method and
reference versions, resolved settings, numerical results and source coverage.
SHA-256 identities bind the input and output. Replay validates the envelope and
then recomputes the method; even a fabricated result with regenerated hashes is
refused if it differs from fresh computation. Checksums establish reproducibility,
not independent source authenticity or biological validity.

The dataset limit is 6 MiB of UTF-8 JSON, with at most 5,000,000 total supplied
bases, 30 supplied references and 500 explicit exclusions. Experiments admit up
to 5,000 windows and a conservative bound of 50,000,000 sequence-scan and
set-membership operations. Exceeding a bound reports an error without silently
sampling or truncating the request. Increase the step or explicitly reduce the
panel/window. Portable analysis records must also fit the shared 10 MiB limit.

JSON exports contain private sequences and provenance. TSV omits sequence bases
but retains identifying metadata, exact source ranges, coverage and result hashes.
This workflow performs no implicit source fetch or genome upload.
