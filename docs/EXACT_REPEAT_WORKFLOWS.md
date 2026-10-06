# Unsampled exact repeat pairs and portable research replay

The research recorder offers **Run and record exact repeat pairs**, alongside
its existing sampled mixed-repeat overview. This is a distinct numerical method:
fixed-length direct and reverse-complement DNA arms, not maximal repeats, repeat
families, tandem-copy classification or biological structure prediction.

## Browser workflow

Import FASTA/GenBank through **Local genomes**, open **Saved research workflows**,
and start recording. Select the genome, set the repeat arm length and maximum gap,
and choose **Workflow exact pair limit**. The exact button uses the arm setting as
a fixed length; the legacy button retains its existing minimum-length semantics.

Run **Run and record exact repeat pairs**. Computation uses an owned worker rather
than the rendering thread. The result shows accepted parameters, resolved-base
coverage, both arm intervals and an explicit complete/incomplete message. The table
shows the first 50 retained pairs; **Export exact repeat pairs TSV** contains every
retained pair and the completeness flag. Draft edits never relabel this result.

**Exact repeat input topology** defaults to linear. To search across the origin,
explicitly select **I assert this input is a complete circular molecule**. Do not
use this for linear molecules or partial assemblies. Changing the selected genome
resets the choice to linear, even when the imported annotation says circular;
replay instead uses the topology explicitly stored in each command. Accepted
results display their submitted topology, independently of current draft controls.

Stop recording before exporting the workflow JSON or saving an on-device workflow
snapshot. The last analysis can also be exported as its own AnalysisRecord JSON.
Reopening a workflow reviews bundled inputs without adding them or running anything.
Use **Add workflow genomes**, then **Replay research workflow**. Replay recomputes
and verifies each output before accepting it; failed/cancelled work keeps previously
accepted evidence. Existing navigation, pangenome and coding commands can be mixed
with exact repeat commands in the same tape.

## Terminal workflow

The existing source-checkout command supports these new exact-pair recordings:

```bash
bun run workflow inspect --input repeat-workflow.json
bun run workflow replay --input repeat-workflow.json --output repeat-analysis.json
```

No new command engine or backend identity substitution is used. Browser and
terminal invoke the same core producer with a method identity independent of
transport. The original source bundle, content IDs, all three resolved search
parameters and any explicit circular topology are retained in the recording. Terminal output-file, timeout, signal,
privacy and no-overwrite rules remain those in `TERMINAL_RESEARCH_REPLAY.md`.
The command consumes a workflow tape, not a standalone analysis JSON.

Legacy repeat commands without `method: "exact-pairs"` retain their original
browser transport/kernel identities and remain browser-only. A tape containing
one is rejected before the terminal executes its first command; it is never
silently skipped or migrated. Record a new exact-pair computation to obtain the
new method. Editing a legacy expected identity is not verification.

## Exact scope, order and limits

Both arms have the requested length (4–256 bases), contain only A/C/G/T, and do
not overlap. In linear mode the spacer is `rightStart - leftEnd`, from zero through
the configured maximum (0–100,000); circular arcs are described below. IUPAC ambiguity is preserved at its original coordinates and
may occur in the spacer but never supplies arm matches. Input is case-insensitive
DNA for computation; original case remains part of input identity. RNA, gaps and
formatting characters are rejected by the core scanner rather than silently removed.

The scan visits every eligible right-arm start and partner: there is no sampling
step and no first-partner shortcut. Order is right start ascending; at each start,
direct pairs precede inverted pairs, each with left starts ascending. A pair whose
arms satisfy both orientations appears twice, once per orientation. Overlapping
occurrences and nested fixed-length windows across different pairs are not merged.
Coordinates are 0-based, half-open, including in the TSV.

### Complete circular molecules

Circular mode considers all n starts, including arms crossing the sequence origin.
Two length-L arms must not share any base on the circle, so no pair exists when
n < 2L. For each unordered pair, the shorter of the two intervening spacer arcs
must be within `maxGap`. The first arm is the one preceding that shorter arc;
equal-length arcs choose the numerically lower first start. Each physical pair is
therefore retained once per matching orientation, not once per circle traversal.
This still permits one direct and one inverted entry for self-complementary arms.

First/second are traversal labels, not numerical left/right order. The scalar
`leftStart` and `rightStart` fields stay in [0,n), while their unrolled ends equal
start + L and may exceed n. The interface splits a wrapped arm into original
half-open intervals in traversal order: for example, a four-base arm starting at
18 on a 20-base circle is `[18,20);[0,2)`. Concatenate these slices to reconstruct
that arm. The new TSV includes both the unrolled endpoints and `left_segments` /
`right_segments`; it also records topology and sequence length in its header.

Order is second start ascending, direct before inverted, then first-arm starts
along the predecessor arc (possibly across zero). A complete pair set is invariant
under rotating/reverse-complementing the input after coordinates are transformed;
the canonical orientation of a tied pair, output order, and truncated prefix need
not be. No circle is duplicated in the input record or allocated as a second genome:
the existing bounded index tracks only the eligible predecessor arc.

Circular records use exact-repeat-pairs method version 2 and explicit
`topology: "circular"`. Linear records and recordings keep their version-1 identities;
the core API accepts `topology: "linear"` as equivalent to omission. Saved commands
use the canonical omission for linear input. Both methods can be mixed in one
workflow and replayed in the existing terminal worker. Changing topology without
recomputing the expected result is rejected, not treated as a migration.

The default output limit is 2,000; the supported range is 1–20,000. One additional
actual match proves that the limit truncates the enumeration. Reaching the limit
alone does not imply incompleteness. A truncated result retains the exact ordered
prefix and reports the right start where the additional match was encountered.
That final visited start may only be partially enumerated. Completeness and the
output limit are part of both replayed evidence and exported tables.

At most 5,000,000 input bases are accepted. A rolling 15-base (or shorter) index
holds only eligible partner starts; full arms are checked before any hit is emitted.
Prefix matches cannot produce false full-arm matches. The method permits at most
50 million base comparisons in candidate verification. Exhaustion throws and
publishes no result, unlike intentional, explicitly identified output truncation.
Choose a smaller region or gap, or a smaller output limit, when work is excessive.
The normal 10 MiB analysis and workflow export limits still apply.

A complete zero-pair scan means no eligible observed pairs for these exact
parameters. It does not establish absence of repeats at other lengths, beyond the
gap bound, in unresolved bases, or across a circular origin when linear mode was
selected. No maximal-extension, topology inference, mismatch tolerance, statistical significance or physical folding
claim is added. Checksums establish content identity, not biological validation.

Core APIs live in `packages/core/src/analysis/exact-repeat-pairs.ts`:
`scanExactRepeatPairs`, `createExactRepeatRecord`, `replayExactRepeatRecord`, and
`exportExactRepeatPairsTsv`. `exactRepeatArmSegments` converts unrolled endpoints
to original intervals. Standalone record replay recomputes coordinates and
coverage; recalculated checksums cannot make forged results match the computation.
