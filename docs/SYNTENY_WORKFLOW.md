# Save and replay annotation-order synteny

Open **Synteny Analysis** with **Alt+S**, or from the analysis menu. Select a
reference genome while the current genome supplies the query. Both records need
annotations and a known genome length. Catalog genomes and accepted local
FASTA/GenBank inputs use the same repository path; a FASTA without annotations
cannot supply a gene-order comparison.

## What the comparison means

The method compares the supplied annotation rows in their original order. It
uses informative product/name tokens and the Jaccard overlap of supplied domain
identifiers. Generic labels such as “hypothetical protein” do not match by name
alone; shared domain calls can still contribute. Locus tags identify rows but
are not independent matching evidence.

The heatmap and alignment use the same annotation distance. A forward DTW pass,
a reversed-order pass and a local reverse-chain search produce heuristic blocks.
Blue blocks follow the same annotation order; red blocks follow the reverse
order. These are **annotation-order scores**, not nucleotide/protein sequence
identity, established homology or validated rearrangement calls. Breakpoint
labels do not establish historical inversions, translocations or indels.

Original row order is not silently sorted, filtered or deduplicated. Gene/CDS
duplicates, missing annotations, repeated labels and reference coverage affect
the result. Gene strands and CDS qualifiers are retained, but the scoring method
does not translate CDS or align genome bases.

**Global Score** is the fraction of query annotation rows covered by accepted
blocks. **Continuity (SCS)** additionally weights similarity and penalizes block
fragmentation. **DTW Distance** is the unnormalized cost of the forward pass;
it depends on both annotation counts. **Query Coverage** is the union of block
coordinate spans, including intervening bases, rather than aligned base coverage.

Annotation indices in the JSON and tables are 0-based; block end indices are
inclusive. Genomic intervals are 0-based and end-exclusive. Reversed blocks
retain the original forward-genome coordinates. Each block span includes all
annotations in that block, including a long interior annotation.

## Portable experiments and tables

**Export synteny experiment JSON** retains both exact ordered annotation sets,
their source labels, available annotation-release metadata, the complete
similarity matrix, block coordinates, forward warping path, breakpoint labels
and summary statistics. It also records the method version, effective settings
and input/result identities. Unavailable reference-release metadata remains null.

The method does not request complete genome sequences. Original genome files
and bases are not copied automatically; every supplied annotation and qualifier
is retained, including any sequence or sensitive text already inside a qualifier.

The three TSV downloads contain all rows, not just the visible viewport:

- **All synteny blocks:** every accepted block, annotation indices, genomic
  coordinate spans, orientation and similarity.
- **Complete similarity matrix:** every query/reference annotation pair,
  including zero scores, with original gene IDs and matrix indices.
- **Source annotations:** both original row sets, IDs, labels, coordinates,
  strands, domains and qualifiers.

TSVs flatten embedded tabs and line breaks and protect text that could be
interpreted as a spreadsheet formula. JSON retains the exact original string
contents. Each table identifies its method and accepted result.

Use **Restore and verify synteny experiment JSON** to reopen an export. The
worker first validates its identities, then recomputes the entire comparison
from the embedded annotations. Even edited results with freshly recalculated
checksums must match this production computation. Unsupported method versions,
missing inputs and numerical mismatches are refused.

The panel switches to the saved experiment only after successful verification.
Its query and reference come from that experiment, independently of the current
explorer selection or catalog availability. **Return to current genome
comparison** resumes the ordinary repository-backed view. A failed or cancelled
reopen leaves the previously accepted comparison available.

## Save on this device

Expand **Saved synteny experiments on this device**, enter a name and choose
**Save snapshot locally**. This captures the currently accepted experiment.
After a reload, return to Synteny Analysis, select the snapshot and choose
**Open saved snapshot**. Opening uses the same complete recomputation as file
import, and does not add genomes to or navigate the main explorer.

Saving is explicit. Snapshots use the existing private research library; its
storage, export, cancellation and removal behavior is described in
[Save private research on this device](LOCAL_RESEARCH_LIBRARY.md). Export JSON
when a portable backup is needed.

## Bounds and ownership

An experiment accepts at most 2,000 annotation rows per genome, 500,000 pair
comparisons and 2 MiB of combined annotation inputs. Portable JSON is limited
to 10 MiB. An oversized input or result fails explicitly rather than exporting
a truncated matrix. Source reads have a 30-second deadline and owned worker
computations have a five-minute deadline.

Changing the live repository, query or reference cancels obsolete work and
hides results belonging to the previous source. Closing the overlay cancels
pending work. **Cancel synteny replay** stops a pending import/recomputation;
late file reads and worker replies cannot replace the accepted evidence.
