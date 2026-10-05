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
transport. The original source bundle, content IDs and all three resolved search
parameters are retained in the recording. Terminal output-file, timeout, signal,
privacy and no-overwrite rules remain those in `TERMINAL_RESEARCH_REPLAY.md`.
The command consumes a workflow tape, not a standalone analysis JSON.

Legacy repeat commands without `method: "exact-pairs"` retain their original
browser transport/kernel identities and remain browser-only. A tape containing
one is rejected before the terminal executes its first command; it is never
silently skipped or migrated. Record a new exact-pair computation to obtain the
new method. Editing a legacy expected identity is not verification.

## Exact scope, order and limits

Both arms have the requested length (4–256 bases), contain only A/C/G/T, and do
not overlap. The spacer is `rightStart - leftEnd`, from zero through the configured
maximum (0–100,000). IUPAC ambiguity is preserved at its original coordinates and
may occur in the spacer but never supplies arm matches. Input is case-insensitive
DNA for computation; original case remains part of input identity. RNA, gaps and
formatting characters are rejected by the core scanner rather than silently removed.

The scan visits every eligible right-arm start and partner: there is no sampling
step and no first-partner shortcut. Order is right start ascending; at each start,
direct pairs precede inverted pairs, each with left starts ascending. A pair whose
arms satisfy both orientations appears twice, once per orientation. Overlapping
occurrences and nested fixed-length windows across different pairs are not merged.
Coordinates are 0-based, half-open, including in the TSV.

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
gap bound, across a circular origin, or in unresolved bases. No maximal-extension,
circularity, mismatch tolerance, statistical significance or physical folding
claim is added. Checksums establish content identity, not biological validation.

Core APIs live in `packages/core/src/analysis/exact-repeat-pairs.ts`:
`scanExactRepeatPairs`, `createExactRepeatRecord`, `replayExactRepeatRecord`, and
`exportExactRepeatPairsTsv`. Standalone record replay recomputes coordinates and
coverage; recalculated checksums cannot make forged results match the computation.
