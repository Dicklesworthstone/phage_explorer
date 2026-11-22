# Terminal history and saved views

The terminal explorer records ordinary browsing: genome selection, coordinate and sequence-search jumps, selected CDS changes, scrolling, DNA/AA/dual mode, and reading frame. Back and Forward restore that complete viewing state. Named views can be exported and reopened in a later terminal session.

## Return to an earlier view

In the explorer, press **Ctrl+B** for Back or **Ctrl+N** for Forward. The command palette also offers **Back to previous explorer view**, **Forward to next explorer view**, and **Saved views and browsing history**. Open the palette with **Ctrl+P** or **:** and search for `history`, `saved views`, or `bookmark`.

The history keeps up to 64 accepted views. Consecutive scroll steps within a short burst share one destination while retaining the departure position. Going Back and then browsing somewhere new starts a new branch, so the old Forward branch is discarded. History is kept in the running terminal session; export named views to preserve useful locations after quitting.

## Name, export, and reopen views

1. Select a genome and the desired position, CDS, display mode, and frame.
2. Open **Saved views and browsing history** from the palette.
3. Press **N**, enter a name, and press Enter.
4. Press **E**, enter a new destination path, and press Enter to export the collection.
5. In a later session, open the same panel, press **O**, and enter that collection path.
6. Choose a named view and press Enter to restore it.

| Panel control | Action |
| --- | --- |
| Up / Down | Select an entry |
| Enter | Restore the selected view |
| Tab | Switch between named views and history |
| B / F | Back / Forward |
| N | Name the current explorer view |
| R | Rename the selected named view |
| D | Forget the selected name in this session |
| O | Open a saved-view collection |
| E | Export the named-view collection to a new file |
| Esc | Cancel the current field or operation, or return to the explorer |

Names and paths are entered literally. Their keystrokes do not trigger explorer shortcuts. Export uses exclusive file creation, so an existing destination is not overwritten. Forgetting a name does not delete any file or genome. Opening a collection merges its names without moving the explorer. Identical entries are deduplicated; a conflicting existing name must be renamed before import succeeds.

## Exact source restoration

A view records the source identity, selected gene, display mode, reading frame, and scroll position. The panel displays base or amino-acid residue positions starting at 1; serialized positions use the explorer's zero-based coordinate convention. An AA view stores a residue position, not a nucleotide position.

Before changing the selected genome, restoration reads and verifies its complete sequence and ordered annotations. Catalog sources are resolved by accession and slug, then checked against their saved fingerprint; a changed numeric catalog genome ID alone does not invalidate a view. Local sources require the exact accepted local content ID, bases, and annotations. Changed bases or annotations and unavailable selected genes are rejected with an error instead of being silently substituted.

Saved-view files contain names, viewing settings, source metadata, and fingerprints. They do **not** embed genome sequences. To restore a private genome in a fresh session, first import its original FASTA/GenBank input or saved local-genome bundle through **Local genomes: import, restore or export**. If that source is missing, the view remains available and its error explains how to supply the input. The existing local-genome workspace remains responsible for importing and preserving those genomes.

An in-progress restore is tied to its repository, source list, and viewing state. A newer selection cancels the old request. Esc cancels pending work; a prepared source that has not yet been accepted returns to the still-owned departure view, and late results cannot take over the explorer. Operations have a 15-second deadline. Cancelling or timing out a file export may leave a partial newly created destination; choose a different new path when retrying.

Collections use the versioned `phage-explorer-saved-views` JSON format and contain at most 64 named views in 1 MiB. Names contain 1–120 printable characters. Source verification supports complete genomes up to 5,000,000 bases and 50,000 annotations. These bounds apply to saved-view navigation and do not change the catalog or existing analysis limits.

## Verification

`packages/tui/src/terminal-navigation-session.test.ts` exercises source identity, changed-input rejection, cancellation, bounded history, catalog ID changes, file conflicts, and reopening after reimporting local inputs.
