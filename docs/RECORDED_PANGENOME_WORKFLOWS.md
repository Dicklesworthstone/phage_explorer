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
**analysis**, not the command tape. General terminal command-tape replay is not
added here. Opening an analysis in the graph workspace verifies it before display;
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
