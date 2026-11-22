# Record and replay private pangenome experiments

The existing **Local genomes → Saved research workflows** recorder supports a
real pangenome command in addition to its navigation, repeats and single-genome
codon commands. It invokes the same graph/GenBank-CDS producer as the pangenome
workspace. It does not record arbitrary activity in other panels or install a
second keyboard command registry.

## Record

Import every required FASTA or GenBank genome before starting. Choose **Start
workflow recording**, then use **Record a real pangenome experiment** to select
2–24 imported genomes and the reference. Selections use full content IDs rather
than accessions; separate records with matching accessions remain distinct.

Choose the alignment, terminal-gap policy and optional strand/origin normalization.
Affine mode exposes mismatch, opening and extension costs. The recorded command
contains all resolved penalties, not a reference to future defaults. Circular
normalization requires an explicit complete-circle assertion and terminal alleles.
Invalid or incompatible settings prevent submission rather than being coerced.
Supplied-alignment mode treats the imported equal columns as already aligned;
equal sequence lengths alone are not evidence of biological homology.

To include coding consequences, choose an imported GenBank reference and enable
**Include the reference's GenBank coding consequences**. Its original bases and
origin must match the graph reference exactly. Select mapped CDS IDs, or leave
that field blank for all mapped CDS. Joined/complement CDS and supported translation
qualifiers are handled by the existing consequence engine, not by view coordinates.

**Run and record pangenome** computes the experiment off the rendering thread.
Only successful, input-consistent results enter the tape. Repeat with other
settings or interleave explicit navigation/repeat commands. The separate
**Run and record CDS analysis** command retains its illustrative host model;
it is not the multi-genome coding-consequence command.
**Run and record reference-backed CDS** is a separate, explicit CAI command using
embedded counts or source-corpus evidence. It can be interleaved with graph commands
and replayed in the terminal; see `CODON_REFERENCE_CORPUS.md`.

## Record a linked phylogeny

The same recorder can reconstruct a pangenome and infer an unrooted
neighbor-joining tree as one typed command. In the browser, use the captured
pangenome inputs and settings above, select **3–24 distinct genomes**, then
complete the phylogeny controls. In the terminal workflow editor, add
**Pangenome-backed phylogeny with explicit homology provenance**; its editor
collects the reference, panel, optional CDS annotation, alignment settings and
tree settings before computing anything.

Supply a name and an explicit assessment or source for backbone homology.
Choose p-distance, JC69 or K80. Complete deletion removes any retained column
containing a gap or ambiguous base; reference-gap insertion columns are excluded
before that filter. The reference backbone is limited to 100,000 bases. Site
bootstrap is either disabled with 0 or uses 20–200 replicates and an explicit
integer seed from 0 through 4,294,967,295. Alignment and distance validity limits
still apply; the workflow does not silently substitute a method or accept a
saturated distance matrix.

The canonical action is `overlay.phylodynamics`. Its parameters contain the
complete existing `pangenome` parameters plus `name`, `reference` and resolved
`options: { distance, deletion: "complete", bootstrap, seed }`. The original
input bundle supplies all sequences and annotations. No open graph or preceding
command is needed. Optional CDS consequences are included in the exact parent
record and do not select a different alignment for the tree.

Recording computes new expected results. Replay independently reconstructs the
parent, checks its identity and the tree's full source/settings/seed, then checks
the recorded result before publishing it. Changing a source, homology statement,
alignment penalty or seed requires a new recording. A cancelled or stale job
cannot install its result. The browser and terminal accept the same tapes and
complete-results archives:

```bash
phage-explorer workflow record --input tree-plan.json --output tree-workflow.json
phage-explorer workflow replay --input tree-workflow.json --repetitions 2 --results --output tree-results.json
phage-explorer workflow replay-results --input tree-results.json --output verified-tree-results.json
```

The browser shows the accepted tree's coverage, parent identity and warnings,
and exports Newick. **Export workflow analysis** retains the full linked parent
and can be reopened in the aligned phylogeny workspace or through the existing
phylogeny CLI. Complete-results export retains each ordered execution, including
repetitions. An unrooted sequence tree and site-bootstrap support do not establish
ancestry, transfer, host range or biological homology; the supplied homology
assessment remains an explicit assumption.

## Save, reopen and replay

Choose **Stop workflow recording**, then export the research workflow JSON or
save a named snapshot in the existing on-device command-workflow library.
Exporting/saving preserves the original input bundle once, each command's full
parameters, and its expected method/input/result identities. It does not retain
all historical graph outputs in the tape. The last accepted analysis is separately
available through **Export workflow analysis**.

On reopening a JSON file or local snapshot, inputs are parsed for review. Nothing
is added and no command is executed automatically. Choose **Add workflow genomes**
with an explicit accession-collision decision when needed, then **Replay research
workflow**. Replays reconstruct the original query set, alignment, graph, variants
and optional coding consequences, and compare the newly computed identities before
accepting each result. Changed or missing bases, annotations, original sources,
settings or numerical outputs stop with a step-specific error. A checksum identifies
content and is not scientific validation.

All commands are validated before the first replay side effect. Context genomes
are checked before computation; every selected genome and annotation is checked
again immediately before publishing evidence. Worker requests are isolated copies.
Changing draft controls does not relabel the accepted result or its exports.

Pause takes effect between commands; the active command may finish. Cancel stops
the current worker and prevents later commands/results from being installed.
Previously completed commands are not undone. Closing the panel cancels active
work; save/export the stopped recording before closing to retain it. The existing
limits remain 128 recorded commands, 10 repetitions, 256 executed commands and
10 MiB for a tape including its private source bundle.

## Inspect the accepted graph elsewhere

Export the accepted workflow analysis and open it in **Sequence Pangenome &
Variants**, or use the existing CLI:

```bash
bun run pangenome verify --experiment workflow-analysis.json
bun run pangenome export --experiment workflow-analysis.json --format gfa --output graph.gfa
bun run pangenome export --experiment workflow-analysis.json --format protein-fasta --output proteins.fasta
```

Protein export requires an annotated result. These commands consume the exported
**analysis**, not the command tape. For explicit headless replay of supported
commands in the complete tape, use `bun run workflow inspect/replay --input workflow.json`;
see `TERMINAL_RESEARCH_REPLAY.md` for the supported actions and interrupt behavior. Opening an analysis in the graph workspace verifies it before display;
executing a recording never replaces an independent active graph workspace.

Each execution owns its own worker. Cancelling a recorded job cannot cancel a
separate workspace's job. Inputs stay local to the existing browser computation
and storage paths. Saved JSON contains private sequences; on-device storage is
not an encrypted backup and may be cleared by the browser. Export before relying
on it for durable retention.

The existing graph, alignment, normalization, CDS and experiment-size limits all
still apply. Alignment-conditional differences are not donor, host-range, expression,
phenotype or internal-rearrangement predictions. Non-identical strand/origin
normalization remains heuristic. See `AFFINE_ALIGNMENT.md`,
`CDS_CONSEQUENCES_WORKFLOW.md` and `LOCAL_RESEARCH_LIBRARY.md` for those contracts.
