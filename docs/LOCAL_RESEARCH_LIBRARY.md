# Save private research on this device

Private imports and analysis panels remain session-only by default. A named
local snapshot is written only when you choose **Save snapshot locally** inside
**Saved … on this device**. Saving again creates another immutable snapshot,
even with the same name. Nothing is replaced or automatically evicted to make
room. Unsaved changes are not included in an earlier snapshot.

## Supported workflows

| Panel | Snapshot contents | What Open does |
|---|---|---|
| Local genomes | Original FASTA/GenBank files and the selected local DNA/AA view, using the existing local bundle format | Reparse in the local worker and show the usual review/add step. No records are automatically added or selected. |
| Saved research workflows | The stopped command tape, its embedded genome bundle, expected outputs and parameters | Load and validate for review. Add bundled genomes and choose Replay separately; opening never executes commands. |
| Reference-backed codon adaptation | Complete reference experiment with original sequence, annotations, reference counts and parameters | Rerun the existing reference-experiment verification before displaying scores. |
| Sequence Pangenome & Variants | Complete accepted graph experiment, including input sequences and normalization parameters | Rebuild through the existing pangenome replay worker and compare the result identity. Draft control edits are not part of an accepted result. |

Open the corresponding panel after a reload, expand **Saved … on this device**,
select the snapshot and choose **Open saved snapshot**. The catalog and unrelated
current analyses are not restored implicitly. Cancel interrupts a pending open;
closing the panel also cancels its operation. A save that already committed can
remain in the library even when cancellation was requested immediately afterward.
The saved list can be refreshed manually and refreshes when the window regains
focus or another explorer tab changes the library.

**Export saved JSON** writes the exact original saved export format, not a new
wrapper. It checks storage integrity but does not rerun numerical analysis. The
file can be imported by the corresponding existing browser panel or compatible
terminal command. Keep these files as independent backups before clearing browser
data. Removing a snapshot requires a second explicit confirmation for that ID;
other snapshots and the current in-memory explorer inputs are unaffected.

## Privacy and durability boundaries

The library uses a separate IndexedDB database on this site's origin. It does not
write the curated SQLite catalog, send genome payloads over the network, enable
telemetry, or synchronize to an account. Cross-tab messages contain only a change
notification, not names, sequences or checksums. This is not encrypted storage:
other code running on the same origin and people using the same browser profile
may be able to access it. Use exported files and a suitable private environment
for sensitive research.

The library allows up to 64 snapshots and 64 MiB of payload in total, with at most
10 MiB per snapshot. Browser storage quotas may impose a lower limit. A failed
transaction does not commit half a snapshot. Metadata and exact export bytes are
stored together, and opening checks the payload's SHA-256 and expected panel kind
before calling the original importer. A checksum identifies bytes; it does not
validate a biological method or make an unsupported old method version executable.

**Ask browser to retain local data** explicitly requests persistent storage for
this site. The browser may refuse; that does not necessarily prevent ordinary
saving. Even a grant does not protect against the user clearing site data, losing
the browser profile or device failure. Private-browsing persistence is also not
guaranteed. No automatic background saving or startup restore is performed.

If storage is blocked, full or damaged, the current session can still use existing
file exports. Close older tabs when an upgrade is blocked. Export and explicitly
remove unneeded snapshots to free library space. Damaged payloads are refused,
not silently repaired, deleted or displayed as verified research.
