# Related-genome pangenomes: browser and terminal

Build a sequence graph and reference-relative variants from actual DNA inputs.
No database, network upload, template companions or host annotations are required.
The graph paths and GFA export preserve every ungapped input sequence exactly.

## Browser

Open **Sequence Pangenome & Variants**. Either load multi-sequence FASTA/dataset
JSON, or select 2–24 genomes already imported through **Local genomes** and choose
**Load selected genomes into pangenome workspace**. Imported records are selected
by full content identity, so matching accessions do not merge different inputs.
Loading does not run alignment or change the explorer's catalog/selection.

Choose the reference, alignment mode and terminal-gap policy, then **Build
sequence graph**. Inspect nodes, exact variant alleles and path coverage. The
wavefront details show each pair's edit distance and actual frontier work.
Changing controls does not relabel an already computed result: submit again.
Cancelling or closing terminates the worker; errors keep the last accepted result.

Export the input dataset, graph GFA, aligned FASTA or complete analysis. Reloading
an analysis freshly recomputes its graph and verifies the full result identity.
The accepted workspace is memory-only; export before refreshing the page.

## Terminal

From the source checkout with Bun and project dependencies installed:

```bash
bun run pangenome inspect --input genomes.fasta

bun run pangenome build --input genomes.fasta --reference reference_id \
  --alignment wavefront --terminal-gaps missing --output experiment.json

bun run pangenome verify --experiment experiment.json

bun run pangenome export --experiment experiment.json --format gfa --output graph.gfa
bun run pangenome export --experiment experiment.json --format fasta --output aligned.fasta
bun run pangenome export --experiment experiment.json --format dataset --output inputs.json
```

`inspect` reports identifiers, lengths and ambiguity counts without printing bases.
`build` requires an explicit reference and alignment mode. FASTA IDs must be unique;
GenBank is not accepted by this command (import it in the browser and export the
pangenome dataset). `verify` optionally accepts `--output verified-copy.json`.
Every `export` first recomputes the experiment; recalculated checksums on forged
output values do not make them valid. Browser and CLI use the same record format.

New outputs use exclusive creation with mode 0600; existing files and symlinks are
never overwritten. Filesystem permissions are subject to OS semantics. A failed
disk write may leave a partial *new* file; choose a new path before retrying.
Summaries go to stdout and errors to stderr with nonzero exit status. Summaries
contain identifiers/counts, not genome bases or variant alleles. Exported files
contain private sequences and should be handled accordingly.

## Alignment modes and boundaries

**provided** consumes an existing equal-column alignment. Equal lengths alone do
not establish homology. **global** retains the exact unit-edit locus DP algorithm
with its 12-million-cell dataset cap and original traceback convention.

**wavefront** computes an exact global unit-edit optimum for closely related,
collinear sequences, tracking only furthest-reaching frontier offsets instead of
the full quadratic matrix. Its deterministic tie rule may choose a different
optimal placement in repetitive sequence than the locus DP. This is a unit-edit
wavefront implementation, not the affine-gap WFA2 library. It searches neither
reverse strands nor circular rotations and does not identify inversions or donors.
Put all sequences in a justified common orientation and origin beforehand.

All modes retain the 4 MiB dataset, 24-sequence, 250,000-column, 4-million-cell,
4,000-block and 12,000-node graph limits. Wavefront work is additionally bounded
to 4 million frontier entries and 50 million symbol comparisons per pair, and
12 million entries / 100 million comparisons for the dataset. With all score
frontiers retained, score d needs (d+1)^2 entries; high divergence or large length
differences can therefore exceed the budget even for short inputs. Exhaustion
returns an error, never an approximate alignment. Use a supplied external
alignment or a smaller, closer region when these limits are reached.

Terminal gaps default to **missing coverage**. Choose **alleles** only when the
sequence ends are complete. Ambiguous bases are preserved in paths but excluded
from variant calls; they are literal symbols during computed alignment. Variant
coordinates are 0-based half-open, with insertions at a zero-width boundary.
Independent insertion slots are left-justified without asserting mutual homology.
Alleles are not repeat-normalized VCF records, gene-effect predictions or evidence
of evolutionary history. Per-pair edit distance counts symbols, not biological events.

New wavefront experiments use method version 3. Existing provided/global version-2
experiments retain their algorithm, serialization and fresh-replay semantics.
Checksums identify content; they do not establish biological correctness.
