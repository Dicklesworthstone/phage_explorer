# RNA pairing and motif workflow

The browser RNA Pairing & Motif Explorer (Alt+R) analyzes an explicit nucleotide interval. The RNA Signals view of Structure Constraints (Alt+Shift+R) uses the same worker and pairing method, with forward/reverse strand projection onto the selected genomic interval.

## Choose the source and interval

Select a catalog phage or an imported local genome, then open the RNA explorer. Genome mode initially analyzes the first 600 bases, or the entire source if it is shorter. The panel states the actual interval and source length; it does not silently run a whole-genome fold.

Enter **Start (1-based)** and **End (inclusive)**, then choose **Analyze interval**. Both endpoints are included. Intervals can contain at most 6,000 bases. An analysis also has a finite computation budget, so some coding intervals below that size must be shortened. Invalid inputs and exhausted budgets produce an error without accepting a partial result.

In **Single Gene** mode, select an annotated CDS. Extraction follows joined segments, strand and `codon_start`. Positions then refer to the extracted coding transcript, not directly to genomic coordinates. A coding interval must start at position 1, 4, 7, and so on, so it begins at a codon boundary. Synonymous analysis is available for standard table 1 and table 11 elongation codons. CDS annotations with other translation tables, translation exceptions or pseudogene annotations retain nucleotide pairing analysis without synonymous interpretation when their sequence can be extracted.

The RNA Signals view also accepts explicit genomic intervals and a strand choice. Its result coordinates project back onto the original forward genomic coordinates, including reverse-strand results.

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

The RNA panels provide export. They do not currently provide a saved-library reopen or a JSON import/replay control. Keep the exported JSON when you need the exact result and input outside the current panel.

## Core API and bounds

The shared core exports `foldRnaPairing`, `analyzeRNAWindows`, `computeSynonymousStress`, `analyzeRNAStructure`, `analyzeGeneRNAStructure`, `resolveRNAStructureOptions`, `RNA_PAIRING_METHOD` and `RNA_STRUCTURE_LIMITS`.

Core callers must supply the intended coding interval and reading frame when enabling synonymous analysis. Browser request validation additionally requires an explicit selected CDS for that interpretation. Legacy names such as `deltaG` and `wildTypeDeltaG` remain for source compatibility; their values are dimensionless pairing-score changes.

Limits are 6,000 supplied bases, 240 bases in an individual fold and 100,000,000 charged dynamic-program candidate evaluations across one analysis. The budget is shared by window folds, synonymous alternatives and terminal-interval scoring, and is checked before a fold begins. Short genes use a positive step size. Inputs are never truncated to satisfy these bounds.
