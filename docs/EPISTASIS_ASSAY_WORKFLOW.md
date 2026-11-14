# Measured epistasis assays

Open **Epistasis explorer** from the command palette, or use **Alt+Shift+E**.
The first panel accepts a local assay dataset or a previously exported evidence
record. It starts empty; **Load synthetic assay example** is an explicit
arithmetic demonstration with demo provenance.

This workspace analyzes the reference protein and observations in the supplied
file. Selecting a catalog genome does not rename or change that assay. The
optional BLOSUM62 sequence illustration is separate, is collapsed initially,
and does not supply missing assay measurements.

## Import and analyze

1. Download the synthetic example to see the complete JSON format, or prepare
   a dataset using the schema below.
2. Choose **Import epistasis assay or saved evidence JSON**, or paste JSON into
   **Paste or edit an assay dataset** and select **Load assay draft**.
3. Review the accepted protein, provenance, assay conditions, units, scale and
   replicate design. Loading a dataset does not run an analysis.
4. Set the bootstrap count and seed, then select **Analyze accepted assay**.
   A count of 0 disables bootstrap intervals; otherwise use 200–2000 samples.
5. Inspect each double mutant's components, missing controls, uncertainty and
   excluded paired blocks. **All assay observations** paginates every supplied
   row, including observations excluded from an individual paired comparison.

An edit in the JSON or settings draft affects the next explicit load or run.
Displayed evidence and downloads continue to describe the accepted inputs and
settings. A rejected import or cancelled operation preserves the prior accepted
result. Each job uses a disposable worker; closing the panel terminates active
work. Export the evidence before closing or reloading if it must be retained.

## Version 1 dataset

This minimal artificial dataset estimates a point contrast of 3 response units.
One observation per genotype is insufficient for an empirical standard error or
bootstrap interval. For real data, supply independent replicate measurements
and replace every identifying and methodological field.

```json
{
  "format": "phage-explorer-epistasis-assay",
  "version": 1,
  "name": "Minimal synthetic arithmetic example",
  "source": {
    "kind": "demo",
    "description": "Artificial measurements for demonstrating the format.",
    "reference": null,
    "license": "CC0-1.0"
  },
  "protein": {
    "id": "synthetic-peptide",
    "accession": null,
    "sequence": "ACDE"
  },
  "assay": {
    "name": "Synthetic response",
    "units": "response units",
    "conditions": "Artificial independent observations, one per genotype.",
    "scale": "identity",
    "replicateDesign": "independent"
  },
  "observations": [
    { "variant": "WT", "replicateId": "unit-1", "value": 10 },
    { "variant": "A1G", "replicateId": "unit-1", "value": 12 },
    { "variant": "C2T", "replicateId": "unit-1", "value": 13 },
    { "variant": "A1G:C2T", "replicateId": "unit-1", "value": 18 }
  ]
}
```

Use source kind **local** for supplied observations; **demo** explicitly denotes
synthetic data. Reference and accession may be null. Describe the independent
sampling unit, conditions and any prior processing explicitly. Source
attribution and license text are retained as supplied, not independently
authenticated.

The protein must contain exact uppercase canonical amino acids. A variant is
**WT**, one substitution such as **A1G**, or two substitutions such as
**A1G:C2T**. Positions are 1-based in that exact protein; the original residue
must match. Double substitutions are canonicalized by position. Different
replacement residues at the same position identify different variants.
Indels, stop changes, unknown residues and higher-order variants are not
supported by this method.

Each observation has a finite numerical value and a replicate ID unique within
its variant. A missing measurement is an absent row, never a zero or a blank.
A measured zero is valid on the identity scale. Censored measurements are not
silently treated as exact measurements. Unknown fields and duplicate
variant/replicate identities are rejected.

## What the contrast means

For each supplied double variant AB, the method requires the matching WT,
single A and single B. It estimates:

```text
mean(g(AB)) - mean(g(A)) - mean(g(B)) + mean(g(WT))
```

- **identity** uses the reported numerical values and an additive null.
  The contrast has the original assay units.
- **natural-log** takes the natural logarithm of each observation before
  averaging. Every value must be strictly positive; no pseudocount is added.
  This estimates a dimensionless log contrast under a multiplicative
  geometric-mean null. It is not the logarithm of arithmetic means. Do not
  choose this option for measurements that have already been logged unless
  applying a second logarithm is the explicitly intended estimand.

The sign denotes a larger or smaller assay response than this declared null.
It does not establish benefit, synergy, antagonism, organismal fitness, binding
energy or escape probability. There is no prediction of unmeasured mutants
and no significance or multiple-testing decision.

## Replicate design and uncertainty

**independent** treats genotype groups as independent and uses all observations
within each required group. Shared replicate labels across groups do not imply
pairing under this design. Summarize technical repeats within their actual
independent unit beforehand. Measurements normalized to a shared uncertain
control may violate the independent-group assumption.

**paired** matches equal replicate IDs across WT, both singles and the double.
Only complete four-genotype blocks contribute to that comparison. The point
estimate is the mean within-block contrast. Every incomplete block is listed
with its missing variants and remains available in the full observation table.
Different double mutants can retain different blocks; excluded missingness can
bias the retained comparison.

Standard errors use sample variances of independent genotype groups or paired
block contrasts. At least two independent units are required in each necessary
group. Optional seeded bootstrap intervals resample within genotype groups or
resample complete paired blocks, preserving the declared design. They require
at least three units in each necessary group and empirical variation.
Insufficient or degenerate intervals are unavailable rather than displayed as
zero uncertainty.

Intervals are central 95% percentile intervals conditional on the observations
and sampling assumptions. Small samples, systematic assay error, dependence
and selection can invalidate their nominal coverage. Comparisons sharing
controls are correlated. Intervals are pointwise, not simultaneous or corrected
for multiple comparisons. The seed is an unsigned 32-bit integer, including 0;
it is preserved even when bootstrap is disabled.

## Complete exports and verified replay

- **Export accepted assay** downloads canonical version 1 JSON, including the
  exact protein and all observations.
- **Export epistasis evidence** downloads a portable AnalysisRecord containing
  the complete input, method version, parameters, seed, output, provenance and
  content identities.
- **Export all contrasts TSV** includes every double variant, component counts
  and means, missing groups, complete and incomplete blocks, and the reason
  uncertainty is unavailable.
- **Export all assay observations TSV** includes every raw and transformed
  observation. Neither TSV is restricted to the visible page. Unavailable
  numbers are written as NA. Formula-looking text labels are escaped for
  spreadsheet import; signed numerical observations remain numbers.
- **Verify accepted epistasis evidence**, or importing a saved evidence file,
  recomputes the method from its embedded input. Stored output is never
  installed just because its checksum is valid. Modified method, settings,
  evidence or interpretation fails replay and leaves the accepted result
  unchanged.

All computation runs locally without an assay-upload API. Exported JSON and TSV
contain the supplied identifiers, sequence, measurements and attribution.

## Explicit bounds

Datasets are limited to 2 MiB, 20,000 protein residues, 4,096 observations,
1,024 variant groups and 512 measured double mutants. Saved evidence files
have a 10 MiB limit. Analysis also bounds total observation uses across pairs
and bootstrap draws; exceeding a limit produces an error, never a truncated
result. Reducing bootstrap samples, disabling intervals or analyzing fewer
double mutants can bring a large dataset within those bounds.

The core module also exposes a strict three-column CSV/TSV observation parser
with header **variant,replicate_id,value**. Callers must supply explicit protein,
source and assay metadata separately. The browser accepts the complete JSON
dataset so those definitions cannot be silently guessed.
