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

Choose p-distance, JC69 or K80, 0 or 20–200 bootstrap replicates, and an unsigned
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
clipped in the exported tree. JC69 or K80 saturation is an error; if any bootstrap is
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

## Explicit outgroup root hypotheses

The terminal command can derive a rooted experiment from a verified original
inference, without treating the arbitrary display root as biological evidence:

```sh
bun packages/tui/src/index.tsx phylogeny root --experiment experiment.json \
  --outgroup outgroup_a,outgroup_b --fraction 0.25 \
  --rooting-evidence 'Independent outgroup evidence and branch-placement rationale' \
  --date-independent --output rooted.json
bun packages/tui/src/index.tsx phylogeny replay --experiment rooted.json
bun packages/tui/src/index.tsx phylogeny export --experiment rooted.json \
  --format newick --output rooted.nwk
```

There is no default outgroup or midpoint: the fraction is strictly between 0 and
1, measured from the outgroup-side endpoint of the separating edge. The user
must justify both the outgroup and branch placement and assert that neither
choice used collection dates. These are recorded assumptions, not independently
verified evidence. The chosen outgroup must occupy exactly one side of a
positive-length edge and at least two ingroup taxa must remain. Any negative NJ
limb, including a roundoff negative, is rejected; no branch is clipped, refitted
or rearranged to make the operation succeed. Every original taxon and pairwise
tree path is retained, and a numeric path-preservation certificate is recorded.

The derived record uses method `explicit-outgroup-rooted-nj` and retains the
original alignment, options, source result identity and complete root decision.
Replay recomputes the original NJ inference and then the root placement. Rehashed
invented trees are not accepted. `replay` and `export` accept either kind of
record; a derived Newick export uses the specified root, while distance and split
exports remain the original unrooted values. Split support is not root support.
Rooting does not date a tree or validate a molecular clock. Start a different
root hypothesis from the original experiment rather than modifying a prior root.

Core rooting tests are in `packages/core/src/analysis/phylogeny-rooting.test.ts`;
terminal rooting and source-preservation tests extend the existing CLI suite.

The browser offers the same explicit rooting operation below each accepted
unrooted result. It requires selecting outgroup taxa, entering the fraction and
rationale, and confirming date-independence; none is preselected for a fresh
inference. The operation runs in the existing disposable worker. Failure or
cancellation preserves the original inference, while edits to the alignment
invalidate both original and derived evidence. Editing only the root draft
hides the prior root and disables rooted exports until that hypothesis is applied;
original unrooted exports remain separate and available.

The existing JSON restore input accepts rooted records from the terminal or
browser and recomputes both stages. Rooted experiment JSON and explicit-root
Newick have their own export buttons. The rooted topology is displayed separately
and is not to branch-length or time scale. Nothing is silently installed into
the temporal workspace or treated as a validated biological root. Keep both the
original experiment and the derived record when comparing alternative roots.
The built-in 12-column teaching quartet can contain tiny negative NJ limbs due
to roundoff; it is subject to the same no-clipping rule as every other input.

## Conditional ancestral reconstruction from a verified root

An explicitly rooted JC69 or K80 experiment can now supply its alignment and
fixed tree directly to the ancestral reconstruction method. The complete
original inference and rooting decision are retained in the new experiment.
Supply the alignment's license or usage permission explicitly; the phylogeny
record does not establish it.

For example, save these ancestral settings as `ancestral-options.json`:

```json
{
  "startColumn": 1,
  "endColumn": 100,
  "gapPolicy": "missing",
  "minPosterior": 0.9
}
```

The window is inclusive and uses original 1-based alignment columns. Set its
end to a column present in your alignment; a window is limited to 4096 columns.
Without an options file, the method uses columns 1 through the smaller of the
alignment length and 4096, treats gaps as missing, and uses a 0.9 consensus
threshold. A supplied `substitution` object can record the existing ancestral
method's sourced JC69, HKY85 or GTR model and site-rate categories. These are
fixed assumptions. K80 distance inference does not estimate a global ancestral
transition/transversion ratio or silently change the reconstruction model.

```sh
bun run phylogeny ancestral --experiment rooted.json \
  --license 'License or permission for this alignment' \
  --options ancestral-options.json --output ancestors.json
bun run phylogeny verify --experiment ancestors.json --output verified-ancestors.json
bun run phylogeny export --experiment ancestors.json \
  --format ancestral-fasta --output conditional-ancestors.fasta
bun run phylogeny export --experiment ancestors.json \
  --format alignment-fasta --output original-alignment.fasta
```

The terminal launcher exposes the same new command and accepts the linked
record through both replay entry points:

```sh
bun packages/tui/src/index.tsx phylogeny ancestral --experiment rooted.json \
  --license 'License or permission for this alignment' \
  --options ancestral-options.json --output terminal-ancestors.json
bun packages/tui/src/index.tsx phylogeny replay --experiment terminal-ancestors.json
bun packages/tui/src/index.tsx ancestral replay terminal-ancestors.json \
  --format fasta --output terminal-conditional-ancestors.fasta
```

All calculations use the existing terminable worker. The phylogeny commands
accept `--timeout-ms` on reconstruction, defaulting to 300000. Missing licenses,
unrooted or p-distance parents, inconsistent saved evidence, invalid settings,
timeouts and cancellation fail before creating output. Existing output files
and symlinks are never replaced.

Reconstruction retains every original column, including gaps and ambiguous
bases excluded by complete deletion during tree inference. Its own gap/window
policy applies separately. FASTA identifiers, letter case, row order and line
formatting are normalized for the ancestral parser; the full original text,
including descriptions and line endings, remains in the parent evidence and is
recovered by `alignment-fasta`. No taxa are pruned and no alignment, topology,
root or branch length is refitted.

The `rooted-nj-ancestral` JSON record binds the parent alignment/root chain to the
conditional state probabilities and joint branch endpoint probabilities. Every
replay and export recomputes those stages. `ancestral-fasta` is a thresholded
internal-node consensus view, using `N` for excluded, impossible, tied or
below-threshold sites; it cannot replace the JSON record for replay. These
conditional probabilities are not empirical confidence, event counts, mutation
dates or selection estimates.

For a linked ancestral record, `newick` exports the fixed rooted tree in
substitutions/site. The headless `unrooted-newick`, `distances-tsv`, `splits-tsv`,
`splits-json` and `rooting-json` views preserve the original inference or root
decision. Distance/split tables identify the selected ancestral result and its
parent results. The terminal launcher's existing `distances` and `splits`
formats remain a matrix and JSON split report, respectively. Bootstrap split
support is not ancestral-state or root-placement confidence.

### K80 transition/transversion distances

K80 (Kimura's two-parameter model) counts A↔G and C↔T transitions separately
from transversions in the same complete-deletion columns used for every pair.
It assumes equal equilibrium nucleotide frequencies and homogeneous independent
sites. It does not fit a global transition/transversion rate ratio or establish
that this model describes the supplied alignment.

For transition fraction P and transversion fraction Q, the corrected distance is
`-0.5 × ln(1 - 2P - Q) - 0.25 × ln(1 - 2Q)` substitutions per site. The method
refuses either saturated logarithm; it never clamps a divergent pair to a finite
estimate. If any resampled pair saturates, every bootstrap support is withheld.
JSON retains each pair's compared sites, transition count and transversion count
in `k80Comparisons`, and replay recomputes them. Existing p-distance and JC69
records retain their identities.

Select **K80 transition/transversion correction** in the browser, or pass
`--distance k80` to `phage-explorer phylogeny infer` (or `bun scripts/phylogeny.ts infer`).
After an explicit outgroup root, the same substitution-length tree can be used
for temporal diagnostics. Dates do not select or justify the root. K80 distance
correction alone establishes neither temporal signal nor a calibrated clock.

Method reference: [Kimura (1980), equation 10](https://doi.org/10.1007/BF01731581).
