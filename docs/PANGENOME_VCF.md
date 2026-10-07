# Haploid VCF from sequence pangenomes

Export the accepted pangenome alignment as variant-only VCF 4.3, with one haploid
sample per non-reference sequence. This is interchange of alignment-derived
sequence differences, not a read-based variant caller or a genotype-likelihood
model. The existing graph, GFA, original sequences, annotations and experiment
identities are unchanged.

## Browser

In **Sequence Pangenome & Variants**, load and compute a graph, or reopen an existing
experiment for fresh verification. Choose **Export haploid variants VCF** and
**Export VCF reference FASTA**. Use both files from the same accepted experiment.
The VCF includes its complete analysis result identity. Query/table filters, the
highlighted path, and draft reference or alignment settings do not restrict or
relabel either export. All non-reference input sequences are represented as samples.

The matching FASTA contains one contig named `reference`. It is the submitted
reference sequence with alignment gaps removed, retaining its original origin.
The VCF's contig has that exact name and length, not an accession looked up from a
database. Query samples are named `query1`, `query2`, etc., sorted by original
sequence ID; `##SAMPLE` descriptions map each to its URI-encoded original ID.
`##phage_explorer_reference_id_uri` records the original reference ID. URI decoding
recovers punctuation and Unicode without letting user identifiers inject VCF fields.

## Terminal

Use the existing pangenome command in a newly built executable or source checkout:

```bash
phage-explorer pangenome export --experiment graph.json \
  --format vcf --output variants.vcf
phage-explorer pangenome export --experiment graph.json \
  --format reference-fasta --output reference.fasta

# Source-checkout equivalents:
bun run pangenome export --experiment graph.json --format vcf --output variants.vcf
bun run pangenome export --experiment graph.json --format reference-fasta --output reference.fasta
```

Each CLI export first reparses and recomputes the saved experiment, including any
normalization and CDS consequences. A checksum over fabricated graph evidence is
not accepted. File creation happens only after verification and serialization.
Existing files and symlinks are never overwritten; outputs use exclusive creation
and mode 0600, subject to OS semantics. An interrupted final disk write can leave
a partial *new* file. No release or installed-binary update is implied by this
source feature. Ordinary summaries contain metadata, not genotype alleles or DNA.

## Calls, coordinates and missingness

VCF POS is **1-based** and REF names the corresponding bases in the matching FASTA.
GT contains one allele index: `0` is reference, `1` is the first ALT, and so forth.
A single `.` is a missing haploid genotype. The chosen reference is not an extra
sample and is excluded from AC/AN. AC counts calls to each alternate allele; AN
counts all nonmissing haploid query calls. These are assembly-sequence counts,
not read depth, population allele frequencies or estimates of biological ploidy.

A call needs resolved A/C/G/T query sequence across the complete output locus,
including indel padding. IUPAC ambiguity within that locus produces `.` rather
than an invented allele or a reference call. With the accepted terminal-gap policy
`missing`, positions outside the overlap of the reference's and query's observed
spans are missing coverage, not deletions. With `alleles`, terminal gaps describe
explicit complete-sequence differences. The exporter never changes that policy.
Columns empty in both the reference and a query carry no sequence/coverage claim.

Unresolved reference sites do not seed variants. No arbitrary A/C/G/T base is
substituted for an ambiguous reference. If an otherwise observed indel requires
unresolved reference padding, export fails rather than changing the reference.
A header-only file is a valid zero-record export, but **absence of a VCF record is
not a claim of reference coverage**. This is not gVCF and does not list all missing
or invariant sites. Keep the full experiment/alignment to inspect those positions.

## Indel representation and limits

Adjacent SNVs can be separate records. Contiguous insertions and deletions form
runs, and empty REF/ALT alleles acquire the preceding reference base as padding;
at the beginning of the contig they use a following reference base. When padding
or different queries' events overlap, the exporter combines them into one locus
with complete, deduplicated alternate sequences and haploid calls for every query.
This avoids mutually overlapping pairwise VCF rows. Opposing gap placements that
reconstruct the reference for every query do not become a variant.

The output is sorted and non-overlapping, but alleles are **not repeat-left-normalized**
or guaranteed minimal. Combined loci may differ in count or boundaries from the
pairwise variant cards. No symbolic structural alleles, breakends, inversions,
rearrangement history or donor predictions are added. QUAL and FILTER are `.`:
there is no invented confidence, read depth, genotype quality or filter PASS.

If merging/padding leaves no fully observed alternate, or a whole-reference
deletion cannot acquire an anchor, export fails actionably rather than silently
omitting a known difference. Use a suitable smaller aligned region or the original
alignment instead. Existing graph limits still apply, with an additional 64-million
column/sample/merge-visit budget and a 10 MiB VCF output limit. These limits produce
an error, not a truncated successful VCF. Reference FASTA can still be exported
when unresolved alleles prevent a VCF export.

With strand/origin normalization, calls describe the normalized query paths in the
submitted reference coordinate system. They cannot by themselves restore each
query's original strand or circular start. The saved experiment and original-FASTA
export retain those transforms. Circular origin-crossing changes can remain split
at the reference ends. No circular-edit or multiple-alignment optimality is added.

Core APIs: `exportPangenomeVcf(graph, resultId?)` and
`exportPangenomeReferenceFasta(graph)`, exported through `@phage-explorer/core`.
They consume accepted graph objects; applications loading saved JSON must call
`replayAlignmentPangenome` first. The optional result ID is metadata, not proof.

Format reference: the official SAMtools/HTS VCF 4.3 specification,
https://github.com/samtools/hts-specs/blob/master/VCFv4.3.tex (REF padding, GT, AC/AN
and missing QUAL/FILTER). Repository tests independently decode records and apply
the alleles to the reference to reconstruct known queries. An independent small
decoder is not HTSlib/bcftools conformance proof; native downstream-tool validation
must be run separately before claiming it.
