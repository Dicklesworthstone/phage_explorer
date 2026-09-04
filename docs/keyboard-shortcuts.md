<!--
  GENERATED FILE. Do not edit by hand.

  Regenerate:  bun scripts/generate-keyboard-tables.ts
  Check:       bun scripts/generate-keyboard-tables.ts --check

  `bun run check` runs the check form, so an edit here fails the build.
  Change the registries instead:
    web  packages/web/src/keyboard/actionRegistry.ts
    tui  packages/tui/src/keymap.ts
-->

# Keyboard shortcuts

This file is generated from the two key registries, so it cannot describe a
binding that does not exist or omit one that does. It previously called
itself a single source of truth while matching neither surface.

## Web app

Generated from `packages/web/src/keyboard/actionRegistry.ts`, which the app
dispatches from directly. An action with no shortcut is reachable from the
command palette or a menu.

### Navigation

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Ctrl+g` | Go to position... |  | Jump to a specific genome coordinate |
| `End / Shift+G` | Jump to end |  | Scroll to the end of the sequence |
| `Home / gg` | Jump to start |  | Scroll to the beginning of the sequence |
| `j / ↓` | Next phage |  | Move to the next phage in the list |
| `k / ↑` | Previous phage |  | Move to the previous phage in the list |

### View

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `f` | Cycle reading frame |  | Advance to the next reading frame |
| `t` | Cycle theme |  | Rotate the active color theme |
| `v / Space` | Cycle view mode |  | Cycle DNA / Amino Acid / Dual view |
| `m` | Toggle 3D model |  | Show or hide the 3D structure viewer |
| `+ / =` | Zoom in |  | Increase sequence zoom level |
| `-` | Zoom out |  | Decrease sequence zoom level |

### Search

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `/` | Search overlay |  | Open the phage search overlay |

### Comparison

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `c` | Compare genomes |  | Open genome comparison overlay |
| `Alt+m` | Mosaic radar |  | Open mosaic radar overlay |
| `]` | Next diff |  | Jump to the next diff segment |
| `[` | Previous diff |  | Jump to the previous diff segment |
| `d` | Toggle diff mode |  | Toggle diff highlighting against reference |

### Analysis

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Alt+a` | AMG pathways | heuristic | Open AMG pathway overlay |
| `Alt+y` | Anomaly detection |  | Open anomaly detection overlay |
| `Alt+b` | Bias decomposition |  | Open bias decomposition overlay |
| `Alt+Shift+c` | Chaos game representation |  | Open CGR overlay |
| `Alt+k` | Cocktail compatibility matrix | heuristic | Open cocktail compatibility overlay |
| `Alt+t` | Codon adaptation |  | Open codon adaptation overlay |
| `Alt+u` | Codon usage bias |  | Open codon usage bias |
| `Alt+c` | CRISPR pressure map | heuristic | Open CRISPR analysis |
| `Alt+e` | Defense arms race | heuristic | Open defense arms race overlay |
| `b` | DNA bendability |  | Open bendability analysis |
| `Alt+o` | Dot plot analysis |  | Open dot plot analysis |
| `Ctrl+Shift+e` | Environmental provenance | external → demo | Open environmental provenance overlay |
| `Alt+Shift+e` | Epistasis explorer |  | Open epistasis overlay |
| `Alt+Shift+f` | Fold quickview |  | Open fold quickview overlay |
| `g` | GC skew analysis |  | Open GC skew analysis |
| `Alt+p` | Genomic signature PCA |  | Open genomic signature PCA |
| `Alt+h` | HGT provenance tracer |  | Open HGT analysis |
| `Alt+Shift+h` | Hilbert curve |  | Open Hilbert curve overlay |
| `Alt+i` | Host interactions | heuristic | Open host-phage protein interaction and effector docking map |
| `Alt+J` | K-mer anomaly cartography |  | Open k-mer anomaly overlay |
| `Alt+Shift+l` | Latent space atlas |  | Open Pan-Phage Latent Space Atlas |
| `l` | Module coherence |  | Open module coherence overlay |
| `Alt+n` | Non-B-DNA structures |  | Open non-B-DNA analysis |
| `Shift+V` | Packaging pressure | heuristic | Open the packaging pressure overlay |
| `Shift+P` | Pangenome graph | heuristic | Open pan-phage variation graph pangenome and variant cards |
| `Alt+w` | Periodicity spectrogram |  | Open periodicity analysis |
| `Alt+Shift+p` | Phase portrait |  | Open phase portrait overlay |
| `Ctrl+Shift+y` | Phylodynamics | external → demo | Open phylodynamic trajectory overlay |
| `p` | Promoter & RBS sites |  | Open promoter and RBS analysis |
| `Alt+x` | Prophage excision |  | Open prophage excision overlay |
| `Alt+d` | Protein domains |  | Open protein domain overlay |
| `Alt+l` | Recenter PCA selection |  | Recenter PCA on current phage |
| `r` | Repeats & palindromes |  | Open repeats and palindromes analysis |
| `Alt+r` | RNA structure | heuristic | Open RNA structure overlay |
| `Alt+Shift+s` | Selection pressure (dN/dS) |  | Gene-aware dN/dS landscape against the diff reference genome |
| `x` | Sequence complexity |  | Open sequence complexity analysis |
| `o` | Sequence logo |  | Open sequence logo overlay |
| `Alt+Shift+r` | Structure constraints |  | Open structure constraints overlay |
| `Alt+s` | Synteny analysis |  | Open synteny analysis |
| `y` | Transcription flow |  | Open the transcription flow overlay |
| `0` | Tropism atlas | heuristic | Open the tropism overlay |
| `Alt+v` | Virion stability | heuristic | Open virion stability overlay |
| `Alt+g` | Virtual gel electrophoresis |  | Open virtual gel overlay |

### Simulation

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Shift+E` | Resistance evolution simulator | simulated | Open resistance evolution simulation |
| `Shift+S` | Simulation hub |  | Open the simulation hub |

### Overlays

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Shift+K` | Amino acid key |  | Open the amino acid key |
| `Shift+L` | Amino acid legend |  | Open the amino acid legend |
| `a` | Analysis menu |  | Open the analysis menu |
| `Esc` | Close overlays |  | Close open overlays |
| `⌘+k / Ctrl+k / :` | Command palette |  | Open the command palette |
| `?` | Help overlay |  | Open keyboard shortcuts help |
| `—` | Multi-Tab Sync |  | Synchronize navigation and view state across browser tabs |
| `⌘+, / Ctrl+,` | Settings overlay |  | Open settings |
| `d` | Toggle help detail |  | Toggle detailed shortcuts in help overlay |

### Education

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Ctrl+Shift+N` | Niche network | demo | Explore niche co-occurrence structure on a simulated community |
| `—` | Take feature tour |  | Start the guided feature tour |
| `Ctrl+b` | Toggle beginner mode |  | Enable or disable beginner mode |

### Export

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `—` | Copy sequence |  | Copy sequence to clipboard (rich text) |
| `—` | Export analysis JSON |  | Download full analysis state |
| `—` | Export as FASTA |  | Download current sequence as FASTA |

### Dev

| Shortcut | Action | Provenance | Description |
|---|---|---|---|
| `Alt+Shift+b` | GPU vs WASM benchmark |  | Open the GPU vs WASM benchmark |

## Terminal UI

Generated from `packages/tui/src/keymap.ts`. That file is data, not the
dispatcher, so `packages/tui/src/keymap.test.ts` holds it to the handler in
both directions: an entry without a handler fails, and a handler without an
entry fails.

Bindings marked with a tier do nothing until the user reaches it. Tiers are
reached by use over time or by manual promotion.

### Navigation

| Key | Action | Tier |
|---|---|---|
| `]` | Jump to next gene start | — |
| `[` | Jump to previous gene start | — |
| `End` | Jump to sequence end | — |
| `Home` | Jump to sequence start | — |

### View

| Key | Action | Tier |
|---|---|---|
| `t` | Cycle colour theme | — |
| `n / c / Space` | Cycle DNA / dual / amino-acid view | — |
| `f` | Cycle reading frame | — |
| `o / p (3D fullscreen)` | Pause or resume the 3D animation | — |
| `z` | Toggle 3D fullscreen | — |
| `m` | Toggle 3D model | — |
| `d` | Toggle diff view | — |

### Analysis

| Key | Action | Tier |
|---|---|---|
| `a` | Analysis menu | intermediate |
| `Shift+A` | Anomaly detection | power |
| `i` | CRISPR pressure | intermediate |
| `b` | DNA bendability | intermediate |
| `Ctrl+F` | Fold quickview | power |
| `g` | GC skew | intermediate |
| `h` | Horizontal gene transfer | intermediate |
| `j` | K-mer anomaly | intermediate |
| `l` | Module coherence | intermediate |
| `Shift+G` | Non-B DNA structures | intermediate |
| `v` | Packaging pressure gauge | intermediate |
| `Shift+P` | Phase portraits | intermediate |
| `p` | Promoter prediction | intermediate |
| `r` | Repeat finder | intermediate |
| `x` | Sequence complexity | intermediate |
| `Shift+S` | Simulation hub | power |
| `u` | Structure constraints | intermediate |
| `Shift+Y` | Synteny alignment | intermediate |
| `e` | Tail fibre tropism | intermediate |
| `y` | Transcription flow | intermediate |

### System

| Key | Action | Tier |
|---|---|---|
| `k` | Amino-acid key | — |
| `Ctrl+P` | Command palette | power |
| `:` | Command palette | power |
| `w` | Comparison view | — |
| `?` | Help overlay | — |
| `q` | Quit (press twice to confirm) | — |
| `s / /` | Search | — |

### Function keys

| Key | Action |
|---|---|
| `F1` | Help overlay |
| `F2` | Search |
| `F3` | Comparison view |
| `F4` | Toggle diff |
| `F5` | Toggle 3D model |
| `F6` | Cycle theme |
| `F7` | Cycle reading frame |
| `F8` | Cycle view mode |
| `F9` | GC skew |
| `F10` | Analysis menu |

F11 is left to the terminal for fullscreen. F12 is bound in neither surface.

## Where the two surfaces differ, and why

The surfaces are not required to agree. They are required to differ for a
stated reason. A difference not listed here is drift.

| Action | Terminal | Web | Why |
|---|---|---|---|
| Command palette | `: or Ctrl+P` | `Ctrl/Cmd+K` | Ctrl+P is the browser print dialog and cannot be intercepted reliably; validateConflicts.ts flags it as reserved. Ctrl+K is the de facto web convention. The TUI has no such constraint and keeps the vim-style colon. |
| Search | `s or /` | `/` | The web app reserves plain letters for overlay shortcuts on the Alt layer and keeps only the vim-style slash. The TUI has spare single letters and offers both. |
| Comparison view | `w` | `c` | The TUI uses c for the DNA/amino-acid view cycle, so comparison took w. The web app cycles views with a toolbar control and leaves c free. |
| Analysis overlays | `plain letters (g, y, v, j, h, ...)` | `Alt layer (Alt+G, Alt+Y, ...)` | A browser page shares its single-letter namespace with find-as-you-type and with any focused input. The terminal does not, so the TUI can spend plain letters where the web app has to reach for a modifier. |
| Toggle DNA / amino-acid view | `c or n or Space` | `v or Space` | The web app spends c on the comparison overlay, so its view cycle moved to v. Pressing c in the web app opens comparison rather than switching view, which is the collision most likely to surprise a TUI user. |
| Packaging pressure gauge | `v` | `Shift+V` | v is the view-mode cycle in the web app, so the pressure gauge took the shifted key. In the terminal the view cycle is on c/n/Space and v was free. |
| Next / previous phage | `arrow keys` | `j / k as well as the arrows` | The web app follows the vim convention of j and k for down and up. The terminal spends both on overlays (j k-mer anomaly, k amino-acid key) and navigates with the arrows only. Pressing j or k in the terminal opens an overlay rather than changing phage. |
| Bracket keys | `previous / next gene` | `previous / next diff segment` | Both are "step through the interesting things", but the interesting things differ: the terminal has no diff navigation and the web app has no gene-jump binding. This is the collision least visible to the user, because both surfaces do something plausible. |
| Function keys | `F1-F10 bound` | `not bound` | F-keys are claimed by the browser and the OS (F1 help, F3 find next, F5 reload, F11 fullscreen, F12 devtools). The TUI binds F1-F10 because a terminal receives them as ordinary escape sequences. F11 is left alone in both, and F12 is bound in neither. |
