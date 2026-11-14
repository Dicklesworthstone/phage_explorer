# Measured virion inactivation

**Virion stability** (`Alt+V`) fits loss of plaque-forming infectivity from exact
plaque counts. Each experiment represents one phage preparation at fixed
temperature and buffer conditions, with a declared plating host. The native
workflow commands use the same versioned method. The selected catalog genome
does not supply measurements or experimental identities.

## Browser workflow

1. Open **Virion stability**. Load count CSV/TSV for review, or fit a complete
   inactivation input JSON.
2. Supply the title, source, permission/license, phage and preparation identities,
   fixed temperature, buffer, assay host, and exposure/assay context. Accession,
   source reference and measured pH may be explicitly missing.
3. Review the count CSV and support cutoff, then **Fit measured inactivation**.
4. Inspect fit status, rate support, conditional reduction times and every plate
   residual. Paging does not truncate exported observations.
5. Export accepted input JSON, complete evidence JSON or all-plate TSV.
   **Restore and verify inactivation evidence JSON** recomputes the complete
   model, support and interpretation before accepting a saved result.

The synthetic example is clearly labeled and does not borrow a catalog identity.
Source attribution is retained but not independently authenticated. Draft edits
remain separate from accepted results until a fit succeeds. Cancellation, invalid
input and failed replay preserve the last accepted result. Computation runs in
an owned worker that is terminated on cancellation or close.

Inputs remain in session memory; export before closing. Every export retains
measurements and their private experimental context. The previous composition
illustration requires **Show legacy stability illustration** and supplies no
storage recommendation.

## Native workflow

Use a newly built executable, or substitute `bun run workflow` in a source
checkout. Existing installed executables are not updated by these source changes.

```bash
phage-explorer workflow stability-template
phage-explorer workflow fit-stability --input inactivation.json --output evidence.json
phage-explorer workflow fit-stability --input inactivation.json --output plates.tsv --format tsv
phage-explorer workflow replay-experiment --input evidence.json --output verified-evidence.json
phage-explorer workflow replay-experiment --input evidence.json --output verified-plates.tsv --format tsv
```

The template prints a complete synthetic input to stdout. Fit/replay commands
print a report; `--output` creates evidence or a table as a **new file**. Existing
files and symlinks are not replaced. Computation/verification failure creates no
output; a failed final disk write can leave a partial new file. `--timeout-ms`
accepts 1–3,600,000 ms (default 300,000). No catalog or browser is required.

## Input contract

Use `format: "phage-explorer-inactivation-input"`, `version: 1`, and
`measurement: "infectious-plaque-counts"`. The template supplies the exact schema;
all keys, including nullable keys, are required and unsupported keys are refused.

| Object | Required contents |
| --- | --- |
| Root | `format`, `version`, `measurement`, `title`, `provenance`, `preparation`, `conditions`, `csv`, `options` |
| `provenance` | `kind` (`user-supplied` or `synthetic`), `source`, nullable `reference`, `license` |
| `preparation` | `phageId`, nullable `accession`, `batchId` |
| `conditions` | `temperatureC`, `buffer`, nullable `pH`, `assayHost`, `description` |
| `options` | `supportDeviance` from 0.01–100 |

CSV and TSV use exactly `time_min,plaque_count,dilution_fraction,volume_ml`:

| Column | Meaning and limits |
| --- | --- |
| `time_min` | Minutes, 0–10,000,000. The earliest observed time supplies the fitted reference time. |
| `plaque_count` | Exact integer, 0–1,000,000. Zero is an observation. |
| `dilution_fraction` | Fraction, 1e-12–1; for example 0.001, never reciprocal 1000. |
| `volume_ml` | Plated mL, 1e-6–10. Exposure is fraction × volume. |

Inputs are limited to 1,000,000 UTF-8 bytes and 1–2,048 plate rows. Blank lines are
ignored; missing cells, TNTC, censored bounds, nonfinite numbers, optical density
and corrected PFU/mL are unsupported. Temperature is explicit (−200–200 °C); pH is
0–14 or null when unmeasured. Metadata describes the experiment but does not fit
a temperature or buffer response. Separate preparations or changing conditions
require separate experiments. One-time and all-zero observations remain
exportable with an unidentified rate.

## Model and interpretation

For exposure eᵢ and time tᵢ, the model is
`Nᵢ ~ Poisson(eᵢ Cref exp(−k (tᵢ − tref)))`, with `k ≥ 0`.
Reference concentration is reoptimized at every rate:
`Cref(k) = sum(Nᵢ) / sum(eᵢ exp(−k (tᵢ − tref)))`.
It is fitted at the earliest observed time, which need not be zero, and is not
fixed to the first plate's count/exposure ratio. The monotone profile score
provides a bracketed global finite optimum when one exists.

| Status | Interpretation |
| --- | --- |
| `estimated` | Finite positive rate and profiled concentration. |
| `zero-rate-boundary` | Zero is the constrained optimum; positive rates can remain supported. Finite reduction times are unavailable. |
| `unbounded-rate` | Positive counts occur only at the earliest time. The likelihood improves toward infinite rate; a labeled limiting fit is retained without an invented finite rate. |
| `unidentifiable` | All counts are zero or there is one sampling time. The rate and reduction times are unavailable. |

Rate support contains values whose profiled deviance loss does not exceed the
cutoff. It is **not a calibrated confidence interval**. Null upper support means
unbounded. If zero is supported, there is no finite upper bound on reduction time.
Conditional half-life is ln(2)/k; one-log reduction time is ln(10)/k. Times beyond
the observed duration are model extrapolations, not observed storage lifetimes.

Independent exact Poisson counts and known exposures are assumptions. Dilution
error, correlated samples, overdispersion, plaque overlap, selection of countable
plates, shoulder/tail kinetics and changing conditions are not modeled. Inspect
residuals and context. No molecular integrity, melting temperature, host
susceptibility, Arrhenius extrapolation or storage recommendation is inferred.

## Evidence and replay

Method `plaque-count-inactivation`, version `1`, retains exact original input
bytes, parsed plates, every prediction and residual, fit status and support,
source context, method references and limitations. Synthetic inputs produce demo
fields; supplied measurements produce observation and conditional fitted-estimate
fields. Very small positive fitted means retain finite natural-log values when
ordinary values underflow; exact/limiting zero means have null logs.

Replay compares the full recomputed record, including interpretation and metadata.
Rehashing a changed numerical result does not make it verified. Numerical replay
establishes consistency, not source authentication or biological validity. JSON
is replayable; the complete TSV contains all rows and model/source metadata.

Method context: [Wyshak and Detre (1972)](https://doi.org/10.1128/am.23.4.784-790.1972)
for plaque count estimation, [the lambda infectivity study](https://pmc.ncbi.nlm.nih.gov/articles/PMC5040123/)
for first-order loss as a conditional model, and [Raue et al. (2009)](https://doi.org/10.1093/bioinformatics/btp358)
for nuisance-parameter profiling. These are method references, not source data,
calibration or a reproduction of those studies.
