# Affine-gap sequence graphs and annotated experiments

The pangenome pipeline offers an explicit `affine` alignment mode alongside
`provided`, `global` and unit-edit `wavefront`. It uses separate mismatch, gap
opening and gap extension penalties, then feeds the same sequence graph,
reference-relative variants, CDS projection, export and verified-replay pipeline.
No external aligner installation, remote sequence upload or database is required.

## Scoring contract

Matches cost zero. A substitution costs `mismatch`. A gap containing **L bases**
costs **gapOpen + L × gapExtend**, including extension on the first base. Defaults
are mismatch 4, opening 6, extension 1. These defaults are a scoring configuration,
not a biologically calibrated likelihood model. Mismatch and extension must be
integers 1–64; opening must be an integer 0–64. All three resolved penalties are
saved, and changing any penalty changes experiment identity.

The implementation performs exact M/I/D wavefront recurrence and traceback for
fixed input representations. It does not prune frontiers or silently fall back to
an approximate alignment. Equal-cost traceback ties choose substitution, deletion,
then insertion; gap extension precedes reopening. Exact common scaling factors
are removed during the search and restored in the reported cost.

Method reference: Marco-Sola et al., *Fast gap-affine pairwise alignment using the
wavefront algorithm*, DOI `10.1093/bioinformatics/btaa777`. This is the project's
TypeScript implementation, not a binding to WFA2, and does not claim WFA2's
low-memory, SIMD, heuristic or dual-gap capabilities.

## Browser

In **Sequence Pangenome & Variants**, choose **Align with separate gap opening
and extension costs (exact affine)**. Set **Mismatch cost**, **Gap opening cost**
and **Gap extension cost**, then build. Invalid penalties disable both graph and
CDS build actions. Draft edits do not relabel accepted results or exported files.
Changing to a non-affine mode removes incompatible penalty settings.

The result shows the submitted penalties and a per-sequence cost table. The same
settings are passed to **Reference CDS and protein consequences** when building
with GenBank annotations. Saved research snapshots and JSON exports preserve the
model; reopening recomputes the graph and any CDS evidence before accepting it.

## Terminal

```bash
bun run pangenome build --input genomes.fasta --reference reference_id \
  --alignment affine --mismatch 4 --gap-open 6 --gap-extend 1 \
  --output affine.json

# An annotated experiment uses the same scoring model.
bun run pangenome build --input genomes.fasta --reference reference_id \
  --alignment affine --annotation reference.gb --output annotated.json

bun run pangenome verify --experiment affine.json
bun run pangenome export --experiment affine.json --format gfa --output graph.gfa
bun run pangenome export --experiment annotated.json --format protein-fasta --output proteins.fasta
```

Penalty flags are rejected outside affine mode. `annotate` retains the saved graph
settings when rebuilding with a new annotation. Every `verify`/`export` recomputes
saved evidence; recalculated checksums do not make fabricated costs valid. Existing
files and symlinks are never overwritten. Ordinary summaries contain metadata,
penalties and counts, not genome bases. Exported files contain private sequences.

## Normalization and boundaries

Both wavefront modes support `--normalization strand|circular`. Circular mode
requires the user to assert complete circular inputs with `--terminal-gaps alleles`.
Unique-anchor normalization is heuristic, not an exhaustive circular optimum.
The affine optimum is conditional on its chosen orientation and anchor.

**Search cost** describes that anchored alignment. **Reference-origin cost** is
the linear cost after alignment columns are rotated back to the submitted reference
origin. Rotating a circular alignment can split one gap into two terminal runs,
so these costs can differ by an opening penalty. Both are recorded explicitly.
Neither is an evolutionary event count. Pairwise scores do not claim a jointly
optimal multiple alignment; insertion slots retain the existing star convention.

Per-pair limits are 4 million allocated frontier offsets across M/I/D, 50 million
attempted symbol comparisons and 100,000 searched score layers. Dataset limits
are 12 million offsets, 100 million comparisons and 300,000 score layers. Existing
sequence/graph/export limits also apply. Layer counts include unreachable score
values after common-factor normalization; they are not a maximum reported cost.
A proven single-contiguous-gap lower-bound shortcut can avoid frontier allocation
for otherwise identical inputs, including large indels. This does **not** promise
large-indel handling with additional differences. Affine search can exhaust work
budgets sooner than unit-edit search. Use supplied alignments for unsupported work.

IUPAC symbols are compared literally while aligning but remain excluded from
resolved variant evidence. Missing terminal coverage is not a deletion unless
explicitly configured as an allele. No internal inversions, rearrangement history,
donor assignment, gene-function or phenotype prediction is added by this mode.

Unannotated affine records use method version 6; annotated composition retains
version 5 and identifies its version-6 graph method in the references. Existing
provided/global/unit-wavefront/normalized and annotated records remain replayable
without migrating their original numerical identities.
