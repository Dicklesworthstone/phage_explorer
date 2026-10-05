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

Weights are counts divided by the maximum count in the synonymous family; CAI is their geometric mean. Met, Trp and terminal stops are excluded. Joined segments, reverse strands, circular-origin joins and `codon_start` use the existing CDS extractor. Only genetic codes 1 and 11 are supported. Ambiguous triplets, partial terminal codons, internal stops, pseudogenes, unsupported recoding or incomplete reference coverage prevent a full gene score. The pooled value is codon-weighted over fully scorable CDS only, with its denominator displayed.

Method basis: Sharp and Li (1987), DOI `10.1093/nar/15.3.1281`. A justified highly expressed reference-gene set is preferable when interpreting CAI as adaptation to that set. No expression status is inferred from a user-supplied label.

Inputs are limited to 5,000,000 genome bases, 20,000 annotations and 25,000,000 total extracted CDS bases. Portable experiments retain the existing 10 MiB AnalysisRecord limit. Checksums identify content; fresh replay also rejects saved outputs that do not match recomputation, but neither check establishes the biological validity of the reference.
