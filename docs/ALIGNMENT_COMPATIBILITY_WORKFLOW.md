# Aligned DNA site compatibility

Open **Mosaic radar** from the command palette or with **Alt+M**. The aligned-DNA
panel accepts an existing homologous multiple alignment independently of the
currently selected catalog genome. The existing k-mer reference-similarity view
remains below it.

This workflow measures the alleles and paired haplotypes actually present in the
supplied alignment. It does not align sequences, infer donors or transfer times,
call biological breakpoints, estimate recombination-event counts, or calculate
p-values. A source declaration and a successful checksum do not establish
biological validity.

## Supply exact input

1. Give the experiment a name and identify its source, version and optional
   license or permissions. Source kinds are user-supplied (`local`), declared
   published/external (`external`), or explicitly synthetic (`demo`). External
   attribution does not cause a download or independently authenticate the source.
2. Describe the alignment method and its supporting evidence or explicit
   hypothesis. Confirm that its columns are intended to be homologous. The app
   cannot establish that declaration from the input alone.
3. Paste aligned DNA FASTA or select a UTF-8 FASTA file. A selected file supplies
   the next calculation until it is cleared or pasted text is edited. File reads
   and calculations are cancelable; source edits cancel pending work.
4. Compare the whole alignment, or enter a range in **1-based inclusive original
   alignment columns**. The record stores the same interval as zero-based,
   half-open `start`/`end`. Excluding sites never renumbers retained columns.
5. Select **Calculate aligned-site compatibility**. Review coverage before
   interpreting the pair matrix. A narrow interval can resolve an eligible-site
   budget error; the app never samples or silently omits eligible pairs.

FASTA identifiers must be unique, 1–80 characters, and contain only letters,
digits, underscore, dot or hyphen. The first header token is the identifier.
There must be 4–64 equal-length sequences, with 1–100,000 columns. Lowercase bases
are normalized for calculation; the original FASTA text remains in the record.
Supported calls are `ACGTRYSWKMBDHVN?-`. Whitespace within sequence lines is
ignored by the shared aligned-DNA parser. Unknown symbols and unequal lengths
are rejected, not repaired.

Exact input and metadata are limited to 2 MiB. A selected interval may contain
at most 256 eligible columns, giving at most 32,640 unordered pairs. The complete
pretty-printed experiment is limited to 10 MiB, the same limit used by JSON
replay and local snapshots. Record creation rejects an oversized export before
it becomes an accepted experiment.

## What is counted

Each selected column receives exactly one classification, in this order:

| Classification | Rule |
| --- | --- |
| Missing / ambiguous | Any taxon has a non-ACGT call, including a gap. The entire column is excluded. |
| Monomorphic | Every taxon has the same unambiguous base. |
| Multiallelic | More than two unambiguous alleles occur. |
| Biallelic singleton | Exactly two alleles occur and one is present in only one taxon. |
| Eligible | Exactly two unambiguous alleles, each present in at least two taxa. |

Singleton columns cannot exhibit all four haplotypes with another site, so their
exclusion cannot hide a four-gamete pair among the complete biallelic columns.
Multiallelic sites are outside this method. Complete-column deletion is explicit;
the method does not silently use a different taxon subset for each pair.

Alleles are ordered lexicographically (`A`, `C`, `G`, `T`) as allele 0 and allele
1. For each unordered eligible pair, the four counts `n00`, `n01`, `n10`, `n11`
sum to the number of supplied taxa. The pair is incompatible when **all four
counts are positive**. The matrix uses red for such pairs, blue for the other
compared pairs, and gray for a site's comparison with itself. Click a cell or
table row to see the actual two-base haplotypes and every contributing taxon ID.

The table is paginated for display. Its filter and pagination never alter the
calculation or exports. A count of zero incompatible pairs is different from
having fewer than two eligible columns; the latter explicitly reports that no
site-pair assessment is available.

## Interpret the evidence carefully

The four-gamete criterion is discussed by Hudson and Kaplan (1985),
[*Statistical Properties of the Number of Recombination Events in the History
of a Sample of DNA Sequences*, Genetics 111:147–164](https://doi.org/10.1093/genetics/111.1.147),
also available [through PubMed Central](https://pmc.ncbi.nlm.nih.gov/articles/PMC1202594/).

Under an infinite-sites model, four gametes at two biallelic sites are
incompatible with a single tree. Recurrent mutation, alignment errors and
sequencing errors are alternative explanations. The count of incompatible
pairs is not the number of recombination events; many dependent pairs can
reflect the same underlying history. Conversely, no observed incompatibility
does not establish absence of recombination. Coordinates here are alignment
coordinates, not genomic coordinates or inferred breakpoint positions.

## Exact example

The explicit **Load synthetic four-gamete example** action fills this input and
marks its source as `demo`. It is not loaded or calculated automatically.

```fasta
>synthetic_a
AA
>synthetic_b
AG
>synthetic_c
GA
>synthetic_d
GG
```

Both columns have A=2 and G=2. The only pair has AA=1, AG=1, GA=1, GG=1, so
there is one incompatible pair. A separate six-taxon control `AA, AA, AG, AG,
GG, GG` has counts 2,2,0,2 and no incompatible pair, with both columns still
eligible. Neither fixture supports a biological recombination claim.

## Export, save and reopen

- **Complete experiment JSON** includes the exact original FASTA and declared
  source, alignment declarations, interval, all exclusions, per-taxon allele
  assignments, all paired counts, method version and interpretation limits.
- **All selected sites TSV** contains one row per selected original column,
  including exclusions, with A/C/G/T and non-ACGT counts. Its columns are 1-based.
- **All compared pairs TSV** contains every unordered eligible pair, both allele
  labels, all four counts including zeros, and the four-gamete flag. Its columns
  are 1-based; it is unaffected by the visible table filter or page.
- **Save snapshot locally** explicitly persists the accepted complete record
  in this browser profile. Draft edits are not included. Reload does not reopen
  private data automatically; choose a saved snapshot and explicitly open it.
  Browser eviction or data clearing can remove snapshots, so retain JSON backups.

JSON replay and snapshot opening recompute from the embedded source, without
depending on the current catalog selection or downloading reference data.
Recomputed outputs and the entire method/provenance contract must match the
saved record. Even an edited output with newly computed checksums is rejected.
Cancelled or failed imports preserve the previous accepted experiment. Saving
or restoring a local snapshot temporarily locks competing source controls.

## Native and batch workflow

The terminal command uses the same exact producer and portable record as the
browser. It needs no catalog, running browser or network connection. From a
source checkout, prefix the command with `bun run packages/tui/src/index.tsx`
in place of `phage-explorer`.

Prepare an input from your already aligned FASTA with explicit source and
alignment declarations:

```bash
phage-explorer alignment-compatibility prepare alignment.fa \
  --name "My alignment" \
  --source-kind local \
  --source-reference "Local alignment supplied by the researcher" \
  --source-version "2026-11-22" \
  --alignment-method "Describe the method and settings used" \
  --alignment-reference "Describe the intended homology and its evidence" \
  --homologous \
  --output compatibility-input.json

phage-explorer alignment-compatibility inspect compatibility-input.json
phage-explorer alignment-compatibility analyze compatibility-input.json \
  --output compatibility-experiment.json
```

`--source-kind` must be `local`, `external` or `demo`. The optional `--license`
supplies a license or permission statement; omission records `null`. Source
attribution and `--homologous` are explicit user declarations, not independently
verified claims. An `external` source never causes a download. The native UTF-8
reader removes an initial byte-order mark; preparation retains the remaining
FASTA text, including its casing and line endings. Inspection validates
equal-length aligned DNA and reports source metadata, sorted taxon IDs,
alignment dimensions and input identity, without calculating pairs or printing
raw sequences. It can inspect an alignment whose full range exceeds the
eligible-site analysis budget.

For a subset, provide **both** `--start` and `--end` in zero-based, half-open
original alignment coordinates. This differs from the browser form's one-based
inclusive entry but is identical to the recorded `start`/`end` contract. For
example, columns 101–300 in the browser use `--start 100 --end 300`:

```bash
phage-explorer alignment-compatibility analyze compatibility-input.json \
  --start 100 --end 300 --output selected-interval.json
phage-explorer alignment-compatibility replay selected-interval.json \
  --format sites --output selected-sites.tsv
phage-explorer alignment-compatibility replay selected-interval.json \
  --format pairs --output selected-pairs.tsv
```

Replay first recomputes the complete saved experiment and rejects differing
results, provenance or method settings. It accepts no input or interval
overrides. Browser JSON can be replayed by the native command, and native JSON
can be reopened in the browser. Both TSV formats retain one-based **original**
column coordinates, every selected site or compared pair and the accepted result
identity. Tables are convenient exports; JSON retains the full replayable record.

Use `-` as the input path for bounded UTF-8 stdin. Output goes to stdout unless
`--output` names a new file; progress and errors go to stderr. Files are created
with private permissions and existing files are never overwritten. Reads,
calculations and stalled output are cancellable with Ctrl-C; computation runs in
an isolated native worker, also embedded in the standalone executable. An
interrupted file or pipe write can leave partial output, so consume it only after
a successful exit. Exit codes are 0 for success, 2 for command-argument errors,
1 for input/computation/output failures, 130 for Ctrl-C and 143 for SIGTERM.
None of these operations uploads private alignments or metadata.

## Programmatic record contract

The producer lives in `packages/core/src/analysis/alignment-compatibility.ts`.
`createCompatibilityExperiment(input, options?)` creates a complete record using
method `aligned-dna-site-compatibility`, version `1`.
`replayCompatibilityExperiment(json)` validates and freshly recomputes it.

The input has `format: "phage-explorer-alignment-compatibility"`, `version: 1`,
`name`, `source: { kind, reference, version, license }`, and
`alignment: { fasta, homologous: true, method, reference }`. `license` is a string
or explicit `null`. Optional options are exactly `{ start, end }` in zero-based,
half-open original alignment coordinates. Unsupported fields are rejected.

Results store sites in increasing original column order. Each site has its
column, ordered alleles, allele counts and a 0/1 assignment string indexed by
the result's sorted taxon IDs. Each compact pair tuple is
`[leftSiteIndex, rightSiteIndex, n00, n01, n10, n11]`; these indices address the
eligible site array, whose `column` fields preserve original coordinates.
All unordered pairs appear in increasing `(leftSiteIndex, rightSiteIndex)` order.
