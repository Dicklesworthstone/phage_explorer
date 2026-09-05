# Bridge Plan: Phage Explorer

## Current reality check — 2026-09-04

**Baseline:** `f9cbbf9ad97ddee790330fd6ad2721db6de6a8a7`. This section supersedes
revision 4 below. The older assessment remains as history, not an active task list.
The pre-existing untracked `test_dde.ts` was preserved. No implementation fixes,
releases, deployments, or issue closures are part of this assessment.

**Verdict:** the core genome browser is substantial, runnable software. The full
research platform promised by the plans is not finished. Recent roadmap closures
have reintroduced invented scientific results behind polished interfaces. Completing
the five previously nonclosed beads would leave these defects, data delivery drift,
and significant proof and performance gaps untouched.

### Evidence and reproducibility

The assessment read AGENTS.md and README.md in full, inspected the deployment and
TUI parity plans, the existing bridge, the numbered roadmap and its repeated idea
families, WASM specifications, keyboard/design/motion/performance documentation,
and the original design history. Roadmap pseudocode and example numbers are proposals,
not scientific reference implementations. Repeated idea numbers are grouped by
capability below; “51” is not a reliable count of independent deliverables.

Evidence collected under `/tmp/phage-reality-20260904/` includes `check.log`,
`unit.log`, `build.log`, `e2e-run.log`, `e2e.json`, `probes.ts`, `probes.log`,
`browser-audit.json`, screenshots, read-only database queries, and GitHub API
snapshots. Commands and decisive outputs are embedded below and in the beads so
the plan does not depend on temporary files surviving.

| Verification | Result and limit |
|---|---|
| `bun run check` | Exit 0: lint, both TypeScript projects, keyboard docs, scripts, bead closure gate, 15 comparison gates. |
| `bun run test` | Exit 0: 1,994 passes, zero failures, 32,803 assertions, 130 files, 51 seconds. |
| Production Vite build | Succeeded in an isolated output directory. The raw-DB deletion plugin was excluded and existing output preserved. Entry 843.86 kB raw / 253.96 kB gzip; 95 precache entries / 4,697.02 KiB. This did not rebuild database assets. |
| CI-selected Chromium suite | 31 passed, 4 failed, 35 tests, 5.9 minutes. Defense test could not find the palette option; lazy-loading test could not find the GC-skew overlay. Scroll FPS failed and navigation timed out under contention. These do not establish a memory leak or four algorithm defects. |
| TUI startup | Bun launched against a copy of the committed DB; Lambda, 24-phage catalog, colored sequence and gene map rendered; Ctrl-C exited 0. This is a startup smoke, not terminal-wide interaction coverage. |
| Native Rust | `env RCH_CARGO_WRAPPER_BYPASS=1 CARGO_TARGET_DIR=/tmp/phage-reality-20260904/cargo-target cargo test --release --manifest-path packages/wasm-compute/Cargo.toml` exited 0: 34 tests passed. This is native verification, not a fresh WASM rebuild. |
| Live web | T4 navigation, pangenome, host interaction, and latent atlas inspected at `https://phage-explorer.org`; no uncaught page errors in that probe. Catalog uses virtual rows: DOM row count is not database cardinality. |
| Published binary | GitHub latest is still v1.4.1, published 2025-12-16; release DB is 3,125,248 bytes. Root package is 1.5.0. Existing release blockers remain valid. |
| Database | Committed SQL passes `quick_check` and foreign-key checks; all 24 sequence lengths equal metadata. 1,695 Pfam hits, 2,039 ESM2 vectors plus 2,039 trigram vectors, 2,039 atlas coordinates, 13 defense rows across 9 phages, 48 AMG rows across 10, 44 tropism rows across 7. |
| Deployed database | Logical content digest matches committed SQL: `a1fd8207b85f3ce331ad27a853fe094c09a065da640f6697e69203e30d4c0633`. The deployed byte SHA differs by design; see the client/server hash mismatch below. |
| Remote checks | HEAD Lighthouse failed at its audit step; release automation failed; deployment-triggered E2E reports success. Those signals do not imply every test reached the deployed origin. |
| Offline control | A second live Chromium probe explicitly exercised the normal-user SW branch by making `navigator.webdriver` false. SW controlled the page and offline reload restored the catalog. The first automation-only failure was rejected as a product defect. Uncached optional features and update races still require tests. |
| Phylodynamic counterexample | Equal-length circular rotations of `ATGGCTGACTTCGCCAAGTACGACCTGATCGGC` by 0, 3 and 6 bases still produce selection output (`treeDnDs=1`). `phylodynamics.ts:918` treats equal length as alignment. Real NCBI FASTA/Mash fetching already works; the defect is the unsupported column/codon inference. |

Live evidence: [latest release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.1),
[HEAD Lighthouse run](https://github.com/Dicklesworthstone/phage_explorer/actions/runs/33910847043),
[HEAD production E2E run](https://github.com/Dicklesworthstone/phage_explorer/actions/runs/33911017750),
[HEAD release automation](https://github.com/Dicklesworthstone/phage_explorer/actions/runs/33910847092).

### Vision ledger

WORKING means the named behavior was exercised, not that every related promise was
proved. PARTIAL separates useful implementations from missing inputs or methods.
UNPROVEN retains uncertainty. WRONG_APPROACH means the current calculation cannot
deliver the named scientific inference. “No active coverage” includes falsely closed
work; it does not mean no historical bead ever mentioned the feature.

| Goal / source | Reality | Evidence / remaining acceptance |
|---|---|---|
| Browse 24 reference phages, DNA/AA, genes, themes, search, comparison; README core loop | WORKING core; PARTIAL proof | TUI startup, live T4, passing keyboard/search/share/overlay tests; full terminal, all themes, and browser engines require broader checks. |
| Real PDB web viewer and procedural TUI morphology; README 3D | PARTIAL proof | Distinct implementations and 23 catalog PDB references exist. Do not equate procedural geometry with deposited structure or promise uncached structures offline. |
| Browser/TUI keyboard parity and progressive disclosure; parity plan | WORKING registered paths; PARTIAL newer parity | Shared action registry and generated shortcut check pass; nine intentional differences are documented. Newly added research views still need explicit TUI parity decisions and navigation tests. |
| Heavy compute in workers, WASM fallback parity; ABI specs | PARTIAL proof | Passing numerical parity tests and production build. Native Rust run and SIMD/browser fallback paths are separate evidence; no blanket speedup claim follows. |
| Fast first visit, 60 FPS, Lighthouse >90; deploy plan and README | NOT MET | Committed Lighthouse baseline is 36 performance, 27.3 s LCP; floor 0.28 is a regression ratchet. Shared-host smoke measured 3.1 FPS versus a 10 FPS floor, not an intrinsic hardware-independent speed. |
| Stable annotated database everywhere; README data pipeline | REGRESSED delivery at audit | Raw SQL and live deployment include atlas; the ignored local gzip had no atlas table. The tracked manifest was stale. Local build read stale compressed content. Logical manifest digest was compared with byte SHA in the loader. Correction recorded September 5: gzip is generated and ignored, not committed. |
| Pan-phage sequence graph, bubbles, donors, breakpoints; top-ten #3 | WRONG_APPROACH | `pangenome-graph.ts` uses morphology templates, no sequence alignment. Identical comparator still gets +350 bp, 90% identity, fixed `AAGTCGAA` microhomology. Live T4 shows six such variants. |
| ESM2/Pfam host interaction inference and optional docking; #35 | WRONG_APPROACH | `HostInteractionOverlay` passes no embedding overrides. Hosts use sine/cosine pseudo-vectors, domains come from names, docking from category and length. Live T4 shows 827 interactions, 31 “high” confidence. |
| Structural epitopes, SASA, clashes, ΔΔG; #3 | WRONG_APPROACH | Precomputed tropism branch passes null sequence; repeating representative protein substitutes for real residues. Synthetic homolog columns and fixed chimera suggestions are not structural inference. |
| Burst inference from user experiments with uncertainty; #33 | WRONG_APPROACH / PARTIAL UI | Fit uses sigmoid trajectory, not the implemented ODE. PFU likelihood is invariant to a 100,000-fold adsorption-rate change. “Bootstrap 95% CI” is a bounded percentage margin. UI offers canonical curves, not the promised import workflow. |
| AMG flux inference and exact bounded LP; #37 | PARTIAL, solver incorrect | Real LP-shaped code exists, but an impossible fixed source with `S=[1], lb=ub=1` returns optimal. With no metabolites and bounds [2,5], objective is 3 while output flux is 5. Generic “E. coli” model includes photosynthesis. |
| ESM2 latent atlas; top-ten #10 | WORKING live basic rendering; PARTIAL claims | Live UI renders 2,039 points, 108 clusters, 524 outliers. Local gzip lacks coordinates. Embedding proximity is not proof of shared function or novel fold. |
| Defense, AMG, host codon/tRNA and receptor annotations; README | PARTIAL | Data and algorithms exist; coverage differs across families. Metadata still says 87 defense rows/15 phages while actual table has 13/9 after Acr shortlist removal. Missing annotation is not negative biological evidence. |
| CRISPR pressure, HGT/mosaic ancestry, environmental and temporal inference; roadmap | PARTIAL | CRISPR already removed fabricated spacers and honestly reports absent reference data; README wording is stale. Phylodynamics fetches real NCBI sequences and uses Mash, but its equal-length test does not establish alignment for selection. Limited panels do not prove host susceptibility, donor direction/timing, calibrated clocks or ecology. |
| RNA structure, non-B DNA, epistasis, virion stability, integration risk; roadmap | PARTIAL scientific validity | Real sequence heuristics exist. Nussinov score is not thermodynamic MFE; BLOSUM scoring is not experimentally calibrated fitness; storage or engineering recommendations require evidence beyond labels. Preserve educational use and honest units. |
| CGR/Hilbert/dot plot/gel/logo/PCA, curvature/periodicity, synteny/DTW, phase portraits, bias decomposition; roadmap | PARTIAL proof | Implementations and unit tests exist. Model-specific numerical, reference-data and browser tests remain necessary; a file or reachable panel alone is not complete scientific validation. |
| Seven simulations, reconstructed switches, packaging/ejection, resistance/cocktails; roadmap | PARTIAL | Interactive models exist. Parameterized simulations and rule-inferred circuits must remain distinct from experimentally predictive models. New energetics/circuit methods need independently checked limits and input sensitivity. |
| Offline/PWA, mobile/accessibility; deployment plan | PARTIAL proof | SW code exists, but `navigator.webdriver` suppresses registration in normal automation. Initial offline failure under automation is not evidence of a user-facing offline failure. Generated install manifest omits icons. Manual screen-reader task remains human-owned. |
| Research workflows: imports, saved views, macros, command language, rich exports; deploy/original plans | PARTIAL / NOT_STARTED | URL share and export utilities exist; no macro recorder/player or general imported-genome workflow found. Overlay overflow undo is not general navigation undo/redo. |
| Current installable cross-platform binary; README installation | NOT MET | Existing `0r8g` / `0r8g.3` track the still-stale release. Successful local source startup does not validate packaged assets. |
| WebRTC, WebCodecs, invasive telemetry, browser terminal skin | DESCOPED explicitly | Preserve recorded decisions (`pt19`, `8kpa`, `i5y3`, related scope beads); local BroadcastChannel and static exports are the delivered alternatives. Do not reopen merely because an old plan still contains pseudocode. |

### Bridge design and execution boundaries

The active work is a dependency graph in `br`, not the historical checkboxes below.
Reopen the existing roadmap beads where their closure overstates the implementation;
create separate regression/proof tasks for uncovered defects. Each implementation
leaf has a companion verification task with concrete adversarial cases and browser
artifacts. Historical closure reasons stay visible as history and are explicitly
superseded by the new evidence. No deferred task is silently closed.

| Track | Concrete implementation and acceptance | Size / priority |
|---|---|---|
| Scientific truth repair | Gate synthetic pangenome, docking, structural and uncertainty output at source, registry, panel, export and cache. Explicit demo mode may preserve illustrations; missing data yields unavailable, not invented identities, affinities, CI or recommendations. Follow with real sequence/structure/model inputs and independent validation. | M containment, L real methods; P1 |
| Numerical foundations | Correct FBA feasibility, nonzero/reversible bounds, objective offsets and termination statuses; verify mass balance, bounds, objective consistency and independent optima. Burst fits must expose parameter identifiability and use actual uncertainty procedures. | M/L; P1 |
| Data identity and packaging | Separate stable logical content version from transport-byte checksum; use one contract in builder, manifest, cache and loader. Regenerate raw/gzip/manifest/atlas metadata atomically and validate semantic equivalence in CI. | M; P1 |
| Browser evidence | Make every local/live spec use one origin contract; assert actual loaded data and prevent fake-ready selectors. Cover new panels, failures, accessibility, mobile, real worker/SW behavior and data version transitions. | M; P1 |
| Performance | First repair repeated DB invalidation. Measure critical-path CPU/network/render work on a controlled runner; stage shell/catalog before optional annotations; reduce eager graph and lazy-load proven heavy dependencies. Preserve goal metrics separately from regression floors. | L; P1/P2 |
| Research completeness | Version/licence reference inputs; classify model versus observation; provide experiment import, provenance export, missing-data states and input-sensitive numerical oracles across the remaining roadmap families. Keep metadata-only similarities out of causal claims. | L, staged by domain; P2 |
| Expert workflows | Canonical command execution supports replayable actions, navigation history and local import; preserve existing key semantics and export fallback. Real external multi-user/video scope stays descoped. | L; P2 |
| Release | Keep the existing release epic and human-owned installer task. Require current annotated assets, checksum validation and clean install tests on supported targets before publication. | M; existing P0 |

The first useful implementation sequence is: prevent misleading scientific output;
repair DB identity/delivery and numerical counterexamples; make browser tests select
the intended origin and prove real data; then complete measured performance and
research methods. Existing release and manual accessibility owners are preserved.
This ordering does not serialize unrelated science, database, browser and release work.

### Planning pass record

Phase 1 and the initial Phase 2 bridge are complete. Phase 3a used the frozen
generation prompt verbatim in epic `phage_explorer-7r0ep`. Eight existing beads
were reopened with counterevidence, three new implementation gaps were created,
and all eleven received companion verification beads. Existing release, benchmark
and human accessibility work was retained. This records planning, not completed fixes.

| Work | Implementation | Independent verification |
|---|---|---|
| Pangenome | `aocy1` | `7r0ep.1` |
| Host interactions | `vny8` | `7r0ep.2` |
| Structural epitopes | `z1wa` | `7r0ep.3` |
| Burst inference | `r22j` | `7r0ep.4` |
| FBA / host models | `v6af` | `7r0ep.5` |
| Database identity | `il8a.2` | `7r0ep.6` |
| Lighthouse defects | `5t4r.4` | `7r0ep.7` |
| Browser performance | `5a2` | `7r0ep.8` |
| Data artifact parity | `7r0ep.9` | `7r0ep.10` |
| Browser proof contract | `7r0ep.11` | `7r0ep.12` |
| Documentation truth | `7r0ep.13` | `7r0ep.14` |

All IDs in this document use the `phage_explorer-` prefix.

### Ambition round 1 — make evidence survive the whole user journey

The initial plan repairs individual calculations but could repeat the same failure
in the next overlay. Improve the shared result boundary: carry data kind, accession
and content version, method/version, parameters, units, input coverage, limitations
and optional citations from computation to palette, panel, copy/download and cache.
Use typed distinctions between observation, sequence-derived score, fitted estimate,
simulation and demonstration. A badge alone cannot authorize a numerical quantity.
An unsupported physical unit, donor identity or confidence interval should be
unrepresentable in an ordinary result, not merely accompanied by a warning.

Create a small, independently shippable containment task for the four newly
misleading science surfaces, followed by the deeper existing method beads. Preserve
the visualizations as explicit teaching examples. Add negative browser assertions
that a selected real phage cannot inherit template results after a phage switch,
cache restore, export or failed fetch. A no-data state must explain the missing
input and provide a useful next action without inventing findings.

The same principle improves packaging: an artifact-set descriptor binds raw SQL,
compressed payload, schema, semantic version and transport checksum. Verification
must exercise the loader against that descriptor. It is insufficient to prove
hash stability only inside the producer. Current logical DB version equivalence
is established; byte integrity and cache identity are separate requirements.

### Ambition round 2 — use independent mathematical evidence

Require both positive capability proof and adversarial rejection. Making every
panel return unavailable would stop false claims but would not fulfill the vision.
For each scientific method, a small versioned positive reference case must produce
the correct useful result, while absent/insufficient inputs must fail explicitly.

Use mathematics where it directly closes the observed gap: sequence reconstruction
and orientation invariants for graph paths; primal feasibility, objective consistency
and dual bounds for LP results; sensitivity rank and profile likelihood for parameter
identifiability; actual resampling/coverage for intervals; held-out families and
reliability analysis for classification scores. Determinism alone is weak evidence:
the fabricated pangenome and host vectors are deterministic already.

Bound validation work by domain. Sequence methods (CGR, Hilbert, dot plots, gels,
logos, PCA, curvature, periodicity, motifs, HGT, synteny/DTW, codon and phase/bias
analyses) need independent small reference outputs, strand/coordinate/null controls,
and real browser-to-core agreement. Biological models (RNA, epistasis, stability,
integration risk, reconstructed switches, packaging/ejection and resistance) need
declared equations, dimensional checks, limiting cases, parameter sensitivity and
an explicit account of which quantities are calibrated. A simulation can be correct
as a simulation without becoming a predictive assay.

For ecology, phylodynamics, CRISPR and host inference, build versioned input
readiness separately from analysis: accession/sequence mapping, sampling dates,
alignment and sampling assumptions, host spacer/PAM/system coverage, abundance
tables, licensing and reference provenance. No match in a limited panel is not
evidence of absence; k-mer similarity cannot replace immune evidence or establish
transfer direction. Split reference-input acquisition from inference so missing
external data is a visible dependency, not a silent fallback that closes a bead.

---

### Ambition round 3 — complete a reproducible research journey

The unit of success is a useful experiment the user can reproduce: select a curated
or locally imported genome, inspect coverage, choose compatible reference inputs,
run a supported analysis, compare an explicit control, and export enough context to
repeat the result. Share URLs alone cannot preserve a local sequence or fitted
experiment. Extend the existing action registry and repository boundary for local
FASTA/GenBank inputs, saved views, typed commands, replayable macros and navigation
history. Bind replay to stable accessions, content versions, parameters and random
seeds; reject missing inputs instead of replaying coordinates against another genome.
Cancellation and phage changes must invalidate outstanding work consistently.

Use content-addressed input artifacts and numerical certificates where useful:
graph path reconstruction, LP feasibility/objective certificates, sensitivity and
identifiability reports, and reference-data coverage accompany the result. These
are concrete checks against the counterexamples above, not a new generic theorem
framework. Calibrated claims require held-out biological families; an arbitrary
similarity score stays a score until that evidence exists. Privacy is local by
default: imported genomes and experiment data do not silently leave the browser.

Finish the same journey on narrow touch screens, keyboard-only desktop and the
terminal surfaces the project promises. Record intentional parity differences in
the existing registry/docs. Exercise real WebKit and Firefox separately from
Chromium device emulation, all eight themes, focus restoration, long content and
reduced motion. Include install-manifest icons and SW update/corruption/recovery
states. Human screen-reader work remains with its existing owner and cannot be
closed by automated accessibility scans.

Keep delivery economical: ship immediate truth repair and DB fixes independently;
stage reference acquisition, method implementation, numerical proof and UI proof
as separate leaves. Do not block every useful fix on a universal evidence framework.
Separate immediate CI regression floors from product performance targets. New
closures require merged code plus evidence for that particular capability; old
waivers referencing closed work cannot silently become permanent acceptance.
Preserve explicit WebRTC/WebCodecs/telemetry descopes and current human release
ownership. None of this plan authorizes publication or destructive cleanup.

---

### Final bridge coverage and refinement outcome

The second Phase 3a generation incorporated all three ambition rounds. Five
Phase 5 passes used the frozen refinement prompt verbatim; pass five found no
further plan changes. All issue mutations used `br`. The final result is **61 new
beads, including 35 independent verification tasks, and eight reopened beads**.
The five previously active issues retain their status and human ownership, with
notes correcting stale evidence. Nothing was closed. There are now 1,047 total
issues: 973 closed, 73 open and one in progress. This count describes tracking,
not product completion.

| Added scope | Implementation / integration | Verification |
|---|---|---|
| Immediate scientific truth repair (five surfaces) | `7r0ep.15` | `7r0ep.16` |
| Typed evidence, reproducibility and exports | `7r0ep.17` | `7r0ep.18` |
| Real protein/host/structure reference inputs | `7r0ep.19` | `7r0ep.20` |
| Sequence conformance integration | `7r0ep.21` | `7r0ep.22` |
| Sequence statistics, encodings, codon adaptation | `7r0ep.21.1` | `7r0ep.21.2` |
| Exact matches, digests, motifs, curvature/periodicity | `7r0ep.21.3` | `7r0ep.21.4` |
| Distances, PCA, synteny/DTW, bias/phase views | `7r0ep.21.5` | `7r0ep.21.6` |
| HGT and recombination interpretation | `7r0ep.21.7` | `7r0ep.21.8` |
| Biological-model integration | `7r0ep.23` | `7r0ep.24` |
| RNA, epistasis and stability | `7r0ep.23.1` | `7r0ep.23.2` |
| Integration, lysogeny circuits, translation | `7r0ep.23.3` | `7r0ep.23.4` |
| Energetics, evolution, plaques and resistance | `7r0ep.23.5` | `7r0ep.23.6` |
| Environmental and abundance-data workflows | `7r0ep.25` | `7r0ep.26` |
| Dated inference and alignment validity | `7r0ep.27` | `7r0ep.28` |
| Host spacer/reference workflow | `7r0ep.29` | `7r0ep.30` |
| Local FASTA/GenBank inputs | `7r0ep.31` | `7r0ep.32` |
| Typed commands, saved views, macros and history | `7r0ep.33` | `7r0ep.34` |
| Portability integration | `7r0ep.35` | `7r0ep.36` |
| PWA installation and SW lifecycle | `7r0ep.35.1` | `7r0ep.35.2` |
| Real browser engines, mobile and all themes | `7r0ep.35.3` | `7r0ep.35.4` |
| TUI parity | `7r0ep.35.5` | `7r0ep.35.6` |
| Sourced host metabolic models | `7r0ep.37` | `7r0ep.38` |
| Controlled WASM benchmarks (existing owner scope) | `j5me` | `7r0ep.39` |
| Current binary installation (existing human owner) | `0r8g.3` | `0r8g.5` |
| Manual assistive-technology evidence | Existing human procedure | `jcud` |

| Refinement pass | Material result |
|---|---|
| 1 — coverage and granularity | Split broad sequence/model/portability scopes into ten bounded implementation tasks with companions; retained integration epics. |
| 2 — dependency and ownership | Separated urgent LP repair from host-model research; wired input and integration proofs; preserved release/manual owners and corrected old baseline assumptions. |
| 3 — test validity | Added family holdouts, identifiable-parameter/coverage tests, independent LP oracles and cache state transitions. Distinguished percentile evidence from three-run repeatability. Added release/benchmark proof companions. |
| 4 — source and self-containment | Confirmed prior CRISPR and actual-sequence fixes; reproduced the remaining equal-length selection defect. Added it to containment, narrowed child ownership and distinguished visual observations from measured contrast defects. |
| 5 — convergence | Rechecked all 74 active beads against coverage, useful positive controls, negative controls, evidence, dependencies and scope. No further content changes identified. |

`br dep cycles --json` reported zero active cycles. `bv --robot-triage` agreed
with `br` on 74 nonclosed items and reported 28 actionable, 46 not actionable.
The robot's `blocked_count=0` is a status count, not evidence that no task has
dependencies. Its highest graph-centrality recommendation is the evidence contract
(`7r0ep.17`), followed by DB identity (`il8a.2`) and Lighthouse (`5t4r.4`).
Immediate truth repair (`7r0ep.15`) remains independently ready and P1; centrality
does not override that user impact. Three practical starting tracks are truthful
output, DB identity/artifact parity, and browser proof/Lighthouse diagnosis.

These phases complete the assessment and implementation plan. They do not complete
the software changes, validate all biological models, establish controlled product
performance, or publish a release. The remaining proof limits are explicit: this
audit ran a selected Chromium suite and a TUI startup smoke, not all browser engines,
every terminal interaction, a fresh WASM build, manual screen readers or a controlled
device benchmark. Future claims require those specific results.

---

## Historical revision 4 — superseded, retained for context

**Reality check:** 2026-09-01 · **Plan written:** 2026-09-02 · **Revision:** 4

## Status: the four starters are done

The plan's own recommended opening sequence has been executed. Recorded here
rather than in a separate document, because this plan is the thing that should
stay current.

| Item | State | Evidence |
|---|---|---|
| **T1.5** wall-clock assertion removed | done | Full suite passes 1393/1393 under six concurrent test processes; previously failed 2 |
| **T1.3** summarize job fails on a failed matrix | done | Reports first, then fails on `needs.e2e-production.result != 'success'` |
| **T2.1** release pipeline unjammed | done, **not pushed** | Version 1.5.0; auto-tag now fails on a stale version. Pushing publishes a public release, which is the operator's call |
| **T1.1** e2e runs on every PR | done | 21 tests, 9 specs; verified passing under deliberate CPU contention in 56s |

Two gate exclusions were found and closed while doing the above, both instances
of the plan's own structural finding:

- `packages/web/**` was excluded from the root tsconfig. 107k lines of the
  deployed app had never been type-checked. Enabling it surfaced three real
  defects, including a graceful-degradation path calling a non-existent setter.
- `packages/tui/**` was excluded from ESLint. 11k lines never linted. That is
  how the unused `AnomalyOverlay` import survived — the same import whose
  missing render branch soft-locked the app.

Both gates are now on and clean, and `check` runs both TypeScript projects.

**Next, per the ordering below:** T0 in bulk, starting with the shared MinHash
sketch cache (`qf8k.1`), which three fabrications depend on.

**Where this came from.** An end-to-end audit read AGENTS.md, README.md, both
PLAN documents and NEW_IDEAS, traced every claim to the code that implements it,
and ran the project's own suites. It produced 76 tracked gaps. Eighteen have
since been closed with verified fixes. This plan covers the rest, and it is the
document the remaining beads are generated and refined from.

**Scope of the promise being bridged to.** From the README: a tool for
researchers who want to *explore* a phage genome, on two surfaces (a single
binary TUI and a web app), with 30+ analyses, 7 simulations, real precomputed
annotations, and WASM acceleration. From PLAN_TO_DEPLOY: Lighthouse >90 all
categories, sub-2s time-to-interactive, full offline. From
PLAN_TO_MAKE_WEB_APP_MIRROR: overlay, hotkey and simulation parity with the TUI.

---

## The one sentence that matters

**The project's problem is not missing capability. It is that a user cannot tell
which capability is real.** 36 of 46 analysis overlays compute honestly from the
loaded genome; the other 10 look identical. Every other gap in this plan is
downstream of that, because each one is another way the artifact and the claim
came apart: documentation that described the wrong surface, a WASM module that
silently degraded, a release pipeline that reported success while shipping
nothing, a tracker that read 99.8% complete.

So the ordering below is not by size. It is: **make the claims true, then make
them stay true, then extend them.**

---

## Gap classes, and why they are ordered this way

| Tier | Class | Why here | Remaining |
|---|---|---|---|
| **T0** | Fabricated results presented as analysis | Actively misinforms a researcher | 6 |
| **T1** | Gates that cannot fail | Every other fix regresses without them | 2 (was 5) |
| **T2** | Shipped reality ≠ repo reality | Users run code no one has verified | 3 (was 4) |
| **T3** | Real code that is unreachable | Capability already paid for, not delivered | 6 |
| **T4** | Claims with no measurement | Cannot be defended or refuted | 4 |
| **T5** | Coverage thin enough to mislead | Empty panel reads as a negative result | 3 |
| **T6** | Dead weight and drift | Misleads the next reader | 8 |

---

# T0 — Fabricated results presented as analysis

The tier that decides whether this tool can be cited.

### Gap T0.1: CRISPR analysis runs on a placeholder spacer set — `uhx4.1`

**Current state.** `packages/core/src/crispr.ts:37` carries the comment
`// Mock spacer database for demo purposes` above six hardcoded 6-mers, scanned
with `indexOf`. A 6-mer recurs by chance roughly every 4 kb, so a 48 kb genome
yields dozens of "hits" that are combinatorial noise. Every hit is attributed to
`host: 'E. coli K-12', // Mock host` regardless of the phage's real host,
including the Mycobacterium, Streptomyces, Bacillus and marine phages. Match
scores come from a string hash. Now labelled `demo` in the registry, which makes
it honest but not useful.

**Target state.** Either real spacer matching, or an overlay that renders only
where real data exists.

**Success criteria.**
- [ ] No displayed hit derives from `MOCK_SPACERS`.
- [ ] The host shown beside a hit is the phage's real host from `phage.db`.
- [ ] A phage with no spacer data for its host yields zero hits, not chance matches.
- [ ] Provenance drops from `demo` to `measured` or `heuristic`, whichever is true.

**Implementation plan.**
1. Add a `crispr_spacers` table to `packages/db-schema` keyed by host taxon,
   with spacer sequence, source array id, and provenance.
2. Extend `packages/data-pipeline/src/build-db.ts` to populate it. CRISPRCasdb is
   the source NEW_IDEAS specifies. Follow the pattern already proven by
   `generate-pfam-domains.py`: download at build time, no credentials, cache
   locally, record the release version in `annotation_meta`.
3. Rewrite the scan in `crispr.ts` against ~30 bp spacers, keeping the existing
   PAM-adjacency scoring, which is real and worth keeping.
4. Where a host has no array, render the empty state that says so.

**Fallback if (1)-(2) prove out of scope.** Gate the overlay on real data and
show "no CRISPR array on record for *Mycobacterium smegmatis*" rather than
noise. This is strictly better than today and is a fraction of the work.

**Dependencies.** None. **Complexity:** L (real data) / S (honest gating).
**Vision goals served.** README "Defense & Tropism Prediction"; therapy-screening
workflow step 2.

---

### Gap T0.2: Two overlays assert "REAL DATA" over fabricated inputs — `uhx4.2`, `uhx4.3`

**Current state.**
- **Phylodynamics** (`PhylodynamicsOverlay.tsx:647-650`) shows a green
  "REAL DATA" banner. It fetches real accessions and dates from NCBI, then
  replaces the sequences with `generatePseudoSequence` — a hash of the accession
  string (`:139`, `:210-226`). Tree topology, clock rate, skyline Ne(t) and dN/dS
  are all computed on that. Its `repository` prop is declared and never used.
- **Environmental provenance** (`:416-419`) shows the same banner. Geography and
  sample counts are genuinely from SRA. The headline novelty score is
  `1 − containment`, and containment is
  `0.3 + seededUnit(hashString(...)) * 0.5` (`:168`) — a hash of the phage name
  and location string. Its demo fallback also mints identifiers styled to look
  like IMG/VR and MGnify accessions (`:391-400`).

**Target state.** No banner asserts more than the data supports.

**Success criteria.**
- [ ] `generatePseudoSequence` is unreachable from any path showing a real-data claim.
- [ ] No displayed quantity derives from `hashString` of a name.
- [ ] No fabricated string resembles an IMG/VR, MGnify, VIROME or SRA accession.
- [ ] An e2e test asserts the banner text matches the provenance actually used.

**Implementation plan (phylodynamics).**
1. Fetch real sequences for the accessions via the existing Entrez client
   (`packages/web/src/api/ncbi-entrez.ts`), in a worker, cached in IndexedDB.
2. Compute distances alignment-free (the MinHash path now works, see T2.2) so a
   multiple alignment is not required.
3. If sequences cannot be fetched, render the empty state — do not synthesise.

**Implementation plan (environmental provenance).**
1. Compute containment for real using MinHash sketches, which is exactly what
   the kernel exists for, or remove the novelty score entirely.
2. Prefix any demo identifier unmistakably (`DEMO-…`).
3. Keep the SRA-derived geography and counts; that part is genuinely good.

**Dependencies.** T2.2 (MinHash) is done, so this is unblocked.
**Complexity:** M each. **Vision goals served.** README "Phylodynamics Support",
"Alignment-Free Genomics".

---

### Gap T0.3: Niche network ignores the loaded phage — `uhx4.4`

**Current state.** `NicheNetworkOverlay.tsx:202` calls
`generateDemoAbundanceTable(25, 60, numNiches)`, a `Math.random` matrix of
`Taxon_1…25`. The overlay receives no repository and no phage, so its output is
identical whichever genome is loaded, and changes on every open. The NMF and
bootstrap mathematics underneath are real and worth keeping. Its originating
bead was closed against a plan for SQLite sketch indexes that were never built.

**Target state.** Either real co-occurrence data, or an educational tool that at
least responds to the user's selection and is reproducible.

**Success criteria.**
- [ ] Output is deterministic for a given phage and parameter set.
- [ ] Reopening with the same phage produces the same network.
- [ ] The overlay receives the loaded phage.

**Implementation plan.** Seed the RNG from the phage id; pass the phage through
`OverlayManager.tsx:460`; if real metagenome co-occurrence is in scope, build the
sketch table the original bead specified.
**Complexity:** S (deterministic + phage-aware) / L (real data).

---

### Gap T0.4: Synteny renders a legend for an impossible outcome — `uhx4.6`

**Current state.** `packages/comparison/src/synteny.ts:146,167` hardcodes
`orientation: 'forward'`; `'reverse'` is never produced. Yet
`SyntenyOverlay.tsx:741-751` renders an "Inverted orientation" legend and
`:764-767` tells the user inverted blocks suggest rearrangements. Block `score`
is also taken from the first gene pair only, and the heatmap's "Similarity:
80.0%" comes from gene-name word overlap returning only 0, 0.5, 0.8 or 1.0.

**Target state.** Inversions are detected, or not advertised.

**Success criteria.**
- [ ] Reverse blocks are produced and tested, or no inversion affordance appears.
- [ ] Block score reflects every pair in the block; a multi-gene block is tested.
- [ ] The heatmap label states what it actually measures.

**Implementation plan.** Gene strand is already in the `genes` table and
`reverseComplement` already exists in `packages/core/src/codons.ts:111`. Detect a
block whose gene order is monotonically decreasing in the target with opposite
strand, mark it reverse, and colour it. Inversions are among the most
biologically interesting signals in phage comparative genomics, and this is the
overlay that should show them.
**Complexity:** M. **Vision goals served.** README "Comparative Synteny Browser".

---

### Gap T0.5: Provenance is declared but not shown where it is read — `uhx4.10`

**Current state.** The primitive, the registry field, all 43 annotations, the
Analysis Menu badge and the enforcement test are done. Not done: the badge does
not render inside each overlay's own header; the Command Palette does not show
it; the TUI has no equivalent; `docs/overlay-design-system.md` does not teach it.

**Success criteria.**
- [ ] Every non-chrome overlay renders its level in its header, always visible.
- [ ] The Command Palette shows it, like the Analysis Menu.
- [ ] The TUI uses an equivalent single-line convention for its shared overlays.
- [ ] `docs/overlay-design-system.md` documents it as a required element.

**Complexity:** M. **Note.** Labelling is not fixing. T0.1–T0.4 remain.

---

### Gap T0.6: Heuristics displayed with the units of measurements — `uhx4.7`, `uhx4.8`, `uhx4.9`

**Current state.**
- **RNA structure** shows "Global MFE … kcal/mol" from a greedy stem scan with
  toy pair energies that can return positive values and returns exactly 0 when
  no stem is found. Slippery sites always score 0.7; riboswitches always 0.3.
- **Virion stability** returns `{4 °C, 100 mM}` as a constant "recommended
  storage" for every phage, inside the therapy-screening story.
- **Packaging pressure** is `5 + 50·φ³` and `min(60, 5+55·φ)`. The README
  promises a bending-energy and Debye-screening model. The underlying simulation
  now uses real genome length and morphology-derived capsid radius; the overlay
  does not.

**Success criteria.**
- [ ] No kcal/mol figure without a parameterised energy model.
- [ ] "No structure detected" is visually distinct from "score 0".
- [ ] No constant presented as a per-phage recommendation.
- [ ] The README's packaging description matches the implementation.

**Complexity:** S each for honesty; M–L each for the real models.

---

# T1 — Gates that cannot fail

Without these, every fix above regresses silently. This tier is why the audit
was necessary at all.

### Gap T1.1: CI never runs the e2e suite — `5t4r.1`

**Current state.** `ci.yml` runs lint, typecheck, unit tests and a web build.
The only workflow running Playwright triggers on `deployment_status`, after
deploy, against the live site. 22 specs covering accessibility, hotkeys, the
overlay stack, deep links and mobile enforce nothing on a pull request.

**Note on the audit's own error.** The audit claimed seven of those specs were
failing. Re-run against a quiescent tree, all 29 tests pass in 26 seconds. That
claim was wrong and the bead was closed as not reproducible. The gap here is
unaffected: the suite is green *and* unenforced.

**Success criteria.**
- [ ] A PR breaking an overlay hotkey fails CI.
- [ ] The job is required for merge.
- [ ] Live-site specs are excluded from the PR job.

**Implementation plan.** Add a Playwright job to `ci.yml` using the existing
`webServer` block in `playwright.config.ts`. Chromium only on PRs; mobile and
tablet projects on main or a schedule. Cache the browser download. Sequence
after T1.5 so CI does not land red.
**Complexity:** S. **This is the highest leverage item in the plan.**

---

### Gap T1.2: Lighthouse is red and asserts nothing — `5t4r.4`, `5t4r.5`

**Current state.** Failing for months on 11 audits, including `color-contrast`
at 0 (a direct WCAG 2.1 AA failure) and `errors-in-console` at 0 (the app logs
errors on load in a clean production build, and nobody has read them). The
config asserts FCP/LCP/TTI at `warn` only and has no `categories:*` assertion, so
the deploy plan's "Lighthouse >90 all categories" is encoded nowhere.

**Success criteria.**
- [ ] Lighthouse passes on main.
- [ ] Category assertions exist at the level the plan promised, or the plan is amended.
- [ ] Every waiver names the audit and the reason.
- [ ] The contrast finding is reconciled with the axe-core result, which reports zero violations.

**Implementation plan.** Read the console errors first — free real bugs. Fix
contrast for real; never waive an accessibility audit. Then promote timing
assertions to `error`.
**Complexity:** M.

---

### Gap T1.3: A summarize job reports success over failed jobs — `5t4r.3`

**Current state.** `e2e-production.yml`'s `summarize` runs `if: always()` and
reported **success** in a run where all eight matrix jobs failed at dependency
install. A workflow whose final job is green while its work is red is worse than
no workflow.

**Success criteria.**
- [ ] A run with any failing matrix job does not present as successful.
- [ ] One complete green run against production is recorded.

**Complexity:** S.

---

### Gap T1.4: Performance budgets are asserted nowhere — `5t4r.6`, `k4ep.3`

**Current state.** `performance-benchmark.e2e.ts` is gated behind
`PLAYWRIGHT_PERF=1` and its analysis-timing tests contain no `expect()` at all.
The deploy plan's Success Metrics table (FCP, LCP, TTI, CLS, FID,
keypress-to-paint, 60 fps) maps to no assertion. Measured today: FCP 3.27 s
against a 1.0 s target, TTI 5.63 s against 2.0 s, on a local server with no
network latency.

**Success criteria.**
- [x] The suite runs in CI without an opt-in env var.
- [x] Every target maps to an assertion or an explicit descope.
- [x] Where a budget cannot be met, the current number is recorded as a baseline and ratcheted.

**Resolved (`5t4r.6`, `k4ep.3`).** `performance-benchmark.e2e.ts` now runs in CI with concrete assertions against documented ratchets (FCP, LCP, TTI, keypress-to-paint, scroll FPS, analysis execution, comparison open, memory leak). Lighthouse category floors and metric budgets are enforced as error gates in `lighthouserc.cjs` (`5t4r.5`). `PLAN_TO_DEPLOY_PHAGE_EXPLORER_AS_WEBAPP.md` encodes the CI-enforced ratchet mapping and formally descopes invasive adoption targets with recorded privacy rationale (`k4ep.3`).

---

### Gap T1.5: The suite fails under load — `5ntn`

**Current state.** `transcription.test.ts:419` asserts elapsed < 5000 ms for a
100 kb sequence. Measured: 386 ms warm, 3.3 s cold, **9.6 s under concurrent
load**. A sibling in `comparison-engine.test.ts` behaves the same. So "1,393
tests pass" is true on an idle machine and false on a busy one.

**Success criteria.**
- [ ] No correctness test asserts a wall-clock duration.
- [ ] The full suite passes with heavy concurrent load.
- [ ] Retained timing checks live in a benchmark with a recorded baseline.

**Complexity:** S. **Must precede T1.1**, or CI lands intermittently red for
reasons unrelated to the change under test — the fastest way to teach a team to
ignore CI.

---

# T2 — Shipped reality ≠ repo reality

### Gap T2.1: Nothing has shipped since December — `0r8g.1`, `0r8g.2`, `0r8g.3`

**Current state.** Last release v1.4.1, 2025-12-16. `git rev-list --count
v1.4.1..HEAD` is 565. Root `package.json` is at **1.3.2**, and a tag `v1.3.2`
already exists on an April 2026 commit that *descends from* v1.4.1. So
`release-automation.yml` reads the version, finds the tag present, sets
`status=exists`, and exits **0** — green, having created nothing — on every push
since April. No tag means `release.yml` never fires.

The web app is unaffected and fully current. The gap is entirely in binary
distribution: the README's recommended install delivers a December binary with a
3.1 MB database against the current 10.4 MB annotated one.

**Success criteria.**
- [ ] A version bump on main produces a tag and a release.
- [ ] The workflow fails loudly rather than succeeding silently when the version is stale.
- [ ] A fresh install produces a binary and database matching main.
- [ ] All three installer paths exercised on a clean machine.

**Implementation plan.**
1. Bump to 1.5.0 (above the highest existing tag). Reconcile
   `packages/web/package.json`, which is at 1.4.1.
2. Fix the `status=exists` branch: benign only when the tag points at HEAD.
3. Dry-run `release.yml`; it has never executed successfully in this configuration.
4. Decide explicitly about the anomalous `v1.3.2` tag. Recommended: leave it and
   move forward; deleting a published tag is a shared-state rewrite needing
   explicit approval under AGENTS.md.

**Complexity:** S, and it unblocks every user-facing fix in this plan reaching
anyone who installs the binary. **Second-highest leverage item.**

---

### Gap T2.2: WASM — done, with one item left — `kalm.3`, `kalm.4`, `kalm.5`, `kalm.6`, `kalm.7`

**Done.** The stale SIMD build (production's preferred variant, eight months
behind, missing two exports) is rebuilt; export sets match at 47; a build gate
refuses divergence. MinHash now initializes and runs.

**Remaining.**
- `kalm.4` Toolchain pin: shipped `.wasm` embeds wasm-bindgen 0.2.106 while
  `Cargo.lock` pins 0.2.127, and the two variants were built with different
  rustc. Add `rust-toolchain.toml`; make parity tests run against both variants
  (they currently test only `pkg`, while production prefers `pkg-simd`).
- `kalm.5` 19 shipped kernels have no JS-parity test, contradicting
  `WASM_ABI_SPEC.md:441` which requires one per kernel. `myers_diff` is checked
  against hand-written expectations rather than the production JS fallback, so
  the two implementations that actually run are never compared.
- `kalm.6` No committed benchmark. Needed before any speedup figure returns to
  the docs.
- `kalm.7` Hot kernels take `&str`, so the SharedArrayBuffer path decodes to a JS
  string and wasm-bindgen re-encodes — two full genome copies per call on the hot
  path. `SequenceHandle` exists to solve exactly this and is unused except for
  dot plots.
- `kalm.3` The 11 regex patches in `inline-wasm-compute.ts` are all currently
  no-ops and cannot fail loudly.

**Complexity:** M (parity tests), S (pin, patches), M (benchmark), M (bytes-first).

---

### Gap T2.3: The TUI can read a different database than the web app — `2rdn.3`

**Current state.** Resolution order prefers `${cwd}/phage.db` over
`packages/web/public/phage.db`. Both exist in a dev tree with **different
contents** (b4bb8876… vs 110db172…): the first from `build:db`, the second from
`build:db:annotated`, which has the ESM2 and Pfam annotations. Two people in the
same checkout can see different results.

**Success criteria.**
- [ ] Same checkout, same annotations on both surfaces.
- [ ] The resolved path and a database fingerprint are discoverable inside the TUI.

**Complexity:** S.

---

### Gap T2.4: Deployed database hash is environment-dependent — `il8a.2`

**Current state.** `build-web-db.ts` VACUUMs then hashes, and the web client
uses that hash as its cache key. A local VACUUM is deterministic (verified: two
runs byte-identical), yet the deployed manifest hash differs from a local VACUUM
of the same committed file. So the cache key depends on the build environment,
and a deploy with no data change can force every returning visitor to
re-download 3.9 MB.

**Success criteria.**
- [ ] Two deploys with unchanged data produce the same manifest hash.
- [ ] A data change still invalidates the cache.

**Implementation plan.** Hash the source content or a logical fingerprint
(schema version + row counts + content digest) rather than post-VACUUM page
layout. **Complexity:** S. Matters because cold start is already over budget.

---

# T3 — Real code that is unreachable

Capability already built and paid for, not delivered.

### Gap T3.1: The keyboard has five conflicting sources of truth — `v3wn.2`–`v3wn.7`

**Current state.** `docs/keyboard-shortcuts.md` calls itself the "single-source
key map" and matches neither surface. The README promises Layer 0 keys are
"immutable" and "stable forever"; four of them (`c`, `v`, `j`, `k`) do
*different things* on the two surfaces, and `[`/`]` mean gene-jump in one and
diff-jump in the other — the dangerous kind, where a user actively causes the
wrong action. Roughly ten more Layer 0 keys are unbound in the web app,
including the whole F1–F10 row. Three TUI bindings (`Ctrl+F`, `Ctrl+P`,
`Shift+Y`) are shadowed by earlier single-letter branches in an if/else chain
that tests `input` before modifiers. The in-app KeyboardPrimer, shown to every
new user, teaches three shortcuts that are not bound. `featureRegistry.ts` is
809 lines of dead code with ~18 wrong shortcuts — and is the most detailed of
the five documents, so it is what a future agent will trust.

**Success criteria.**
- [ ] No document describes a binding that does not exist.
- [ ] No binding exists that no document describes.
- [ ] Divergences are enumerated deliberately with a recorded reason.
- [ ] `bun run check` fails when code and docs drift.
- [ ] Every shortcut the KeyboardPrimer teaches works.

**Implementation plan.**
1. Restructure the TUI handler to dispatch on a normalised `{key, ctrl, shift,
   meta}` tuple through a lookup table. This is the precondition for generating
   docs, because a table can be enumerated and an if/else chain cannot. Per
   AGENTS.md, do this by hand in a 46 KB file, not mechanically.
2. Generate `docs/keyboard-shortcuts.md` from both registries.
   `scripts/generate-keyboard-tables.ts` already exists for this and is wired
   into nothing. Add it to `check`.
3. Decide Layer 0 explicitly: restore parity for the keys that currently do
   *different* things, or amend the README's immutability promise. Record
   browser-reserved combinations as deliberate divergences.
4. Resolve `featureRegistry.ts`: delete with approval, or derive from
   `actionRegistry` and mount `FullFeatureModal`. Do not leave it.

**Complexity:** L overall; step 2 alone is M and removes most of the drift risk.

---

### Gap T3.2: Unreachable and half-wired surfaces — `9vk4.1`, `9vk4.2`, `9vk4.4`, `9vk4.5`, `9vk4.7`, `v3wn.3`

| Item | State | Resolution |
|---|---|---|
| `tour` overlay | Only id of 58 with no render path; `FeatureTour.tsx` never imported; store persists tour-completion state for a feature nobody can start | Mount it with an entry point, or remove component + id + state together |
| `collaboration` overlay | Unreachable, and its BroadcastChannel transport cannot cross machines while its UI offers join-by-session-id. `SignalingMessage` types declared, never used; zero `RTCPeerConnection` in the repo | Rename to tab-sync and make it reachable, or park it, or build real WebRTC as its own epic. Do not leave the current shape |
| `D` for diff (web) | Registry entry and toolbar label exist; no handler is ever registered. Diff is Layer 0 and a headline README feature | Register it; the diff machinery exists (`DiffHighlighter` already binds next/prev) |
| `gpuWasmBenchmark` | Listed in production menus; component returns null unless DEV | Gate the registry entry on DEV, or ship it — it is the only JS-vs-WASM measurement surface and T2.2's benchmark needs it |
| `offline.html`, File System Access utils | Built, precached, never referenced / wrapped twice and never called | Wire or remove with approval. Export of analysis results is the obvious fit |
| 24 dead Rust exports + every `SequenceHandle` accessor | Compiled into both shipped variants, base64-inlined into the bundle | Wire or remove. Adopting `SequenceHandle` for GC skew/entropy/k-mer kills most of this *and* delivers T2.2's zero-copy |

**Complexity:** S–M each; `collaboration` is a real decision, not a cleanup.

---

# T4 — Claims with no measurement

`kalm.6` (benchmark), `il8a.3` (ProteinDomain overlay credits InterProScan
while the rows are PyHMMER Pfam-A hits — matters because the tool determines how
a domain call should be interpreted), `6ljm.8` (CHANGELOG stops at 2026-03-21,
omitting ~170 commits including the entire ESM2 and Pfam pipeline), `k4ep.3`
(deploy-plan metrics).

The README is now reconciled; these are the remaining claim/measurement gaps.

---

# T5 — Coverage thin enough to mislead — `il8a.1`

**Current state.** `defense_systems` has 5 rows across **2 of 24** phages, all
`anti-RM` at confidence 0.55, four of them on P1. No anti-CRISPR row exists at
all, despite the README advertising AcrIIA4-family detection.
`amg_annotations` covers 8 of 24; `tropism_predictions` 7 of 24. So three
overlays are empty for most of the catalogue, and an empty panel reads as "no
defense systems present" rather than "not annotated".

**Why coverage is low.** The scanners match keywords against gene product names,
and phage annotations are dominated by "hypothetical protein". A known
limitation of the approach, not a bug.

**The opportunity.** 1,695 real Pfam-A hits and 2,039 real ESM2 vectors now ship
in the database and did not exist when those scanners were written. Pfam families
are a far better signal than product names, and ESM2 nearest-neighbour search
against known Acr proteins is exactly what NEW_IDEAS ideas 2 and 8 specify.

**Success criteria.**
- [ ] Empty states distinguish "no annotation available" from "none found".
- [ ] Defense and AMG calls derive from `protein_domains`, not product names.
- [ ] Coverage and method recorded after the change.

**Complexity:** S (empty states) / M (domain-derived) / L (embedding search).
**Highest scientific value per hour in the whole plan.**

---

# T6 — Dead weight and drift

`k4ep.1` (four features closed-as-done and never built: WebRTC, WebCodecs export,
TUI skin, error telemetry — reopen or descope explicitly, do not leave them
reading as delivered), `k4ep.2` (10 of ~51 roadmap ideas unbuilt, two from the
curated top ten; several were descoped for lacking inputs that now exist),
`k4ep.4` (closure standard: 525 of 888 closed beads carry no reason),
`k4ep.5` (accessibility epic blocked on a manual screen-reader run no agent can
perform — split it to a human owner), `k4ep.6` (bv validation), `zzqa`
(phantom tsconfig include, stale WASM ambient types), `oox6` (enable
unused-import linting — lint runs at `--max-warnings=0` and still missed one),
`sni9` (two stray root scripts).

---

## What the repairs unlock — the part this plan initially missed

The first draft of this document was purely remedial: a tiered list of things
that are wrong. That is half a plan. Two things changed in the last two days
that make several previously-impossible capabilities cheap, and a plan that
does not exploit them is leaving the best work on the table.

### Unlock 1: MinHash now runs, and it is the key to three fabricated overlays

`initMinHashWasm` was never called, so every MinHash consumer silently used
exact k=15 set Jaccard. It now initializes. That single kernel is the honest
implementation of three separate things this plan lists as fabrications:

| Fabrication | What MinHash gives it |
|---|---|
| **T0.2 environmental containment** — currently `hashString(name)` | Containment of a query genome in a sample is *definitionally* a MinHash containment estimate. The invented number has a real replacement that already compiles |
| **T0.2 phylodynamics distances** — currently hashes of accessions | Alignment-free pairwise distance over real fetched sequences, so no multiple alignment is needed and the tree becomes real |
| **T0.1 CRISPR alternative** — if a real spacer set proves out of scope | Sketch-based similarity against host genomes is a defensible second-best that beats six hardcoded 6-mers by any measure |

**Consequence for the plan:** T0.1–T0.3 are not three independent research
projects. They are three consumers of one now-working kernel plus a data-fetch
each. Sequence them together and share the sketch cache.

### Unlock 2: the annotations that descoped ideas now exist

`k4ep.2` records ten roadmap ideas with no implementation. Several were closed
"out of scope" specifically because they needed protein embeddings or domain
calls the project did not have. It now ships **2,039 real ESM2 vectors** and
**1,695 real Pfam-A hits**, credential-free and reproducible.

| Idea | Why it was descoped | Why it is now feasible |
|---|---|---|
| **Top-10 #10 Pan-Phage Latent Space Atlas** (`wae`, closed "Out of scope") | Needed ESM2 embeddings in SQLite | They are in SQLite. 2,039 vectors, 320-d, all 24 phages. UMAP coordinates can be precomputed at build time exactly as the idea specifies |
| **#3 Structural Epitope Clash Map** (`t9j`) | Needed per-protein structure signal | Pfam domain boundaries plus fetched RCSB structures give real coordinates for tail-fiber regions |
| **Anti-CRISPR detection** (T5, and README's AcrIIA4 claim) | Keyword scan finds nothing in "hypothetical protein" | Nearest-neighbour search in ESM2 space against a small set of known Acr proteins. This is the method NEW_IDEAS idea 2 specifies, and the vectors are already shipped |
| **#7 Protein Domain Chord Plot** | Needed domain calls | 1,695 of them, with E-values |

**Consequence for the plan:** T5 (annotation coverage) is not merely "make the
empty panels less empty". It is the single highest-value tier, because the same
embedding index serves the atlas, the Acr detector and the domain plot. Build
the index once.

### Unlock 3: provenance can be a feature, not an apology

T0.5 currently treats the provenance badge as a warning label. That is the
defensive reading. The offensive one: **no tool this project compares itself
against tells you where a number came from.** Geneious does not. SnapGene does
not. The NCBI viewer does not.

A "how do I know this?" affordance — click any result, see the actual
computation, its inputs, the kernel that ran (WASM or JS), the annotation
release version, and a citable description — turns the project's most
embarrassing finding into the thing that distinguishes it. The machinery is
already half-built: `annotation_meta` records pipeline versions, the WASM loader
knows which variant ran, and every analysis module has a defined input set.

**Consequence for the plan:** T0.5 is promoted from "finish the labelling" to
"build the provenance affordance", and it should absorb the citation surface a
researcher needs anyway.

---

## The structural cause, and the one change that addresses it

Every gap in this document is an instance of one pattern: **an artifact and its
claim were allowed to drift because nothing compared them.**

- The web app was excluded from `tsconfig`, so 107k lines were never type-checked
  — and a graceful-degradation path that called a non-existent setter shipped.
- `pkg-simd` was never rebuilt by anything, so production ran an eight-month-old
  module and the failure mode was a silent fallback.
- `release-automation.yml` compared a version to a tag and exited 0 on mismatch.
- The README was compared to nothing.
- 525 of 888 closed beads recorded no evidence, so the tracker was compared to
  nothing either.

The pattern is not carelessness; each individual decision was locally
reasonable. It is the *absence of a comparison step*. So the durable fix is not
"be more careful", it is: **every claim gets a mechanical comparison, and the
comparison runs in CI.**

Four already exist as of this revision and should be the template for the rest:

1. `overlay-wiring.test.ts` — every openable overlay has a render branch.
2. `overlay-provenance.test.ts` — every overlay declares its data provenance.
3. `readme-catalog.test.ts` — the README's phage table matches the database.
4. The WASM variant drift gate in `scripts/build.ts`.

Each was written with a planted negative proving it catches the defect it exists
for. **Every tier below should end with one.** T3.1 should generate its
keyboard docs and fail `check` when stale. T4 should fail when a speedup figure
has no benchmark row. T5 should fail when an overlay claims coverage it lacks.

That is the difference between this plan fixing 40 defects and this plan making
the 41st impossible.

## Ordering

```
T1.5 flaky wall-clock  ─┐
                        ├─► T1.1 e2e in CI ──► everything below stays fixed
T1.3 summarize gate   ─┘

T2.1 release unjam ──────► users see any of this at all

T0.1 CRISPR      ─┐
T0.2 REAL DATA   ─┤
T0.3 niche       ─┼─► T0.5 provenance everywhere ──► the tool becomes citable
T0.4 synteny     ─┤
T0.6 units       ─┘

T5 annotation coverage ──► the analyses become scientifically useful
T3.1 keyboard truth    ──► the two surfaces stop contradicting each other
T2.2 WASM parity/bench ──► the performance story becomes defensible
T3.2, T4, T6           ──► debt
```

**Start here, in this order:** T1.5 (hours), T1.3 (hours), T2.1 (hours), T1.1
(a day). Four small items; after them nothing regresses silently and users
actually receive fixes. Then T0 in bulk.

---

## Verification plan

When this plan is complete, each of these must be demonstrable, not asserted:

- [ ] Open any overlay; its provenance is visible before and after opening, and accurate.
- [ ] No overlay displays a number derived from a hash of a name.
- [ ] `bun run check` and the full suite pass under heavy concurrent load.
- [ ] A PR that breaks a hotkey, an overlay, or an accessibility rule fails CI.
- [ ] `curl … install.sh | bash -s -- --with-database` yields a binary and database matching main.
- [ ] Lighthouse passes all four categories on main.
- [ ] Every keyboard document is generated, and `check` fails when one is stale.
- [ ] Every speedup figure in the repo traces to a row in a committed benchmark.
- [ ] Defense, AMG and tropism either cover most of the catalogue or say why not.
- [ ] `br ready` reflects real remaining work; no bead reads as delivered when it is not.

---

## Retirement

This document is deleted when the beads it generates are closed. It exists to
sequence them, not to outlive them. If it is still here with no open T0 or T1
beads, it is stale and should go.
