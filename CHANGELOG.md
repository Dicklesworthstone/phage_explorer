# Changelog

All notable changes to [Phage Explorer](https://github.com/Dicklesworthstone/phage_explorer) are documented in this file.

Phage Explorer is a TUI + web application for browsing, visualizing, and analyzing bacteriophage genetic data. It features color-coded DNA/amino acid sequences, WebGL-accelerated rendering, WASM-powered analysis, 3D protein structure viewing, and 30+ interactive analysis overlays covering 24 real phage genomes.

> **Convention:** Entries link to commits (`commit/HASH`) and comparison views (`compare/TAG1...TAG2`). Releases with binaries are marked with a GitHub Release badge. Items are grouped by capability domain.

---

## [Unreleased] (v1.4.1..HEAD) — 2025-12-15 to 2026-03-11

412 commits since v1.4.1. This represents the largest development sprint in the project's history, spanning major new analysis modules, a WASM compute pipeline, WebGL rendering, and deep mobile UX work.

[Compare: v1.4.1...main](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.1...main)

### New Analysis Overlays & Simulations

- **Epistasis & Fitness Landscape Explorer** — interactive epistasis analysis with region merging and fitness visualization ([`712b032`](https://github.com/Dicklesworthstone/phage_explorer/commit/712b032c55c4558e5457cb79957ac90362d06df0))
- **Resistance Evolution Overlay** — Gillespie stochastic simulation of antibiotic resistance dynamics ([`744c73d`](https://github.com/Dicklesworthstone/phage_explorer/commit/744c73d03d3aa7176c951a534ac59dc447d3d851), [`5b0a774`](https://github.com/Dicklesworthstone/phage_explorer/commit/5b0a77424f2477c370efbda11768ea4cbff587fc))
- **Regulatory Constellation Overlay** — visualize promoter and regulatory element networks ([`c644943`](https://github.com/Dicklesworthstone/phage_explorer/commit/c644943ec77c900de116349138c5a6564981fce3))
- **RNA Structure & Packaging Signal Explorer** — secondary structure prediction and packaging signal identification ([`fbe9cc2`](https://github.com/Dicklesworthstone/phage_explorer/commit/fbe9cc25f24292c4bef0b86c30f35eac7c98e24e))
- **Metagenomic Co-Occurrence & Niche Profiler** — environmental niche analysis and co-occurrence patterns ([`e8e53b8`](https://github.com/Dicklesworthstone/phage_explorer/commit/e8e53b85e5e43070306a481a38b1b1f2968877e7))
- **Phylodynamic Trajectory Explorer** — temporal evolutionary trajectory visualization ([`25bd65a`](https://github.com/Dicklesworthstone/phage_explorer/commit/25bd65a0fe5d6e112f2ab792b8985b87955631c0))
- **Environmental & Geospatial Provenance Map** — geographic origin mapping with provenance data ([`34766f4`](https://github.com/Dicklesworthstone/phage_explorer/commit/34766f4dfcf4d02f0e6ad09c8f90729958b756e8))
- **Prophage Excision Precision Mapper** — precision mapping of prophage integration/excision sites ([`7421ee7`](https://github.com/Dicklesworthstone/phage_explorer/commit/7421ee78bff7b0e66fd3e4cbbace522568e25ca1))
- **Cocktail Compatibility Overlay** — lysis timing, Sie genes, immunity, and receptor scoring for phage therapy ([`10a5c43`](https://github.com/Dicklesworthstone/phage_explorer/commit/10a5c43514858ff0c4688cbfe0e45f7a050a13d8))
- **Module Overlay** — modular genome coherence analysis integrated into OverlayManager ([`a34854b`](https://github.com/Dicklesworthstone/phage_explorer/commit/a34854b3969201b0ad4b4bdbdc4df1f45ddf8c3c))
- Enhanced **PromoterOverlay** with core regulatory detection capabilities ([`4c28b2f`](https://github.com/Dicklesworthstone/phage_explorer/commit/4c28b2fbc6e81ba320b85926ae3e25777e8ea563))
- Enhanced **tropism receptor prediction** algorithms ([`c0d3003`](https://github.com/Dicklesworthstone/phage_explorer/commit/c0d3003bf1852bb067b0fb4afe9a375aaacb3007))
- **HGT passport stamp** provenance view with amelioration timing ([`1719004`](https://github.com/Dicklesworthstone/phage_explorer/commit/17190045e0097a80539cc9a34c151fe9199fc89f))
- Real API integration for phylodynamics and provenance overlays ([`51d40a3`](https://github.com/Dicklesworthstone/phage_explorer/commit/51d40a3ab7273081d5ba0c6a92423b041d775d90))

### WASM Compute Pipeline

- **Myers diff algorithm** with guardrails for sequence comparison ([`687a002`](https://github.com/Dicklesworthstone/phage_explorer/commit/687a002)), integrated into comparison worker ([`cb443f2`](https://github.com/Dicklesworthstone/phage_explorer/commit/cb443f2))
- **Dense k-mer counter** and WASM ABI specification ([`90e6a87`](https://github.com/Dicklesworthstone/phage_explorer/commit/90e6a87))
- **MinHash signatures** with performance instrumentation ([`c93925e`](https://github.com/Dicklesworthstone/phage_explorer/commit/c93925e)), MinHash signature cache with LRU eviction ([`9dc9ce4`](https://github.com/Dicklesworthstone/phage_explorer/commit/9dc9ce4))
- **KL divergence window scanning** for anomaly detection ([`9f7cd86`](https://github.com/Dicklesworthstone/phage_explorer/commit/9f7cd86), [`95b49eb`](https://github.com/Dicklesworthstone/phage_explorer/commit/95b49eb))
- **SequenceHandle** for zero-copy sequence storage and transfer ([`393e2d5`](https://github.com/Dicklesworthstone/phage_explorer/commit/393e2d5), [`0a26127`](https://github.com/Dicklesworthstone/phage_explorer/commit/0a26127))
- **Dot plot self-comparison** via WASM with progressive refinement ([`c05b842`](https://github.com/Dicklesworthstone/phage_explorer/commit/c05b842), [`3e624a7`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e624a7))
- **Spatial-hash bond detection** for O(N) structure loading ([`7924ff6`](https://github.com/Dicklesworthstone/phage_explorer/commit/7924ff6))
- WASM GC skew computation and 3D structure caching ([`c9450d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/c9450d1))
- WASM codon usage acceleration in workers ([`ac41b5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ac41b5b))
- Centralized browser capabilities and WASM loader module ([`5a72124`](https://github.com/Dicklesworthstone/phage_explorer/commit/5a72124))
- Gzip-compressed database support with worker decompression ([`ff31d8b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ff31d8b))
- Rebuilt WASM binaries with dotplot_self and inlined bytes ([`3c3b66e`](https://github.com/Dicklesworthstone/phage_explorer/commit/3c3b66e))

### WebGL & Rendering

- **WebGL-accelerated sequence grid renderer** — major rendering upgrade ([`7091deb`](https://github.com/Dicklesworthstone/phage_explorer/commit/7091deb0c648e96e53da8094a51e287ddc124e40))
- **GPU-accelerated WebGL dot plot** for sequence comparison ([`4e5fc3a`](https://github.com/Dicklesworthstone/phage_explorer/commit/4e5fc3a5048e2feb482b501a659228a1c230b041))
- **OffscreenCanvas worker renderer** for smooth scrolling ([`798aa38`](https://github.com/Dicklesworthstone/phage_explorer/commit/798aa38))
- **GenomeTrack system** for synchronized analysis visualization ([`5442cbd`](https://github.com/Dicklesworthstone/phage_explorer/commit/5442cbd67e24eb9ed286085da12f0e7350cdc812))
- Simplified WebGL renderer with shared GlyphAtlas ([`042b478`](https://github.com/Dicklesworthstone/phage_explorer/commit/042b478908ab98321fabdb4b474924c68a1d70fc))
- iOS WebKit optimizations and dynamic overscan tuning ([`9f4a667`](https://github.com/Dicklesworthstone/phage_explorer/commit/9f4a6679bc16635d8530f01223a5b5feadda7406))
- Dual-mode rendering in sequence grid with improved overscan ([`1bbe31b`](https://github.com/Dicklesworthstone/phage_explorer/commit/1bbe31ba869d2abb03a0d8cbe09e7e2192c2f223))
- Single-pass micro batch rendering optimization ([`6e259cb`](https://github.com/Dicklesworthstone/phage_explorer/commit/6e259cb))
- Content reveal animations and design system tokens ([`d162605`](https://github.com/Dicklesworthstone/phage_explorer/commit/d162605))
- Enhanced diff mode with dimmed matches and gap markers ([`c004a3d`](https://github.com/Dicklesworthstone/phage_explorer/commit/c004a3dce8dbcdc2f87a0d58ceb92ebdf2030582))

### 3D Viewer Enhancements

- Enhanced fullscreen mode with HUD and keyboard controls ([`5b2c960`](https://github.com/Dicklesworthstone/phage_explorer/commit/5b2c9605dd589bf9735ae688bd16d230c05acc5f))
- Context-correct atom count estimates in tooltip ([`3efe7b7`](https://github.com/Dicklesworthstone/phage_explorer/commit/3efe7b72357b6a3168057fc5b0e3d6157118b461))
- Culling optimizations for ASCII 3D renderer ([`4cce11b`](https://github.com/Dicklesworthstone/phage_explorer/commit/4cce11b69b460a993a6d14e879c8d97f7b8b65e6))

### Keyboard & Command System

- **ActionRegistry** as single source of truth for all shortcuts ([`c5cb1be`](https://github.com/Dicklesworthstone/phage_explorer/commit/c5cb1be), [`6d721d3`](https://github.com/Dicklesworthstone/phage_explorer/commit/6d721d3), [`9a17cd5`](https://github.com/Dicklesworthstone/phage_explorer/commit/9a17cd5))
- **ActionRegistry-driven overlays** and command surfaces ([`c908e41`](https://github.com/Dicklesworthstone/phage_explorer/commit/c908e41))
- **Hotkey conflict detection** ([`c08ce27`](https://github.com/Dicklesworthstone/phage_explorer/commit/c08ce27))
- HelpOverlay renders from ActionRegistry with Depth Layers ([`d692044`](https://github.com/Dicklesworthstone/phage_explorer/commit/d692044))
- Platform-aware shortcut formatting via actionSurfaces module ([`b11cfe5`](https://github.com/Dicklesworthstone/phage_explorer/commit/b11cfe5))
- GotoOverlay and reorganized keyboard shortcuts ([`34bed80`](https://github.com/Dicklesworthstone/phage_explorer/commit/34bed80))
- Experience-level-aware progressive disclosure in HelpOverlay ([`3e07fa5`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e07fa5))

### UX & Design System

- **Overlay chrome primitives** — semantic tokens, typography hierarchy, state management ([`85c6d5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/85c6d5b), [`b6004a7`](https://github.com/Dicklesworthstone/phage_explorer/commit/b6004a7), [`ca1a573`](https://github.com/Dicklesworthstone/phage_explorer/commit/ca1a573), [`463028c`](https://github.com/Dicklesworthstone/phage_explorer/commit/463028c))
- **FullFeatureModal** with comprehensive feature registry ([`bc6bb8c`](https://github.com/Dicklesworthstone/phage_explorer/commit/bc6bb8cd3761a8616062951e6fbadd35e9f2e7f6))
- **Context-Aware Help System** infrastructure ([`2bcb7e2`](https://github.com/Dicklesworthstone/phage_explorer/commit/2bcb7e22f87b6295aeca17d563aa14a0e3f69526))
- Experience-level-aware tooltip hints ([`31f8ed4`](https://github.com/Dicklesworthstone/phage_explorer/commit/31f8ed4b0e5908eda0e5344ab43347ab262e8775))
- Stripe-level design system polish and micro-interactions ([`89b5ab4`](https://github.com/Dicklesworthstone/phage_explorer/commit/89b5ab4), [`97abc26`](https://github.com/Dicklesworthstone/phage_explorer/commit/97abc26), [`5c43a48`](https://github.com/Dicklesworthstone/phage_explorer/commit/5c43a48))
- Queued toast notification system replacing inline toasts ([`95f9e31`](https://github.com/Dicklesworthstone/phage_explorer/commit/95f9e31))
- Device-aware defaults and centralized motion/FX policy ([`903e242`](https://github.com/Dicklesworthstone/phage_explorer/commit/903e242), [`9847dd0`](https://github.com/Dicklesworthstone/phage_explorer/commit/9847dd0))

### Mobile UX

- Touch UI breakpoint (`isTouchUi`) and improved tablet form inputs ([`73973b1`](https://github.com/Dicklesworthstone/phage_explorer/commit/73973b1))
- Context menu, swipe actions, and gesture-based interactions ([`e91d112`](https://github.com/Dicklesworthstone/phage_explorer/commit/e91d112))
- Phage navigation UX polish for mobile ([`9a72c45`](https://github.com/Dicklesworthstone/phage_explorer/commit/9a72c453ad0f84953791dac506421641e9082c09))
- Landscape layout optimization and responsive typography ([`0518583`](https://github.com/Dicklesworthstone/phage_explorer/commit/0518583))
- Mobile sequence view zoom defaults for readability ([`8b67d5b`](https://github.com/Dicklesworthstone/phage_explorer/commit/8b67d5b))
- Visual viewport CSS variables for iOS keyboard handling ([`f9b18d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/f9b18d1))
- Safe-area-inset support for notch and Dynamic Island ([`1fd3623`](https://github.com/Dicklesworthstone/phage_explorer/commit/1fd3623))
- Comprehensive iPhone Safari fixes for notch, keyboard, and PWA ([`e76d5ed`](https://github.com/Dicklesworthstone/phage_explorer/commit/e76d5ed))
- Resolved scroll flickering across mobile browsers ([`120c433`](https://github.com/Dicklesworthstone/phage_explorer/commit/120c433), [`c9003a8`](https://github.com/Dicklesworthstone/phage_explorer/commit/c9003a8), [`66999eb`](https://github.com/Dicklesworthstone/phage_explorer/commit/66999eb))
- Restored touch targets in sequence controls ([`758a1aa`](https://github.com/Dicklesworthstone/phage_explorer/commit/758a1aa))

### Accessibility

- ARIA attributes on CanvasTrack and PostProcessingCanvas ([`0667e5a`](https://github.com/Dicklesworthstone/phage_explorer/commit/0667e5a))
- ARIA labels on remaining canvas visualizations ([`ec87161`](https://github.com/Dicklesworthstone/phage_explorer/commit/ec87161))
- ARIA labels on overlay canvas elements ([`eabf9b0`](https://github.com/Dicklesworthstone/phage_explorer/commit/eabf9b0))
- WCAG 44px minimum touch targets enforced ([`4b43fd4`](https://github.com/Dicklesworthstone/phage_explorer/commit/4b43fd4))

### SEO & Social Sharing

- Vercel Edge function for dynamic OpenGraph images ([`1068f59`](https://github.com/Dicklesworthstone/phage_explorer/commit/1068f5908a1a5da7f7f22bdb98ca8fd824da0503))
- PWA icons and static OpenGraph share images ([`f64f023`](https://github.com/Dicklesworthstone/phage_explorer/commit/f64f023410e432cb4b4c74f2ae1da6b41110a187))
- Comprehensive meta tags for social sharing and SEO ([`f4094a7`](https://github.com/Dicklesworthstone/phage_explorer/commit/f4094a7edcbfdd6bf9e5e6e307d6d55ac6be00ae))
- Google Analytics 4 tracking ([`2f7daa5`](https://github.com/Dicklesworthstone/phage_explorer/commit/2f7daa5e482e53378622f61a48dc8f6a9cfed495))
- Vercel Analytics and Speed Insights ([`ce3dd9f`](https://github.com/Dicklesworthstone/phage_explorer/commit/ce3dd9f6863c08449c59678efe519dd307b7a44f))
- GitHub social preview image ([`445218e`](https://github.com/Dicklesworthstone/phage_explorer/commit/445218e7a0de6fb4837a7bd87cecbb66af0f44d4))

### Core Analysis Fixes

- Correct ribosome TASEP and stabilize simulations ([`6cb6947`](https://github.com/Dicklesworthstone/phage_explorer/commit/6cb6947))
- Handle ambiguous bases (N) correctly in anomaly scanning ([`c45ec4a`](https://github.com/Dicklesworthstone/phage_explorer/commit/c45ec4a))
- Normalize RNA U-to-T in anomaly scanner preprocessing ([`9a9dba3`](https://github.com/Dicklesworthstone/phage_explorer/commit/9a9dba3))
- Deterministic eigenvectors and MinHash parity ([`f226831`](https://github.com/Dicklesworthstone/phage_explorer/commit/f226831))
- Handle ambiguity/gaps in CGR and logos ([`fb94224`](https://github.com/Dicklesworthstone/phage_explorer/commit/fb94224))
- Escape IUPAC regex and share reverseComplement ([`8e31354`](https://github.com/Dicklesworthstone/phage_explorer/commit/8e31354))
- Expand RNA regulatory element detection ([`a9fdb1e`](https://github.com/Dicklesworthstone/phage_explorer/commit/a9fdb1e))
- Guard PCA against single-sample division by zero ([`bf477ca`](https://github.com/Dicklesworthstone/phage_explorer/commit/bf477ca44dcd47fe9d01f060dde5fcd77b75ef55))
- Guard against division by zero in comparison module ([`3eb204c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3eb204cb1bce0a5817488ca8d64b9da807d13038))
- Short sequence handling in packaging signal detection ([`53f3d68`](https://github.com/Dicklesworthstone/phage_explorer/commit/53f3d68))
- Bit shift overflow in denseKmerMemoryCost for k>15 ([`4620613`](https://github.com/Dicklesworthstone/phage_explorer/commit/4620613))
- Unreachable code in sigma-70 promoter detection ([`29f0c4f`](https://github.com/Dicklesworthstone/phage_explorer/commit/29f0c4f75507fe2d153948874b22d08c5d797e90))

### Worker & Infrastructure

- SharedArrayBuffer handling in TextDecoder calls across workers ([`6979cdc`](https://github.com/Dicklesworthstone/phage_explorer/commit/6979cdc))
- Worker URL inlining to prevent bundler hoisting ([`959686e`](https://github.com/Dicklesworthstone/phage_explorer/commit/959686e))
- Enhanced worker system with PCA and off-main-thread compute ([`f9ed176`](https://github.com/Dicklesworthstone/phage_explorer/commit/f9ed176))
- Service worker: serve precached app shell for navigation requests ([`dc05a76`](https://github.com/Dicklesworthstone/phage_explorer/commit/dc05a76))
- Service worker: prevent stale JS caching causing scroll/blur bugs ([`ba1511b`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba1511b))
- IndexedDB cache utilities with quota error handling ([`0f6da8f`](https://github.com/Dicklesworthstone/phage_explorer/commit/0f6da8f))
- Lazy-load overlays and add service worker build ([`90c5031`](https://github.com/Dicklesworthstone/phage_explorer/commit/90c5031be30be644daf4bba50c1b212965ab9175))
- DB load timing instrumentation ([`a51c90d`](https://github.com/Dicklesworthstone/phage_explorer/commit/a51c90d))

### Testing

- Comprehensive unit tests for analysis modules (epistasis, phylodynamics, provenance, prophage-excision, recombination-radar, RNA structure, CGR compare, metagenomic-niche, CRISPR pressure, transcription, anomaly scanner, virtualizer, codons, fold-embeddings, edit distance) ([`72fd767`](https://github.com/Dicklesworthstone/phage_explorer/commit/72fd7674a502916b684482dc7075fa33a6cf4418), [`f036aac`](https://github.com/Dicklesworthstone/phage_explorer/commit/f036aac7b8fc2362a6fe275a1b8f2e91c3618e0f), and 25+ test commits)
- Comprehensive Zustand store unit tests ([`bbd8a66`](https://github.com/Dicklesworthstone/phage_explorer/commit/bbd8a66c729fda0ec10ee03f465714a34a6c68b7))
- LRU cache unit tests ([`b36ad57`](https://github.com/Dicklesworthstone/phage_explorer/commit/b36ad577b8688e67b195e2d3f30815a3ff62cc30))
- 3D math utility tests ([`a28ff23`](https://github.com/Dicklesworthstone/phage_explorer/commit/a28ff236f19eec0eff9b78485f9d0f7bd43a75c9))
- WASM diff parity tests and edge case tests ([`ef852fa`](https://github.com/Dicklesworthstone/phage_explorer/commit/ef852fa), [`ebc284f`](https://github.com/Dicklesworthstone/phage_explorer/commit/ebc284f))
- Comprehensive E2E tests for keyboard, overlays, mobile UX, and performance benchmarks ([`d85451f`](https://github.com/Dicklesworthstone/phage_explorer/commit/d85451f), [`d260771`](https://github.com/Dicklesworthstone/phage_explorer/commit/d260771), [`de456b0`](https://github.com/Dicklesworthstone/phage_explorer/commit/de456b0621d90a44d55a413c23007469fde05865))
- E2E scroll repaint black flash regression test ([`5d8a5cb`](https://github.com/Dicklesworthstone/phage_explorer/commit/5d8a5cbc72d40cc5c4428c42412b4576d1aeb818))

### Licensing & Housekeeping

- License updated to MIT with OpenAI/Anthropic Rider ([`ed86bea`](https://github.com/Dicklesworthstone/phage_explorer/commit/ed86bea4e885cd942c63475598244dca6f7ca990))
- README license references updated ([`2798027`](https://github.com/Dicklesworthstone/phage_explorer/commit/27980272405fd5bfdc3eecd93fc70e9d678685e8))
- Deploy fixes: restore db build step, remove edge function errors ([`f759b32`](https://github.com/Dicklesworthstone/phage_explorer/commit/f759b32e8c98670b615a57f916f49b1c1c2458f2), [`ff7fa81`](https://github.com/Dicklesworthstone/phage_explorer/commit/ff7fa810f207ff4fcd61d5fd1a3fd488e3842c4d))

---

## [v1.4.1] — 2025-12-15 (GitHub Release)

**TypeScript Strict Mode Compatibility**

17 commits. Ensures full compatibility with React 19 and modern TypeScript configurations.

[Compare: v1.4.0...v1.4.1](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.0...v1.4.1) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.1)

### Type System & React 19 Compatibility

- Added `@types/pako` and `@types/three` for compression and 3D visualization type coverage ([`82a1077`](https://github.com/Dicklesworthstone/phage_explorer/commit/82a1077))
- Extended `ThemePalette` interface with `sparklineGradient` property across all theme definitions ([`82a1077`](https://github.com/Dicklesworthstone/phage_explorer/commit/82a1077))
- Updated all `RefObject` types to `RefObject<T | null>` pattern for React 19 ([`3e48a1c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e48a1c))
- Fixed JSX namespace compatibility and component prop types ([`3e48a1c`](https://github.com/Dicklesworthstone/phage_explorer/commit/3e48a1c))
- Added `GenomeTrackSegment` type assertions in genome track overlays ([`93c11c0`](https://github.com/Dicklesworthstone/phage_explorer/commit/93c11c0))
- Fixed GlyphAtlas color record type indexing and WebGPU `writeBuffer` casts ([`c6da891`](https://github.com/Dicklesworthstone/phage_explorer/commit/c6da891))
- Exported additional tropism types; added `'diff'` to `ComparisonTab` union ([`65f9a60`](https://github.com/Dicklesworthstone/phage_explorer/commit/65f9a60))
- Updated educational module component types for React 19 ([`b3f44ed`](https://github.com/Dicklesworthstone/phage_explorer/commit/b3f44ed))
- Set worker format to `'es'` for Vite 7 compatibility ([`9489179`](https://github.com/Dicklesworthstone/phage_explorer/commit/9489179))

### Content Additions (pre-release)

- Expanded phage catalog from 12 to 24 genomes ([`36d98bb`](https://github.com/Dicklesworthstone/phage_explorer/commit/36d98bb))
- Added phage anatomy diagram gallery ([`fb7b032`](https://github.com/Dicklesworthstone/phage_explorer/commit/fb7b032))
- Added lifecycle "business model" intuitions and intuitive framings to glossary ([`3875c52`](https://github.com/Dicklesworthstone/phage_explorer/commit/3875c52), [`6c03bc9`](https://github.com/Dicklesworthstone/phage_explorer/commit/6c03bc9))
- Renamed "AA" abbreviation to "Amino Acids" throughout UI ([`b09dea4`](https://github.com/Dicklesworthstone/phage_explorer/commit/b09dea4))

### Build Status

- Zero TypeScript compilation errors, zero ESLint warnings
- Successfully deployed to [phage-explorer.org](https://phage-explorer.org)

---

## [v1.4.0] — 2025-12-15 (GitHub Release)

**Mobile UX Excellence**

14 commits. Delivers a native-feeling mobile experience with gesture physics, smooth scroll, and touch-optimized controls.

[Compare: v1.3.1...v1.4.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.3.1...v1.4.0) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.0)

### Touch Interaction

- **Floating Action Button (FAB)** with haptic feedback and spring-physics animations via `@react-spring/web` ([`beb476f`](https://github.com/Dicklesworthstone/phage_explorer/commit/beb476f))
- **ActionDrawer** with categorized quick actions (View, Analysis, Tools) ([`beb476f`](https://github.com/Dicklesworthstone/phage_explorer/commit/beb476f))
- **Gesture hooks** (`useSwipe`, `useDragGesture`, `usePinchGesture`, `useLongPress`) via `@use-gesture/react` with `prefers-reduced-motion` support ([`7587ff6`](https://github.com/Dicklesworthstone/phage_explorer/commit/7587ff6))
- Horizontal swipe navigation between phages ([`7587ff6`](https://github.com/Dicklesworthstone/phage_explorer/commit/7587ff6))

### Smooth Scroll & Animations

- **Lenis** integration for premium scroll physics (lerp: 0.1, touch multiplier: 2) ([`ea5d8ba`](https://github.com/Dicklesworthstone/phage_explorer/commit/ea5d8ba))
- **BottomSheet overlays** with spring-based animations, multiple snap points, velocity-aware decisions, and rubberband effect ([`7d3ec81`](https://github.com/Dicklesworthstone/phage_explorer/commit/7d3ec81))

### Progressive Enhancement

- **WASM detection** with early fail-fast and clear error messaging for unsupported browsers ([`aa67c59`](https://github.com/Dicklesworthstone/phage_explorer/commit/aa67c59))
- Onboarding step indicator with progress dots and glow effect ([`a504891`](https://github.com/Dicklesworthstone/phage_explorer/commit/a504891))
- Consistent overlay close buttons with `IconX` SVG across browsers ([`11c8b91`](https://github.com/Dicklesworthstone/phage_explorer/commit/11c8b91))

### Service Worker

- PDB structure caching: CacheFirst strategy, 90-day expiry, max 50 structures ([`ba2fa1e`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba2fa1e))
- Network timeouts: 3-second timeout on NetworkFirst strategies ([`ba2fa1e`](https://github.com/Dicklesworthstone/phage_explorer/commit/ba2fa1e))

### Bug Fixes

- FAB z-index corrected to appear above BottomSheet backdrop ([`11388c8`](https://github.com/Dicklesworthstone/phage_explorer/commit/11388c8))
- Bottom sheet close button increased to 44px for WCAG 2.5.5 compliance ([`9d90467`](https://github.com/Dicklesworthstone/phage_explorer/commit/9d90467))
- Fixed CSS variable names in action drawer ([`11388c8`](https://github.com/Dicklesworthstone/phage_explorer/commit/11388c8))

### Dependencies Added

- `@use-gesture/react` ^10.3.1, `@react-spring/web` ^10.0.3, `@studio-freight/lenis` ^1.0.42

---

## [v1.3.1] — 2025-12-15 (GitHub Release)

**Bug Fix Release**

4 commits. Critical display bug fix discovered via Playwright automated testing of the live production site.

[Compare: v1.3.0...v1.3.1](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.3.0...v1.3.1) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.1)

### Bug Fixes

- **GC content display (P0):** Fixed stat bar showing 4985.8% instead of 49.86% -- `gcContent` was already stored as a percentage in the database but the display code multiplied by 100 again ([`e0743d7`](https://github.com/Dicklesworthstone/phage_explorer/commit/e0743d7))
- **Disabled button styling:** Added proper CSS for disabled ControlDeck navigation buttons (opacity 0.4, `cursor: not-allowed`, muted text, no hover/active effects) ([`e0743d7`](https://github.com/Dicklesworthstone/phage_explorer/commit/e0743d7))

---

## [v1.3.0] — 2025-12-15 (GitHub Release)

**Major Performance Optimization Release**

17 commits. Dramatic performance improvements via WebGPU compute shaders, expanded WASM functions, and comprehensive React optimizations.

[Compare: v1.2.0...v1.3.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.2.0...v1.3.0) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.0)

### Performance Targets

| Area | Improvement |
|------|-------------|
| GPU Analysis | 10-100x faster |
| WASM Computation | 5-20x faster |
| Initial Load | 40-60% faster |
| Sequence Scroll | 2-3x smoother |
| Memory Usage | 50% reduction |

### WebGPU Compute Shaders (6 new)

- `edit_dist.wgsl` — wavefront-parallel Levenshtein distance ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))
- `gc_skew.wgsl` — sliding window GC skew computation ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))
- `entropy.wgsl` — Shannon entropy calculation ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))
- `search.wgsl` — parallel motif/pattern search ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))
- `repeats.wgsl` — palindrome and tandem repeat detection ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))
- `dotplot.wgsl` — self-similarity dot plot matrix ([`43f75f7`](https://github.com/Dicklesworthstone/phage_explorer/commit/43f75f7))

### Expanded WASM Module (15+ functions)

- Core genetics: `translate_sequence`, `reverse_complement`, `calculate_gc_content` ([`63fd0cc`](https://github.com/Dicklesworthstone/phage_explorer/commit/63fd0cc))
- Analysis: `pca_power_iteration`, `shannon_entropy`, `jensen_shannon_divergence` ([`63fd0cc`](https://github.com/Dicklesworthstone/phage_explorer/commit/63fd0cc))
- Sequence: `detect_repeats`, `compute_gc_skew`, `compute_complexity` ([`63fd0cc`](https://github.com/Dicklesworthstone/phage_explorer/commit/63fd0cc))
- Display: `build_grid` for optimized viewport rendering ([`63fd0cc`](https://github.com/Dicklesworthstone/phage_explorer/commit/63fd0cc))

### React & Memory Optimizations

- **SharedArrayBuffer** pool for zero-copy worker communication ([`f6930b2`](https://github.com/Dicklesworthstone/phage_explorer/commit/f6930b2))
- **LRU caching** with bounded memory and automatic eviction; fixed React Query `gcTime: Infinity` memory leak ([`08b7c91`](https://github.com/Dicklesworthstone/phage_explorer/commit/08b7c91))
- `React.memo` on expensive components, visibility detection for offscreen skip ([`3ead092`](https://github.com/Dicklesworthstone/phage_explorer/commit/3ead092))
- Database prefetch priority queue, batch inserts (5-10x faster builds), conditional manifest requests with ETag ([`98800fa`](https://github.com/Dicklesworthstone/phage_explorer/commit/98800fa))

### Infrastructure

- COOP/COEP headers enabling SharedArrayBuffer in browsers ([`50d9e17`](https://github.com/Dicklesworthstone/phage_explorer/commit/50d9e17))
- Dynamic WASM imports for graceful fallback when module unavailable ([`9746eb8`](https://github.com/Dicklesworthstone/phage_explorer/commit/9746eb8))

### Mobile (pre-release work bundled into this tag)

- Complete mobile UI redesign with clean bottom tab bar ([`bbbd5a8`](https://github.com/Dicklesworthstone/phage_explorer/commit/bbbd5a8))
- Premium mobile UX enhancements with haptics and native feel ([`a6028eb`](https://github.com/Dicklesworthstone/phage_explorer/commit/a6028eb))
- BottomSheet and mobile CSS bug fixes ([`8ca6446`](https://github.com/Dicklesworthstone/phage_explorer/commit/8ca6446))

---

## [v1.2.0] — 2025-12-14 (GitHub Release)

**UI Polish & 3D Visualization Fixes**

8 commits. Focuses on fixing critical UI issues and improving the desktop experience.

[Compare: v1.1.0...v1.2.0](https://github.com/Dicklesworthstone/phage_explorer/compare/v1.1.0...v1.2.0) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.2.0)

### 3D Visualization

- **Element-based atom coloring**: ball-and-stick and surface modes now display CPK colors (nitrogen=blue, oxygen=red, sulfur=yellow, etc.) ([`3d670a4`](https://github.com/Dicklesworthstone/phage_explorer/commit/3d670a4))
- Expanded element color palette with 8 additional elements (BR, I, F, B, SI, AL, CO, NI) ([`3d670a4`](https://github.com/Dicklesworthstone/phage_explorer/commit/3d670a4))
- Fixed material settings that were washing out element colors ([`3d670a4`](https://github.com/Dicklesworthstone/phage_explorer/commit/3d670a4))

### Overlay System

- Fixed AnalysisSidebar tool buttons that were not opening overlays ([`5bdaa06`](https://github.com/Dicklesworthstone/phage_explorer/commit/5bdaa06))
- Added 6 missing overlay components (GC Skew, Complexity, Bendability, Promoter, Repeats, K-mer Anomaly) ([`5bdaa06`](https://github.com/Dicklesworthstone/phage_explorer/commit/5bdaa06))
- Corrected overlay ID mismatches ([`5bdaa06`](https://github.com/Dicklesworthstone/phage_explorer/commit/5bdaa06))

### UI & Styling

- CRT overlay z-index lowered below modals to prevent content obstruction ([`94e1714`](https://github.com/Dicklesworthstone/phage_explorer/commit/94e1714))
- Settings modal enlarged from 600px to 800px ([`cb6b0f1`](https://github.com/Dicklesworthstone/phage_explorer/commit/cb6b0f1))
- Comprehensive button system with hover/active/focus states ([`df424d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/df424d1))
- Full AnalysisSidebar styling with micro-interactions ([`df424d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/df424d1))
- Custom scrollbar styling, accessibility support for `prefers-reduced-motion` and `prefers-contrast` ([`df424d1`](https://github.com/Dicklesworthstone/phage_explorer/commit/df424d1))

### Performance

- MatrixRain animation pauses when tab is hidden or element is offscreen ([`44fe0d4`](https://github.com/Dicklesworthstone/phage_explorer/commit/44fe0d4))
- Reduced animation FPS from 30 to 24 ([`44fe0d4`](https://github.com/Dicklesworthstone/phage_explorer/commit/44fe0d4))
- CSS containment hints for smoother rendering ([`44fe0d4`](https://github.com/Dicklesworthstone/phage_explorer/commit/44fe0d4))

---

## [v1.1.0] — 2025-12-14 (GitHub Release)

**Desktop UI Enhancement**

510 commits from project inception. First tagged release, introducing persistent UI components, the web app, and the complete TUI.

[Compare: initial...v1.1.0](https://github.com/Dicklesworthstone/phage_explorer/compare/5afb38b...v1.1.0) | [Release page](https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.1.0)

### Foundation (2025-12-06 through 2025-12-14)

- Project initialized with monorepo structure: `core`, `comparison`, `data-pipeline`, `db`, `renderer-3d`, `state`, `tui`, `web` packages ([`5afb38b`](https://github.com/Dicklesworthstone/phage_explorer/commit/5afb38b558d188bfd330540eb67cb7b132de9a81))
- NCBI data pipeline fetching real phage genomes ([`5afb38b`](https://github.com/Dicklesworthstone/phage_explorer/commit/5afb38b558d188bfd330540eb67cb7b132de9a81))
- SQLite database schema for phage data storage ([`5afb38b`](https://github.com/Dicklesworthstone/phage_explorer/commit/5afb38b558d188bfd330540eb67cb7b132de9a81))
- Cross-platform build system with single-binary compilation via Bun ([`c7f842a`](https://github.com/Dicklesworthstone/phage_explorer/commit/c7f842a06ab3c6a11f0593448da3300d1bbb1761))
- CI/CD pipeline for automated builds and releases ([`3556c8d`](https://github.com/Dicklesworthstone/phage_explorer/commit/3556c8d27400c26ab0b6684f2550cccadbc633aa))
- One-liner `curl | bash` installation script ([`852066f`](https://github.com/Dicklesworthstone/phage_explorer/commit/852066f))

### TUI Application

- Full-screen HUD interface with arrow-key navigation between phages ([`0397474`](https://github.com/Dicklesworthstone/phage_explorer/commit/0397474))
- Color-coded DNA (ACTG) and amino acid sequence views ([`a817644`](https://github.com/Dicklesworthstone/phage_explorer/commit/a817644))
- 5 color themes: Classic, Ocean, Matrix, Sunset, Forest ([`1f040d9`](https://github.com/Dicklesworthstone/phage_explorer/commit/1f040d9))
- ASCII 3D wireframe phage models with multi-quality gradient rendering ([`778c08b`](https://github.com/Dicklesworthstone/phage_explorer/commit/778c08b))
- Gene map navigation with position tracking and snap-to-gene ([`1f040d9`](https://github.com/Dicklesworthstone/phage_explorer/commit/1f040d9))
- Layer-1 quick overlays: GC skew, complexity, bendability, promoter/RBS, repeats/palindromes ([`1f040d9`](https://github.com/Dicklesworthstone/phage_explorer/commit/1f040d9))
- Diff mode for visual sequence comparison between phages
- Fuzzy search by name, host, family, or accession
- Reading frame cycling (1, 2, 3)
- Amino acid property legend

### Web Application

- Full web experience deployed at [phage-explorer.org](https://phage-explorer.org)
- 3D structure viewer using real PDB structures from RCSB with cartoon, ball-and-stick, and surface rendering modes
- Interactive color-coded sequence grid with smooth scrolling
- 30+ analysis overlays including GC skew, dot plots, Hilbert curves, HGT detection, synteny
- sql.js for in-browser SQLite queries, zero telemetry, works offline after initial load

### Desktop UI Components (v1.1.0 focus)

- **ActionToolbar** — persistent control bar surfacing 15+ hidden keyboard shortcuts: view mode toggles, reading frame selector, display controls, quick access buttons ([`8ce63b8`](https://github.com/Dicklesworthstone/phage_explorer/commit/8ce63b8387b941c4a939a741d12d1a6acda090ca))
- **AnalysisSidebar** — collapsible panel organizing 25+ analysis tools by category (Sequence, Gene Features, Codon, Structural, Evolutionary, Host Interaction, Simulations) ([`8ce63b8`](https://github.com/Dicklesworthstone/phage_explorer/commit/8ce63b8387b941c4a939a741d12d1a6acda090ca))
- **QuickStats** — compact metrics bar showing genome length, GC content, gene count, Baltimore group, host organism, structure availability, accession ([`8ce63b8`](https://github.com/Dicklesworthstone/phage_explorer/commit/8ce63b8387b941c4a939a741d12d1a6acda090ca))
- Progressive breakpoints optimized for 1440px, 1600px, 1920px, 2560px+ (ultrawide 21:9 and 32:9)
- Three-column dashboard grid on wide screens

### Genome Comparison Engine

- Statistical analysis algorithms for genome comparison ([`f6e186f`](https://github.com/Dicklesworthstone/phage_explorer/commit/f6e186f))
- Biological metrics and comparison engine ([`e850e11`](https://github.com/Dicklesworthstone/phage_explorer/commit/e850e11))

### Simulation Framework

- Simulation Hub with interactive phage biology simulations: Lysogeny Decision Circuit, Plaque Growth Automata, Ribosome Traffic, Burst Kinetics, and more ([`a40b48d`](https://github.com/Dicklesworthstone/phage_explorer/commit/a40b48d))

### Analysis Capabilities

- WASM-accelerated Rust-compiled spatial algorithms
- PDB structure parser for 3D visualization ([`bd8c304`](https://github.com/Dicklesworthstone/phage_explorer/commit/bd8c304))
- Functional group detection for 3D structure analysis ([`70ddef3`](https://github.com/Dicklesworthstone/phage_explorer/commit/70ddef3))
- PCA with lowered WASM threshold and optimized k-NN search ([`7ab621f`](https://github.com/Dicklesworthstone/phage_explorer/commit/7ab621f))
- Ancestral sequence reconstruction ([`d107a5f`](https://github.com/Dicklesworthstone/phage_explorer/commit/d107a5f))

### Mobile

- Safe area support for notches and home indicators
- Touch targets meeting WCAG 2.5.5 (44x44px minimum) ([`4b43fd4`](https://github.com/Dicklesworthstone/phage_explorer/commit/4b43fd4))
- Optimized padding, gaps, and typography for small screens
- E2E test suite across iPhone SE, iPhone 14, iPhone 14 Pro Max, Pixel 7, iPad Mini, iPad Pro

### Phage Catalog

24 real phages included: Lambda, T4, T7, PhiX174, MS2, M13, P22, Phi29, Mu, Phi6, SPbeta, T5, P1, P2, N4, Felix O1, D29, L5, PhiC31, PhiKZ, PRD1, PM2, Qbeta, T1.

### Binaries (SHA256)

```
b82701b7  phage-explorer-linux-arm64
fd316031  phage-explorer-linux-x64
fd9b0a6e  phage-explorer-macos-arm64
e884027f  phage-explorer-macos-x64
74cde349  phage-explorer-windows-x64.exe
7c1ca2c9  phage.db
```

---

## Initial Commit — 2025-12-06

[`5afb38b`](https://github.com/Dicklesworthstone/phage_explorer/commit/5afb38b558d188bfd330540eb67cb7b132de9a81) — Project scaffolding with monorepo package structure, TypeScript configuration, NCBI data pipeline, SQLite schema, and initial TUI components.

---

<!-- Links -->
[Unreleased]: https://github.com/Dicklesworthstone/phage_explorer/compare/v1.4.1...main
[v1.4.1]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.1
[v1.4.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.4.0
[v1.3.1]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.1
[v1.3.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.3.0
[v1.2.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.2.0
[v1.1.0]: https://github.com/Dicklesworthstone/phage_explorer/releases/tag/v1.1.0
