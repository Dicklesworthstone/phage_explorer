# Complete genome-comparison experiments

The browser **Comparison** panel and native `comparison` command use the same
`genome-comparison` method, version 3. A portable experiment retains both complete
accepted genomes, original annotation rows, supplied codon counts, effective
settings, and all comparison outputs. Reopening recomputes the experiment before
accepting the saved evidence.

## Compare in the browser

1. Import private FASTA/GenBank records through **Local genomes**, or select a
   pair from the current repository. Open **Comparison** and choose Phage A and
   Phage B. Changing the pair starts a comparison with the last applied settings.
2. Inspect Summary, K-mer, Info, Correlation, Biological, Genes, and Diff. The
   displayed sequences, annotations and metrics all belong to the accepted pair.
3. Expand **Comparison settings** to choose k-mer sizes and edit-metric sampling
   settings. Draft edits apply only when you choose **Run**; the portable panel
   separately displays the settings of the accepted result.
4. Choose **Export comparison JSON** to download the complete experiment, or
   **Save snapshot locally** to retain an immutable named copy on this device.
   Closing the panel does not save it automatically.

| Setting | Accepted values | Effect |
|---|---|---|
| K-mer sizes | 1–8 distinct integers, each 1–31 | Selects the reported k-mer comparisons. |
| Whole-sequence edit metric limit | 0–10,000 bases | Inputs above this length use sampled edit windows; zero always selects sampling. |
| Sampled edit window size | 1–2,000 bases | Sets the edit-metric window size. |
| Sampled edit window count | 1–100 | Sets the number of edit-metric windows. |

The **Diff** tab and aligned indels in **Genes** use a separate bounded exact
unit-edit alignment. These sampling settings do not turn an approximate edit
metric into an exact alignment. When the exact alignment exceeds its budget,
the experiment retains its explicit unavailable reason and the other metrics.

Within the configured whole-sequence limit, edit metrics reuse the accepted exact
alignment. If its budget is exhausted, exact operation counting uses rolling
rows rather than a quadratic traceback matrix. Above the configured limit,
sampled windows estimate total distance; insertion, deletion and substitution
counts are `null` with an explicit reason because sampling cannot establish an
operation breakdown. The terminal displays that reason instead of invented counts.
Version 3 binds this corrected evidence contract. Earlier comparison records are
rejected on replay; recompute their original inputs to create a current experiment.

### Navigate the accepted comparison

The Diff view owns its position, zoom, DNA/amino-acid mode and reading frame.
Next/previous differences, position jumps, the position bar, canvas clicks,
wheel scrolling and mode/frame controls operate on the accepted comparison
sequence. They do not move the main explorer or change its mode, frame or zoom.
Navigation changes in the main explorer likewise do not move this comparison
viewport. The ordinary explorer continues to use its existing shared controls.

This separation also applies to reopened experiments whose embedded genomes are
absent from the current repository. Use the accepted-source banner to identify
that pair; the comparison's coordinates belong to those embedded sequences.

**Cancel comparison**, changing the selected sources, and closing the overlay
cancel pending computation. Cancelled or obsolete reads and worker replies
cannot publish a result for a later selection. Incomplete sequence reads are
rejected instead of comparing an unlabeled prefix.

## Reopen without the original catalog

Choose **Reopen comparison JSON**, or select an entry under **Saved genome
comparison experiments on this device** and choose **Open saved snapshot**.
The worker validates the method and record, recomputes from the embedded bases,
annotations, codon inputs and settings, and compares the complete evidence.
Changing a saved numerical result and recalculating its checksums is insufficient
to make it pass replay.

Only successful replay switches the panel to the saved experiment. Its source
banner identifies the embedded pair; the current repository and explorer
selection do not replace those sources. All seven tabs remain available even
when the original catalog is absent. **Return to current genomes** resumes the
live comparison. Failed imports and **Cancel comparison replay** preserve the
accepted evidence and current display mode.

The local library survives ordinary reloads in the same browser profile.
Snapshots are not encrypted or synchronized, and clearing browser storage or
eviction can remove them. Export JSON as a separate backup. The shared library
supports up to 64 snapshots and 64 MiB total, with no automatic eviction.

## Use the same record in the terminal

```bash
phage-explorer comparison run reference.gb query.fa --output comparison.json
phage-explorer comparison replay comparison.json --output verified-comparison.json
```

Each source file contains one accepted DNA genome; FASTA, GenBank and local genome
bundles are supported. `--params settings.json` accepts the four setting names
below. The output path must be new. Use `-` for one stdin input; progress and
errors go to stderr.

```json
{
  "kmerSizes": [3, 5, 7, 11],
  "maxEditDistanceLength": 10000,
  "editDistanceWindowSize": 1000,
  "editDistanceWindowCount": 20
}
```

Browser exports can be replayed by this command, and terminal exports can be
reopened in the browser. Replay uses saved parameters and does not accept
overrides. Runtime timestamps and elapsed durations are operational metadata
excluded from the result identity; complete scientific outputs remain bound.

## Evidence and limits

Each genome is bounded to 1,000,000 ungapped IUPAC DNA bases and 20,000 annotation
rows. The complete input-and-result record must fit within 10 MiB; inputs near
their individual limits can still produce a record too large to accept. The
worker reports that failure rather than exporting a truncated experiment.

JSON contains all comparison metrics, coverage and unavailable reasons, every
exact alignment run and display-mask byte, and the original annotations and
supplied counts. A shortened visible table is not an export limit. Annotation
and alignment coordinates in the record are zero-based and half-open; displayed
base ranges are one-based and inclusive, with explicit interbase sites for
insertions and deletions.

These are descriptive comparisons. K-mer resemblance does not establish
homology, function, host range or species identity. Position-paired information
and sampled windows depend on the submitted strand and origin. Gene-name overlap
does not establish orthology. Supplied codon counts are retained as supplied;
when counts are absent, frame zero of the whole sequence supplies composition
counts, not a predicted CDS set. FASTA input acquires no inferred annotations.
Each accepted record also carries the method's detailed limitations.

Both source genomes are embedded in the export. Import, comparison and replay
run locally and do not upload them.
