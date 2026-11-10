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

## Environmental observations from the command line

The installed executable exposes the same local dataset, producer and replay
contracts without opening a catalog or requiring a browser:

```bash
phage-explorer environment inspect samples.json --output reviewed-samples.json
phage-explorer environment analyze reviewed-samples.json --output sample-evidence.json
phage-explorer environment replay sample-evidence.json --output verified-evidence.json
phage-explorer environment replay sample-evidence.json --format tsv --output all-samples.tsv
```

`inspect` validates and exports a dataset without creating an analysis. `analyze`
creates the portable evidence record. `replay` recalculates every summary and
checks the complete original result identity; even a changed result with fresh
checksums is refused. Browser and terminal records can be replayed in either
surface. TSV contains every observation, including not-assayed records and
missing dates, coordinates or abundance. Its empty fields are not zeros, and it
is a table rather than a replayable experiment.

To derive environmental observations from an abundance matrix, choose an exact
taxon ID and join any metadata using the existing abundance importer:

```bash
phage-explorer abundance inspect counts.csv --metadata samples.csv --output community.json
phage-explorer environment from-abundance community.json --taxon query-id --output query-samples.json
phage-explorer environment analyze query-samples.json --output query-evidence.json
```

`from-abundance` also accepts CSV/TSV or a saved abundance analysis. A saved
analysis must pass fresh abundance replay before its inputs are used. The
conversion selects only the exact supplied taxon, joins metadata by sample ID,
and produces a dataset for review. A missing taxon is an error; source kinds,
zeros, missing metadata, measurement units and declared location/date precision
retain the same meaning as in the browser. No public metadata lookup occurs.

Use `-` as the input for UTF-8 stdin. Output goes to stdout unless `--output`
names a new path; structured progress and errors go to stderr. Files are bounded
to 10 MiB and source datasets to 4 MiB/5,000 samples. Only regular files are read;
existing output files and symlinks are refused, and new output files use
owner-only permissions. Computation runs in an owned native worker embedded in
the compiled executable. Ctrl-C or `--timeout-ms` cancels before publication;
once publication begins, the complete accepted output is written. The default
timeout is 300,000 milliseconds, with an explicit range of 1–3,600,000.

For a source checkout, prefix the same arguments with
`bun packages/tui/src/index.tsx environment`. Run
`phage-explorer environment --help` for the full command contract.

## Spacer-reference evidence in the interactive terminal

Select the genome to compare, then press **F6** from the main terminal screen
to open **CRISPR Spacer Reference Evidence** immediately. **I** also opens the
panel after the terminal's existing intermediate-tier unlock.
The reference-library format is the same `phage-explorer-spacer-library`
version `1` used by the browser CRISPR panel.

1. Press **l**, enter a local library JSON path, and press Enter. Review its
   source, hosts and scope in **4: Source**. No DNA search runs merely by loading
   a library.
2. Use **h** to cycle between all hosts and individual hosts, or **H** to enter
   an exact library host ID. Use **+/-** to choose 0–5 substitutions.
3. Choose topology with **o** when it is unspecified. Known topology from an
   imported genome is retained. Unknown topology does not imply circular
   origin-spanning sequence.
4. Press **Enter** to read the complete selected genome and run the comparison.
   Inspect hits, coverage and excluded references separately.
5. Export accepted spacer evidence with **e** (replayable JSON) or **t**
   (complete hit TSV). Use **b** to export the loaded reference library.
   Each export asks for a new output path.
6. Press **r** and supply saved evidence JSON to recompute and verify it against
   the current genome identity, exact DNA and selected topology. A saved result
   is accepted only when fresh evidence agrees.

| Key | Action |
| --- | --- |
| F6 | Open spacer evidence from the main screen, without a tier wait |
| `l` | Load a local spacer-library JSON file |
| `h` / `H` | Cycle host scope / enter an exact host ID; blank selects all |
| `+` / `-` | Adjust allowed substitutions, from 0 through 5 |
| `o` | Cycle unknown/linear/circular topology when source metadata has not fixed it |
| Enter | Search with the displayed draft settings |
| `1` / `2` / `3` / `4` | Hits / Coverage / Excluded / Source |
| `A` / `5` | Run the optional Acr heuristic / inspect its separate shortlist |
| Arrows, Page Up/Down, Home/End | Page through all displayed rows |
| `r` | Verify a saved spacer experiment through fresh computation |
| `e` / `t` / `b` | Export accepted spacer JSON / all hit TSV / loaded library JSON |
| `c` | Cancel current work, preserving prior accepted spacer evidence |
| Esc | Cancel a path prompt, cancel active work, or close an idle panel |
| `I` | Close the panel and cancel its owned work |

The panel distinguishes draft settings from those used by the accepted result.
Changing a host, mismatch allowance or topology does not relabel old hits.
Switching the repository or selected genome invalidates old accepted evidence;
a reference library may be retained for the next comparison.

Paths are local regular UTF-8 files. Library input is limited to 2 MiB and saved
spacer evidence to 10 MiB. Output paths are created exclusively with owner-only
permissions; existing files and symlinks are refused. All file-path input is
literal: these prompts do not execute shell commands or expand shell syntax.

### Reference scope and interpretation

A library declares a source kind/reference/version/license/scope, named hosts
and strains with accessions, and spacer records with host IDs and array
accessions. Each spacer explicitly declares DNA/RNA/unknown target,
guide-equivalent/unknown orientation, and an optional system designation.
A PAM or seed rule includes its source reference; no rule is guessed from a
host or system name. See the
[spacer-library interfaces and validator](../packages/core/src/analysis/spacer-reference.ts)
for the complete field contract.

The matcher searches both genome strands using supported, unambiguous
20–128-base DNA spacers in guide-equivalent orientation. Unsupported references
remain visible as exclusions. Up to 500 hosts, 10,000 records and a
5,000,000-base genome are accepted; additional hit/work limits fail explicitly
instead of accepting a truncated search. The five-minute worker timeout and
cancellation keep the terminal responsive.

Coordinates are zero-based, half-open intervals on the forward genome.
Circular hits retain traversal-ordered segments when crossing the origin.
Mismatch offsets and PAM/seed interpretation follow guide-equivalent
orientation. The TSV includes all accepted hits, source metadata, rule outcomes
and coordinate conventions.

A sequence match is not proof of immunity, host range or anti-CRISPR activity.
No supplied data, unsupported references, no usable DNA windows and no sequence
match are distinct results. Review host/reference coverage and PAM/seed
limitations before interpreting a hit or absence of hits.

### Optional Acr candidate heuristic

Press **A** to run the independent sequence-only size/charge heuristic for the
current genome's eligible annotated genes; inspect **5: Acr heuristic**.
It requires no spacer library. Work runs in the native worker and can be
cancelled with **c**. Genome changes invalidate its result.

The shortlist reports a heuristic score and its size/charge rationale.
These scores are uncalibrated, not probabilities or confirmed anti-CRISPR
annotations. The method handles a bounded set of short contiguous coding
spans; unsupported annotations are reported separately rather than silently
flattened into a sequence. Its simple translation assumptions limit coverage.
The spacer JSON and hit TSV exports describe the accepted spacer comparison;
the Acr shortlist is a separate analysis.
