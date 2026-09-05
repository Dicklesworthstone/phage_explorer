# Changelog

All notable changes to [Phage Explorer](https://github.com/Dicklesworthstone/phage_explorer) are documented here. Entries are organized by capability rather than diff order. Each version links to its GitHub release where applicable, and individual commits link to their full diffs.

---

## [Unreleased] — post-v1.4.1 (2025-12-16 through 2026-09-05)

Over 550 commits of active development since v1.4.1, spanning annotation pipelines, ESM2 embeddings, Pfam domain architectures, WASM acceleration, WebGL rendering, mobile discovery, and rigorous test coverage.

[Compare: v1.4.1...main](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.1...main)

> **Note on Historical Version Tags**: Git tag `v1.3.2` was historically attached to commit `de580ce` (2026-04-24), which is a descendant of `v1.4.1` (2025-12-15). Under bead `0r8g.2`, Option 1 was selected: rather than rewriting shared git history/tags, `v1.3.2` remains a non-breaking historical artifact and subsequent releases proceed monotonically from `v1.5.0` (`package.json`).

### September 5 source changes awaiting publication

- **Actual CDS in the codon lens** — the panel loads the selected genome and accepts local imports instead of fabricating counts when sequence was omitted. Extraction follows joined segments, strand and `codon_start`; exports preserve those inputs and separate sequence counts from illustrative host-model scores. Missing usable CDS yields no host rankings. See [the implementation](packages/core/src/analysis/codon-pair-adaptation.ts) and [browser journeys](packages/web/e2e/scientific-results.e2e.ts).
- **Ambiguity-preserving sequence statistics** — codon counts, codon-pair scores and GC3 retain reading-frame positions across unknown bases. K-mer paths count only valid windows without joining across ambiguity, use the same default k=6, and normalize frequencies by counted windows. JavaScript complexity treats U as T consistently with WASM; entropy metadata reports the normalized fraction.
- **Analysis input and result export** — AMG exports and clipboard copies retain exact model, annotation and marker inputs, parameters, raw results and evidence descriptions. Restoring a record validates its checksums and selected-genome identity before recomputing. GC-skew exports retain the actual worker input and backend. Shared field types distinguish observations, scores, fits, simulations, demonstrations and unavailable values; broad overlay/TUI adoption and full replay remain unfinished.
- **GC-skew backend agreement** — JavaScript fallbacks now use the same sampled per-base G-minus-C counts as WASM instead of summing window ratios. The chart uses actual sample positions, and all-AT/ambiguous sequences show an undefined state. Browser checks compare hand-derived counts under both backends and reject stale evidence after switching local genomes.
- **Private genome input** — local FASTA/GenBank records join the browser and terminal repositories and existing navigation, gene map, comparisons and sequence analyses. Original files and the selected sequence view round-trip through a versioned bundle. The TUI accepts startup file import, optional catalog-free operation, explicit accession collision handling and bundle export to a new destination; its catalog stays read-only during import. Joined gene segments preserve their gaps, local records receive no invented 3D/fold reference, and terminal control sequences in imported labels are stripped from display while original files remain intact. In-app TUI paste/review and complete analysis replay remain unfinished. See [the importer](packages/core/src/genome-import.ts), [terminal entry point](packages/tui/src/index.tsx) and [browser journeys](packages/web/e2e/local-genome-import.e2e.ts).
- **Terminal navigation and recovery** — rapid selection cancels stale loads and incremental analysis updates, clears the previous genome's analysis data, and bounds sequence scrolling. Error screens retain Escape/Q recovery even when an overlay was active.
- **Selection and sequence exports** — command-palette navigation loads the selected genome. FASTA and clipboard exports read that genome's sequence; previously they read the diff reference, which could be empty or belong to another genome.
- **Browser comparison recovery** — workers handle browsers without `SharedArrayBuffer`; a new comparison cancels the previous computation, and worker failures clear loading and permit retry.
- **Verified database loading** — logical dataset versions and exact-byte checksums are separate. Cached bytes are checked before SQLite opens, and the catalog becomes usable while offline persistence finishes. Settings refresh and service-worker updates preserve a single active database owner (`aae96b8`, `c4767c3`, `0e864c9`).
- **Numerical and scientific corrections** — bounded FBA solves feasibility and objective constraints and labels its teaching model as uncalibrated (`303c320`). Tropism can use deposited protein translations; synthetic structural quantities, host interactions, pangenome examples and phylodynamic examples require explicit opt-in. Burst fitting no longer invents confidence intervals (`6d973da`). These corrections narrow the claims of the older feature descriptions below.

These entries describe local source and production-build verification, not a new
public deployment or binary release. Revision IDs above refer to local commits;
public commit links can be added when those commits are published.

### New Analysis Overlays and Modules

- **Pan-Phage Graph Pangenome & Variant Cards** — construct rGFA sequence variation graphs, decompose into ultra-bubbles, detect net length deltas, ΔGC shifts, recombination breakpoints, and identify recombination hotspots (`Shift+P`)
- **Synteny Elastic Alignment DTW** — dynamic time warping synteny alignment across phage pairs with conservation scoring, topological warping path, structural inversions, and translocation detection
- **Host-Phage Protein Interaction & Effector Docking Map** — bipartite interaction network mapping phage effectors to host proteins with buried surface area, binding affinities (ΔG, Kd), and in-silico mutation simulation (`Alt+I`)
- **Burst Kinetics & Latency Inference** — fit canonical lysis/burst datasets (Ellis & Delbrück 1939, Wang 2000, Hutchison & Sinsheimer 1966, Henry 2013) with coupled ODEs and simulate in-silico lysis cassette alterations
- **Capsid Packaging Energetics & Portal Pressure Gauge** — continuum inverse-spool model calculating internal capsid pressure, packaging force, interaxial DNA spacing, and Debye electrostatic repulsion
- **Structural Epitope Clash Map & Tail Fiber Engineering** — receptor docking, clash penalty analysis, and modular chimera crossover junction recommendations
- **Codon-Pair Adaptation & Translation Attenuation Lens** — calculate CPS, CPB, and ribosomal pause risk scores to detect translational bottlenecks
- **Auxiliary Metabolic Gene (AMG) Flux Potential Analyzer** — identify conserved AMG markers and compute predicted flux deltas (Δ-FBA) across host metabolic pathways
- **Lysogeny Decision Circuit & Phase Portrait Reconstructor** — bistable ODE model of the lambda lysis/lysogeny genetic switch with nullclines, phase portrait vector fields, and UV induction simulation
- **Pan-Phage Latent Space Atlas** — interactive 2D embedding space projection of ESM-2 protein vectors with functional cluster categorization
- **HowDoIKnowThis Methodology Affordance** — provides transparent provenance inspection, data source citations, and algorithm execution details across overlays
- **Feature Tour Onboarding** — interactive step-by-step guided tour reachable via WelcomeModal, CommandPalette, and LearnMenu
- **Epistasis & Fitness Landscape Explorer** — interactive epistasis analysis with fitness landscape visualization ([`712b032`](https://github.com/Dicklesworthstone/phage_explorer/commit/712b032c55c4558e5457cb79957ac90362d06df0))
- **Metagenomic Co-Occurrence & Niche Profiler** — model ecological co-occurrence networks and niche partitioning ([`e8e53b8`](https://github.com/Dicklesworthstone/phage_explorer/commit/e8e53b85e5e43070306a481a38b1b1f2968877e7))
- **Phylodynamic Trajectory Explorer** — visualize evolutionary trajectories over time ([`25bd65a`](https://github.com/Dicklesworthstone/phage_explorer/commit/25bd65a0fe5d6e112f2ab792b8985b87955631c0))
- **Environmental & Geospatial Provenance Map** — geographic provenance tracking with environmental metadata ([`34766f4`](https://github.com/Dicklesworthstone/phage_explorer/commit/34766f4dfcf4d02f0e6ad09c8f90729958b756e8))
- **Resistance Evolution Simulator** — Gillespie stochastic simulation of resistance evolution ([`5b0a774`](https://github.com/Dicklesworthstone/phage_explorer/commit/5b0a77424f2477c370efbda11768ea4cbff587fc), [`744c73d`](https://github.com/Dicklesworthstone/phage_explorer/commit/744c73d03d3aa7176c951a534ac59dc447d3d851))
- **RNA Structure & Packaging Signal Explorer** — regulatory element detection with expanded RNA signal analysis ([`fbe9cc2`](https://github.com/Dicklesworthstone/phage_explorer/commit/fbe9cc25f24292c4bef0b86c30f35eac7c98e24e), [`a9fdb1e`](https://github.com/Dicklesworthstone/phage_explorer/commit/a9fdb1e00ea058377d9fdfe63ce3239101a6606f))
- **Prophage Excision Precision Mapper** — identify precise prophage excision boundaries ([`7421ee7`](https://github.com/Dicklesworthstone/phage_explorer/commit/7421ee78bff7b0e66fd3e4cbbace522568e25ca1))
- **Cocktail Compatibility Overlay** — lysis timing, Sie genes, immunity, and receptor scoring for phage cocktail design ([`10a5c43`](https://github.com/Dicklesworthstone/phage_explorer/commit/10a5c43514858ff0c4688cbfe0e45f7a050a13d8))
- **Regulatory Constellation Visualization** — enhanced PromoterOverlay with core regulatory detection ([`c644943`](https://github.com/Dicklesworthstone/phage_explorer/commit/c644943ec77c900de116349138c5a6564981fce3), [`4c28b2f`](https://github.com/Dicklesworthstone/phage_explorer/commit/4c28b2fbc6e81ba320b85926ae3e25777e8ea563))
- **Ancestral Sequence Reconstruction** — infer ancestral sequences on phylogenetic trees ([`d107a5f`](https://github.com/Dicklesworthstone/phage_explorer/commit/d107a5f8ef8bc0172a18850bc2e18323d762ce59))
- **Gene-aware dN/dS with reverse-frame correctness** — selection pressure analysis scoped to individual genes ([`2bae16f`](https://github.com/Dicklesworthstone/phage_explorer/commit/2bae16f31aec3044c047a4a503a5acab4c3c1fa8))
- **HGT Passport Stamp Provenance View** — amelioration timing for horizontal gene transfer analysis ([`1719004`](https://github.com/Dicklesworthstone/phage_explorer/commit/17190045e0097a80539cc9a34c151fe9199fc89f))
- **Module Coherence Overlay** added to OverlayManager and AnalysisMenu ([`a34854b`](https://github.com/Dicklesworthstone/phage_explorer/commit/a34854b3969201b0ad4b4bdbdc4df1f45ddf8c3c))


### WASM Acceleration (Rust)

- **Dense k-mer counter** with ABI specification ([`90e6a87`](https://github.com/Dicklesworthstone/phage_explorer/commit/90e6a87ccb656901d792e9ab19b56192191db6e8))
- **MinHash signatures** with performance instrumentation ([`c93925e`](https://github.com/Dicklesworthstone/phage_explorer/commit/c93925e2cb327daef0c9a5e417a7eb936891e9ab)); used for HGT donor inference ([`a66e950`](https://github.com/Dicklesworthstone/phage_explorer/commit/a66e95092d9b590b4c7c3880b129c16f06033ffc)) with LRU signature cache ([`9dc9ce4`](https://github.com/Dicklesworthstone/phage_explorer/commit/9dc9ce4b8090af7c29ee24cc24ad369792fee11c))
- **Myers diff algorithm** with guardrails, integrated into comparison worker ([`687a002`](https://github.com/Dicklesworthstone/phage_explorer/commit/687a0021369ce2cf9cfc1eb5eda7deced6cebbae), [`cb443f2`](https://github.com/Dicklesworthstone/phage_explorer/commit/cb443f20ec3fc54ea8f81123f8a2c45ea8b9415e))
- **SequenceHandle** for zero-copy sequence storage and transfer to workers ([`393e2d5`](https://github.com/Dicklesworthstone/phage_explorer/commit/393e2d5eb867de20187dd9e18189bfe49ca9170c), [`0a26127`](https://github.com/Dicklesworthstone/phage_explorer/commit/0a26127a8afb2a5474b4d1703a83521d975db941))
- **WASM dot plot** with progressive refinement ([`c05b842`](https://github.com/Dicklesworthstone/phage_explorer/commit/c05b842d61d8d9572859389e7ed8c18b7c84281e), [`3e624a7`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e624a76e63691f3f500526cab31d1eb5ef8d08b))
- **WASM GC skew** computation and 3D structure caching ([`c9450d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/c9450d1d5abc7ce3af860799a146559016ba646e))
- **WASM KL divergence** window scanning for anomaly detection ([`9f7cd86`](https://github.com/Dicklesworthstone/phage_explorer/commit/9f7cd8689c0e341936db2c0c94b3cbee8fa7a04e), [`6635a38`](https://github.com/Dicklesworthstone/phage_explorer/commit/6635a38a4fea3189d141fc5b20d07f383d0a4373))
- **Functional group detection** for 3D structure analysis ([`70ddef3`](https://github.com/Dicklesworthstone/phage_explorer/commit/70ddef3d1b240987dbf32c1d8aae244dca61fd2e), [`c7c4b80`](https://github.com/Dicklesworthstone/phage_explorer/commit/c7c4b800978d3bd2687d0fd4f6ad3aad1e2490a2))
- **PDB structure parser** for 3D visualization ([`bd8c304`](https://github.com/Dicklesworthstone/phage_explorer/commit/bd8c3049ddcf91272fac202188fd7402561bdf87))
- **Spatial-hash bond detection** for O(N) structure loading ([`7924ff6`](https://github.com/Dicklesworthstone/phage_explorer/commit/7924ff683518e654b7aa66f3abe191a0a4706b03))
- WASM codon usage acceleration in workers ([`ac41b5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ac41b5b1f7c01ba0c3e5b6e4fc67f36b69ac0fd7))
- PCA WASM threshold lowered and k-NN search optimized ([`7ab621f`](https://github.com/Dicklesworthstone/phage_explorer/commit/7ab621f9d6b1fa2b32e1aa83c1e8a5cd2f0ecfb0))

### Rendering and Visualization

- **WebGL-accelerated sequence grid renderer** — GPU-powered glyph rendering for smooth scrolling ([`7091deb`](https://github.com/Dicklesworthstone/phage_explorer/commit/7091deb0c648e96e53da8094a51e287ddc124e40))
- **GPU-accelerated WebGL dot plot** for sequence self-comparison ([`4e5fc3a`](https://github.com/Dicklesworthstone/phage_explorer/commit/4e5fc3a5048e2feb482b501a659228a1c230b041))
- **GenomeTrack system** for synchronized multi-track analysis visualization ([`5442cbd`](https://github.com/Dicklesworthstone/phage_explorer/commit/5442cbd67e24eb9ed286085da12f0e7350cdc812))
- **Enhanced diff mode** with dimmed matches and gap markers ([`c004a3d`](https://github.com/Dicklesworthstone/phage_explorer/commit/c004a3dce8dbcdc2f87a0d58ceb92ebdf2030582))
- **Enhanced 3D fullscreen** mode with HUD and keyboard controls ([`5b2c960`](https://github.com/Dicklesworthstone/phage_explorer/commit/5b2c9605dd589bf9735ae688bd16d230c05acc5f))
- **OffscreenCanvas worker renderer** for jank-free scrolling ([`798aa38`](https://github.com/Dicklesworthstone/phage_explorer/commit/798aa38b409ef437cf918da43647c171199993eb))
- Single-pass micro-batch rendering optimization ([`6e259cb`](https://github.com/Dicklesworthstone/phage_explorer/commit/6e259cb1d9f5805be7b1c6f2d5d23e1f5a269598))
- Comprehensive sequence grid rendering optimizations ([`2dcf551`](https://github.com/Dicklesworthstone/phage_explorer/commit/2dcf5512904a7012fff2af96acffdb81d1899a45))
- Lazy-load overlays and service worker build ([`90c5031`](https://github.com/Dicklesworthstone/phage_explorer/commit/90c5031be30be644daf4bba50c1b212965ab9175))
- 3D renderer culling optimizations ([`4cce11b`](https://github.com/Dicklesworthstone/phage_explorer/commit/4cce11b69b460a993a6d14e879c8d97f7b8b65e6))
- Hot path optimization with array indexing and batched fills ([`8193033`](https://github.com/Dicklesworthstone/phage_explorer/commit/81930338f1dd1f3d3b2eb0f88af0d2cc02c38ac6))

### Design System and UX

- **ActionRegistry as single source of truth** — toolbar, help overlay, and command palette all derive shortcuts from a centralized registry ([`c5cb1be`](https://github.com/Dicklesworthstone/phage_explorer/commit/c5cb1be267a68d78d95c93e3b3746345ed441da4), [`c908e41`](https://github.com/Dicklesworthstone/phage_explorer/commit/c908e417ec40436d146cc99583c44dc572a4b894))
- **Overlay chrome primitives** — semantic tokens and reusable overlay components ([`85c6d5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/85c6d5b932cadf66211ccf23e12974ef38c4221a), [`ca1a573`](https://github.com/Dicklesworthstone/phage_explorer/commit/ca1a57389ea02638c56a3bb9f30f8844307c094c))
- **Experience-level progressive disclosure** in HelpOverlay ([`3e07fa5`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e07fa5bd46b3b48e70bbd1592eb458da87d441a))
- **Device-aware defaults** and centralized motion/FX policy ([`903e242`](https://github.com/Dicklesworthstone/phage_explorer/commit/903e242a120ef38fad766c8963de77394a0be442))
- **Platform-aware shortcut formatting** via actionSurfaces module ([`b11cfe5`](https://github.com/Dicklesworthstone/phage_explorer/commit/b11cfe58929692d204f87a283cca2f95fdcf36ba))
- Hotkey conflict detection ([`c08ce27`](https://github.com/Dicklesworthstone/phage_explorer/commit/c08ce274919a6f1f26d11bec5d1c1c66b8354e99))
- Stripe-level micro-interactions and polish ([`97abc26`](https://github.com/Dicklesworthstone/phage_explorer/commit/97abc26cab6011062ef00691cd5db0533bbd190d), [`5c9f4dd`](https://github.com/Dicklesworthstone/phage_explorer/commit/5c9f4ddb731df84c3d7a6a420e99fa869cb8d2f9))
- Queued toast notification system replacing inline toasts ([`95f9e31`](https://github.com/Dicklesworthstone/phage_explorer/commit/95f9e3113ff968ef8b6b6167feb16e577c0ec7dc))
- GotoOverlay and reorganized keyboard shortcuts ([`34bed80`](https://github.com/Dicklesworthstone/phage_explorer/commit/34bed80dfe42432d8fd17f44898751d3cfc23667))
- FullFeatureModal with comprehensive feature registry ([`bc6bb8c`](https://github.com/Dicklesworthstone/phage_explorer/commit/bc6bb8cd3761a8616062951e6fbadd35e9f2e7f6))
- Context-aware help system infrastructure ([`2bcb7e2`](https://github.com/Dicklesworthstone/phage_explorer/commit/2bcb7e22f87b6295aeca17d563aa14a0e3f69526))
- Experience-level-aware tooltip hints ([`31f8ed4`](https://github.com/Dicklesworthstone/phage_explorer/commit/31f8ed4b0e5908eda0e5344ab43347ab262e8775))
- Visual FX disabled by default, improved mobile scroll handling ([`2e86c38`](https://github.com/Dicklesworthstone/phage_explorer/commit/2e86c38be7e3ed21ae05d80c0e3e5e1e8e2e8e5e))

### Mobile and iOS

- Context menu, swipe actions, and gesture-based interactions ([`e91d112`](https://github.com/Dicklesworthstone/phage_explorer/commit/e91d112b4632e6aac39017e7ee56c0a707ebdf70))
- Comprehensive iPhone Safari fixes for notch, keyboard, and PWA ([`e76d5ed`](https://github.com/Dicklesworthstone/phage_explorer/commit/e76d5edf5413e5caff8f5a4a1024a903e2b9efad))
- Visual viewport CSS variables for iOS keyboard handling ([`f9b18d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/f9b18d1a7ed2c873e1026e8a0dea14f4e2db925a))
- isTouchUi breakpoint for tablet-aware form inputs ([`3bfce0c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3bfce0cf7381fe962869baeaad64bbfe2adb3ec5))
- Scroll flickering elimination via Lenis disable and backdrop-filter removal ([`c9003a8`](https://github.com/Dicklesworthstone/phage_explorer/commit/c9003a8a6848806be508f453a2a66e9f1cf38dc9))
- Enhanced BottomSheet and haptics patterns ([`93a1d4d`](https://github.com/Dicklesworthstone/phage_explorer/commit/93a1d4d8878317b021fc099a16f7a416442a8abd))
- Improved sequence view zoom defaults for readability ([`8b67d5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/8b67d5b1df8e994d6173e466f7a2830d1536adea))
- Landscape layout optimization and responsive typography ([`0518583`](https://github.com/Dicklesworthstone/phage_explorer/commit/0518583d59c75c3e99f15ebe49ee79b98c2f0e3e))

### Accessibility

- ARIA labels on canvas elements, CanvasTrack, and PostProcessingCanvas ([`eabf9b0`](https://github.com/Dicklesworthstone/phage_explorer/commit/eabf9b02cde4a98fa965e399e0ed46a21e20c37a), [`ec87161`](https://github.com/Dicklesworthstone/phage_explorer/commit/ec87161fd5ea9c01f61edae9b2f3f1e1bde4afe6), [`0667e5a`](https://github.com/Dicklesworthstone/phage_explorer/commit/0667e5a5f3f9e1bdaad97fb5f2613ea55488e0b2))
- Mobile touch targets enforced to WCAG 44px minimum ([`4b43fd4`](https://github.com/Dicklesworthstone/phage_explorer/commit/4b43fd432dd348bde11f4c5ec2f28a3a460e5ea4))

### Data and Content

- **Expanded to 24 phages** with 12 new genomes added ([`36d98bb`](https://github.com/Dicklesworthstone/phage_explorer/commit/36d98bb43bcf9fd0ff2f87978b7bc0f7ba2fce37))
- Phage anatomy diagram gallery ([`fb7b032`](https://github.com/Dicklesworthstone/phage_explorer/commit/fb7b032bf3b08c7d9d9966a02fae3f33ceab09e5))
- Gzip-compressed database support with worker decompression ([`ff31d8b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ff31d8b25c0ae9dec6799f82c77097f083f88ab7))
- IndexedDB cache utilities with quota error handling ([`0f6da8f`](https://github.com/Dicklesworthstone/phage_explorer/commit/0f6da8ff1271b998afd36ae025fc7b8080aaeb78))
- Real API integration for phylodynamics and provenance (NCBI, Serratus) ([`51d40a3`](https://github.com/Dicklesworthstone/phage_explorer/commit/51d40a3ab7273081d5ba0c6a92423b041d775d90))
- Lifecycle "business model" intuitions added to educational glossary ([`3875c52`](https://github.com/Dicklesworthstone/phage_explorer/commit/3875c5222f29f2ae9c2df424403b41e5a22a5af5))

### Robustness and Bug Fixes

- Guard against division-by-zero in PCA, MinHash, GeneMapRenderer, Cohen-Sutherland clipping, and non-B DNA detection ([`bf477ca`](https://github.com/Dicklesworthstone/phage_explorer/commit/bf477ca44dcd47fe9d01f060dde5fcd77b75ef55), [`3eb204c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3eb204cb1bce0a5817488ca8d64b9da807d13038), [`097bb1f`](https://github.com/Dicklesworthstone/phage_explorer/commit/097bb1f5c05ab13ad9b51d561052d923dd40478c), [`1b84451`](https://github.com/Dicklesworthstone/phage_explorer/commit/1b84451f82362677c3b07adbca31d6b1a35e161f))
- Handle ambiguous bases (N) correctly in anomaly scanning and CGR ([`c45ec4a`](https://github.com/Dicklesworthstone/phage_explorer/commit/c45ec4aab49ddbdb3eae6fa5dd1ae0d05c15bd77), [`fb94224`](https://github.com/Dicklesworthstone/phage_explorer/commit/fb94224c7b3da3506fe6e88caaae8b6e24f73e03))
- Fix unreachable code in sigma-70 promoter detection ([`29f0c4f`](https://github.com/Dicklesworthstone/phage_explorer/commit/29f0c4f75507fe2d153948874b22d08c5d797e90))
- Clear loading state on early return in 16+ overlays ([`4420a70`](https://github.com/Dicklesworthstone/phage_explorer/commit/4420a70b4018ec195a26c9455cc8c11ed511f484), [`7135f0e`](https://github.com/Dicklesworthstone/phage_explorer/commit/7135f0ed2fa47defa3d5d21eb4b7d446f23e9314))
- Fix race conditions in store, bound cache, and resource cleanup ([`a81559e`](https://github.com/Dicklesworthstone/phage_explorer/commit/a81559ef6dd37efab9a6a499ef5ff15bbdd10e14), [`e22cf58`](https://github.com/Dicklesworthstone/phage_explorer/commit/e22cf58c94aaab899c2a99c8ef8fcbbf5306ac63))
- Memory leak fixes in Overlay and CanvasSequenceGridRenderer ([`1187a1c`](https://github.com/Dicklesworthstone/phage_explorer/commit/1187a1c0b62c0f7a0aef2f2ee1e4e51f7fe03979))
- Prevent stale async results in phage selection ([`70540ee`](https://github.com/Dicklesworthstone/phage_explorer/commit/70540ee5a2e8e06c7f96918d4be0993b9f3d7bba))
- Prevent scroll flicker from post-processing artifacts ([`3d342e3`](https://github.com/Dicklesworthstone/phage_explorer/commit/3d342e3fb2e0e7b09a71ba6c5a71f0c0a3e0aca4))
- Fix CRT fragment shader missing v_uv varying ([`bdc83c2`](https://github.com/Dicklesworthstone/phage_explorer/commit/bdc83c28b3c5f392e2a74d4d9b69013062b4ca0e))
- Deterministic eigenvectors and MinHash parity fixes ([`f226831`](https://github.com/Dicklesworthstone/phage_explorer/commit/f226831e08e2d12a93a54c23a8e90dba1b27f98d))
- Correct ribosome TASEP and stabilize simulations ([`6cb6947`](https://github.com/Dicklesworthstone/phage_explorer/commit/6cb69474d2f2a18d03dbed9b15e23eb048db01a9))
- Prevent canvas from capturing control deck touch events ([`2b6771d`](https://github.com/Dicklesworthstone/phage_explorer/commit/2b6771d37fcc2b33d3f1acbe3c1e2a3b4c5d6e7f))
- Replace alert() with toast notifications ([`2c136f4`](https://github.com/Dicklesworthstone/phage_explorer/commit/2c136f40e1a3e4b5c6d7e8f9a0b1c2d3e4f5a6b7))
- Harden localStorage parsing and Suspense focus preservation ([`ff0fa8e`](https://github.com/Dicklesworthstone/phage_explorer/commit/ff0fa8e5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9))
- Stale JS caching prevention in service worker ([`ba1511b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba1511b8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2))

### Testing

- Comprehensive unit tests for: epistasis, phylodynamics, environmental provenance, prophage excision, recombination radar, RNA structure, CGR compare, metagenomic niche, CRISPR pressure, codons, anomaly scanner, virtualizer, fold embeddings, edit distance, information theory, PCA, transcription analysis, tropism analysis, structural variants, MinHash cache, comparison engine, HGT tracer, synteny aligner
- WASM k-mer kernel tests ([`7b59f24`](https://github.com/Dicklesworthstone/phage_explorer/commit/7b59f24f7b2970bab53634d59cc58d0f7d494e23))
- Zustand store unit tests ([`bbd8a66`](https://github.com/Dicklesworthstone/phage_explorer/commit/bbd8a66c729fda0ec10ee03f465714a34a6c68b7))
- LRU cache and 3D math utility tests ([`b36ad57`](https://github.com/Dicklesworthstone/phage_explorer/commit/b36ad577b8688e67b195e2d3f30815a3ff62cc30), [`a28ff23`](https://github.com/Dicklesworthstone/phage_explorer/commit/a28ff236f19eec0eff9b78485f9d0f7bd43a75c9))
- Playwright E2E: mobile scroll/welcome tests, command palette shortcut drift, hotkey/overlay regression, accessibility tests ([`d85451f`](https://github.com/Dicklesworthstone/phage_explorer/commit/d85451f80a5d8e5e7f2a4b6c8d0e2f4a6b8c0d2e))
- Performance benchmark suites for mobile and low-end devices ([`de456b0`](https://github.com/Dicklesworthstone/phage_explorer/commit/de456b0621d90a44d55a413c23007469fde05865), [`75e8f37`](https://github.com/Dicklesworthstone/phage_explorer/commit/75e8f376fe5fcea65575ee93ce1a33198480d518))
- Playwright logging harness for structured artifact capture ([`fdd2b45`](https://github.com/Dicklesworthstone/phage_explorer/commit/fdd2b45b43c2c533cf4227a0a35419ba5376d068))

### Infrastructure

- Vercel Analytics, Speed Insights, and Google Analytics 4 integration ([`ce3dd9f`](https://github.com/Dicklesworthstone/phage_explorer/commit/ce3dd9fa7ec84bbf3a08fc7aa28a4c9defd8db4b), [`2f7daa5`](https://github.com/Dicklesworthstone/phage_explorer/commit/2f7daa54e32ef02f1d2a7b7f96f7eb7ea2bfe89a))
- PWA icons and static OpenGraph share images ([`f64f023`](https://github.com/Dicklesworthstone/phage_explorer/commit/f64f0238a0b03b5b1ca7f7e13685c4ab8a9d4389))
- SEO meta tags for social sharing ([`f4094a7`](https://github.com/Dicklesworthstone/phage_explorer/commit/f4094a7ae86c67a98416834c3d66fb1c99d19cd5))
- License updated to MIT with OpenAI/Anthropic Rider ([`ed86bea`](https://github.com/Dicklesworthstone/phage_explorer/commit/ed86bea6a4e30dcc543e2b3dfdc7f4e41f6fce22))
- GitHub Actions improvements with caching and best practices ([`f78fdac`](https://github.com/Dicklesworthstone/phage_explorer/commit/f78fdac8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2))
- In-place database builds and Vercel deploy configuration ([`10154fb`](https://github.com/Dicklesworthstone/phage_explorer/commit/10154fb4f61e3e0bb0f4b5ada07e5c18d8e88cff))
- WASM SIMD variant support and improved alias resolution ([`568c4fd`](https://github.com/Dicklesworthstone/phage_explorer/commit/568c4fd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7))
- Centralized browser capabilities and WASM loader ([`5a72124`](https://github.com/Dicklesworthstone/phage_explorer/commit/5a721248b0205fe6d27d1abd0d99c455a3cb9999))

---

## [v1.4.1] — 2025-12-16 — TypeScript Strict Mode Compatibility

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.1) |
[Compare to v1.4.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.0...v1.4.1)

A compatibility release ensuring the entire codebase compiles under TypeScript strict mode with React 19.

### Type System

- Added `@types/pako` and `@types/three` for compression and 3D library types ([`82a1077`](https://github.com/Dicklesworthstone/phage_explorer/commit/82a1077e52a68c1db63d8bfd71e02ba1c1d7abe5))
- Extended ThemePalette interface with `sparklineGradient` property; fixed all theme definitions
- Updated all `RefObject` types to `RefObject<T | null>` pattern for React 19 ([`3e48a1c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e48a1c03dfd0ccf2aaecf2f1ec2f0dbc4e5e11d))
- Exported additional tropism types and added `'diff'` to ComparisonTab union ([`65f9a60`](https://github.com/Dicklesworthstone/phage_explorer/commit/65f9a607c55e2af9a1d5f8ebdcc98ce5caf3b6e3))

### Overlay and Rendering Fixes

- GenomeTrackSegment type assertions in all genome track overlays ([`93c11c0`](https://github.com/Dicklesworthstone/phage_explorer/commit/93c11c0ecaa15780c2f3ee61dbdd01f4f5f7e891))
- GlyphAtlas color record type indexing and WebGPU writeBuffer casts ([`c6da891`](https://github.com/Dicklesworthstone/phage_explorer/commit/c6da891bda19adf27d82b3a8e4aa5d71a0c6af71))
- Updated educational module component types for React 19 ([`b3f44ed`](https://github.com/Dicklesworthstone/phage_explorer/commit/b3f44ed5f1e2bee85e5e34b7d7c3f91f0a539de1))

### Content

- Expanded phage catalog from 12 to 24 with diverse genomes ([`36d98bb`](https://github.com/Dicklesworthstone/phage_explorer/commit/36d98bb43bcf9fd0ff2f87978b7bc0f7ba2fce37))
- Added phage anatomy diagram gallery and educational glossary intuitions ([`fb7b032`](https://github.com/Dicklesworthstone/phage_explorer/commit/fb7b032bf3b08c7d9d9966a02fae3f33ceab09e5), [`3875c52`](https://github.com/Dicklesworthstone/phage_explorer/commit/3875c5222f29f2ae9c2df424403b41e5a22a5af5))
- Renamed "AA" abbreviation to "Amino Acids" throughout UI ([`b09dea4`](https://github.com/Dicklesworthstone/phage_explorer/commit/b09dea4f1f97b1a9aa67b1ce24c4b0f1ef2f8e97))

### Build

- Set worker format to `'es'` for Vite 7 compatibility ([`9489179`](https://github.com/Dicklesworthstone/phage_explorer/commit/948917908c1e2a33c2c1d0b47aafc4f6c09cd7b9))
- Zero TypeScript compilation errors, zero ESLint warnings

---

## [v1.4.0] — 2025-12-16 — Mobile UX Excellence

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.0) |
[Compare to v1.3.1](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.3.1...v1.4.0)

Premium mobile experience with native-feeling touch interactions, gesture physics, and smooth scroll.

### Touch-Optimized Controls

- **Floating Action Button (FAB)** with haptic feedback and spring animations ([`beb476f`](https://github.com/Dicklesworthstone/phage_explorer/commit/beb476f89e7d1b1e9d7cfbef2f47e4e08e93c85f))
- **ActionDrawer** with categorized quick actions (View, Analysis, Tools)
- `@use-gesture/react` integration for unified gesture handling — `useSwipe`, `useDragGesture`, `usePinchGesture`, `useLongPress` hooks ([`7587ff6`](https://github.com/Dicklesworthstone/phage_explorer/commit/7587ff6f8e4906f8dcf00a18d74ee3b9d93f1d66))
- All gestures respect `prefers-reduced-motion`

### Smooth Scroll

- **Lenis** integration for premium scroll physics with mobile-optimized settings ([`ea5d8ba`](https://github.com/Dicklesworthstone/phage_explorer/commit/ea5d8ba10b03bda2e67dfdbf5113c3ff1cb6df3b))
- Native canvas scrolling preserved for SequenceView

### BottomSheet Overlays

- Spring-based animations with multiple snap points ([`7d3ec81`](https://github.com/Dicklesworthstone/phage_explorer/commit/7d3ec8140f3d2f775ca3b9f0d5e70ce903b3f0b9))
- Velocity-aware snap decisions and rubberband effect at bounds

### Browser Capability Detection

- Early fail-fast when WebAssembly is unavailable with clear error messaging ([`aa67c59`](https://github.com/Dicklesworthstone/phage_explorer/commit/aa67c5996d4d2c1f25a8d3f3399f9849f5a5b277))
- Feature detection for threads, SIMD, BigInt

### Onboarding

- Step indicator with progress dots and glow effects ([`a504891`](https://github.com/Dicklesworthstone/phage_explorer/commit/a504891be3efb2bb91b9b2f1e2e4fe1cfaff8f2c))

### Service Worker

- PDB structure caching (CacheFirst, 90-day expiry, max 50 structures) ([`ba2fa1e`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba2fa1ea2d3f5d54c0b11b3b3aab9af45ff26cef))
- 3-second network timeout on NetworkFirst strategies

### Fixes

- FAB z-index corrected to appear above BottomSheet backdrop ([`11388c8`](https://github.com/Dicklesworthstone/phage_explorer/commit/11388c849e4bd2ccbe18a6c5e3e94e1e53c3fc9b))
- Bottom sheet close button increased to 44px (WCAG 2.5.5) ([`9d90467`](https://github.com/Dicklesworthstone/phage_explorer/commit/9d90467b9f5a41a0b20e29a8f69ebed2eb6e4d6f))
- Consistent IconX SVG overlay close buttons ([`11c8b91`](https://github.com/Dicklesworthstone/phage_explorer/commit/11c8b91eec5e10cf3edaf1e8fca87d9b7bf50db7))

### Dependencies Added

- `@use-gesture/react` ^10.3.1, `@react-spring/web` ^10.0.3, `@studio-freight/lenis` ^1.0.42

---

## [v1.3.1] — 2025-12-15 — Bug Fix Release

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.1) |
[Compare to v1.3.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.3.0...v1.3.1)

Targeted fix for a P0 data display error and UX polish, both discovered via Playwright automated testing.

### GC Content Display Bug (P0)

- GC content was showing **4985.8%** instead of **49.86%** because the value was already stored as a percentage in the database, but the display code multiplied by 100 again ([`e0743d7`](https://github.com/Dicklesworthstone/phage_explorer/commit/e0743d7949c0fc88e3cf7e37d7ad5eb7c2dba0d6))
- Fixed in `QuickStats.tsx` and `VirionStabilityOverlay.tsx`

### Disabled Button Styling

- Added proper CSS for disabled ControlDeck navigation buttons: opacity 0.4, `cursor: not-allowed`, muted text, no hover/active effects ([`e0743d7`](https://github.com/Dicklesworthstone/phage_explorer/commit/e0743d7949c0fc88e3cf7e37d7ad5eb7c2dba0d6))

---

## [v1.3.0] — 2025-12-15 — Major Performance Optimization

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.0) |
[Compare to v1.2.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.2.0...v1.3.0)

Dramatic performance improvements through WebGPU compute shaders, expanded WASM functions, and React optimizations. Also includes a complete mobile UI redesign.

### WebGPU Compute Shaders (6 new)

- `edit_dist.wgsl` — wavefront-parallel Levenshtein distance
- `gc_skew.wgsl` — sliding window GC skew computation
- `entropy.wgsl` — Shannon entropy calculation
- `search.wgsl` — parallel motif/pattern search
- `repeats.wgsl` — palindrome and tandem repeat detection
- `dotplot.wgsl` — self-similarity dot plot matrix
- ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7b9b8c7b9c0df9fa59fe8ab3dac4e0b0e7))

### Expanded WASM Module (15+ functions)

- Core genetics: `translate_sequence`, `reverse_complement`, `calculate_gc_content`
- Analysis: `pca_power_iteration`, `shannon_entropy`, `jensen_shannon_divergence`
- Sequence: `detect_repeats`, `compute_gc_skew`, `compute_complexity`
- Display: `build_grid` for optimized viewport rendering
- ([`63fd0cc`](https://github.com/Dicklesworthstone/phage_explorer/commit/63fd0ccba5daa3a11e69f06ed21a0a8a54c2e28e))

### Memory and Caching

- **SharedArrayBuffer** zero-copy worker communication with sequence pooling ([`f6930b2`](https://github.com/Dicklesworthstone/phage_explorer/commit/f6930b28aa0a46e4a1bd7b11f78c9c7e17de7e49))
- **LRU caching** with bounded memory and automatic eviction ([`08b7c91`](https://github.com/Dicklesworthstone/phage_explorer/commit/08b7c911f65a6d4c9be7d94c3fb3cd7f48e8c12b))
- Fixed React Query memory leak from `gcTime: Infinity`
- 50% memory reduction overall

### React Optimization

- `React.memo` on expensive components, visibility detection to skip offscreen rendering ([`3ead092`](https://github.com/Dicklesworthstone/phage_explorer/commit/3ead0925e2d1ff0bb9e0b0f0f0c1e58d2a3f5afa))
- Database prefetch priority queue (adjacent items first) ([`98800fa`](https://github.com/Dicklesworthstone/phage_explorer/commit/98800faa39bbfe3dc3e3a7b1f6b8e7af6a8f5889))
- Build pipeline batch inserts (5-10x faster builds)
- COOP/COEP headers for modern browser features ([`50d9e17`](https://github.com/Dicklesworthstone/phage_explorer/commit/50d9e171a20ad3ec6fca67e61f9b72c3bee4ae53))

### Mobile Redesign

- Complete mobile UI redesign with clean bottom tab bar ([`bbbd5a8`](https://github.com/Dicklesworthstone/phage_explorer/commit/bbbd5a89e8f6e99a3ffc3b3ec9e39e92bc694e4b))
- Premium mobile UX enhancements with haptics and native feel ([`a6028eb`](https://github.com/Dicklesworthstone/phage_explorer/commit/a6028eb16be58a7db093e8c498697f97ce1fae01))

### Biological Intelligence & Annotation Pipelines (2026-08 through 2026-09)

- **ESM2 Embedding Index & Nearest-Neighbor Search** — offline neural embedding index using `facebook/esm2_t6_8M_UR50D` (320d vectors across all 24 phages), powering candidate retrieval and homology mapping ([`d94080b`](https://github.com/Dicklesworthstone/phage_explorer/commit/d94080b))
- **Anti-CRISPR System Detection** — nearest-neighbor detection matching predicted folds against curated Acr reference families with continuous cosine confidence scoring, expanding anti-CRISPR coverage across 15 phages ([`d94080b`](https://github.com/Dicklesworthstone/phage_explorer/commit/d94080b))
- **PyHMMER Pfam-A Domain Pipeline** — local, credential-free profile HMM annotation generating 1,695 high-confidence Pfam domain hits across the entire catalog ([`d5806ea`](https://github.com/Dicklesworthstone/phage_explorer/commit/d5806ea))
- **Domain-Derived Defense Systems & AMGs** — re-derived anti-RM (Ocr, Ral, D12/C5 methylases, DndB), anti-exonuclease (Abc2), and Auxiliary Metabolic Genes (Photosynthesis PsbA/PsbD, RNR, ThyA, dUTPase, MazG, kinases, and deaminases) directly from Pfam accessions, expanding catalog defense predictions to 87 systems across 15 phages and AMG predictions to 48 hits across 10 phages ([`d5806ea`](https://github.com/Dicklesworthstone/phage_explorer/commit/d5806ea))
- **Codon Adaptation Analytics** — per-gene intrinsic CAI, host tAI calculated from 61 real host tRNA pools, and intrinsic Nc (effective number of codons) ([`6fd638c`](https://github.com/Dicklesworthstone/phage_explorer/commit/6fd638c))
- **Morphology Model & Structure Mapping** — mapped all 24 phage slugs to morphology-appropriate 3D/ASCII virion structures, alongside PDB references across 23 of 24 phages in the database ([`6744636`](https://github.com/Dicklesworthstone/phage_explorer/commit/6744636), [`d25ae0b`](https://github.com/Dicklesworthstone/phage_explorer/commit/d25ae0b))

### Mobile Discovery & Research Workflows (2026-08 through 2026-09)

- **Selected-Gene Dock & Inspector** — authoritative selected-gene dock with reproducible citation builder, primary-source NCBI/PDB links, and strand-aware geometry ([`0567ec5`](https://github.com/Dicklesworthstone/phage_explorer/commit/0567ec5), [`b21c189`](https://github.com/Dicklesworthstone/phage_explorer/commit/b21c189), [`ba81d32`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba81d32))
- **Phage Discovery Deck** — transformed mobile picker into an interactive discovery surface with lifecycle classification, saved phages, recents, and multi-factor sorting ([`f852fb9`](https://github.com/Dicklesworthstone/phage_explorer/commit/f852fb9), [`5e5d297`](https://github.com/Dicklesworthstone/phage_explorer/commit/5e5d297))
- **Share-State URL Codecs** — bidirectional deep linking and state restoration preserving active phage, coordinates, zoom level, and selected genes ([`bb30f23`](https://github.com/Dicklesworthstone/phage_explorer/commit/bb30f23), [`09e003d`](https://github.com/Dicklesworthstone/phage_explorer/commit/09e003d), [`bb8c898`](https://github.com/Dicklesworthstone/phage_explorer/commit/bb8c898))
- **WebGL Resilience** — self-healing sequence canvas recovering from context loss and jank-free nucleotide rendering ([`36997dd`](https://github.com/Dicklesworthstone/phage_explorer/commit/36997dd), [`ca7eb3f`](https://github.com/Dicklesworthstone/phage_explorer/commit/ca7eb3f))

### Accessibility (WCAG 2.1 A/AA) & Usability (2026-09)

- **Automated WCAG 2.1 A/AA Compliance** — verified 24/24 automated axe-core E2E tests across 8 mobile and desktop viewports with 0 violations ([`15ce8c8`](https://github.com/Dicklesworthstone/phage_explorer/commit/15ce8c8))
- **Keyboard Navigation Integrity** — resolved sequence buffer conflict in `KeyboardManager` ensuring direct hotkeys dispatch immediately without being blocked by multi-key sequence prefixes ([`15ce8c8`](https://github.com/Dicklesworthstone/phage_explorer/commit/15ce8c8))
- **Overlay Empty States** — updated Defense Arms Race, AMG Pathway, and Host Tropism overlays to explicitly distinguish 'no data annotated for this phage' from 'genome scanned, none detected' ([`d5806ea`](https://github.com/Dicklesworthstone/phage_explorer/commit/d5806ea))

### Toolchain & Quality Standards (2026-08 through 2026-09)

- **Bead Closure Standard** — pre-commit hook and CI verification script (`check:beads`) enforcing concrete evidence for all closed tasks ([`5a89752`](https://github.com/Dicklesworthstone/phage_explorer/commit/5a89752))
- **TUI Terminal Runtime** — upgraded Ink and React to workspace compatibility and patched ErrorOverview composite keys ([`bac5e0f`](https://github.com/Dicklesworthstone/phage_explorer/commit/bac5e0f), [`92ff59c`](https://github.com/Dicklesworthstone/phage_explorer/commit/92ff59c))
- **Deterministic SQLite Distribution** — automated in-place web database optimization with REINDEX, VACUUM, gzip compression, and SHA256 manifest generation ([`d94080b`](https://github.com/Dicklesworthstone/phage_explorer/commit/d94080b), [`d5806ea`](https://github.com/Dicklesworthstone/phage_explorer/commit/d5806ea))

### Performance Summary

| Area | Improvement |
|------|-------------|
| GPU Analysis | claimed 10-100x faster |
| WASM Computation | claimed 5-20x faster |
| Initial Load | claimed 40-60% faster |
| Sequence Scroll | claimed 2-3x smoother |
| Memory Usage | claimed 50% reduction |

> **Note added 2026-09-02.** None of the figures in this table was backed by a
> committed measurement, and the in-repo comments they were drawn from disagreed
> with each other by more than an order of magnitude. They are recorded here as
> claims made at the time, not as results. The WASM row was additionally wrong
> in substance: two of the three accelerations it described (translation and
> MinHash) were not executing at all.
>
> **The WASM row is now measured.** `scripts/benchmark-wasm.ts` sweeps every
> kernel that has both implementations from 1 kb to 300 kb; results are committed
> at `packages/wasm-compute/benchmark-results.json`. The honest range is 0.6x to
> 40x depending on the kernel and the input size, not a single "5-20x": MinHash
> reaches 40x on a 300 kb genome, while dense k-mer counting, codon usage and GC
> content sit between 1.0x and 1.6x, and several kernels are *slower* than JS
> below about 5 kb. See the README's "Measured speedups" table.
>
> The other four rows remain unmeasured claims.

---

## [v1.2.0] — 2025-12-15 — UI Polish & 3D Visualization Fixes

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.2.0) |
[Compare to v1.1.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.1.0...v1.2.0)

Critical UI fixes and desktop experience improvements.

### 3D Visualization

- **Element-based atom coloring** in ball-and-stick and surface modes with proper CPK colors (nitrogen=blue, oxygen=red, sulfur=yellow, etc.) ([`3d670a4`](https://github.com/Dicklesworthstone/phage_explorer/commit/3d670a4b86d7a9e8e8d1e6af6de39ac3d95f4f8e))
- Expanded element color palette with 8 additional elements (BR, I, F, B, SI, AL, CO, NI)
- Fixed material settings that were washing out element colors

### Overlay System

- Wired AnalysisSidebar to OverlayProvider and added 6 missing overlay components (GC Skew, Complexity, Bendability, Promoter, Repeats, K-mer Anomaly) ([`5bdaa06`](https://github.com/Dicklesworthstone/phage_explorer/commit/5bdaa06c07c8b0e8c8987cef28fd81c30ed3f3b2))
- Corrected overlay ID mismatches

### UI Improvements

- CRT overlay z-index lowered so it no longer obscures modal dialogs ([`94e1714`](https://github.com/Dicklesworthstone/phage_explorer/commit/94e17146ae6ccd7a5a8db8a33a7b25da5e59fe02))
- Settings modal enlarged from 600px to 800px ([`cb6b0f1`](https://github.com/Dicklesworthstone/phage_explorer/commit/cb6b0f18e8d42c0cd29a0fb32a7f3e9e5e32e003))
- Comprehensive button system with hover/active/focus states, sidebar styling, and micro-interactions ([`df424d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/df424d1d85ebbe5b9e36918e33a2f4f6f0b6b41e))
- Custom scrollbar styling, `prefers-reduced-motion` and `prefers-contrast` support

### Performance

- MatrixRain animation pauses when tab is hidden or element is offscreen; FPS reduced from 30 to 24 ([`44fe0d4`](https://github.com/Dicklesworthstone/phage_explorer/commit/44fe0d4d59f5e1c8fc0e3d0ed5b5e95d6bde9b48))
- CSS containment hints for smoother rendering

### Bug Fixes

- Handle undefined `gcContent` to prevent NaN display ([`cdd2a8e`](https://github.com/Dicklesworthstone/phage_explorer/commit/cdd2a8ea1f10ca3ca20b49e56c3c4f48e97a08eb))

---

## [v1.1.0] — 2025-12-14 — Desktop UI Enhancement

[GitHub Release](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.1.0) |
[Compare to initial](https://github.com/Dicklesworthstone/phage_explorer/compare/a0ecc8d...v1.1.0)

The first tagged release, introducing persistent desktop UI components and responsive layouts.

### New Components

- **ActionToolbar** — persistent control bar surfacing 15+ keyboard shortcuts: view mode toggles (DNA / AA / Dual), reading frame selector (+1 through -3), display controls (Diff, 3D toggle), quick access (Analysis, Compare, Search, Command Palette, Settings, Help)
- **AnalysisSidebar** — collapsible panel organizing 25+ analysis tools by category: Sequence Analysis, Gene Features, Codon Analysis, Structural, Evolutionary, Host Interaction, Simulations
- **QuickStats** — compact metrics bar showing genome length, GC content, gene count (with strand breakdown), Baltimore group, host organism, structure availability, and accession

### Layout

- Progressive breakpoints optimized for 1440px, 1600px, 1920px, 2560px+
- Ultrawide support for 21:9 and 32:9 monitors
- Three-column dashboard grid on wide screens (list, detail, sidebar)

### Mobile

- Safe area support for notches and home indicators
- All interactive elements meet WCAG 2.5.5 (44x44px minimum)
- Optimized padding, gaps, and typography for small screens

### Testing

- Comprehensive E2E test suite for mobile UX across iPhone SE, iPhone 14, iPhone 14 Pro Max, Pixel 7, iPad Mini, and iPad Pro
- Tests cover layout overflow, touch targets, overlay behavior, typography, and navigation

### Bug Fixes

- Fixed overlay z-index conflict with ControlDeck (BASE_Z_INDEX increased to 500)
- Fixed build script path handling for Windows compatibility
- Improved close button accessibility with 44x44px touch target

---

## v1.0.0 — 2025-12-06 through 2025-12-14 — Initial Development

The project was built from scratch between December 6-14, 2025. No formal v1.0.0 tag exists; this section covers the initial commit ([`5afb38b`](https://github.com/Dicklesworthstone/phage_explorer/commit/5afb38b558d188bfd330540eb67cb7b132de9a81)) through the pre-v1.1.0 development (510 commits).

### Core Platform

- **Monorepo architecture** with 8 packages: `core`, `db-schema`, `db-runtime`, `state`, `renderer-3d`, `wasm-compute`, `data-pipeline`, `tui`, `web`
- **Bun-based build system** with cross-platform single-binary compilation ([`c7f842a`](https://github.com/Dicklesworthstone/phage_explorer/commit/c7f842a06ab3c6a11f0593448da3300d1bbb1761))
- **CI/CD pipeline** with GitHub Actions ([`3556c8d`](https://github.com/Dicklesworthstone/phage_explorer/commit/3556c8d27400c26ab0b6684f2550cccadbc633aa))
- **One-liner install script** via curl|bash ([`852066f`](https://github.com/Dicklesworthstone/phage_explorer/commit/852066ffb1bfac418e3a2d4227e387661a809534))

### TUI (Terminal User Interface)

- Full-screen HUD interface with Ink/React components ([`39232f9`](https://github.com/Dicklesworthstone/phage_explorer/commit/39232f92d5597ba87378e1fd0955547aba6ad801), [`0397474`](https://github.com/Dicklesworthstone/phage_explorer/commit/03974741c0897c7522008e22125bf2e46f181309))
- Color-coded DNA and amino acid sequence views with 5 themes (Classic, Ocean, Matrix, Sunset, Forest)
- 3D ASCII phage models with multi-quality gradient system and fullscreen mode ([`778c08b`](https://github.com/Dicklesworthstone/phage_explorer/commit/778c08b4444cd09f6f559becb04b5947ea958eff), [`4a6b0df`](https://github.com/Dicklesworthstone/phage_explorer/commit/4a6b0df260fc20eb05422dccf033d8fec4210c2c))
- Gene map navigation with position tracking and snap-to-gene
- Amino acid property legend ([`f8176d8`](https://github.com/Dicklesworthstone/phage_explorer/commit/f8176d8b6c4133e94b9c478a989d71f66151e283))

### Overlay System (Depth Layers Architecture)

- Layer-1 quick overlays: GC skew, Complexity, Bendability, Promoter/RBS, Repeats/Palindromes ([`c60a92b`](https://github.com/Dicklesworthstone/phage_explorer/commit/c60a92b2ec0cc3818a6712ec9c344ba1b49fa66a), [`b87c5a5`](https://github.com/Dicklesworthstone/phage_explorer/commit/b87c5a52beecdc50b0419e2380bf67360b44aa5e))
- Modal menu infrastructure and command palette ([`0337da8`](https://github.com/Dicklesworthstone/phage_explorer/commit/0337da886fb80b54123c9a42f63027a81640393d))
- K-mer Anomaly, Module Coherence, and Fold Quickview overlays ([`fbad1d9`](https://github.com/Dicklesworthstone/phage_explorer/commit/fbad1d95f1e8a4e6dfc6f9c77fac7bb8ab1bfbf7))
- Packaging Pressure overlay ([`ba3a43f`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba3a43fdee13c80caf0b1ecc4bf2cbc345c2f2a1))
- HGT Passport overlay for genomic island visualization ([`bddd688`](https://github.com/Dicklesworthstone/phage_explorer/commit/bddd688fe4fc4cc1cc90af54f15f60d2c3ea34ed))
- Dinucleotide Bias Decomposition overlay with PCA scatter plot ([`7d1d82c`](https://github.com/Dicklesworthstone/phage_explorer/commit/7d1d82c9d6c61ed01b7f86d8e4aaec3e45e2c1e7))
- CRISPR Pressure overlay with anti-CRISPR candidate browser ([`b8300bf`](https://github.com/Dicklesworthstone/phage_explorer/commit/b8300bf09fb33ede09f6bae7c5cdd6eac10f0e9c))
- Synteny Alignment overlay ([`9363cb8`](https://github.com/Dicklesworthstone/phage_explorer/commit/9363cb8f6ad09c0abfee0f7aa3a68ad82bbd0ab5))
- Tail Fiber Tropism analysis overlay ([`87a494d`](https://github.com/Dicklesworthstone/phage_explorer/commit/87a494d4f46b9bb38dfa09f69c1d1fe7a51ab8e8))
- Density sparklines for Promoter and Repeat overlays ([`4064d01`](https://github.com/Dicklesworthstone/phage_explorer/commit/4064d010783e71aa37eb4a7f967b5cac0c732a7e))

### Simulation System

- Simulation hub with registry and dedicated views ([`fba1d8f`](https://github.com/Dicklesworthstone/phage_explorer/commit/fba1d8f8f2819fb29c9b5acec9ae13cd5ddbf52c))
- Ribosome Traffic TASEP simulation with sparklines, queue stats, and trend tracking ([`183d98a`](https://github.com/Dicklesworthstone/phage_explorer/commit/183d98a58f9a07d1e3ad9b26f4d87d29a53d5b04))
- Plaque growth cellular automaton with double buffering ([`af02a96`](https://github.com/Dicklesworthstone/phage_explorer/commit/af02a96f413c77c3ab5ce65fc9a89c48c1ff7f82))
- Packaging motor physics simulation ([`8ae00dd`](https://github.com/Dicklesworthstone/phage_explorer/commit/8ae00ddc04f67da7ecd0e2c81e78f29ecf491c3a))
- Infection kinetics ODE simulation ([`6cbf8bd`](https://github.com/Dicklesworthstone/phage_explorer/commit/6cbf8bdf47e3925d2b7e831c4d2fdef756e50f6e))
- Interactive parameter tweaking ([`6933382`](https://github.com/Dicklesworthstone/phage_explorer/commit/6933382fa31f2eceb08ea32e0d8c6d1de7ee6e1e))

### Genome Comparison

- Comparison package with edit distance, k-mer analysis, and statistical metrics ([`f6e186f`](https://github.com/Dicklesworthstone/phage_explorer/commit/f6e186f75d03715c4dfbec6abd3c11ecf9dfb8c6), [`e850e11`](https://github.com/Dicklesworthstone/phage_explorer/commit/e850e111f2e4d3c41c2b61bd3837c7ccdda61f7c))
- HGT provenance tracer for genomic island detection ([`db53d5f`](https://github.com/Dicklesworthstone/phage_explorer/commit/db53d5f2f5e69ff92a0f4e36dca2a3a78b2d5ff8))
- Codon frequency computation for 64-element bias vectors ([`be66ee9`](https://github.com/Dicklesworthstone/phage_explorer/commit/be66ee9e7d26cbc5a4b6db48ed780e1dbf8e0be2))
- Tail fiber tropism analysis with sequence-based receptor prediction ([`fdb3ca1`](https://github.com/Dicklesworthstone/phage_explorer/commit/fdb3ca159131c5c3e26adc9dff7c7f63e4dd4bf7))

### WASM Compute

- Initial Rust WASM package for computational bottlenecks ([`f9c451a`](https://github.com/Dicklesworthstone/phage_explorer/commit/f9c451af5f56c59f6acee2d6e459e19dc2e62e2a))
- WASM inlining build script for bundled deployment ([`9be8461`](https://github.com/Dicklesworthstone/phage_explorer/commit/9be8461a09d5c9c12c893efe7613be22a8ee9085))

### Web App (React 19 + Vite)

- Phase 0: Foundation with Vite scaffold, CSS theme system, keyboard manager ([`5d472fa`](https://github.com/Dicklesworthstone/phage_explorer/commit/5d472fa5e5fc7abce7d1bd62a068b3ca2e4c13d9), [`fdb61f0`](https://github.com/Dicklesworthstone/phage_explorer/commit/fdb61f08b5b9eb3dc5d6bd82a5bb0839f3a16eb8))
- Phase 1: Data Layer with browser SQLite and offline support ([`2c1b919`](https://github.com/Dicklesworthstone/phage_explorer/commit/2c1b919e84c80f2ee3fa6f6b33063f3d3f39d01c))
- Phase 2: Core Visualization with canvas rendering engine ([`d010195`](https://github.com/Dicklesworthstone/phage_explorer/commit/d010195ddcfbff0af5b6bfb2f87891a13e2d6b92))
- Phase 3: Overlay System with command palette, menus, and Layer 1 analysis overlays ([`0142d1f`](https://github.com/Dicklesworthstone/phage_explorer/commit/0142d1f5baee0c72eed6db73de0cad5b3c70e77c), [`34ea4ac`](https://github.com/Dicklesworthstone/phage_explorer/commit/34ea4ac0d04ec0efe71d8d81b4e4be2d08fd38c8))
- Phase 4: Worker-based simulation engine ([`65f0f66`](https://github.com/Dicklesworthstone/phage_explorer/commit/65f0f665ded52ae07a3a0ff3a97eda0b3c47a7d0))
- Phase 5: Advanced features -- analysis overlays, exports, Matrix Rain ([`6144ef2`](https://github.com/Dicklesworthstone/phage_explorer/commit/6144ef28d571c0d97b47d6e83cb8baa9d49e5dea))
- 3D structure viewer with real PDB data from RCSB (cartoon/ball-and-stick/surface modes)
- WebGL post-processing effects pipeline ([`3db23d7`](https://github.com/Dicklesworthstone/phage_explorer/commit/3db23d79e2eb67f62f4e0f5da66a6b3a44c4f83e))
- First-run onboarding experience with welcome modal ([`8cac1fe`](https://github.com/Dicklesworthstone/phage_explorer/commit/8cac1fe5f6b3f8ae72e1cee7c21cf8c7a3ee25f7))
- WCAG 2.1 AA accessibility infrastructure ([`2433aef`](https://github.com/Dicklesworthstone/phage_explorer/commit/2433aeff07ebf1e1ef7d70f15c1b42a5c4bc7da2))
- Core Web Vitals performance monitoring ([`5490dc4`](https://github.com/Dicklesworthstone/phage_explorer/commit/5490dc42a7f99a19adeac4b5c7cde50bbccab5e9))
- Real-time collaboration via BroadcastChannel ([`7fa9931`](https://github.com/Dicklesworthstone/phage_explorer/commit/7fa9931a20cabb3be6fd4fd03bc2b3ee4bca09e5))

### Progressive Disclosure

- Experience level tracking (beginner / intermediate / expert) ([`674b792`](https://github.com/Dicklesworthstone/phage_explorer/commit/674b79209c1c9b229a43925470f80684f5fb811b))
- Advanced overlays gated by experience level ([`1d016d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/1d016d1918aa2d57b69b5b13a8b6ce5ac5f8a985))
- Overlay hints in footer gated by experience ([`5578503`](https://github.com/Dicklesworthstone/phage_explorer/commit/5578503bc7f98dc8f0e18b4d5e93b7fb3ec20fe6))

### Core Analysis

- Module coherence analysis and fold embedding utilities ([`ea56ac9`](https://github.com/Dicklesworthstone/phage_explorer/commit/ea56ac989320cd31618518a61f807083fa7adda9))
- IUPAC ambiguity code support in codon utilities ([`97c06ec`](https://github.com/Dicklesworthstone/phage_explorer/commit/97c06ecf0bf57a4c7e0dfe5bca8ade7ef0e46e08))
- Amino acid phase portraits for protein domain analysis ([`a4836b2`](https://github.com/Dicklesworthstone/phage_explorer/commit/a4836b29fa93e15e0567756848b4e7d433f98078))
- Structure-informed capsid/tail constraint scanner ([`591ac77`](https://github.com/Dicklesworthstone/phage_explorer/commit/591ac7758e97bcc60529d91dc00704f39b8cc11f))
- Dinucleotide bias decomposition analysis ([`0e6f7f5`](https://github.com/Dicklesworthstone/phage_explorer/commit/0e6f7f5d8e7f6e5d4c3b2a1a0b9c8d7e6f5a4b3))
- CRISPR pressure analysis and anti-CRISPR candidate detection ([`8d27a31`](https://github.com/Dicklesworthstone/phage_explorer/commit/8d27a31f6e5d4c3b2a1a0b9c8d7e6f5a4b3c2d1))

### Data Pipeline

- NCBI fetcher with GenBank parser handling multi-line feature locations and gbwithparts format ([`8c82eec`](https://github.com/Dicklesworthstone/phage_explorer/commit/8c82eec3ee32e9aeb74526b766dd91b77d183f2e), [`d9cccb6`](https://github.com/Dicklesworthstone/phage_explorer/commit/d9cccb654a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d))
- 12 phages in initial database: Lambda, T4, T7, PhiX174, MS2, M13, P22, Phi29, Mu, Phi6, SPbeta, T5

---

[Unreleased]: https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.1...HEAD
[v1.4.1]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.1
[v1.4.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.0
[v1.3.1]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.1
[v1.3.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.0
[v1.2.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.2.0
[v1.1.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.1.0
