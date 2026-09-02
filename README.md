# Phage Explorer

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun%201.1+-purple)
![License](https://img.shields.io/badge/License-MIT%2BOpenAI%2FAnthropic%20Rider-blue)

A Terminal User Interface (TUI) for browsing, visualizing, and analyzing bacteriophage genetic data. Features color-coded DNA/amino acid sequences, rotating 3D ASCII phage models, and instant navigation between genomes—no browser, no cloud, just a fast local binary.

**One-liner install:**
```bash
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/phage_explorer/main/install.sh?$(date +%s)" | bash
```

---

## Screenshots

<p align="center">
  <img src="docs/images/lambda_phage_full_interface.webp" alt="Phage Explorer main interface" width="100%">
  <br>
  <em>Main dashboard — Phage selector with 24 genomes, Lambda phage illustration, color-coded sequence grid, 3D protein structure viewer, and Analysis Tools panel</em>
</p>

<p align="center">
  <img src="docs/images/t5_phage_3d_structure.webp" alt="Sequence grid with 3D structure" width="100%">
  <br>
  <em>Sequence + Structure view — Color-coded amino acid grid with gene map, alongside the WebGL 3D structure viewer showing PDB 8ZVI, fetched live from RCSB and parsed in a worker</em>
</p>

<p align="center">
  <img src="docs/images/t5_phage_sequence_detail.webp" alt="Virtual Gel Electrophoresis" width="100%">
  <br>
  <em>Virtual Gel Electrophoresis [Alt+G] — Simulate restriction enzyme digestion with EcoRI, HindIII, BamHI and more; compare predicted band patterns against experimental gels</em>
</p>

<p align="center">
  <img src="docs/images/t5_phage_zoomed_view.webp" alt="Simulation Hub" width="100%">
  <br>
  <em>Simulation Hub [Shift+S] — Interactive phage biology simulations: Lysogeny Decision Circuit, Plaque Growth Automata, Ribosome Traffic, Burst Kinetics, and more</em>
</p>

---

## Phage 101 for engineers (why this field is wild)

**What phages are (in engineering terms):** self-assembling nanosyringes that package code (DNA/RNA) in a protein shell, land on bacteria, and inject that code to hijack the host. They’re the most abundant biological “edge devices” on Earth (≈10³¹ particles), continuously stress‑testing bacterial firmware.

### Why people study them
- *Medicine*: design phage cocktails to beat antibiotic‑resistant infections.
- *Biotech*: workhorse enzymes (T7 RNA polymerase, Phi29 DNA pol) are phage gifts used in PCR, in‑vitro transcription, and genome amplification.
- *Evolution & ecology*: phages rewrite bacterial genomes, drive the ocean carbon cycle, and shape your gut microbiome.
- *Engineering playground*: modular genomes swap parts (tail fibers, lysis cassettes) like microservice plugins.

### How phages cracked the genetic code
- **Hershey–Chase blender experiment (1952)** used phage T2 to prove DNA is the hereditary material.
- **Crick–Brenner frameshift experiment (1961)** in phage T4 rII genes showed the code is read in *triplets*—delete/insert three bases and the protein still works.
- **Early codon assignments** relied on phage RNA/DNA templates (e.g., poly‑U/UGG) to map base triplets to amino acids, paving the way for the 64‑codon table we use today.

---

- **What they are:** Bacteriophages (“phages”) are bacteria‑infecting viruses. They self‑assemble into nanomachines with a head (capsid) that stores DNA/RNA and a tail that injects it like a syringe.
- **Why they matter today**
  - *Medicine*: design phage cocktails to beat antibiotic‑resistant infections.
  - *Biotech*: workhorse enzymes (T7 RNA polymerase, Phi29 DNA pol) are phage gifts used in PCR, in‑vitro transcription, and genome amplification.
  - *Evolution & ecology*: phages are the most abundant biological entities on Earth. They rewrite bacterial genomes, drive the ocean carbon cycle, and shape your gut microbiome.
- **Modular by design:** Phage genomes behave like Lego kits—swapping tail fibers, lysis cassettes, and regulatory modules across lineages. That modularity is exactly what Phage Explorer visualizes.
- **Historical impact:** Foundational experiments (Hershey–Chase blender test for DNA as genetic material; Luria–Delbrück fluctuation test revealing random mutation) used phages. They were also the playground for cracking the genetic code.

### Quick mental model for software folks
- **Genome = source code** (A/C/G/T chars) with strongly typed 3-char opcodes (codons).
- **Promoter/RBS = function entry points** that recruit ribosomes (the runtime) to start decoding.
- **Reading frame = instruction pointer alignment;** shift by one base and every downstream opcode changes.
- **Stop codons = return;** terminate translation and hand control back to the host.
- **Phage lifecycle = deployment strategy:** lytic = `rm -rf host`; lysogenic = `git clone` into host genome and wait.

## A 90‑second genetic code primer

- DNA alphabet: A, C, G, T (RNA swaps T→U). Proteins are chains of 20 amino acids.
- Translation reads DNA in **codons**—non‑overlapping triplets of bases (64 possible combos). Every three letters → one amino acid or a stop signal.
- The mapping is fixed and mostly redundant (“degenerate”): several codons can encode the same amino acid. Three codons encode **stop**, and ATG usually marks **start**.
- Reading frames matter: shift by one base and every downstream codon changes. Phage Explorer lets you flip frames live to see amino acid strings reflow.
- Triplets are proven by phage genetics: three-base indels restore the reading frame; doublet/singlet changes scramble everything.
- Quick lookup:

| Codon | Amino acid | Notes |
|-------|------------|-------|
| ATG   | M (Methionine) | Start codon |
| TTT / TTC | F (Phenylalanine) | Aromatic |
| GAA / GAG | E (Glutamic acid) | Acidic |
| TGG | W (Tryptophan) | Unique single-codon amino acid |
| TAA / TAG / TGA | * (Stop) | Terminates translation |

- **Chemistry buckets:** Amino acids group into hydrophobic, polar, acidic, basic, and “special” (glycine, proline, cysteine, histidine). Themes color by these groups so chemical patterns pop while you scroll.

---

## Features

- **Full-Screen HUD Interface** — Navigate between phages instantly with arrow keys
- **Color-Coded Sequences** — DNA (ACTG) and amino acid views with distinct, beautiful colors
- **8 Color Themes** — Holographic, Cyberpunk, Classic, Ocean, Matrix, Sunset, Forest, Monochrome (cycle with `T`)
- **3D Structure Viewer** — Web: real structures fetched live from RCSB by catalog PDB ID, parsed (PDB and mmCIF) and rendered with Three.js, cached in IndexedDB and the service worker. TUI: procedural morphology models rendered as ASCII wireframe with a Z-buffer, one per phage morphotype
- **Gene Map Navigation** — Visual gene bar with position tracking and snap-to-gene
- **Layer-1 Quick Overlays** — `G` GC skew, `X` complexity, `B` bendability, `P` promoter/RBS motifs, `R` repeats/palindromes
- **Diff Mode** — Compare sequences between phages visually
- **Search** — Fuzzy search by name, host, family, or accession
- **24 Real Phages** — Lambda, T4, T7, PhiX174, MS2, M13, P22, Phi29, Mu, Phi6, SPbeta, T5, P1, P2, N4, Felix O1, D29, L5, PhiC31, PhiKZ, PRD1, PM2, Qβ, T1
- **WASM-Accelerated** — Rust-compiled sequence routines for fast in-browser analysis
- **Zero Dependencies at Runtime** — Single binary, no Bun/Node required

---

## Quick Start

### Option 1: Pre-built Binary (Recommended)

```bash
# Install latest release (includes database)
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/phage_explorer/main/install.sh?$(date +%s)" | bash -s -- --with-database

# Run
phage-explorer
```

### Option 2: Build from Source

```bash
# Clone and install
git clone https://github.com/Dicklesworthstone/phage_explorer.git
cd phage_explorer
bun install

# Build the phage database (fetches from NCBI, ~1 minute)
bun run build:db

# Run the TUI
bun run dev
```

### Option 3: Web App

The full web experience is live at **https://phage-explorer.org**. It includes:

- **3D Structure Viewer** — Real PDB/mmCIF structures fetched live from RCSB and rendered with Three.js; 23 of 24 phages have catalog PDB IDs, the rest show an empty state
- **Interactive Sequence Grid** — Color-coded DNA/amino acid display with smooth scrolling
- **30+ Analysis Overlays** — GC skew, dot plots, Hilbert curves, HGT detection, synteny, and more
- **WASM-Accelerated** — Rust-compiled sequence operations (translation, k-mer counting, MinHash) for fast in-browser analysis
- **Mobile-Friendly** — Touch gestures, bottom sheets, haptic feedback

Deployment details:
- Hosting: Vercel (prod alias: `phage-explorer.org`)
- Build command: `cd packages/web && bun run ../../scripts/build-web-db.ts --source public/phage.db --output public && bun run build`
- Output: `packages/web/dist`
- SQLite database bundled as static asset, queried via sql.js in-browser
- Minimal telemetry (Vercel Analytics and Speed Insights only), works offline after initial load

The **TUI** remains available for terminal enthusiasts:
- Local SQLite DB with instant queries
- ASCII 3D wireframe models
- Real-time keyboard controls, diff mode, command palette
- Build locally: `bun install && bun run build:db && bun run dev` (or use the prebuilt binary)

---

## Keyboard Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between phages |
| `←` / `→` | Scroll sequence left/right |
| `PgUp` / `PgDn` | Scroll by one page |
| `Home` / `End` | Jump to start/end of genome |
| `N` / `C` | Toggle DNA / Amino Acid (codon) view |
| `F` | Cycle reading frame (1, 2, 3) |
| `T` | Cycle color theme |
| `D` | Toggle diff mode vs reference phage |
| `M` | Toggle 3D model display |
| `K` | Toggle amino acid key legend |
| `S` / `/` | Search phages |
| `[` / `]` | Jump to previous/next gene |
| `?` | Show help overlay |
| `Q` | Quit |

---

## Included Phages

| Phage | Genome | Type | Host | Notes |
|-------|--------|------|------|-------|
| **Lambda (λ)** | 48,502 bp | dsDNA | E. coli K-12 | Classic temperate phage, lysogenic |
| **T4** | 168,903 bp | dsDNA | E. coli B | Large lytic phage, contractile tail |
| **T7** | 39,937 bp | dsDNA | E. coli | Famous for its RNA polymerase |
| **PhiX174** | 5,386 bp | ssDNA | E. coli C | First DNA genome sequenced (1977) |
| **MS2** | 3,569 bp | ssRNA | E. coli | First genome ever sequenced (1976) |
| **M13** | 6,407 bp | ssDNA | E. coli | Filamentous, used in phage display |
| **P22** | 41,724 bp | dsDNA | Salmonella | Transducing phage |
| **Phi29** | 19,282 bp | dsDNA | B. subtilis | DNA polymerase for amplification |
| **Mu** | 36,717 bp | dsDNA | E. coli | Transposable phage |
| **Phi6** | 2,948 bp | dsRNA | P. syringae | Rare dsRNA phage with envelope |
| **SPbeta** | 134,416 bp | dsDNA | B. subtilis | Large temperate phage |
| **T5** | 121,750 bp | dsDNA | E. coli | Two-step DNA injection |
| **P1** | 94,800 bp | dsDNA | E. coli | Plasmid prophage, Cre-lox origin |
| **P2** | 33,593 bp | dsDNA | E. coli | Founding Peduovirus |
| **N4** | 70,153 bp | dsDNA | E. coli | Injects its own RNA polymerase |
| **Felix O1** | 86,155 bp | dsDNA | Salmonella | Classic Salmonella-typing phage |
| **D29** | 49,136 bp | dsDNA | Mycobacterium | SEA-PHAGES workhorse, TB research |
| **L5** | 52,297 bp | dsDNA | Mycobacterium | First sequenced mycobacteriophage |
| **PhiC31** | 41,491 bp | dsDNA | Streptomyces | Serine integrase for gene therapy |
| **PhiKZ** | 280,334 bp | dsDNA | Pseudomonas | Jumbo phage, forms nucleus-like shell |
| **PRD1** | 14,927 bp | dsDNA | E. coli | Tailless, internal lipid membrane |
| **PM2** | 10,079 bp | dsDNA | Pseudoalteromonas | Marine, first lipid-containing phage |
| **Qβ** | 4,217 bp | ssRNA | E. coli | RNA replicase, isothermal amplification |
| **T1** | 48,836 bp | dsDNA | E. coli | Notorious lab contaminant |

---

## Color Themes

Cycle through themes with `T`:

- **Classic** — Traditional bioinformatics colors (green A, blue C, amber G, red T)
- **Ocean** — Cool blue/teal palette
- **Matrix** — Green terminal aesthetic
- **Sunset** — Warm orange/coral tones
- **Forest** — Natural earth greens and browns

Each theme provides distinct colors for:
- 4 nucleotides (A, C, G, T) + N
- 20 amino acids grouped by property (hydrophobic, polar, acidic, basic, special) + stop codon

---

## Architecture

```
phage-explorer/
├── packages/
│   ├── core/           # Domain logic: codons, theming, grid virtualization
│   ├── db-schema/      # Drizzle ORM schema (phages, sequences, genes, etc.)
│   ├── db-runtime/     # Repository implementations over SQLite
│   ├── state/          # Zustand store for UI state management
│   ├── renderer-3d/    # ASCII 3D rendering engine with Z-buffering
│   ├── wasm-compute/   # Rust/WASM for performance-critical algorithms
│   ├── data-pipeline/  # NCBI fetcher and database builder
│   ├── web/            # React web app with WebGL 3D viewer
│   └── tui/            # Ink/React TUI components
├── phage.db            # SQLite database (generated)
└── install.sh          # One-liner installer script
```

---

## UI Design System

To keep 31+ planned features coherent, Phage Explorer follows a lightweight design system tailored for text UIs:

- **Color semantics**  
  - Green `#22c55e`: good / conserved / similar  
  - Yellow `#eab308`: caution / neutral  
  - Red `#ef4444`: warning / divergent  
  - Blue `#3b82f6`: informational metrics  
  - Purple `#a855f7`: notable / special  
  - Gray `#6b7280`: background / reference / inactive

- **Graph & sparkline standards**  
  - Height: 3–5 text rows; Width: terminal width where possible  
  - Auto-normalize values; show min/max in labels  
  - Prefer Braille dots for dense sparklines; fall back to ASCII if needed

- **Panels, modals, overlays**  
  - Single-line box borders, 1-char padding  
  - Headers bold, centered, include close hint (e.g., “Esc to close”)  
  - Max width 80 chars or `(terminal width - 4)`, whichever is smaller

- **Interaction “depth layers” (progressive disclosure)**  
  - Layer 0: Core always-on controls (navigation, view toggles, help, search)  
  - Layer 1: Quick overlays (single-key toggles; limit 3 active)  
  - Layer 2: Analysis menu (`A`) with numbered shortcuts + fuzzy search  
  - Layer 3: Simulation hub (`Shift+S`) for interactive models  
  - Layer 4: Command palette (`:` or `Ctrl+P`) that fuzzy-searches all actions

Use these conventions for any new component: pick colors from the palette above, respect padding/borders, and place advanced features in deeper layers so newcomers see a stable core UI.

---

## Depth Layers & Keybinding Conventions (progressive disclosure)

Phage Explorer serves both newcomers and power users by stacking features in “depth layers”:

- **Layer 0 – Sacred Surface (always available, never changed)**  
  Navigation: `↑` `↓` `←` `→` `PgUp` `PgDn` `Home` `End`  
  View: `N`/`C`/`Space` (DNA/AA), `F` (frame), `T` (theme), `D` (diff), `M` (3D model)  
  Meta: `?` (help), `S` or `/` (search), `Q` (quit)  
  These keys are stable forever; everything else builds on top.

- **Layer 1 – Quick Overlays (single-key toggles; max 3 active)**  
  Reserved keys: `G` (GC skew), `X` (complexity), `B` (bendability), `P` (promoter/RBS), `R` (repeats).  
  Data is precomputed on phage selection so toggles feel instant. (Feature hooks coming next.)

- **Layer 2 – Analysis Menu (`A`)**  
  Categorized, numbered actions (e.g., GC skew analysis, dot plots, codon dashboards). Supports fuzzy search.

- **Layer 3 – Simulation Hub (`Shift+S`)**  
  Full-screen interactive simulations (lysogeny circuits, ribosome traffic, plaque automata, etc.).

- **Layer 4 – Command Palette (`:` or `Ctrl+P`)**  
  Fuzzy-search every action; shows the shortcut path (e.g., “GC skew [G] Overlay” or “Dot plot [A→4] Analysis”).

Keystroke budget rule: Layer 0 keys are immutable; new features must live in higher layers. This keeps discoverability for beginners and speed for experts.

---

## Installation Options

### Installer Flags

```bash
# Install to custom directory
curl -fsSL .../install.sh | bash -s -- --dest ~/bin

# Install system-wide
curl -fsSL .../install.sh | bash -s -- --system

# Install specific version
curl -fsSL .../install.sh | bash -s -- --version v1.0.0

# Build from source instead of downloading binary
curl -fsSL .../install.sh | bash -s -- --from-source

# Include phage database
curl -fsSL .../install.sh | bash -s -- --with-database

# Auto-add to PATH
curl -fsSL .../install.sh | bash -s -- --easy-mode
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VERSION` | latest | Pin specific release tag |
| `DEST` | `~/.local/bin` | Install directory |
| `OWNER` | `Dicklesworthstone` | GitHub owner |
| `REPO` | `phage_explorer` | GitHub repository |

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `bun run dev` | Run TUI in development mode |
| `bun run build:db` | Build phage database from NCBI |
| `bun run build` | Compile to single binary |
| `bun run build:all` | Build for all platforms |
| `bun run lint` | ESLint (zero warnings) |
| `bun run typecheck` | TypeScript checks |
| `bun run check` | Lint + typecheck |
| `bun run test` | Run unit tests |

---

## Technical Details

- **Sequence Storage**: Chunked in 10kb segments for efficient virtualized rendering
- **Virtualized Rendering**: Only visible sequence portion rendered, smooth 60fps scrolling
- **3D Engine**: Custom ASCII renderer over procedural morphology models (TUI); WebGL/Three.js viewer over real RCSB structures (web)
- **WASM Acceleration**: Rust-compiled WebAssembly for sequence operations (translation, k-mer counting, MinHash) with automatic JS fallback
- **3D Structure Loading**: Web fetches `files.rcsb.org` by catalog PDB ID and parses PDB or mmCIF in a worker, with spatial-hash bond detection; two cache tiers (IndexedDB and the service worker) make repeat views instant
- **State Management**: Zustand for reactive UI updates
- **Database**: SQLite with Drizzle ORM, ~6 MB for 24 phages with PDB structure references

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Database missing | Run `bun run build:db` or use `--with-database` flag |
| NCBI fetch errors | Retry `build:db`; NCBI has rate limits |
| Binary not in PATH | Use `--easy-mode` or manually add install directory |
| Terminal too small | Resize to at least 80x24 for best experience |
| Colors not showing | Ensure terminal supports 256 colors / truecolor |

---

## Security & Privacy

- **Network calls**: Only to NCBI during database build
- **Minimal telemetry**: Vercel Analytics and Speed Insights only; no user data collection
- **Local data**: All data stored in local SQLite database
- **Open source**: Full source code available for audit

---

## Performance Notes

- Single-binary distribution, no runtime dependencies
- SQLite database for instant local queries
- Virtualized sequence rendering for genomes up to 500kb+
- Chunked fetching avoids loading entire genomes into memory
- 3D model rendering at ~20fps with minimal CPU usage
- **WASM acceleration**: Rust routines for translation, k-mer counting, and MinHash reduce CPU time on large genomes
- Web Worker isolation keeps UI responsive during heavy computation
- Automatic fallback to pure JS when WASM unavailable

---

## CI/CD

- **Lint + Typecheck**: Every push and PR
- **Cross-platform builds**: macOS (arm64, x64), Linux (x64, arm64), Windows (x64) via `bun run build:<target>`
- **Release infrastructure**: DSR (Doodlestein Self-Releaser) is the release path; GitHub Actions is not used
- **Database artifacts**: Pre-built `phage.db` included in releases

---

## Development

1. `bun install` to set up dependencies
2. `bun run build:db` to create the database
3. `bun run dev` to run the TUI
4. Run `bun run check` before committing changes

---

## Analysis Algorithms (25+)

Phage Explorer implements a comprehensive suite of genomic analysis algorithms, from classic bioinformatics to cutting-edge machine learning approaches.

### Sequence Homology & Structure

| Algorithm | Description | Complexity |
|-----------|-------------|------------|
| **Dot Plot** | Downsampled self-homology comparison with direct & inverted (reverse-complement) scoring | O(bins² × window) |
| **Chaos Game Representation** | Fractal IFS-based genomic fingerprinting; maps DNA to 2D coordinates using corner mappings (A→0,0 T→1,0 C→0,1 G→1,1) | O(N) |
| **Recombination Radar** | k-mer Jaccard similarity against reference panel; detects mosaic segments & HGT breakpoints | O(N × refs) |
| **Hilbert Curve Atlas** | Maps 1D sequence to 2D via space-filling curve; preserves locality for visual pattern recognition | O(N) |

### Codon & Translation Analysis

| Algorithm | Description |
|-----------|-------------|
| **Codon Bias (RSCU)** | Relative Synonymous Codon Usage; identifies preferred/rare codons per amino acid family |
| **Ribosome Traffic** | Particle-based translation simulation with collision detection; bottleneck identification based on codon rarity |
| **Periodicity Analysis** | Spectral analysis of GC% and purine runs; identifies repeating motifs (tandem repeats, period-3 codon patterns) |
| **K-mer Frequency** | 256-element tetranucleotide vectors for phylogenetic profiling; base-4 encoding for O(1) lookup |

### Non-B DNA Detection

| Structure | Algorithm |
|-----------|-----------|
| **G-quadruplex** | G4Hunter scoring: +1 to +4 per G-run length, -1 to -4 per C-run; identifies potential G4-forming regions |
| **Z-DNA** | Dinucleotide propensity scoring; CG/GC repeats favor left-handed helix formation |
| **Cruciform** | Inverted repeat detection with stem-loop energy estimation |

### Defense & Tropism Prediction

| Feature | Method |
|---------|--------|
| **CRISPR Pressure** | Spacer matching against mock host CRISPR arrays; rates evolutionary pressure 0-10 scale |
| **Anti-CRISPR (ACR)** | Heuristic scoring for defense-suppressing genes; flags known families (e.g., AcrIIA4). Ocr-like proteins are classified as anti-RM. |
| **Tail Fiber Tropism** | Precomputed lightweight trigram-embedding predictions loaded from `data/tropism-embeddings.json`; not ESM2/HDBSCAN inference at build time |
| **Prophage Excision** | Detects integrase genes; searches for attL/attR direct repeats; models excision products |

### Protein Structure & Function

| Feature | Description |
|---------|-------------|
| **Protein Domains** | 1,695 Pfam domain hits generated locally with PyHMMER and Pfam-A; E-values and protein boundaries included |
| **Fold Embeddings** | ESM2 `esm2_t6_8M_UR50D` mean-pooled 320-dimensional vectors for all CDS genes; deterministic k-mer hash fallback |
| **AMG Detection** | 25 conservative keyword-supported AMG predictions mapped to known KEGG orthologs; evidence and confidence retained |

---

## Interactive Simulations (7)

The Simulation Hub (`Shift+S`) provides interactive models of phage biology with adjustable parameters and real-time visualization.

### 1. Lysogeny Decision Circuit
**Model:** ODE system of Lambda lysis-lysogeny bistable switch
**State variables:** CI and Cro repressor concentrations
**Parameters:**
- Hill cooperativity (n=1-4) — controls switch steepness
- MOI (multiplicity of infection) — tips balance toward lysogeny
- UV damage — triggers lytic induction

**Output:** Phase classification (lysogenic/lytic/undecided) with time-series history

### 2. Ribosome Traffic Simulator
**Model:** Particle-based translation with stochastic elongation
**Mechanics:**
- 9-codon ribosome footprint
- Elongation rates derived from phage codon usage bias
- Rare codons create traffic jams → bottlenecks

**Output:** Protein production rate, stall events, density heatmap

### 3. Plaque Growth Automata
**Model:** Cellular automaton with reaction-diffusion dynamics
**Cell states:** Empty → Bacteria → Infected → Lysed → Phage → Lysogen
**Parameters:** Burst size, latent period, diffusion probability, adsorption rate, lysogeny probability
**Grid:** Toroidal wrap-around, ~100 steps/frame

### 4. Burst Kinetics Simulator
**Model:** SIR-like ODE system (dB/dt, dI/dt, dP/dt)
**Features:**
- Adsorption kinetics: k [mL/(phage·min)]
- Exponential latent period decay
- Logistic bacterial growth with carrying capacity

### 5. Resistance Cocktail Evolution
**Model:** Gillespie stochastic simulation with tau-leaping
**States:** Sensitive → Partially resistant (per phage) → Fully resistant
**Key insight:** Mono-phage resistance emerges faster than cocktail resistance (synergy effect)
**Tracks:** Sensitive/resistant populations, emergence time, individual phage counts

### 6. Packaging Motor Pressure Gauge
**Model:** Physics-informed DNA packaging
**Factors:**
- Intrinsic pressure from DNA bending: L/(R²) energy model
- Ionic strength effects (Debye screening ~0.304/√I nm)
- Morphology-specific baselines (headful/cos/phi29)

**Output:** Fill fraction, internal pressure (atm), motor force (pN)

### 7. Evolution Replay
**Model:** Molecular clock with mutations and genetic drift
**Mechanics:**
- Poisson-distributed mutations per generation
- Selection coefficients from normal distribution
- Fitness clamped 0.6-1.5, effective population (Ne) tracks drift

---

## WASM Acceleration

Performance-critical algorithms are implemented in Rust and compiled to WebAssembly for near-native speed in the browser.

### What's Accelerated

| Algorithm | Threshold | Speedup | Fallback |
|-----------|-----------|---------|----------|
| **Sequence translation & reverse complement** | Always | ~5-20x over naive JS | Pure JS translation |
| **K-mer counting** | Large genomes | ~2-10x | TypedArray JS |
| **MinHash similarity** | Pairwise comparisons | ~5-20x | Pure JS hash comparison |

### Why Rust/WASM for Sequence Work

Genomic sequence operations can dominate CPU time on large phage genomes. The `wasm-compute` package handles hot paths that are otherwise pure JavaScript loops over hundreds of thousands of bases or amino acids:

1. Six-frame translation and codon counting for every CDS
2. K-mer extraction and counting for dot plots, Hilbert curves, and phylogenetic signatures
3. MinHash signature comparison for recombination and similarity overlays

The WASM module falls back to pure JavaScript implementations if WASM loading fails.

### Automatic Fallback

When WASM isn't available (older browsers, restricted environments), Phage Explorer gracefully falls back to pure JavaScript implementations. Users get the same features, just slower on large datasets.

---

## Precomputed Annotations

The SQLite database includes extensive precomputed annotations, enabling instant analysis with zero latency.

### Database Schema

| Table | Contents |
|-------|----------|
| `phages` | 24 reference phages with metadata (accession, family, genus, host, morphology, lifecycle, genome stats) |
| `sequences` | Chunked 10kb segments for virtualized streaming |
| `genes` | Full annotations (position, strand, type, qualifiers as JSON) |
| `codonUsage` | Per-phage amino acid and codon frequency counts |
| `proteinDomains` | 1,695 Pfam-A hits generated locally with PyHMMER, including E-values and boundaries |
| `foldEmbeddings` | 2,039 ESM2 320-dimensional vectors plus deterministic k-mer hash fallback vectors |
| `amgAnnotations` | 25 conservative heuristic predictions mapped to known KEGG orthologs |
| `defenseSystems` | Heuristic anti-CRISPR/anti-RM/anti-Abi predictions with confidence |
| `tropismPredictions` | Precomputed tail-fiber receptor predictions from `data/tropism-embeddings.json` |
| `codonAdaptation` | Intrinsic Nc (effective number of codons), per-gene intrinsic CAI, and host-specific tAI (for available hosts such as *E. coli*) |

### Annotation Pipeline

Core annotations are built by `bun run build:db`; run `bun run build:db:annotated` for the complete ESM2 + Pfam database (DSR can also drive release builds):
1. **NCBI fetch** → Raw sequences and gene annotations
2. **Heuristic scans** → Anti-CRISPR / anti-RM / anti-Abi defense-system predictions
3. **Intrinsic codon metrics** → Nc (effective number of codons), per-gene intrinsic CAI, and host-specific tAI for available host tRNA pools
4. **Protein embeddings** → `bun run build:esm2` downloads the public 8M-parameter ESM2 checkpoint and stores mean-pooled 320-dimensional vectors
5. **Pfam domains** → `bun run build:pfam` scans all proteins locally with PyHMMER and Pfam-A
6. **SQLite build** → Indexed, compressed database (~10 MB with both embedding sets and domain hits)

InterPro/SMART and broader KEGG pipelines remain optional enhancements; the shipped database includes Pfam-A hits and conservative AMG-to-KEGG ortholog mappings without requiring credentials.

---

## Alignment-Free Genomics

Traditional sequence comparison requires alignment (BLAST, etc.), which is slow and fails for distant homologs. Phage Explorer includes alignment-free methods that work on raw k-mer statistics.

### Chaos Game Representation (CGR)

Maps a genome to a 2D fractal image:
- Start at center (0.5, 0.5)
- For each nucleotide, move halfway toward its corner
- Plot the point

**Result:** A unique "fingerprint" where similar genomes produce similar fractals. Visually identifies sequence biases, repeat structures, and phylogenetic relationships without alignment.

### K-mer PCA

1. Compute tetranucleotide (4-mer) frequency vectors (256 dimensions)
2. Run PCA to reduce to 2-3D
3. Cluster phages by genomic signature

**Why it works:** Oligonucleotide frequencies are remarkably stable within a genome but differ between species. This captures "genomic dialect" independent of gene order or alignment.

### Recombination Radar

Detects horizontal gene transfer and mosaic genomes:
1. Slide a window across the query genome
2. Compute k-mer Jaccard similarity to each reference
3. Plot "donor" assignment along the genome

**Output:** Identifies breakpoints where the genome switches from one "parent" to another—direct evidence of recombination events.

---

## Why Phage Explorer Exists

Most phage genomics tools are either:
- **Too specialized** — Built for one analysis type, require pipeline assembly
- **Too heavyweight** — Need cloud infrastructure, accounts, or complex installation
- **Too dated** — Command-line tools from the 2000s with no visualization

Phage Explorer combines:
- **Breadth** — 25+ analyses in one interface
- **Speed** — Precomputed annotations + WASM = instant results
- **Accessibility** — Single binary or web app, zero configuration
- **Education** — Interactive simulations teach the biology, not just display data

It's designed for the researcher who wants to *explore* a phage genome, not run a production pipeline.

---

## Rendering Pipeline

### Sequence Grid Virtualization

Phage Explorer handles genomes up to 500kb+ without loading the entire sequence into memory.

**How it works:**
1. Sequences stored in 10kb chunks in SQLite
2. Virtual window tracks visible region + 500bp overscan buffer
3. Only visible chunks loaded and rendered
4. Row tiles cached with content hashing—scroll reuses existing tiles
5. Incremental blitting renders only newly visible rows

**GlyphAtlas optimization:**
- Pre-renders all nucleotides and amino acids to a texture atlas
- 10x faster than calling `fillText()` per character
- O(1) array-based glyph lookup (not `Map.get()`)
- Automatic device pixel ratio scaling (1x to 3x)

**Zoom levels:**
| Preset | Cell Size | Use Case |
|--------|-----------|----------|
| Genome | 1px | Full genome overview |
| Micro | 4px | Regional patterns |
| Region | 8px | Gene-level navigation |
| Codon | 12px | Reading codons |
| Base | 18px | Individual nucleotides |

### 3D Rendering

**ASCII Renderer (TUI):**
- 70-character gradient for smooth shading: `.'-",:;Il!i><~+_-?][}{1)(|\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$`
- Float32 Z-buffer for proper occlusion
- Cohen-Sutherland line clipping with z-interpolation
- Front-to-back edge sorting for optimal depth writes
- Brightness mapping: depth → 0.2-1.0 intensity range

**WebGL Renderer (Web):**
- Three render modes: cartoon ribbons, ball-and-stick, surface mesh
- Fetches and parses real structures from RCSB by catalog PDB ID; falls back to an explicit empty state for the one phage with no deposited structure
- CRT post-processing: chromatic aberration, scanlines, bloom, vignette, film grain

---

## Color Theme System

8 scientifically-grounded themes, each with 40+ color tokens.

### Amino Acid Color Logic

Colors map to biochemical properties so structural patterns are visible while scrolling:

| Property | Amino Acids | Color Family | Rationale |
|----------|-------------|--------------|-----------|
| **Hydrophobic** | V, L, I, M, F, W | Blues/Purples | Nonpolar, buried in core |
| **Polar** | S, T, N, Q | Cyans/Teals | OH/NH₂ side chains |
| **Positive** | K, R, H | Blues | Basic, cationic |
| **Negative** | D, E | Reds | Acidic, anionic |
| **Special** | C, P, G, A | Yellows/Silvers | Unique structural roles |
| **Stop** | * | Bright Red | Termination signal |

### Available Themes

1. **Holographic** (default) — Glassmorphic cyan/magenta, electric accents
2. **Cyberpunk** — Neon grid aesthetic (cyan/magenta/yellow)
3. **Classic** — Traditional bioinformatics (green A, blue C, amber G, red T)
4. **Ocean** — Cool water-inspired blues and teals
5. **Matrix** — Green monochrome terminal aesthetic
6. **Sunset** — Warm orange/red/gold gradient
7. **Forest** — Natural greens and earth tones
8. **Monochrome** — Accessibility-focused grayscale

---

## Mobile UX

Phage Explorer is fully touch-optimized with gesture navigation and haptic feedback.

### Touch Gestures

| Gesture | Action |
|---------|--------|
| **Swipe left/right** | Navigate between phages (spring physics animation) |
| **Pinch** | Zoom sequence grid between presets |
| **Long press** | Context menu with progressive haptic buildup |
| **Pull down** | Refresh/reload data |

### Haptic Feedback Patterns

8 distinct vibration patterns for tactile feedback:

| Pattern | Duration | Use |
|---------|----------|-----|
| `light` | 10ms | Selections, toggles |
| `medium` | 25ms | Button presses |
| `heavy` | 50ms | Important actions |
| `success` | 15-50-25ms | Task completion |
| `warning` | 30-80-30ms | Destructive action alert |
| `error` | 50-100-50-100-50ms | Triple buzz for errors |
| `selection` | 5ms | Slider/picker scrubbing |
| `impact` | 35ms | Drag/drop or physical feedback |

Haptics respect `prefers-reduced-motion` and gracefully degrade on unsupported devices.

### Bottom Sheets

Mobile overlays use iOS-style bottom sheets:
- Snap points: 25%, 50%, 90% of screen height
- Drag handle with visual feedback
- Swipe-to-dismiss with velocity detection
- Safe area insets for notched devices

---

## Overlay Architecture

30+ analysis overlays, architected for performance and maintainability.

### Code Splitting

**Eager-loaded (instant):** Search, Help, Settings, Command Palette
**Lazy-loaded (on-demand):** All analysis overlays via React Suspense

This keeps initial bundle small (~200KB) while supporting 30+ feature-rich overlays.

### Overlay Categories

| Category | Overlays |
|----------|----------|
| **Sequence** | GC Skew, Complexity, Bendability, Promoter, Repeats, K-mer Anomaly |
| **Visualization** | CGR Fractal, Hilbert Curve, Dot Plot, Phase Portrait, Logo Plot |
| **Genomic** | HGT Detection, CRISPR Systems, Non-B DNA, Prophage Excision |
| **Protein** | Codon Bias, RNA Structure, Fold Viewer (ESM2 with k-mer fallback), Pfam Domains |
| **Ecology** | Host Tropism (precomputed trigram), Defense Arms Race, Cocktail Compatibility, AMG Pathways (conservative KEGG mappings) |
| **Simulation** | All 7 interactive simulations |

### Composable UI Primitives

Overlays share 12+ reusable components:
- `OverlaySection` / `OverlaySectionHeader` — Consistent section styling
- `OverlayGrid` / `OverlayRow` — Responsive layouts
- `OverlayStatCard` / `OverlayStatGrid` — Metric displays
- `OverlayKeyValue` / `OverlayBadge` — Data presentation
- `OverlayLegend` — Color key explanations

---

## State Management

Zustand powers all UI state, shared between TUI and web platforms.

### Store Structure

The `PhageExplorerStore` manages ~170 state properties:

| Domain | Properties |
|--------|------------|
| **Navigation** | Current phage, scroll position, zoom level |
| **View** | DNA/AA mode, reading frame, active theme |
| **Overlays** | Overlay stack (max 3), overlay-specific data |
| **Simulations** | Active simulation, parameters, history |
| **User** | Experience level, completed tours, preferences |

### Key Patterns

**Overlay stack limit:**
```typescript
overlays: [...filtered, newOverlay].slice(-3) // Max 3 active
```

**View mode scroll preservation:**
- DNA→AA: `scrollPosition / 3` (codons are 3bp)
- AA→DNA: `scrollPosition * 3`

**LocalStorage persistence:** Beginner mode, tour completion, theme preference

---

## Data Pipeline

### NCBI Integration

The data pipeline fetches sequences from NCBI's Entrez API:

1. **ESearch** — Query nucleotide database with filters
2. **ESummary** — Batch metadata retrieval (50 items/request)
3. **EFetch** — Full GenBank records with gene annotations

**Filters applied:**
- `viruses[filter] OR phage[Title]`
- Sequence length constraints
- Collection date for temporal analysis

### Transformations

| Step | Input | Output |
|------|-------|--------|
| **Normalization** | Raw FASTA | Uppercase, N-padded |
| **Chunking** | Full sequence | 10kb segments |
| **Translation** | DNA chunks | 6-frame amino acids |
| **Annotation** | GenBank features | Structured gene records |
| **Domain scan** | Protein sequences | Pfam-A hits via local PyHMMER scan; InterPro/SMART remain optional |
| **Embedding** | Protein sequences | ESM2 320-dimensional vectors plus k-mer hash fallback |

### Phylodynamics Support

For temporal analysis, the pipeline:
- Parses collection dates (ISO, "May-2020", "2020", etc.)
- Bins sequences by month/year
- Extracts geographic metadata
- Computes temporal coverage histograms

---

## Use Cases

### Research Workflows

**Comparative genomics:**
1. Load two phages (e.g., Lambda and P22)
2. Toggle Diff mode (`D`) to highlight sequence differences
3. Use Dot Plot overlay to visualize synteny
4. Identify conserved vs. variable regions

**Gene function prediction:**
1. Navigate to gene of interest with `[`/`]`
2. Inspect gene product and qualifiers from the NCBI GenBank record
3. Use the Fold Viewer overlay to compare ESM2 protein embeddings
4. Cross-reference local Pfam-A domain hits and conservative AMG-to-KEGG ortholog predictions

**Phage therapy candidate screening:**
1. Use Host Tropism overlay to verify target range
2. Check Defense Arms Race for anti-CRISPR genes
3. Run Cocktail Compatibility for multi-phage therapy
4. Simulate Resistance Evolution to predict durability

### Educational Use

**Teaching the genetic code:**
- Toggle reading frames (`F`) to show frameshift effects
- Compare DNA vs. amino acid views (`N`/`C`)
- Run Ribosome Traffic simulation to visualize translation

**Demonstrating phage biology:**
- Lysogeny Decision Circuit shows Lambda switch mechanics
- Plaque Growth Automata visualizes infection spread
- Packaging Motor demonstrates DNA condensation physics

---

## Comparison with Other Tools

| Feature | Phage Explorer | NCBI Viewer | Geneious | SnapGene |
|---------|---------------|-------------|----------|----------|
| **Startup time** | <100ms | 5-10s | 30s+ | 10s |
| **3D structures** | Live from RCSB (web); procedural models (TUI) | None | Plugin | None |
| **Analysis tools** | 30+ built-in | 3-5 | 20+ (paid) | 10+ |
| **Offline** | Full | No | Yes | Yes |
| **Mobile** | Full touch UI | Limited | No | No |
| **Simulations** | 7 interactive | None | None | None |
| **Price** | Free | Free | $2,500/yr | $695 |
| **Open source** | Yes | No | No | No |

**Best for:** Rapid exploration, education, phage therapy research
**Not ideal for:** High-throughput pipelines (use command-line tools), primer design (use SnapGene)

---

## License

MIT License (with OpenAI/Anthropic Rider) — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- Sequence data from [NCBI GenBank/RefSeq](https://www.ncbi.nlm.nih.gov/)
- TUI framework: [Ink](https://github.com/vadimdemedes/ink) (React for CLIs)
- Database: [Drizzle ORM](https://orm.drizzle.team/) + SQLite
- Runtime: [Bun](https://bun.sh/)
