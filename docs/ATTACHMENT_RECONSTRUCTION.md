# Reconstruct supplied attachment sites

Switch to **Power** mode, then open **Prophage excision** from the command palette
or use **Alt+X**. Integration uses an explicitly selected phage and a host locus
you provide. The same panel also reconstructs excision from a supplied integrated
locus without requiring a selected phage; see the
[excision coordinates and example](../README.md#supplied-integration-and-prophage-excision).
The separate, optional repeat-search view remains available for exploratory
sequence hypotheses.

## Complete a reconstruction

1. Select a catalog phage or import and accept a local genome.
2. Enter a host locus name, source reference and version. Paste one FASTA record
   or raw DNA, or choose a local FASTA file. Declare a linear locus or a complete
   circular host molecule; an optional accession and license stay with the input.
3. Supply the shared attB and attP crossover-core coordinates and their
   orientations, with evidence or an explicit hypothesis for each. Form
   coordinates are **1-based inclusive** in each original forward sequence.
   Exported coordinates are **0-based, end-exclusive**.
4. Declare that the phage input is circular, or explicitly assume that it has
   circularized. The first choice requires circular topology in the source.
   Set the number of context bases to show around each junction.
5. Choose **Reconstruct declared attachment sites**. The worker validates the
   complete inputs, requires exactly matching oriented cores, and builds the
   conditional integrated sequence, attL/attR previews and source-coordinate map.

Unambiguous A/C/G/T input is required. Each sequence is limited to 1,000,000
bases, with at most 1,500,000 combined. Cores contain 1–256 bases and cannot wrap
across an input origin. Reorigin a source explicitly if necessary. Context
previews allow up to 1,000 bases per side and shorten at linear boundaries or
to avoid repeating bases from a circular product. Host files are limited to
4 MiB; saved experiment JSON is limited to 10 MiB.

The product retains every base from both supplied substrates exactly once.
Its length is the sum of the host and phage lengths, and its topology follows
the host. The phage may be reverse-complemented and rotated at the supplied
attachment site. attL and attR follow the declared attB orientation, so a
reverse-strand attB exchanges their left/right positions in the displayed
forward sequence.

## A small hand-checkable example

This is synthetic sequence arithmetic, not a biological attachment-site reference.
Import a local phage FASTA containing `CCACAA` and use host DNA `TTACGG`.
For both inputs, declare positions **3–4**, forward strand, as the shared
`AC` core; state that phage circularization is an assumption. Choose two
context bases per side.

The expected integrated sequence is `TTACAACCACGG`: six host bases plus six
phage bases. The attL preview is `TTACAA`, and the attR preview is `CCACGG`.
These literal results let you inspect coordinate conversion and conservation
without treating an arbitrary short match as an experimentally active site.

## Preserve and reopen the experiment

**Export complete attachment experiment** includes both input sequences,
source declarations, exact sites, topology/circularization assumptions, options,
junctions, integrated sequence and coordinate map. **Export integrated sequence
FASTA** contains every product base; the on-screen preview may be abbreviated.
**Export junction previews FASTA** contains the two displayed contexts.

**Saved attachment experiments on this device** uses the existing opt-in local
research library. Save captures the accepted result, excluding later draft
edits. Reopening a local snapshot or exported JSON recomputes the operation and
checks its recorded identity. The saved sources are self-contained; they do not
depend on the currently selected catalog genome. A mismatched result is refused.
No sequence is uploaded; replay uses the embedded sources.

## Replay complete reconstructions from the terminal

A newly built native executable can verify an exported attachment integration or
prophage excision experiment without a browser, current catalog or original
source file:

```bash
phage-explorer workflow replay-experiment --input attachment-experiment.json
phage-explorer workflow replay-experiment --input attachment-experiment.json --output verified-attachment.json
phage-explorer workflow replay-experiment --input excision-experiment.json --output verified-excision.json
```

From a source checkout, replace `phage-explorer workflow` with `bun run workflow`.
Replay reconstructs from the embedded sources, topology, declared sites and
options, then checks the complete method, reference and result identities. An
attachment record retains its integrated molecule, junctions and coordinate map.
An excision record retains both the excised phage and restored host, their
junctions, topology, source origins and complete coordinate maps. Changed outputs
are refused even when their file checksums have been recomputed.

Standard output is a verification report with result and input identities; it
does not print the sequences. `--output NEW_FILE` exclusively creates the complete
verified AnalysisRecord JSON and never overwrites an existing file. These two
methods have no TSV representation; `--format tsv` fails before creating a file.
The JSON contains private source and product sequences. `--timeout-ms` and
cancellation terminate the owned replay worker. Verification establishes
reproducibility of the declared sequence operation, not source authentication or
biological activity.

## What the result means

This is conditional conservative sequence composition from supplied attachment
declarations. It does not discover active sites, establish host range, predict
integration/excision probability, or validate integrase compatibility. The
identical core is not the complete binding site, and the canonical splice
position is a sequence convention rather than an inferred biochemical cleavage
position.

[Singh, Ghosh and Hatfull (2013)](https://doi.org/10.1371/journal.pgen.1003490)
describes attachment-site identity and biological requirements in the Bxb1
serine-integrase system. It motivates keeping sequence composition separate
from a claim of recombinase activity; it is not a calibration dataset for this
generic operation.
