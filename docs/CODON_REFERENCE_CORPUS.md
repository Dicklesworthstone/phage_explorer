# Build a codon reference from original annotated sequences

The reference-codon workflow can derive its input counts directly from original
GenBank CDS, then retain that source derivation inside a query experiment. It uses
the same source importer, supported-CDS extractor, count scorer, and result-record
machinery as the existing research workflows. No external service is contacted.

This is a **declared reference corpus**, not automatic discovery of highly expressed
genes or proof that the selected organism is a suitable host. Supply a defensible
source citation, version, organism label and gene-selection rationale. Counts and
CAI alone do not establish expression, host range, infectivity or gene function.

## Browser

Import the reference and query GenBank records through **Local genomes**. Under
**Reference-backed codon adaptation**, open **Build reference counts from imported
GenBank**, select the source record, and enter the corpus name, organism, citation,
version and genetic code. **Mapped reference CDS identifiers** lists the numeric
IDs available for an explicit comma-separated subset. A blank subset selects every
mapped CDS in that source record.

Choose **Build and use source-backed reference**. Parsing and counting occur in
an independently owned worker. The loaded reference reports selected, counted,
excluded and unmappable CDS plus source identities and warnings. Changing its
metadata controls affects the next build, not the accepted counts or exports.

### Record and replay reference-backed query scoring

Under **Local genomes → Saved research workflows**, start recording, choose the
**Workflow genome** and **Workflow CDS**, then open **Record reference-backed
codon adaptation**. Load **Workflow codon reference JSON** with either the count-only
reference or **Export source corpus experiment** from the builder. Loading reads
the file into a draft; it neither calculates nor records anything. A query-analysis
export is not a reference-corpus input.

Choose **Workflow reference zero-count replacement**, then **Run and record
reference-backed CDS**. Each command embeds the exact reference JSON, an explicit
CDS selection and the resolved zero policy. The source-corpus variant reparses its
original GenBank, recounts and verifies its selected transcripts before scoring.
Reference accessions, filenames and URLs never trigger file or network lookups.
The query genome and annotations are bound to the recording's original input bundle.

The accepted-result table shows scores, coverage and unavailable-CDS reasons;
its 50-row preview does not restrict the complete analysis export. Reference or
policy draft changes cannot alter an accepted result. The command list abbreviates
embedded reference text for display; JSON exports retain it without modification.

Stop recording before exporting or saving an on-device workflow snapshot. On
reopening, review and explicitly add the bundled query genomes before replaying.
Replay uses the references saved in each command, not today's draft controls,
and verifies the newly computed method/input/result identities. Count-only and
source-corpus commands may be mixed with navigation, exact repeats and pangenomes.
They work with `phage-explorer workflow inspect/replay --input workflow.json` and
the existing `bun run workflow` source command. The final verified analysis is also
accepted by `codon-reference verify`.

The existing **Run and record CDS analysis** action remains an illustrative host
model. Its old commands cannot acquire reference-backed semantics by adding a
method label; the complete method-specific parameters and expected output must
come from a new computation. An older host without the reference adapter rejects
these new commands before playback rather than falling back to an illustrative model.

Each reference is embedded per command. The whole tape still has a 10 MiB limit,
including its query input bundle and repeated references. An over-limit recording
is refused before replacing accepted evidence; no source is silently dropped.
Cancel and close terminate the operation's worker. Failed/cancelled executions
preserve prior accepted evidence, while completed earlier replay commands remain.
Checksums and reproducible counts do not validate the reference's biological suitability.

Select the query genome and CDS in the existing query controls, then **Analyze
against reference**. The worker freshly verifies the source corpus before using
its counts. The exported query experiment contains the complete source experiment;
reopening it reparses the reference sources, recounts, and recomputes query scores.
No source file needs to remain beside the exported experiment.

The browser builder selects one imported reference record per build. For multiple
records, build a corpus with the terminal command below or the core API, then open
it with **Codon reference JSON file**. The reference file
picker accepts either existing count-only JSON or a source corpus experiment.
Large source text is not put into the editable count-JSON text box. The query's
existing save/reopen library also retains its embedded source experiment.

**Export source corpus experiment** preserves the original inputs and audit.
**Export count-only reference JSON** emits the existing 64-codon interchange schema
without its source derivation, and appends the corpus result identity to the source
version. Keep the corpus experiment to make source replay possible. Both formats contain research data; the source experiment includes private
sequence input. References are not automatically persisted separately.

## Terminal

The source-checkout command is `bun run codon:reference`. A newly built main
executable uses `phage-explorer codon-reference` with the same arguments. No separate
command parser, database lookup, or external aligner is involved.

```bash
# Discover records, full content IDs and mapped CDS IDs.
bun run codon:reference inspect --genome reference.gb

# Build counts from the whole annotated input. Choose the actual source code.
bun run codon:reference build-reference \
  --genome reference.gb --output corpus.json \
  --name "Declared reference CDS set" --organism "Source organism" \
  --citation "Source citation and selection rationale" \
  --reference-version "your-source-version" --genetic-code 11

# Reparse the original source and verify counts and the exclusion audit.
bun run codon:reference verify-reference --experiment corpus.json

# The query result embeds and recounts the original corpus before scoring.
bun run codon:reference analyze \
  --genome query.gb --reference corpus.json --output query-experiment.json
bun run codon:reference verify --experiment query-experiment.json

# Optional count-only interchange; verification precedes export.
bun run codon:reference export-reference \
  --experiment corpus.json --output counts.json
```

Without `--record`, reference building selects every parsed record in the source
file or local-genome bundle. `--record ACCESSION_OR_CONTENT_ID` selects one exact
record; a non-unique accession fails rather than choosing a record implicitly.
`--gene-ids 1,2,7` requires `--record`. Mapped numeric CDS IDs are scoped to one selected record; the corpus builder
does not accept an ambiguous cross-record numeric subset.

Every selected source must be annotated GenBank: FASTA does not establish coding
frames. Unsupported selected CDS reject a build by default. `--unavailable exclude`
explicitly excludes and audits them instead; a corpus with no remaining counted
codons still fails. `verify-reference` optionally writes `--output` to a new
verified copy. Existing output files and symlinks are never overwritten. A failure
during final disk writing may leave a partial **new** file; it is not silently
removed. Ordinary summaries print identifiers and coverage, not DNA sequences.

## Counting and exclusion contract

Each accepted transcript contributes every complete DNA triplet in transcript order,
including its initiation triplet and any terminal stop. No pseudocount is added by
the builder. Joined segments, reverse complements, circular-origin joins and
`codon_start` are interpreted by the existing supported-CDS extractor. A GTG
initiation triplet contributes GTG, not a rewritten ATG. Downstream CAI retains its
existing codon-family exclusions and selected reported-zero policy.

Only genetic codes 1 and 11 are supported. Under the feature-table convention,
absent `transl_table` means 1; the builder does not silently override that annotation
with the user-entered code. A conflicting table, unresolved coding base, internal
stop, incomplete codon, unsupported recoding/pseudogene qualifier, or inconsistent
deposited translation excludes the **entire** CDS. Such exclusion fails a strict
build. Repeated CDS qualifiers require source correction even with exclusion enabled,
because parser warnings cannot reliably assign them to one mapped feature.

Repeated transcript-coordinate signatures within one record count once; subsequent
selected duplicates are excluded and audited. Distinct loci and overlapping CDS
are separate observations and can count the same genomic bases more than once.
Exact duplicate records are deduplicated by the importer, not by matching accessions.

All 64 codons are reported. Zero means absent from the accepted transcripts, not
absent from the organism. A synonymous family with no observations cannot become
fully adapted through reported-zero replacement. Coverage distinguishes selected
mapped CDS, excluded selected CDS, and unmappable source CDS. In an all-CDS strict
build, unmappable source CDS cause an error rather than silent omission; a deliberate
mapped subset or explicit omission policy is required.

Limits are the original 10 MiB input, 100 records and 5,000,000 genome bases, plus
20,000 selected CDS and 25,000,000 bases of transcript extraction work. The complete
analysis export is also limited to 10 MiB. Combining a large corpus and query can
exceed that limit even when each source separately fits; no embedded source or audit
is dropped to force an export to succeed.

Source corpora use method `genbank-codon-reference`, version 1. Source-backed CAI
uses `reference-codon-adaptation`, version 2. Count-only CAI retains its existing
version-1 identities. Replayed records are freshly reconstructed and compared,
including exclusions and counts; recalculating hashes over fabricated counts is
not sufficient. Checksums verify content consistency, not scientific suitability.

Primary interpretation references: INSDC Feature Table definitions for CDS locations,
`codon_start` and `transl_table` (https://www.insdc.org/submitting-standards/feature-table/),
NCBI genetic codes 1 and 11 (https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi),
and Sharp & Li's CAI definition (DOI `10.1093/nar/15.3.1281`).
