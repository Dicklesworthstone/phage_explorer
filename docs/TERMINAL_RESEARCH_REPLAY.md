# Replay browser research workflows from the terminal

A stopped **Local genomes → Saved research workflows** recording can be replayed
with `phage-explorer workflow` in a newly built executable, or from the source
checkout with Bun and the project's dependencies. This is an explicit, database-free
command; it does not start the graphical terminal viewer or modify the browser's
saved library. These source changes do not publish a release or update an older
installed executable. The existing `bun run workflow` entrypoint remains supported.

## Main executable commands

The main launcher now exposes the same pangenome, reference-count codon and workflow
implementations as the checkout scripts. Argument validation, model defaults, record
identities and exclusive-create output rules are shared, not reimplemented. No shell
or second Bun executable is launched to run these commands. Headless dispatch occurs
before loading the explorer UI, state store or catalog; no `--no-catalog` flag is needed.

```bash
phage-explorer pangenome build --input genomes.fasta --reference ref \
  --alignment affine --output graph.json
phage-explorer pangenome verify --experiment graph.json
phage-explorer codon-reference analyze --genome query.gb --reference counts.json \
  --output codons.json
phage-explorer workflow inspect --input workflow.json
phage-explorer workflow replay --input workflow.json --output analysis.json --progress
```

Use `phage-explorer pangenome --help`, `codon-reference --help` or `workflow --help`
for the complete options. Each command's help names the actual executable invocation;
help formatting never rewrites user metadata in JSON reports. Source equivalents are
`bun run pangenome`, `bun run codon:reference` and `bun run workflow` with the same
remaining arguments. Existing abundance/host-metabolism and interactive-import paths
remain separate and available.

The build's worker manifest now supplies the first-stage source entries, their
runtime URL definitions and the second-stage embedded entries together. This includes
the research replay worker alongside abundance, host metabolism and local import.
The runtime chooses a build-time embedded worker path in a compiled build, or a
module-relative TypeScript path in a source checkout. Neither depends on the working
directory nor accepts a worker path from user data or environment variables.
The compiled executable does not require adjacent worker files or a source checkout.

`packages/tui/src/commands/scientific-entrypoint.test.ts` includes real-process
entrypoint tests and a native two-stage compile/relocation test. The latter moves
staging artifacts away and runs the copied executable with an empty tool search
path, then verifies a recorded circular-repeat analysis. Native Bun and compiled
checks must actually run before claiming platform packaging validation; an auxiliary
Node/TypeScript execution is not a replacement for that test.

## Source checkout examples

```bash
# Reparse the bundled inputs and inspect supported actions without calculating.
bun run workflow inspect --input workflow.json

# Recompute and verify every command; print a JSON execution report to stdout.
bun run workflow replay --input workflow.json

# Also create the last verified analysis for the existing analysis tools.
bun run workflow replay --input workflow.json --output analysis.json --progress

# Repeat the full recorded experiment, subject to the total execution limit.
bun run workflow replay --input workflow.json --repetitions 2 --timeout-ms 600000

# When the exported analysis is an annotated pangenome, existing exports work.
bun run pangenome verify --experiment analysis.json
bun run pangenome export --experiment analysis.json --format protein-fasta --output proteins.fasta
```

The input is a **command tape**, not a pangenome analysis or an IndexedDB database.
Export the stopped workflow JSON, or use its saved snapshot's JSON backup action.
The original FASTA/GenBank inputs are embedded in that tape. The terminal reparses
those inputs into an isolated headless host; it neither looks up matching accessions
in a catalog nor reads filenames embedded in source metadata. Matching accessions
remain separate content-identified genomes.

## Supported actions and exact limits

The terminal reuses `ResearchWorkflow`, `CommandSession`, the canonical action IDs,
and the existing numerical producers. It does not maintain a second command engine.

| Recorded action | Terminal behavior |
| --- | --- |
| `nav.goto` | Validate the exact genome, gene, reading frame, view mode and position; apply headless view state. No screen is rendered. |
| `overlay.pangenomeGraph` | Recompute the sequence graph with supplied/global/unit-wavefront/affine settings, optional strand/circular normalization, and optional GenBank CDS consequences. |
| `overlay.codonAdaptation` | Commands with `method: "reference-cai"` recompute reference-backed CAI from embedded count JSON or a freshly recounted source-corpus experiment. Legacy commands without the discriminator retain their illustrative host model; no command is silently migrated. |
| `overlay.repeats` with `method: "exact-pairs"` | Recompute unsampled fixed-length direct/inverted pairs with the portable method, including its explicit completeness and output limit. |
| Legacy `overlay.repeats` without that method | Browser-only transport/backend identity; the terminal does not relabel another engine or ignore an identity mismatch. |

Unknown actions and legacy repeat commands reject the **whole replay before its first
command**. Known command parameters are also validated before computation. `inspect`
reports unsupported steps; `canReplay` indicates supported actions and accepted
input/parameter shape, not that numerical verification has already succeeded.
New exact-pair recordings are described in `EXACT_REPEAT_WORKFLOWS.md`.
No commands are skipped, no shell fragments are executed, and no remote references
are fetched. A tape containing unsupported actions should be replayed in the browser.

Limits remain 10 MiB of UTF-8 command input, 128 recorded commands, 1–10 repetitions,
and at most 256 executed commands. Original importer, alignment, graph, CDS and
10 MiB analysis-export limits still apply. Default timeout is 300,000 milliseconds;
`--timeout-ms` accepts 1–3,600,000 and covers input reading, execution and output.
All analysis computation and genome parsing run in an owned worker thread.

## Verification, output and cancellation

Each step's freshly computed method, input identity and result identity must match
its recorded expectation **before** the shared adapter applies it. Changed bases,
annotations, selected IDs, model settings, method versions or computed results stop
with a step-specific error. Verification is against the tape's own declared inputs
and expectations; it does not authenticate its author or validate biology.

The successful stdout report contains the exact decoded tape text's SHA-256,
execution/iteration/step indexes, action IDs, analysis identities and headless views.
It does not contain genome bases, transcript sequences or protein sequences. Names,
accessions and identifiers may nevertheless be sensitive metadata.

`--output` writes the **last verified analysis**, not the report or command tape.
Its `lastAnalysisExecution` in the report identifies the producing command, even
if later navigation clears the visible result. Navigation-only tapes can verify
without `--output`; requesting an analysis from them is an error. The complete tape
must finish successfully before a destination is opened. Files use exclusive
creation and mode 0600; existing files and symlinks are never overwritten. OS
permission semantics apply. A failure or interruption during the final disk write
may leave a partial new file; it is not silently removed. Choose a new destination
before retrying. Exported analysis files contain the private source sequences.

`--progress` emits structured progress lines to stderr, not stdout. Completed-step
progress does not certify that a requested output file was subsequently saved.
SIGINT/SIGTERM and timeouts terminate the invocation's own worker; they cannot
cancel a separate replay. Late results are ignored. No successful report or analysis
is published for a computation that fails or is interrupted. Interruption during
final file writing has the explicit partial-file caveat above. Exit status is 0
for success, 1 for failure, 124 for timeout, 130 for SIGINT and 143 for SIGTERM.

This adds unattended numerical replay, not arbitrary keyboard macros, interactive
TUI restoration, repeat-backend portability or predictive biological validation.
