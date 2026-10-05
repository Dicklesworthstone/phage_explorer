# Related-genome pangenomes: browser and terminal

Build a sequence graph and reference-relative variants from actual DNA inputs.
No database, network upload, template companions or host annotations are required.
Graph paths spell each ungapped input in its submitted or explicitly normalized
representation. Recorded inverse transforms recover the original strand and start.

## Browser

Open **Sequence Pangenome & Variants**. Either load multi-sequence FASTA/dataset
JSON, or select 2–24 genomes already imported through **Local genomes** and choose
**Load selected genomes into pangenome workspace**. Imported records are selected
by full content identity, so matching accessions do not merge different inputs.
Loading does not run alignment or change the explorer's catalog/selection.

Choose the reference, alignment mode and terminal-gap policy, then **Build
sequence graph**. Wavefront mode also offers **Strand and origin handling**:
keep the submitted representation, normalize whole-sequence strand, or normalize
strand and origin when **all inputs are complete circles**. The last option
requires explicitly selecting complete-sequence terminal alleles. Do not apply
circular normalization to linear or partial assemblies.

Inspect nodes, exact variant alleles and path coverage. With normalization enabled,
the transform table shows each input's strand, offset and supporting evidence.
Select a graph path and node to inspect its original input coordinates, including
reverse-strand and origin-crossing segments. Reference-relative variants retain
the submitted reference origin. Wavefront details show each pair's edit distance
and actual frontier work. Changing controls does not relabel an already computed
result: submit again. Cancelling or closing terminates the worker; errors keep
the last accepted result.

Export the input dataset, graph GFA, aligned FASTA, **original sequence FASTA** or
complete analysis. Aligned FASTA spells normalized paths when normalization was
requested; original FASTA inverts each transform and reconstructs original
ungapped sequences from graph nodes. Reloading an analysis freshly recomputes its
graph and verifies the full result identity, including normalization evidence.
The accepted workspace is memory-only; export before refreshing the page.

## Terminal

From the source checkout with Bun and project dependencies installed:

```bash
bun run pangenome inspect --input genomes.fasta

# Keep submitted strand/origin; missing terminal sequence is not an allele.
bun run pangenome build --input genomes.fasta --reference reference_id \
  --alignment wavefront --terminal-gaps missing --output experiment.json

# Use only when ALL inputs are complete circular molecules.
bun run pangenome build --input circles.fasta --reference reference_id \
  --alignment wavefront --normalization circular --terminal-gaps alleles \
  --output circular-experiment.json

bun run pangenome verify --experiment circular-experiment.json

bun run pangenome export --experiment circular-experiment.json --format gfa --output graph.gfa
bun run pangenome export --experiment circular-experiment.json --format fasta --output aligned.fasta
bun run pangenome export --experiment circular-experiment.json --format original-fasta --output original.fasta
bun run pangenome export --experiment circular-experiment.json --format dataset --output inputs.json
```

`--normalization none` is equivalent to omitting the option. `strand` chooses
whole-sequence forward/reverse orientation without changing the linear origin;
`circular` also normalizes origins. Both require `--alignment wavefront`.
`circular` additionally requires `--terminal-gaps alleles`, with no silent override.

`inspect` reports identifiers, lengths and ambiguity counts without printing bases.
`build` requires an explicit reference and alignment mode. FASTA IDs must be unique;
GenBank is not accepted by this command (import it in the browser and export the
pangenome dataset). `verify` optionally accepts `--output verified-copy.json`.
Every `export` first recomputes the experiment; recalculated checksums on forged
output values or transforms do not make them valid. Browser and CLI use the same
record format. The dataset export preserves original input representations.

New outputs use exclusive creation with mode 0600; existing files and symlinks are
never overwritten. Filesystem permissions are subject to OS semantics. A failed
disk write may leave a partial *new* file; choose a new path before retrying.
Summaries go to stdout and errors to stderr with nonzero exit status. Summaries
contain identifiers/counts/transform metadata, not genome bases or variant alleles.
Exported files contain private sequences and should be handled accordingly.

## Alignment modes and boundaries

**provided** consumes an existing equal-column alignment. Equal lengths alone do
not establish homology. **global** retains the exact unit-edit locus DP algorithm
with its 12-million-cell dataset cap and original traceback convention.

**wavefront** computes an exact global unit-edit optimum for closely related,
collinear sequences in the chosen representation, tracking only furthest-reaching
frontier offsets instead of the full quadratic matrix. Its deterministic tie rule
may choose a different optimal placement in repetitive sequence than the locus
DP. This is a unit-edit wavefront implementation, not the affine-gap WFA2 library.
Without normalization it retains the submitted strands and origins. No mode
identifies internal inversions, rearrangements, donors or evolutionary history.

All modes retain the 4 MiB dataset, 24-sequence, 250,000-column, 4-million-cell,
4,000-block and 12,000-node graph limits. Wavefront work is additionally bounded
to 4 million frontier entries and 50 million symbol comparisons per pair, and
12 million entries / 100 million comparisons for the dataset. With all score
frontiers retained, score d needs (d+1)^2 entries; high divergence or large length
differences can therefore exceed the budget even for short inputs. Exhaustion
returns an error, never a partial alignment. Use a supplied external alignment
or a smaller, closer region when these limits are reached.

Terminal gaps default to **missing coverage**. Choose **alleles** only when the
sequence ends are complete. Ambiguous bases are preserved in paths but excluded
from variant calls; they are literal symbols during computed alignment. Variant
coordinates are 0-based half-open, with insertions at a zero-width boundary.
Independent insertion slots are left-justified without asserting mutual homology.
Alleles are not repeat-normalized VCF records, gene-effect predictions or evidence
of evolutionary history. Per-pair edit distance counts symbols, not biological events.

## Strand and circular-origin normalization

Exact equivalence is checked first: whole-sequence forward/reverse equivalence
for strand mode, or all circular origins on both strands for circular mode.
A linear-time prefix search counts equivalent origins. When several transforms
are equivalent, forward strand then the lowest offset wins deterministically;
the evidence reports the tie rather than claiming a unique biological origin.
IUPAC equivalence here is literal symbol equivalence, not resolved-base identity.

Otherwise, unique exact A/C/G/T 15-mers choose a strand and, for circular input,
an anchor. Repeated or ambiguous windows cannot anchor. Support windows overlap
in neither input, including across the circular boundary. At least three anchors
and at least twice the opposite-strand support are required. This is a **heuristic
selection rule**, not a calibrated confidence score or exhaustive optimization
over every possible circular alignment. Insufficient or conflicting support
stops with an actionable error instead of choosing a transform from an accession
or silently reverting to an unnormalized comparison.

Circular alignment starts at the selected shared anchor, runs exact bounded WFA,
and rotates alignment columns back to the submitted reference origin. Counting
consumed query bases during that rotation handles indels before the origin.
The result is exact conditional on the selected anchor, not an unconstrained
circular edit optimum. An edit spanning the reference origin can be split into
terminal variant intervals. A deleted or repetitive origin can have multiple
equivalent surviving representations. No biological replication origin is inferred.

Transforms use `normalized = rotateLeft(orientedOriginal, offset)`, where
`orientedOriginal` is the input itself for `+` and its reverse complement for `-`.
Offsets are 0-based in the oriented original. GFA includes reversible comment
records `# path-transform<TAB>pathId<TAB>{"strand":"-","offset":127}`; generic GFA
viewers may ignore them and will show normalized paths. Original FASTA export
performs the inverse. Node-coordinate segments are 0-based half-open in original
input coordinates, listed in traversal order; reverse-complement reverse-strand
segments before concatenation. A wrapped interval has two segments.

Normalized experiments use method version 4. Without normalization, wavefront
version-3 and provided/global version-2 records retain their existing identities
and fresh-replay semantics. Checksums identify content; they do not establish
biological correctness or independently validate user-asserted topology.
