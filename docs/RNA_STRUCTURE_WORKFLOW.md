# RNA pairing and motif workflow

The browser RNA Pairing & Motif Explorer (Alt+R) analyzes an explicit nucleotide interval. The RNA Signals view of Structure Constraints (Alt+Shift+R) uses the same worker and pairing method, with forward/reverse strand projection onto the selected genomic interval.

## Choose the source and interval

Select a catalog phage or an imported local genome, then open the RNA explorer. Genome mode initially analyzes the first 600 bases, or the entire source if it is shorter. The panel states the actual interval and source length; it does not silently run a whole-genome fold.

Enter **Start (1-based)** and **End (inclusive)**, then choose **Analyze interval**. Both endpoints are included. Intervals can contain at most 6,000 bases. An analysis also has a finite computation budget, so some coding intervals below that size must be shortened. Invalid inputs and exhausted budgets produce an error without accepting a partial result.

In **Single Gene** mode, select an annotated CDS. Extraction follows joined segments, strand and `codon_start`. Positions then refer to the extracted coding transcript, not directly to genomic coordinates. A coding interval must start at position 1, 4, 7, and so on, so it begins at a codon boundary. Synonymous analysis is available for standard table 1 and table 11 elongation codons. CDS annotations with other translation tables, translation exceptions or pseudogene annotations retain nucleotide pairing analysis without synonymous interpretation when their sequence can be extracted.

The RNA Signals view also accepts explicit genomic intervals and a strand choice. Its result coordinates project back onto the original forward genomic coordinates, including reverse-strand results.

## Analyze private inputs from the terminal

The native workflow commands can create a fresh RNA experiment directly from
local FASTA, GenBank or a private genome bundle:

```bash
phage-explorer workflow inspect-rna --input genomes.fa
phage-explorer workflow inspect-rna --input genomes.fa --record CONTENT_ID
phage-explorer workflow inspect-rna --input annotated.gb --gene CDS_ID
phage-explorer workflow analyze-rna --input genome.fa --start 3 --end 11 --strand - \
  --window 9 --step 9 --wobble false --output rna.json
phage-explorer workflow replay-experiment --input rna.json --output verified-rna.json
phage-explorer workflow replay-experiment --input rna.json --format tsv --output rna-windows.tsv
```

Replace `CONTENT_ID` and `CDS_ID` with identifiers shown by inspection. For a
multi-record input, the initial inspection lists every record name and complete
content ID, leaving the selected source empty. Select `--record CONTENT_ID` to
inspect that genome's CDS rows or analyze an interval; accession labels and file
order never choose between multiple records. Single-record input needs no
`--record`. Adding `--gene CDS_ID` inspects that annotation's extracted transcript
length and whether synonymous analysis is available. Inspection does not compute
structures or print nucleotide sequences.

`analyze-rna` requires `--start`, `--end` and `--strand`. Coordinates are one-based
and inclusive at the command line. Without `--gene`, they address the original
forward genome and either `+` or `-` is accepted. With `--gene`, they address
the extracted transcript after joined/complemented segments and `codon_start`;
use `--strand +` and start at a codon boundary (1, 4, 7, ...). The interval must
fit that actual source and contain at most 6,000 bases. The command never trims
an out-of-range interval or silently selects another CDS.

| Option | Default | Accepted values |
|---|---|---|
| `--window` | 120 bases for genomes; 60 for CDS | 1–240 bases |
| `--step` | 30 bases for genomes; 15 for CDS | 1–6,000 bases |
| `--min-loop` | 3 | 0–30 intervening bases |
| `--wobble` | `true` | `true` or `false` |
| `--synonymous` | `false` | `true` only for supported selected CDS |

Default window and step sizes are reduced to the selected interval's length
when it is shorter. Explicit values are retained as requested; only complete
windows are folded. Every resolved setting is saved in the result. Synonymous
analysis requires an annotation-defined table 1 or 11 CDS without exceptional
or pseudogene annotations. Other supported CDS can still receive pairing-only
analysis.

Use `--output NEW_FILE` for the complete AnalysisRecord JSON, or add
`--format tsv` for every returned window and its original source coordinates.
The JSON opens in the browser RNA explorer and replays through the existing
`replay-experiment` command without the original input file or catalog. Both
exports contain private sequence data. Standard output reports the selected
content ID, coordinate source, parameters and result identity without printing
the sequence.

Input reads are bounded, outputs are created exclusively, and an existing file
is never replaced. `--timeout-ms` and cancellation terminate the owned analysis
worker; invalid selections and failed calculations create no partial analysis
output. These commands use the same bounded maximum-pairing method and
interpretation limits described below. From a source checkout, replace
`phage-explorer workflow` with `bun run workflow`; an older installed executable
must be rebuilt to acquire the new commands.

## Inspect actual structures

Each full window receives an exact maximum-pairing solution under the following declared objective:

- A–U and C–G pairs, with G–U wobble enabled by the browser defaults.
- At most one partner for each nucleotide.
- No crossing pairs.
- At least three intervening bases between paired positions by default.
- Equal unit weight for every permitted pair.

An interval dynamic program and deterministic traceback produce the actual pair list, pair count and dot-bracket structure. On a tie, the implementation prefers an unpaired right endpoint and then the lowest-index partner. This chooses one optimum; it does not estimate how probable that structure is.

The browser uses windows of up to 120 bases at 30-base steps for genomic intervals, and up to 60 bases at 15-base steps for coding transcripts. A shorter selected interval reduces the window and step as needed. Only complete windows are folded. Inspect every returned window in the expandable structure table, including its sequence, coordinates, pair count and paired fraction. Independent, potentially overlapping windows are not a single compatible whole-transcript structure.

The pairing score is **minus the pair count**, with no energy unit. A window without pairs retains a null score and an explicit zero pair count. The displayed mean includes windows with pairs only. IUPAC ambiguity is preserved in the input and reported in coverage; ambiguous bases cannot pair.

This objective has no nearest-neighbor energies, temperature, stacking or loop energies, pseudoknots, kinetic model, or ensemble probabilities. Pair counts are not minimum free energies or measurements of RNA stability. The algorithm family is described by [Nussinov and Jacobson (1980)](https://doi.org/10.1073/pnas.77.11.6309); the exact implemented objective and limitations travel with each result.

## Synonymous sensitivity and motif candidates

Genome coordinates alone do not establish a reading frame, so genome mode does not compute synonymous scores. For a supported selected CDS, each synonymous substitution is evaluated at the precise codon position within a local context of up to 30 nucleotides on either side. The score is the change in the same unit-weight pairing objective.

The heat strip normalizes score sensitivity within the selected input. Equal values receive tied midranks; all-zero inputs cannot manufacture highly sensitive codons. Stop and ambiguous codons are skipped, and skipped intervals break contiguous sensitive regions. These results describe mathematical score variability, not selection, expression, fitness, or a measured functional effect.

Regulatory labels are separate sequence-pattern hypotheses. The fixed motif scanner reports its observed sequence and coordinates, including Shine–Dalgarno spacing and a candidate stem immediately followed by a U tract. It does not attach calibrated confidence values. Motif scanning uses its own fixed rules; changing a core window-fold option does not redefine those motif rules. A GC-rich paired interval end is not evidence that the selected interval is a biological genome or transcript terminus.

## Cancellation and export

Computation runs in an owned browser worker. Cancel, close, a source change, or a new submitted interval retires that worker; a late response cannot replace a newer input. Draft interval edits do not relabel an accepted result.

**Export RNA analysis** writes the complete accepted AnalysisRecord JSON, including:

- The exact submitted interval sequence and source metadata.
- The source coordinate system, interval bounds and strand.
- Resolved parameters, method identity, reference and limitations.
- All window structures, pair coordinates, codon sensitivities, motif observations and coverage.

Input and exported result coordinates are zero-based and half-open; the browser presents one-based inclusive coordinates. For reverse-strand genomic analysis, the original forward interval is preserved and the worker analyzes its reverse complement. For a selected gene, the saved interval is already in transcript order.

## Reopen and verify saved experiments

Expand **Reopen an exported RNA experiment** in the RNA Pairing & Motif Explorer
and select the saved AnalysisRecord JSON (up to 10 MiB). The importer checks the
file's integrity, method, coordinate source and complete settings, then runs the
original interval through an owned worker. Every recomputed field must match the
saved evidence before a result is shown as verified. A valid checksum with
fabricated structures, changed scores or different evidence descriptions is
rejected.

The reopened result is labeled with its **saved source**, coordinate system,
interval and strand. It does not adopt the current explorer genome's name or
change that genome's selection. Closing the RNA overlay or choosing **Cancel RNA replay**
interrupts both file reading and computation; a cancelled file or late worker
reply cannot install a new result. This path also accepts exports from the RNA
Signals view, including reverse-strand genomic intervals. Unsupported method
versions are refused rather than recalculated using new defaults.

**Export verified RNA JSON** retains the full replayable experiment.
**Export verified RNA windows TSV** contains every folded window, with zero-based,
half-open bounds both relative to the analyzed interval and in its declared
source coordinate system. Pair positions are zero-based within the analyzed
interval; reverse-strand source ranges are mapped back onto the original forward
genome. A no-pair window has a blank score cell and an explicit zero pair count.
The on-screen preview shows at most 50 windows, while both exports retain all of
them. TSV is an inspection table, not a substitute for the JSON replay inputs.

The same saved export can be verified without a browser or catalog:

```bash
bun run workflow replay-experiment --input rna-pairing-analysis.json
bun run workflow replay-experiment --input rna-pairing-analysis.json --output verified-rna.json
bun run workflow replay-experiment --input rna-pairing-analysis.json --output rna-windows.tsv --format tsv
```

A newly built executable accepts the same arguments after `phage-explorer workflow`.
The existing command's exclusive-create output, timeout and cancellation rules
apply. These commands do not update an installed older binary. Original numerical
work limits remain in force, and missing source data are never fetched.

Replay verifies numerical reproducibility against the supplied source and
assumptions. It does not authenticate the source annotation or establish biological
validity. Exported JSON and TSV contain sequence data. Standalone RNA imports are
session-only; automatic persistence and standalone saved-library reopening remain
outside this interface.

## Record RNA as part of a research workflow

In **Local genomes → Saved research workflows**, start an explicit recording and
expand **Record RNA pairing intervals**. Select a workflow genome, then choose
genomic coordinates or a particular annotated CDS. This form records only its own
explicit commands; opening or changing the separate RNA explorer is not recorded.

Both interval endpoints are presented as one-based inclusive positions. Genomic
intervals can use either strand. A selected CDS is already in transcript order,
including joined/complemented segments and `codon_start`, so its strand is fixed to
forward transcript order and its start must be a codon boundary. All pairing
settings are explicit. Synonymous sensitivity is off by default and can be enabled
only for supported table 1 or 11 CDS without exceptional or pseudogene annotation.
Pairing-only analysis remains available when extraction is supported.

**Run and record RNA pairing** derives the source name, accession, coordinate
system and interval bases from the exact genome snapshot in the recording. The
worker uses the same bounded RNA producer as the standalone explorer. Accepted
results show source coordinates and dot-bracket windows; changing the draft or
cancelling a later request cannot relabel an earlier accepted result.
**Export workflow analysis** writes the ordinary replayable RNA AnalysisRecord;
**Export workflow RNA windows TSV** includes all folded windows and their
sequences. The RNA explorer and `workflow replay-experiment` can reopen the JSON.

Stop recording to export or save the command tape. **Replay and retain all results**
includes RNA outputs in the complete workflow archive, with each repetition's
execution index. Reopening an archive first reviews its sources; explicit replay
must verify every command before the archive is accepted. A modified sequence,
annotation, interval, option or recorded numerical result stops verification.

The canonical action is `overlay.rnaStructure`. Its parameters are:

```json
{
  "contentId": "<the imported genome's complete 64-character content ID>",
  "geneId": null,
  "start": 0,
  "end": 600,
  "strand": "+",
  "options": {
    "windowSize": 120,
    "stepSize": 30,
    "minLoopSize": 3,
    "allowWobble": true,
    "frame": 0,
    "includeSynonymousStress": false
  }
}
```

These stored coordinates are zero-based and half-open. `geneId: null` selects the
genome; a positive CDS ID selects its annotation-defined transcript. The complete
original source remains in `context.bundle`, not in a path or URL. The exact
method parameters, inputs and result identity are verified on every replay.

These commands also work in declarative terminal plans passed to `workflow record`,
then `workflow replay`, `replay-results` and `extract-result`. No catalog or source
network request is needed. The interactive terminal draft editor retains its
existing analysis choices; RNA commands can be authored through the browser form
or a validated declarative plan. Existing tape, analysis, execution-count and
computation limits apply. No new RNA model or biological validation is implied by
recording the existing method.

## Core API and bounds

The shared core exports `foldRnaPairing`, `analyzeRNAWindows`, `computeSynonymousStress`, `analyzeRNAStructure`, `analyzeGeneRNAStructure`, `resolveRNAStructureOptions`, `RNA_PAIRING_METHOD` and `RNA_STRUCTURE_LIMITS`.

Core callers must supply the intended coding interval and reading frame when enabling synonymous analysis. Browser request validation additionally requires an explicit selected CDS for that interpretation. Legacy names such as `deltaG` and `wildTypeDeltaG` remain for source compatibility; their values are dimensionless pairing-score changes.

Limits are 6,000 supplied bases, 240 bases in an individual fold and 100,000,000 charged dynamic-program candidate evaluations across one analysis. The budget is shared by window folds, synonymous alternatives and terminal-interval scoring, and is checked before a fold begins. Short genes use a positive step size. Inputs are never truncated to satisfy these bounds.
