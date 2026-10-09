# Local aligned-DNA phylogeny

Open the existing dated-tree overlay (Ctrl+Shift+Y), then choose **Infer an
unrooted tree from aligned DNA**. This lazy-loaded workspace uses the existing
`aligned-dna-neighbor-joining` core method. It does not replace the temporal,
strict-clock, ancestral-reconstruction or explicit NCBI search workflows.
Opening it does not upload an alignment or query the selected catalog genome.

## Inputs and computation

Paste an already aligned DNA FASTA or select a local file (at most 2 MiB).
Supply its name, source/homology provenance, local-versus-synthetic designation,
and explicit confirmation that the columns represent homologous aligned sites.
The parser requires 3–64 unique taxa and equal nonzero lengths, up to 100,000
columns. It does not run a multiple-sequence aligner. The original input text is
retained in the portable experiment; provenance and homology are user assertions,
not independently verified evidence.

Choose p-distance or JC69, 0 or 20–200 bootstrap replicates, and an unsigned
32-bit seed (including zero). Common complete deletion excludes any column with
a gap, missing or ambiguous base in any taxon from every pair. Work is bounded
by the core method's declared operation budget; exceeding it is an explicit error,
not silent subsampling. Computation runs in a worker. Cancel, editing an input,
closing the workbench, and closing the overlay terminate obsolete computation.
A delayed file read cannot replace a newer draft. File decoding rejects malformed
UTF-8 instead of substituting characters into an alignment.

## Interpretation and exports

The browser displays connectivity, signed branch lengths, positive-length
unrooted splits, resampling counts/proportions, excluded columns and paginated
pairwise distances. The topology drawing is **not to branch-length or time
scale**. Its display root has no ancestral meaning. Zero/nonpositive edges are
dashed rather than shown as supported resolutions, and negative lengths are not
clipped in the exported tree. JC69 saturation is an error; if any bootstrap is
saturated, all split supports are withheld by the core method.

Export the complete experiment JSON for reproducibility, or Newick, the distance
matrix TSV, and split-support JSON for downstream tools. Newick has an arbitrary
serialization root; support is exported as unrooted splits, not rooted clade
labels. Importing an experiment verifies content identities **and recomputes the
full result**. A self-consistent checksum for invented output is insufficient.
This is software reproducibility, not independent validation of a biological tree.

Data are held in memory only. Export before closing this panel or overlay.
Changing a draft invalidates the accepted result and disables exports until a
new calculation succeeds. Temporal diagnostics remain a separate workspace:
justify biological rooting independently and resolve incompatible negative
lengths through an appropriate inference method rather than silently passing the
Newick display root to a clock estimator. No clock, selection, host-range,
transmission or population-size inference is supplied by this workflow.

## Terminal interoperability

The same script is now wired into the lazy terminal launcher, without loading
Ink or requiring a genome catalog:

```sh
bun packages/tui/src/index.tsx phylogeny inspect --alignment aligned.fasta
bun packages/tui/src/index.tsx phylogeny infer --alignment aligned.fasta \
  --source 'Alignment source and homology provenance' --output experiment.json \
  --distance p-distance --bootstrap 100 --seed 0
bun packages/tui/src/index.tsx phylogeny replay --experiment experiment.json
bun packages/tui/src/index.tsx phylogeny export --experiment experiment.json \
  --format newick --output tree.nwk
```

Binaries compiled from this launcher support `phage-explorer phylogeny` with the
same subcommands. These source changes do not publish or replace released binaries.
Existing terminal outputs are never overwritten. Browser and terminal use the
same evidence schema, exact input identities, numerical method and options.

## Verification entry points

```sh
bun test packages/core/src/analysis/aligned-phylogeny.test.ts \
  packages/web/src/workers/AlignedPhylogenySession.test.ts \
  packages/tui/src/phylogeny-cli.test.ts
bun run check
bun run build:web
cd packages/web
bunx playwright test --project=chromium --workers=1 e2e/aligned-phylogeny.e2e.ts
```

The browser journeys use the production overlay and real worker, exercise
browser-to-terminal-to-browser replay, reject rehashed forged output, and check
cancellation and delayed imports. Synthetic quartets are software test oracles,
not empirical phylogenetic benchmarks. Native Bun, browser, production-build and
full-workspace results must be reported separately from any adapter-based checks.
