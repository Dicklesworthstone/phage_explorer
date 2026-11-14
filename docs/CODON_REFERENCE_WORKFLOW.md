# Reference-backed codon adaptation

Analyze annotated coding sequences against a supplied codon-count reference, without the built-in illustrative host profiles. This is a reference-relative sequence score, not measured expression, tRNA abundance, host range or infectivity. The supplied reference's citation and biological suitability remain the user's responsibility.

## Browser

Open **Local genomes**, import and add an annotated GenBank file, then reopen Local genomes and find **Reference-backed codon adaptation**. Choose a genome and either all CDS or one CDS. Load or paste a reference JSON file, choose the reported-zero policy and select **Analyze against reference**.

The table includes unavailable CDS with reasons and reference coverage. **Export reference experiment** saves genome bases, annotations, exact reference JSON, selected IDs, zero policy and results. **Reopen and verify reference experiment** checks identities and recomputes scores from those inputs; no catalog or previously imported genome is required for verification. It does not add saved genomes to the explorer automatically. Reference inputs and results are session-local until explicitly exported.

## Terminal (Bun, repository checkout)

No curated database or network service is required:

```sh
# List stable record selectors and CDS IDs, without printing sequence bases.
bun run codon:reference inspect --genome query.gb

bun run codon:reference analyze \
  --genome query.gb --reference counts.json --output experiment.json

# Multi-record files require an unambiguous accession or full content ID.
bun run codon:reference analyze \
  --genome records.gb --record ACCESSION_OR_CONTENT_ID \
  --gene-ids 1,3 --zero-count 0.5 \
  --reference counts.json --output selected-experiment.json

# Browser and terminal experiments use the same format and implementation.
bun run codon:reference verify --experiment experiment.json
```

The direct equivalent is `bun scripts/codon-reference.ts ...`. `verify` optionally accepts `--output verified-copy.json`. Output files are exclusively created with owner-only permissions; existing files and symlinks are never overwritten. Standard output contains a JSON summary, not the private inputs; failures return exit code 1. A result with no fully scorable CDS is a valid unavailable result (`cai: null`), not a fabricated score.

## Reference format

Up to 128 KiB. Provide uppercase DNA codons and **integer counts**, not percentages or pre-normalized weights. Example below is only a two-codon format illustration, not a validated biological reference:

```json
{
  "format": "phage-explorer-codon-reference",
  "version": 1,
  "name": "Your documented reference corpus",
  "organism": "Your organism",
  "geneticCode": 11,
  "source": {
    "citation": "Describe or cite the source and selection of reference genes",
    "version": "Your corpus release"
  },
  "counts": { "AAA": 8, "AAG": 2 }
}
```

Every codon in a consumed synonymous family must be explicitly reported, with at least one observation in that family. Omitted counts are unavailable, not zeros. Reported zeros receive either the chosen 0.5 replacement (default) or remain zero. An entirely zero family remains unavailable under either policy.

Weights are counts divided by the maximum count in the synonymous family; CAI is their geometric mean. Singleton amino-acid families and terminal stops are excluded according to the reference's explicit NCBI genetic code. Supported tables are:

| NCBI table | Relevant codon meanings | Consequence for reference weights |
|---|---|---|
| 1 and 11 | Standard elongation meanings | Met and Trp are singletons; 18 scored families |
| 4 | TGA encodes Trp | TGA and TGG form a scored family; 19 scored families |
| 15 | TAG encodes Gln | The Gln family requires CAA, CAG and TAG counts |
| 25 | TGA encodes Gly | The Gly family requires GGT, GGC, GGA, GGG and TGA counts |

Every codon in a scored family must have a reported count, including reassigned codons. For example, table-4 counts TGA=8 and TGG=2 give weights 1 and 1/4; a query containing one of each has a reference-relative score of 1/2. Omitting TGG leaves the family unavailable, rather than supplying a zero.

Joined segments, reverse strands, circular-origin joins and `codon_start` use the shared CDS extractor. Query annotations must have the reference's codon meanings: tables 1 and 11 are compatible for this score; tables 4, 15 and 25 require the same explicit annotation. An absent `transl_table` remains table 1 and never inherits a recoded reference's table. The original initiation triplet is retained; this method does not estimate initiation efficiency.

Ambiguous triplets, partial terminal codons, internal stops under the declared table, pseudogenes, unsupported recoding or incomplete reference coverage prevent a full gene score. The pooled value is codon-weighted over fully scorable CDS only, with its denominator displayed. The illustrative built-in host profiles retain their existing standard-code scope.

Standard-code count-only and source-backed records keep method versions 1 and 2. Reassigned-code equivalents use versions 3 and 4 and are recomputed from the saved inputs during replay. These code-aware extensions are sequence scores; their support for a translation table does not establish biological calibration.

Method basis: [Sharp and Li (1987)](https://doi.org/10.1093/nar/15.3.1281), with synonymous families from the [NCBI genetic-code tables](https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi). A justified highly expressed reference-gene set is preferable when interpreting CAI as adaptation to that set. No expression status is inferred from a user-supplied label.

Inputs are limited to 5,000,000 genome bases, 20,000 annotations and 25,000,000 total extracted CDS bases. Portable experiments retain the existing 10 MiB AnalysisRecord limit. Checksums identify content; fresh replay also rejects saved outputs that do not match recomputation, but neither check establishes the biological validity of the reference.
