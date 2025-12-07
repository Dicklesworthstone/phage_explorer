# Phage Explorer

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun%201.1+-purple)
![License](https://img.shields.io/badge/license-MIT-green)

A Terminal User Interface (TUI) for browsing, visualizing, and analyzing bacteriophage genetic data. Features color-coded DNA/amino acid sequences, rotating 3D ASCII phage models, and instant navigation between genomes.

**One-liner install:**
```bash
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/phage_explorer/main/install.sh | bash
```

---

## What are phages, and why do they matter?

- **Bacteriophages (phages)** are viruses that infect bacteria. They are the most abundant biological entities on Earth and shape microbial ecosystems, the ocean carbon cycle, and your own microbiome.
- **Why people study them**
  - Medicine: craft phage cocktails to fight antibiotic‑resistant infections.
  - Biotechnology: enzymes like T7 RNA polymerase and Phi29 polymerase are phage gifts that power PCR, IVT, and genome amplification.
  - Evolution: phages are modular, recombining “Lego kits” that swap genes and reveal how genomes evolve.
- **Historical impact:** Classic phage experiments (Hershey–Chase, Luria–Delbrück) established DNA as genetic material and the statistical nature of mutation. Phages helped crack the genetic code and seeded modern molecular biology.

## A 90‑second genetic code primer

- DNA alphabet: A, C, G, T (RNA uses U instead of T).
- The code is read in **codons**: non‑overlapping triplets of bases.
- Each codon maps to an amino acid (or a stop signal). Example:

| Codon | Amino acid | Notes |
|-------|------------|-------|
| ATG   | M (Methionine) | Start codon |
| TTT / TTC | F (Phenylalanine) | Aromatic |
| GAA / GAG | E (Glutamic acid) | Acidic |
| TGG | W (Tryptophan) | Unique single-codon amino acid |
| TAA / TAG / TGA | * (Stop) | Terminates translation |

- **Reading frames matter:** shift the starting base by 1 or 2 and every downstream codon changes. Phage Explorer lets you flip frames and watch amino acid strings update instantly.
- **Color hints:** Amino acids cluster by chemistry (hydrophobic, polar, acidic, basic, special). Themes use those groups so patterns pop visually while you scroll.

---

## Features

- **Full-Screen HUD Interface** — Navigate between phages instantly with arrow keys
- **Color-Coded Sequences** — DNA (ACTG) and amino acid views with distinct, beautiful colors
- **5 Color Themes** — Classic, Ocean, Matrix, Sunset, Forest (cycle with `T`)
- **3D ASCII Phage Models** — Rotating wireframe models of phage structures
- **Gene Map Navigation** — Visual gene bar with position tracking and snap-to-gene
- **Diff Mode** — Compare sequences between phages visually
- **Search** — Fuzzy search by name, host, family, or accession
- **12 Real Phages** — Lambda, T4, T7, PhiX174, MS2, M13, P22, Phi29, Mu, Phi6, SPbeta, T5
- **Zero Dependencies at Runtime** — Single binary, no Bun/Node required

---

## Quick Start

### Option 1: Pre-built Binary (Recommended)

```bash
# Install latest release (includes database)
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/phage_explorer/main/install.sh | bash -s -- --with-database

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
│   ├── data-pipeline/  # NCBI fetcher and database builder
│   └── tui/            # Ink/React TUI components
├── phage.db            # SQLite database (generated)
└── install.sh          # One-liner installer script
```

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
- **3D Engine**: Custom ASCII renderer with perspective projection and Z-buffering
- **State Management**: Zustand for reactive UI updates
- **Database**: SQLite with Drizzle ORM, ~1.4MB for 12 phages

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
- **No telemetry**: Zero analytics or tracking
- **Local data**: All data stored in local SQLite database
- **Open source**: Full source code available for audit

---

## Performance Notes

- Single-binary distribution, no runtime dependencies
- SQLite database for instant local queries
- Virtualized sequence rendering for genomes up to 500kb+
- Chunked fetching avoids loading entire genomes into memory
- 3D model rendering at ~20fps with minimal CPU usage

---

## CI/CD

- **Lint + Typecheck**: Every push and PR
- **Cross-platform builds**: macOS (arm64, x64), Linux (x64, arm64), Windows (x64)
- **Automated releases**: Tagged versions trigger binary builds and GitHub release
- **Database artifacts**: Pre-built `phage.db` included in releases

---

## Contributing

1. Fork and clone the repository
2. `bun install` to set up dependencies
3. `bun run build:db` to create the database
4. `bun run dev` to run the TUI
5. Make changes and run `bun run check` before submitting

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- Sequence data from [NCBI GenBank/RefSeq](https://www.ncbi.nlm.nih.gov/)
- TUI framework: [Ink](https://github.com/vadimdemedes/ink) (React for CLIs)
- Database: [Drizzle ORM](https://orm.drizzle.team/) + SQLite
- Runtime: [Bun](https://bun.sh/)
