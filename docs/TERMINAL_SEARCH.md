# Search catalog entries and selected genomes in the terminal

Open search with **S**, **/** or **F2**, or choose **Search phages** in the
command palette. The palette also finds this command through terms such as
sequence, motif, gene, locus or coordinate.

Search opens in Catalog mode. **Tab** and **Shift+Tab** cycle through the modes.
Genomic modes search the currently selected, fully loaded catalog or accepted
local genome; catalog mode searches the available phage list.

| Mode | Query example | Result |
| --- | --- | --- |
| Catalog | `lambda` or `E. coli` | Matching catalog entries |
| Sequence | `ATG` | Literal nucleotide matches |
| Motif | `TATAWAW` | IUPAC motif matches, including overlapping occurrences |
| Gene | `terminase` or a locus tag | Matching gene names, locus tags or products |
| Feature | `CDS` or `tRNA` | Matching annotation types, names or products |
| Position | `1000-2000` | Overlapping features, or a position marker without an annotation |

Coordinates are **0-based and end exclusive**. Use the arrow keys to select a
result and **Enter** to open it. Genomic hits move the current sequence view and
select the exact feature when one is available. AA views receive the corresponding
sequence-view position. **Esc** cancels pending work and closes search.

## Search controls

| Control | Action |
| --- | --- |
| Ctrl+S | Cycle both, forward and reverse strands in Sequence or Motif mode |
| Ctrl+N | Cycle 0–3 allowed mismatches in Sequence mode |
| Ctrl+F | Toggle fuzzy matching in Gene or Feature mode |
| Ctrl+T | Toggle case sensitivity in genomic text modes |
| Ctrl+R | Reload the selected source and retry the current query |
| Ctrl+U | Clear the current query |
| Left / Right, Home / End | Move within the query |
| Ctrl+A / Ctrl+E | Move to the beginning or end of the query |
| Backspace / Delete | Remove text before or at the cursor |

Each mode retains its own query while the overlay remains open. Pasted control
characters are treated as text, so a paste cannot submit a result or change modes.

## Source and computation limits

Genomic search requires a complete sequence of 1–5,000,000 bases. Queries are
limited to 10,000 characters and results to 500; refine a query when that result
limit is reached. Reads and worker scans have finite deadlines and can be retried.
No sequence or annotation is uploaded.

Missing, incomplete or failed reads show an explicit unavailable state. Changing
the selected genome, repository, catalog list, mode or query invalidates pending
results. Closing search terminates its worker; late replies cannot navigate the
newly selected source.
