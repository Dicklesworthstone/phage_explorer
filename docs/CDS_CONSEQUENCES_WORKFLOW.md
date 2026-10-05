# Coding consequences in the pangenome workflow

The pangenome workspace can rebuild a sequence graph together with coding-sequence
(CDS) consequences from a matched GenBank reference. It evaluates all query changes
within a CDS together, rather than assigning isolated effects to individual variants.
This is descriptive sequence analysis conditional on alignment and annotations,
not a prediction of gene function, clinical impact, infectivity or host range.

## Browser

Open **Sequence Pangenome & Variants**, load sequences and choose the reference,
alignment mode and terminal-gap policy. Under **Reference CDS and protein
consequences**, choose either an already imported, exact-sequence-matched GenBank
record or **Build with GenBank annotation file**. Files may also be local genome
bundles containing the original GenBank. Nothing is uploaded.

The GenBank sequence and origin must exactly match the selected reference; matching
accessions alone are insufficient. Multiple matching annotation records require an
accession or full content ID. For an imported record, the selected content ID is
passed automatically. Use **Mapped CDS identifiers** or the terminal inspection
command to find numeric CDS IDs. Leave the IDs blank to analyze all mapped CDS,
or enter a comma-separated subset such as `1,2,7`.

Both annotation actions rebuild the graph and CDS evidence from the submitted
inputs/settings in the existing cancellable worker. A failed or cancelled build
leaves the previous accepted experiment intact. Editing controls changes the next
build, not the current result or exports. A plain **Build sequence graph** deliberately
produces an unannotated result; it does not carry old annotation results forward.

Inspect available/changed/unavailable comparison counts; filter by query, effect,
CDS identifier, name or product. Results are paged at 50 comparisons. Selecting a
row shows reference transcript segments, conceptual translations, projected query
sequence, missingness and gap runs. Transcript intervals are 0-based half-open in
reference coordinates and listed in traversal order. First protein differences are
shown as 1-based symbol positions in the interface and 0-based offsets in TSV.

The annotation accession/content ID displayed above results belongs to the accepted
experiment. Parser warnings expose excluded or unsupported annotations. An unavailable
comparison is never equivalent to unchanged sequence.

## Terminal

These commands use the same producer and result format as the browser:

```bash
# Inspect available annotation records, content IDs and mapped CDS IDs.
bun run pangenome inspect-annotations --annotation reference.gb

# Compute a graph and coding consequences together.
bun run pangenome build --input genomes.fasta --reference reference_id \
  --alignment wavefront --annotation reference.gb --gene-ids 1,2 \
  --output annotated.json

# Add or replace annotations on a previously saved, verified experiment.
bun run pangenome annotate --experiment graph.json --annotation reference.gb \
  --output annotated.json

bun run pangenome verify --experiment annotated.json
bun run pangenome export --experiment annotated.json --format consequences-tsv --output consequences.tsv
bun run pangenome export --experiment annotated.json --format cds-fasta --output transcripts.fasta
bun run pangenome export --experiment annotated.json --format protein-fasta --output proteins.fasta
```

`build` and `annotate` accept `--annotation-record ACCESSION_OR_CONTENT_ID` and
`--gene-ids 1,2,7`. Omitting gene IDs means all mapped CDS, including when reannotating
a previous subset. `annotate` first verifies the old experiment, then rebuilds using
its original sequence inputs and graph settings. It writes a new output and never
changes the source file. Coding exports reject unannotated experiments. Every
terminal export recomputes the saved experiment before creating a file.

Output files are exclusive-create with mode 0600, subject to OS semantics. Existing
files and symlinks are not overwritten. A failed disk write may leave a partial new
file; choose a new destination to retry. Ordinary stdout contains metadata/counts,
not raw genome, CDS or protein sequences. Exported files contain private data.

## Exports, persistence and interpretation

**TSV** includes every analyzed query/CDS pair, including unavailable and deleted
CDS, with source/result identity, annotation identity, segments, effects, reasons,
lengths and gap/missingness counts. It contains no raw transcript/protein strings.
Controls and backslashes in labels are escaped; formula-like cells are prefixed
with an apostrophe for spreadsheet safety. Exact originals remain in experiment JSON.

**CDS/protein FASTA** includes supported reference sequences and nonempty, available
projected query sequences, irrespective of display filters. Unavailable and deleted
sequences are not invented. Conceptual translations retain `*` stop symbols,
including internal stops; no downstream extension is inferred. Headers distinguish
reference from projected-query roles, encode external labels, and bind to the CDS
result ID. These are not deposited query protein annotations.

**Complete pangenome experiments** use method version 5 and retain original genomes,
GenBank input, selected annotation/CDS IDs and graph settings. Reopen via file import
or the existing **Saved pangenome experiments** library to recompute alignment,
normalization, graph, transcripts and effects before accepting the result. The
graph's original-sequence exports and unannotated version-2/3/4 replay remain unchanged.
Checksums bind content; they do not independently validate biological claims.

Only genetic codes 1 and 11 are supported. Joined/reverse-strand CDS and codon_start
are honored. Reference pseudogenes, translation exceptions, unsupported segments,
incomplete reference codons and internal reference stops remain unavailable.
Ambiguous query bases or missing terminal coverage prevent a complete consequence.
Internal gaps are interpreted as deletions conditional on the alignment. Frameshift
and frame-restored labels describe gap-run lengths, not proven biological events.
The pipeline does not discover query-specific genes or infer regulatory effects.

Annotation input is bounded to 10 MiB. Existing graph/alignment limits still apply;
CDS work is additionally bounded to 12,000 query/CDS comparisons and 8 million
projected columns/bases as enforced by the producer. Select fewer genes or a smaller
region when these limits are reached; no silent sampling or approximate result is used.
