# Import and restore local genomes inside the terminal explorer

Open the existing command palette with **Ctrl+P**, search for **Local genomes**,
and choose **Local genomes: import, restore or export**. This opens a private
file/review screen without restarting the program. The explorer's input handlers
are suspended while the file screen is active: letters in filenames cannot trigger
genome shortcuts. Returning remounts the explorer with the accepted selection and
drops its old sequence/analysis caches.

## Import and review

Press **I**, enter a literal local file path, and press Enter. DNA FASTA, GenBank,
and version-1 local-genome bundles use the same parser as browser imports. Relative
paths resolve from the process working directory; `~/` is supported. Do not add shell
quotes. No shell, glob, environment-variable expansion, remote lookup or upload occurs.
Input must be a regular UTF-8 file, limited to 10 MiB. Parsing runs in an owned
worker thread, not the Ink rendering thread. Pipes and devices are rejected.

Inspect parsed accessions, names, lengths, mapped CDS counts and warnings. Left/Right
pages through records. Long names and warning summaries are truncated for display;
the parser's original sources and annotations remain in the accepted session.
Nothing is added during review.

Press Enter to add the reviewed records and select the bundle's saved genome/view,
or its first record in DNA view. Matching accessions do **not** authorize replacing
anything. The default rejects collisions. **C** explicitly permits keeping different
records with matching accessions separately; content-identified reimports deduplicate.
The catalog is checked again immediately before acceptance. Failed merges leave the
review and previously accepted records intact so a collision decision can be revised.
The existing 100-record, 5,000,000-base and portable-bundle limits still apply.

Esc cancels active work. From a review it discards that review and returns to the
accepted explorer. Late cancelled reads cannot install a genome or replace a newer
review. The import operation never writes genome data to the curated database.
Reference-dependent views retain their existing local-input availability restrictions.

## Export and restore

Press **E** and choose a **new** output path. The bundle contains **all accepted local
original inputs**, including records added after startup, plus the current local
genome's DNA/AA/dual view, reading frame and position. If the selected genome is from
the catalog, the bundle contains the private inputs without a local view selection.
If a newly selected genome has not finished loading, return to the explorer before
saving; an old record's identity is never attached to the new selection's position.

Files use exclusive creation and mode 0600; existing files and symlinks are never
overwritten. OS permission semantics apply. Computation/serialization failure occurs
before a destination is opened. Cancellation or I/O failure during the final disk
write can leave a partial **new** file; it is not silently removed. Use a new
destination before retrying. Original inputs may contain private sequences.

To restore, import the exported bundle through the same I/review/Enter flow, or open
it in the browser's Local genomes panel. Sources are reparsed, not trusted as cached
annotations. A saved AA position is checked in residue coordinates, not nucleotide
coordinates. Terminal display escaping is applied only to display copies, preserving
the original source and content identity for export.

## Startup and packaged builds

```bash
# Start an empty private workspace without a catalog or initial file.
bun run packages/tui/src/index.tsx --no-catalog

# Existing startup import remains available.
bun run packages/tui/src/index.tsx --import query.gb --no-catalog

# Export the entire final local session on normal exit, including in-app additions.
bun run packages/tui/src/index.tsx --no-catalog --export-bundle new-session.json
```

The same flags apply to a newly built `phage-explorer` executable. The build includes
the import worker in both bundling and executable-compilation stages. This source
change does not publish a release or update an installed older binary.

With no genomes loaded, Esc from the manager quits; importing a file begins exploration.
`--allow-accession-collisions` applies only to an explicit startup `--import`; in-app
imports always require their own decision. An exit export with no accepted local
records reports an error rather than creating a misleading empty bundle.

This is input/view restoration, not replay of every terminal keystroke or analysis.
Use the separate `workflow inspect/replay` command for supported recorded numerical
workflows. Nothing is persisted automatically. Export before quitting; deleting
inputs, editing the curated catalog and automatic startup macro execution are not
part of this interface.
