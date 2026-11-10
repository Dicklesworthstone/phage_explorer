# Environmental and spacer evidence workspaces

These workspaces keep supplied inputs, their source descriptions and computed
results together. Environmental observations refer to the dataset's declared
query. Spacer comparisons use the currently selected genome and an explicitly
supplied reference library. A source label records attribution; it does not
independently authenticate an assay or reference.

## Environmental observations in the browser

Open the environmental provenance panel, titled **Environmental Sample
Evidence**.

1. Choose **Import environmental dataset or saved evidence JSON**, or paste a
   dataset under **Paste environmental dataset JSON**.
2. Review the accepted query, source, measurement method and sample count.
   Importing a dataset validates it; select **Analyze environmental observations**
   to calculate summaries.
3. Inspect **Overview**, **Biomes**, **Geography** and **All observations**.
   Detection fractions use assayed samples. Abundance means use only supplied
   numerical values. The observation table includes records without coordinates,
   dates or abundance.
4. Use **Export environmental dataset** for reusable inputs, **Export
   environmental evidence** for the replayable experiment, or **Export all
   observations TSV** for every sample.
5. Reimport the evidence JSON through the same file input to verify identities
   and recompute all summaries. A changed result fails verification even if its
   checksums were regenerated.

Files are processed locally in a worker. **Cancel environmental work** stops
the owned operation; an error or cancellation preserves the last accepted
input/result. Changing the selected catalog phage does not rename the imported
query. Table paging and the first-1,000-marker geographic preview do not truncate
JSON or TSV exports.

### Version-1 dataset contract

The format is `phage-explorer-environmental`, version `1`. Inputs are limited
to 4 MiB of UTF-8 JSON and 5,000 samples. Empty sample arrays are valid and produce
an explicit no-observations warning. All listed fields are required, including
nullable fields; unsupported fields are rejected.

| Object | Fields |
| --- | --- |
| Dataset | `format`, `version`, `name`, `query`, `source`, `measurement`, `samples` |
| `query` | `id`, `label`, `accession` (string or `null`) |
| `source` | `kind` (`local`, `external` or `demo`), `study`, `reference` (string or `null`), `version`, `license` (string or `null`) |
| `measurement` | `type` (`presence`, `counts` or `relative-abundance`), `method`, `normalization` |
| Each sample | Unique `id`, `accession` (string or `null`), `biome`, `country` (string or `null`), `location` (object or `null`), `collectionDate` (string or `null`), `occurrence`, `abundance` (number or `null`) |
| Non-null `location` | `latitude`, `longitude`, `uncertaintyKm` (number or `null`) |

Text fields must be nonempty and contain no control characters. Supported biomes
are `gut`, `marine`, `freshwater`, `soil`, `hot_spring`, `wastewater`,
`clinical`, `food` and `unknown`.

This complete example is deliberately marked `demo`; its samples are invented:

```json
{
  "format": "phage-explorer-environmental",
  "version": 1,
  "name": "Synthetic sample-format example",
  "query": {
    "id": "synthetic-query",
    "label": "Synthetic query; no catalog association",
    "accession": null
  },
  "source": {
    "kind": "demo",
    "study": "Invented observations illustrating detected, zero and unassayed records",
    "reference": null,
    "version": "1",
    "license": "CC0 for this synthetic example"
  },
  "measurement": {
    "type": "counts",
    "method": "Invented example counts; no experimental assay",
    "normalization": "Synthetic counts per example sample"
  },
  "samples": [
    {
      "id": "EXAMPLE-1",
      "accession": null,
      "biome": "wastewater",
      "country": null,
      "location": {
        "latitude": 0,
        "longitude": 0,
        "uncertaintyKm": null
      },
      "collectionDate": "2000-02",
      "occurrence": "detected",
      "abundance": 12
    },
    {
      "id": "EXAMPLE-2",
      "accession": null,
      "biome": "wastewater",
      "country": null,
      "location": null,
      "collectionDate": "2000-02-29",
      "occurrence": "not-detected",
      "abundance": 0
    },
    {
      "id": "EXAMPLE-3",
      "accession": null,
      "biome": "wastewater",
      "country": null,
      "location": null,
      "collectionDate": null,
      "occurrence": "not-assayed",
      "abundance": null
    }
  ]
}
```

The example has three samples, two assays, one detection, one reported location
and two dated records. Its wastewater detection fraction is 1/2 and its mean
measured count is (12 + 0)/2 = 6. The unassayed record contributes to neither
denominator.

### Missing values, units and precision

- `occurrence` is `detected`, `not-detected` or `not-assayed`.
  Not detected describes the supplied assay; it does not establish biological
  absence. Not assayed represents missing evidence and requires
  `abundance: null`.
- `presence` requires null abundance for every sample. `counts` accepts
  integers from 0 through 1,000,000,000,000. `relative-abundance` accepts
  finite values from 0 through 1 under the declared normalization.
  A supplied positive value requires `detected`; zero requires
  `not-detected`. An assayed record may have null abundance when occurrence
  is known but numerical abundance was not measured.
- Missing abundance is excluded from its mean, never imputed as zero.
  The panel displays the number of numerical observations used. Measurements
  retain their units and normalization; the method performs no unit conversion.
- `collectionDate` accepts valid Gregorian `YYYY`, `YYYY-MM` or
  `YYYY-MM-DD`, retaining that precision. Use null for an unknown date;
  invalid dates are refused.
- Latitude and longitude must be finite numbers in [-90, 90] and [-180, 180].
  A location needs both. Reported uncertainty is in kilometres, from 0 through
  40,075; null means unknown precision. Missing coordinates stay unlocated,
  even when country or locality text is available. No country centroid is
  substituted. Map markers have fixed size, not an abundance or uncertainty
  scale.

### Reuse an abundance dataset

Export a version-1 abundance dataset from **Abundance associations & niche
factors**. In **Use a taxon from an abundance dataset**, select that file, enter
the **exact taxon identifier** from `table.taxa`, and choose **Load selected
abundance taxon**. Review and analyze the resulting environmental input.

The adapter selects exactly that table row, keeps sample IDs/order and joins
metadata by `sampleId`, not row position. Positive values become detected;
zero values become not detected. Original counts or relative abundances are
preserved. The selected taxon ID becomes both query ID and label; the study
description and reference come from the supplied abundance source.

Optional metadata keys are `accession`, `habitat`, `country`,
`latitude`, `longitude`, `uncertaintyKm` and `collectionDate`.
Omit an optional metadata key when its value is unknown. Both coordinates are required if
either is supplied; uncertainty requires coordinates. Malformed supplied
coordinates or dates fail validation. Recognized habitat labels map to biomes;
generic `water` and unrecognized descriptions stay `unknown`.
Missing metadata produces null location/date fields, not inferred values.

### Public context, examples and separate genome comparison

**Fetch public phage-family context** explicitly contacts Serratus and NCBI SRA
for metadata associated with broad phage families. It sends no local file,
genome sequence or selected-phage name. Returned runs are all
`not-assayed` with null abundance for the environmental query: a family
metadata search supplies no query-specific sequence test. Run identities,
reported coordinates, original location text and available date precision are
retained. Failed or empty lookups do not substitute synthetic observations.

**Load synthetic environmental example** is an explicit choice. The dataset,
figures and evidence record retain their demo label, independently of the
currently selected phage.

**Compare selected genome with local catalog** is a separate sequence comparison.
Its nearest-reference 16-mer containment does not use the environmental dataset.
It is not global novelty, absence from the union of references, or environmental
abundance. Likewise, sample counts and detection fractions describe the supplied
sampling design; they do not establish habitat preference or population
prevalence.

The input validator, summarizer and replay method are defined in
[environmental-evidence.ts](../packages/core/src/analysis/environmental-evidence.ts).
