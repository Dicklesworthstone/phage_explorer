# Phage Explorer Web: A Cyberpunk Bioinformatics Experience

> **Vision**: Transform Phage Explorer from a terminal application into a browser-native experience that *amplifies* the cyberpunk aesthetic through GPU-accelerated visuals, while preserving—and enhancing—the keyboard-driven immediacy that makes the TUI feel alive.

This document provides a comprehensive blueprint for deploying Phage Explorer as a modern web application on Vercel, leveraging canvas/WebGL/WebGPU for stunning visualizations while maintaining sub-50ms interaction latency and the distinctive "hacker terminal" feel.

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Visual Language Deep-Dive](#visual-language-deep-dive)
3. [Target Architecture](#target-architecture)
4. [Interaction Model](#interaction-model)
5. [Data Architecture](#data-architecture)
6. [Rendering Pipeline](#rendering-pipeline)
7. [Component System](#component-system)
8. [Performance Architecture](#performance-architecture)
9. [Novel Web Capabilities](#novel-web-capabilities)
10. [Deployment Strategy](#deployment-strategy)
11. [Phased Execution Plan](#phased-execution-plan)
12. [Risk Mitigation](#risk-mitigation)
13. [Success Metrics](#success-metrics)
14. [Appendices](#appendices)

---

## Design Philosophy

### Core Principles

**1. Terminal Authenticity, Not Simulation**
We're not emulating a terminal—we're building a *native web experience* that channels the same energy. The distinction matters:
- A terminal emulator would impose constraints (character grid, 256 colors, no GPU)
- We adopt the *aesthetic vocabulary* (monospace, scan lines, phosphor glow) while exploiting web's superpowers

**2. Keyboard-First, Mouse-Aware**
Every action is keyboard-accessible. Mouse/touch are *accelerators*, not requirements:
- Keyboard: Primary interface, vim-inspired modal patterns
- Mouse: Direct manipulation shortcuts (click to focus, drag to pan)
- Touch: Gesture vocabulary mapping to keyboard equivalents

**3. Instant Feedback, Zero Perceived Latency**
Users should feel like they're editing a local file, not querying a server:
- Target: <16ms for visual feedback (one frame at 60fps)
- Target: <50ms for action completion
- Target: <150ms for complex computations (show progress indicator beyond this)

**4. Progressive Disclosure, Expert Ceiling**
- Novice: Essential controls visible, guided exploration
- Intermediate: Analysis overlays, keyboard shortcuts, customization
- Power: Command palette, macro recording, scripting, multi-phage workflows

**5. Offline-First, Cloud-Enhanced**
The app works completely offline after first load. Cloud features (collaboration, sync) are additive, not required.

---

## Visual Language Deep-Dive

### The Cyberpunk Aesthetic Stack

Our visual design draws from CRT monitors, 80s sci-fi interfaces, and modern cyberpunk media. Every visual element serves both aesthetic and functional purposes.

#### 1. Phosphor Glow System

**The Science**: CRT monitors produced light via phosphor excitation, creating characteristic glow halos around bright elements. We simulate this for that authentic retro-futuristic feel.

**Implementation**:
```glsl
// Phosphor bloom shader (simplified)
vec3 phosphorGlow(vec3 color, vec2 uv, sampler2D source) {
    vec3 bloom = vec3(0.0);
    float weights[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);

    for (int i = -4; i <= 4; i++) {
        for (int j = -4; j <= 4; j++) {
            vec2 offset = vec2(float(i), float(j)) * 0.002;
            float weight = weights[abs(i)] * weights[abs(j)];
            bloom += texture(source, uv + offset).rgb * weight;
        }
    }

    // Phosphor color temperature (slightly green-blue like old monitors)
    bloom *= vec3(0.9, 1.0, 0.95);

    return color + bloom * 0.4;
}
```

**Application Points**:
- Focused elements get a 2px glow halo in theme accent color
- Active overlays pulse gently (0.5Hz, ±10% intensity)
- Selection highlights use additive blending for that "lit up" look
- Gene highlights in the map glow based on function category

#### 2. Scanline Overlay

**Purpose**: Horizontal scanlines break up solid colors, adding texture and authenticity. They also improve readability by creating visual rhythm.

**Implementation**:
```css
.scanlines::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 1px,
    rgba(0, 0, 0, 0.15) 1px,
    rgba(0, 0, 0, 0.15) 2px
  );
  pointer-events: none;
  mix-blend-mode: multiply;
}

/* Animate for CRT flicker effect (subtle, reduced-motion respecting) */
@media (prefers-reduced-motion: no-preference) {
  .scanlines--animated::after {
    animation: scanline-flicker 8s linear infinite;
  }
}

@keyframes scanline-flicker {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.97; }
  51% { opacity: 1; }
  52% { opacity: 0.98; }
}
```

**Density Options** (user preference):
- `dense`: 1px lines, 2px repeat (classic CRT)
- `subtle`: 1px lines, 4px repeat (modern interpretation)
- `off`: No scanlines (accessibility/preference)

#### 3. Chromatic Aberration

**The Effect**: Color fringing at edges, mimicking imperfect optics or CRT convergence issues. Used sparingly for emphasis.

**Implementation** (CSS filter for simple cases):
```css
.chromatic-aberration {
  filter: url(#chromatic-aberration-filter);
}

/* SVG filter definition */
<filter id="chromatic-aberration-filter">
  <feColorMatrix type="matrix"
    values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
    result="red"/>
  <feOffset in="red" dx="1" dy="0" result="red-shifted"/>

  <feColorMatrix in="SourceGraphic" type="matrix"
    values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
    result="green"/>

  <feColorMatrix in="SourceGraphic" type="matrix"
    values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
    result="blue"/>
  <feOffset in="blue" dx="-1" dy="0" result="blue-shifted"/>

  <feBlend mode="screen" in="red-shifted" in2="green"/>
  <feBlend mode="screen" in2="blue-shifted"/>
</filter>
```

**Usage**:
- Error messages (strong aberration, 3px offset)
- Warnings (medium, 2px)
- Focus transitions (subtle, 1px, animated)
- Never on text being read (readability first)

#### 4. Matrix Rain / Data Cascade

**Purpose**: Background visual indicating data processing, genome streaming, or system activity. Creates visual interest without distracting from content.

**Implementation** (Canvas-based for performance):
```typescript
interface RainColumn {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  opacity: number;
}

class MatrixRainEffect {
  private columns: RainColumn[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Use actual nucleotide/amino acid characters for thematic coherence
  private charSets = {
    dna: 'ACGT'.split(''),
    amino: 'ACDEFGHIKLMNPQRSTVWY*'.split(''),
    mixed: 'ACGT∆∇◊○●□■◆'.split(''),
  };

  render(deltaTime: number) {
    // Fade existing content (trail effect)
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw columns
    this.ctx.font = '14px "JetBrains Mono", monospace';

    for (const col of this.columns) {
      // Leading character: bright
      this.ctx.fillStyle = `rgba(0, 255, 136, ${col.opacity})`;
      this.ctx.fillText(col.chars[0], col.x, col.y);

      // Trailing characters: progressively dimmer
      for (let i = 1; i < col.chars.length; i++) {
        const fade = 1 - (i / col.chars.length);
        this.ctx.fillStyle = `rgba(0, 255, 136, ${col.opacity * fade * 0.5})`;
        this.ctx.fillText(col.chars[i], col.x, col.y - i * 16);
      }

      // Update position
      col.y += col.speed * deltaTime;
      if (col.y > this.canvas.height + 100) {
        this.resetColumn(col);
      }
    }
  }
}
```

**Trigger Contexts**:
- Database loading (continuous flow)
- WASM computation (burst patterns)
- Phage switching (cascade transition)
- Background idle (very sparse, 5% density)

#### 5. Terminal Typography

**Font Stack** (in preference order):
```css
--font-mono:
  'Berkeley Mono',           /* Premium, if licensed */
  'JetBrains Mono',          /* Excellent, free */
  'Fira Code',               /* Good ligatures */
  'Source Code Pro',         /* Google Fonts fallback */
  'SF Mono',                 /* macOS */
  'Cascadia Code',           /* Windows */
  'Menlo',                   /* macOS fallback */
  'Consolas',                /* Windows fallback */
  monospace;
```

**Typography Scale**:
```css
--text-xs: 10px;    /* Gene labels, dense data */
--text-sm: 12px;    /* Secondary info, hints */
--text-base: 14px;  /* Primary content, sequence */
--text-lg: 16px;    /* Headers, focused elements */
--text-xl: 20px;    /* Panel titles */
--text-2xl: 24px;   /* App title, major sections */

/* Line heights optimized for scanline alignment */
--leading-tight: 1.2;
--leading-normal: 1.5;
--leading-relaxed: 1.75;
```

**Character Rendering**:
- Subpixel antialiasing disabled in sequence views (crisp pixels)
- `text-rendering: geometricPrecision` for alignment
- `font-feature-settings: "zero" 1, "ss01" 1` for slashed zero and code ligatures

#### 6. Color System

**Palette Architecture**:
```typescript
interface ThemePalette {
  // Core semantic colors
  background: {
    base: string;      // Deepest background (#0a0a0f)
    surface: string;   // Panels, cards (#12121a)
    elevated: string;  // Modals, dropdowns (#1a1a25)
    overlay: string;   // Transparent overlays (rgba)
  };

  // Accent spectrum (theme-dependent)
  accent: {
    primary: string;   // Main action color (cyan/green/magenta)
    secondary: string; // Supporting accent
    tertiary: string;  // Subtle highlights
  };

  // Semantic status
  status: {
    success: string;   // Positive (#00ff88)
    warning: string;   // Caution (#ffcc00)
    error: string;     // Problem (#ff3366)
    info: string;      // Neutral info (#00ccff)
  };

  // Text hierarchy
  text: {
    primary: string;   // Main content (#e0e0e0)
    secondary: string; // Labels, hints (#888899)
    muted: string;     // Disabled, decorative (#444455)
    inverse: string;   // On accent backgrounds (#000000)
  };

  // Biological semantics
  nucleotide: Record<'A' | 'C' | 'G' | 'T' | 'N', { fg: string; bg: string }>;
  aminoAcid: Record<AminoAcid, { fg: string; bg: string }>;

  // Data visualization gradient
  gradient: {
    stops: string[];   // 5-7 color stops for heatmaps
    anomaly: string;   // Outlier highlight
  };

  // Effect colors
  glow: string;        // Bloom color (usually matches primary)
  scanline: string;    // Scanline tint (subtle dark)
}
```

**Theme Presets** (expanded from TUI):
1. **Classic** - Green/cyan on deep navy, original bioinformatics feel
2. **Cyberpunk** - Magenta/cyan neon on black, Blade Runner aesthetic
3. **Matrix** - Pure green phosphor monochrome
4. **Ocean** - Teal/aqua palette, calming but focused
5. **Sunset** - Warm orange/pink gradients, late-night coding
6. **Forest** - Earth tones, organic feel for biological data
7. **Monochrome** - Grayscale with gold accents, minimal distraction
8. **Pastel** - Light mode alternative, soft colors (accessibility)
9. **High Contrast** - Maximum contrast ratios (WCAG AAA)
10. **Custom** - User-defined palette builder

#### 7. Animation System

**Timing Functions**:
```css
/* Snappy, mechanical feel */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out-expo: cubic-bezier(0.87, 0, 0.13, 1);

/* Glitchy, digital feel */
--ease-steps: steps(8, end);
--ease-glitch: steps(3, jump-both);

/* Organic, biological feel (for simulations) */
--ease-out-back: cubic-bezier(0.34, 1.56, 0.64, 1);
```

**Duration Scale**:
```css
--duration-instant: 0ms;      /* Keyboard feedback */
--duration-fast: 50ms;        /* Micro-interactions */
--duration-normal: 150ms;     /* Panel transitions */
--duration-slow: 300ms;       /* Major state changes */
--duration-emphasis: 500ms;   /* Attention-grabbing */
```

**Standard Animations**:
```css
/* Element appearance (fade + slight scale) */
@keyframes appear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* Glitch effect for errors/warnings */
@keyframes glitch {
  0%, 100% { transform: translate(0); }
  20% { transform: translate(-2px, 1px); }
  40% { transform: translate(2px, -1px); }
  60% { transform: translate(-1px, 2px); }
  80% { transform: translate(1px, -2px); }
}

/* Pulse for active/processing states */
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 5px var(--glow-color); }
  50% { box-shadow: 0 0 15px var(--glow-color), 0 0 30px var(--glow-color); }
}

/* Typewriter effect for command feedback */
@keyframes typewriter {
  from { width: 0; }
  to { width: 100%; }
}
```

---

## Target Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                     │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                         React Application                          │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │ │
│  │  │   UI Shell   │  │    State     │  │    Rendering Engine      │ │ │
│  │  │  - Layout    │  │   (Zustand)  │  │  - Canvas/WebGL/WebGPU  │ │ │
│  │  │  - Routing   │◄─┤  - Phages    │──┤  - Sequence Grid        │ │ │
│  │  │  - Keyboard  │  │  - Overlays  │  │  - Gene Map             │ │ │
│  │  │  - Commands  │  │  - Sims      │  │  - Sparklines           │ │ │
│  │  └──────────────┘  └──────┬───────┘  │  - 3D Renderer          │ │ │
│  │                           │          └──────────────────────────┘ │ │
│  │  ┌────────────────────────▼────────────────────────────────────┐  │ │
│  │  │                    Core Packages (Shared)                    │  │ │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐ │  │ │
│  │  │  │   @core    │  │   @state   │  │    @wasm-compute       │ │  │ │
│  │  │  │  - Types   │  │  - Store   │  │  - Rust→WASM kernels  │ │  │ │
│  │  │  │  - Themes  │  │  - Actions │  │  - GC skew, k-mer     │ │  │ │
│  │  │  │  - Grid    │  │  - Persist │  │  - Complexity, etc.   │ │  │ │
│  │  │  └────────────┘  └────────────┘  └────────────────────────┘ │  │ │
│  │  └─────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐ │
│  │   Web Workers       │  │   Service Worker    │  │   IndexedDB     │ │
│  │  - Heavy compute    │  │  - Offline cache    │  │  - SQLite DB    │ │
│  │  - WASM execution   │  │  - Asset precache   │  │  - User prefs   │ │
│  │  - Simulation runs  │  │  - Background sync  │  │  - Sim snapshots│ │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Static Assets + Optional Edge Functions
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              VERCEL                                      │
│  ┌────────────────────────┐  ┌────────────────────────────────────────┐ │
│  │    Static Hosting      │  │         Edge Functions                 │ │
│  │  - JS/CSS bundles      │  │  - Telemetry ingestion                │ │
│  │  - WASM modules        │  │  - Feature flags                      │ │
│  │  - phage.db (compressed│  │  - Share URL generation               │ │
│  │  - Glyph atlases       │  │  - Collaborative session init         │ │
│  └────────────────────────┘  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/
├── core/                 # Shared types, themes, utilities (unchanged)
├── state/                # Zustand store (web-safe persistence layer added)
├── wasm-compute/         # Rust→WASM computation kernels (unchanged)
├── db-runtime/           # Database access layer
│   ├── src/
│   │   ├── node.ts       # Node/Bun adapter (existing)
│   │   ├── browser.ts    # sql.js adapter (new)
│   │   └── index.ts      # Runtime detection + unified API
│   └── wasm/             # sql.js WASM binary
├── web/                  # NEW: Web application
│   ├── src/
│   │   ├── app/          # React app structure
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   └── phage/[id]/page.tsx
│   │   ├── components/   # UI components
│   │   │   ├── chrome/   # Layout, navigation
│   │   │   ├── sequence/ # Sequence grid, viewers
│   │   │   ├── overlays/ # Analysis overlays
│   │   │   ├── panels/   # Drawers, modals
│   │   │   └── primitives/ # Buttons, inputs, etc.
│   │   ├── rendering/    # Canvas/WebGL renderers
│   │   │   ├── sequence-canvas.ts
│   │   │   ├── gene-map-canvas.ts
│   │   │   ├── sparkline-canvas.ts
│   │   │   └── shaders/  # GLSL shaders
│   │   ├── hooks/        # React hooks
│   │   ├── workers/      # Web Workers
│   │   └── service-worker/ # SW for offline
│   ├── public/           # Static assets
│   │   ├── phage.db.br   # Brotli-compressed SQLite
│   │   └── fonts/        # Self-hosted fonts
│   └── vite.config.ts    # Bun + Vite config
└── tui/                  # Existing TUI (preserved)
```

### Technology Decisions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| **Framework** | React 19 + Vite | Familiar, excellent tooling, concurrent features for smooth updates |
| **Routing** | React Router 7 or file-based (Vite) | Simple client-side routing, no SSR needed |
| **State** | Zustand (existing) | Already in use, minimal bundle, works in browser |
| **Styling** | CSS Modules + CSS Variables | Scoped styles, theme tokens, zero runtime |
| **Canvas** | Raw Canvas 2D + WebGL | Maximum control for custom aesthetics |
| **WebGL** | regl (thin wrapper) | Small footprint, direct GL access |
| **WebGPU** | wgpu-matrix + custom | Future-proof, massive parallelism (feature flag) |
| **WASM** | Existing Rust kernels | Reuse compute code, near-native speed |
| **Database** | sql.js (SQLite WASM) | Use existing phage.db, no backend needed |
| **Storage** | IndexedDB (via idb) | Cache DB, preferences, sim snapshots |
| **Workers** | Comlink | Type-safe worker communication |
| **Build** | Bun + Vite | Fast builds, existing toolchain |
| **Deploy** | Vercel | Static hosting, edge functions, easy |

---

## Interaction Model

### Keyboard-First Design

The keyboard is the primary input device. Every feature is accessible without a mouse.

#### Modal System (Vim-Inspired)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NORMAL MODE (default)                        │
│  Navigation, viewing, quick actions                                 │
│  ─────────────────────────────────────────────────────────────────  │
│  ↑↓ or j/k    Switch phage                                         │
│  ←→ or h/l    Scroll sequence                                      │
│  g g          Jump to start                                         │
│  G            Jump to end                                           │
│  / or s       Enter SEARCH mode                                     │
│  :            Enter COMMAND mode                                    │
│  v            Enter VISUAL mode (selection)                         │
│  i            Enter INSERT mode (annotations, future)              │
│  ?            Show help overlay                                     │
└─────────────────────────────────────────────────────────────────────┘
         │              │               │               │
         ▼              ▼               ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ SEARCH MODE │ │COMMAND MODE │ │ VISUAL MODE │ │ INSERT MODE │
│             │ │             │ │             │ │             │
│ Type query  │ │ :theme dark │ │ Select      │ │ Add notes   │
│ ↑↓ navigate │ │ :export png │ │ region for  │ │ (future)    │
│ Enter select│ │ :sim start  │ │ analysis    │ │             │
│ Esc cancel  │ │ Tab complete│ │ y yank      │ │             │
│             │ │ Esc cancel  │ │ Esc cancel  │ │ Esc exit    │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

#### Hotkey Map (Comprehensive)

**Navigation**
| Key | Action | Context |
|-----|--------|---------|
| `↑` / `k` | Previous phage | Global |
| `↓` / `j` | Next phage | Global |
| `←` / `h` | Scroll left (10bp/3aa) | Sequence |
| `→` / `l` | Scroll right (10bp/3aa) | Sequence |
| `Shift+←` | Scroll left (100bp/30aa) | Sequence |
| `Shift+→` | Scroll right (100bp/30aa) | Sequence |
| `Ctrl+←` | Jump to previous gene | Sequence |
| `Ctrl+→` | Jump to next gene | Sequence |
| `gg` | Jump to position 0 | Sequence |
| `G` | Jump to end | Sequence |
| `{number}G` | Jump to position | Sequence |
| `Ctrl+g` | Show position info | Global |
| `zz` | Center current position | Sequence |

**View Controls**
| Key | Action | Context |
|-----|--------|---------|
| `Space` | Toggle DNA ↔ Amino Acid view | Global |
| `1` `2` `3` | Set reading frame | AA mode |
| `f` | Cycle reading frame | AA mode |
| `d` | Toggle diff mode | With comparison |
| `t` | Cycle theme | Global |
| `T` | Open theme picker | Global |
| `Ctrl++` / `=` | Zoom in | Sequence |
| `Ctrl+-` | Zoom out | Sequence |
| `Ctrl+0` | Reset zoom | Sequence |
| `m` | Toggle 3D model | Global |
| `M` | 3D model fullscreen | Global |
| `z` | Toggle fullscreen sequence | Global |

**Overlays (Layer 1)**
| Key | Action | Notes |
|-----|--------|-------|
| `g` | GC content / GC skew | Basic |
| `x` | Sequence complexity | Intermediate |
| `b` | DNA bendability | Intermediate |
| `p` | Promoter / RBS signals | Intermediate |
| `r` | Repeat finder | Intermediate |
| `J` | K-mer anomaly | Power |
| `L` | Module detection | Power |
| `V` | Selection pressure (dN/dS) | Power |
| `Y` | Transcription flow | Power |
| `0` | Clear all overlays | Global |

**Panels (Layer 2-4)**
| Key | Action | Notes |
|-----|--------|-------|
| `a` / `A` | Analysis menu | Full menu drawer |
| `S` (Shift) | Simulation hub | Simulation launcher |
| `:` / `Ctrl+p` | Command palette | Global command bar |
| `w` / `W` | Comparison panel | Multi-phage compare |
| `/` / `s` | Search | Fuzzy search all |
| `?` | Help overlay | Hotkey reference |
| `Ctrl+k` | Quick command | Alternative palette |
| `Escape` | Close/cancel | Context-dependent |

**Actions**
| Key | Action | Notes |
|-----|--------|-------|
| `y` | Yank (copy) selection | With visual selection |
| `Ctrl+c` | Copy current view | Screenshot to clipboard |
| `Ctrl+s` | Save/export | Opens export dialog |
| `Ctrl+z` | Undo (where applicable) | Navigation history |
| `Ctrl+Shift+z` | Redo | Navigation history |
| `.` | Repeat last action | Vim-style |
| `q{a-z}` | Record macro | Power feature |
| `@{a-z}` | Play macro | Power feature |

#### Command Palette

The command palette (`:` or `Ctrl+P`) provides access to all functionality with fuzzy search:

```
┌─────────────────────────────────────────────────────────────────────┐
│ :                                                                    │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│   > theme dark                                                       │
│   ─────────────────────────────────────────────────────────────────  │
│   ● Theme: Set Dark Mode                               Cyberpunk     │
│   ○ Theme: Cycle Themes                                t             │
│   ○ Theme: Open Theme Picker                           T             │
│   ○ Analysis: GC Skew Overlay                          g             │
│   ○ Simulation: Ribosome Traffic                       S → select    │
│                                                                      │
│   ─────────────────────────────────────────────────────────────────  │
│   ↑↓ navigate  Enter select  Tab complete  Esc cancel               │
└─────────────────────────────────────────────────────────────────────┘
```

**Command Categories**:
- `theme:` - Theme switching and customization
- `overlay:` - Toggle analysis overlays
- `sim:` - Start/stop simulations
- `export:` - Export data, images, videos
- `go:` - Navigation jumps
- `set:` - Preference changes
- `phage:` - Phage selection and comparison
- `help:` - Documentation access

### Mouse & Touch

Mouse and touch are accelerators, not requirements. They map to keyboard equivalents:

| Gesture | Action | Keyboard Equivalent |
|---------|--------|---------------------|
| Click on phage | Select phage | `↓`/`↑` then `Enter` |
| Click on sequence | Jump to position | `{number}G` |
| Scroll wheel | Scroll sequence | `←`/`→` |
| Shift+scroll | Zoom | `Ctrl++`/`Ctrl+-` |
| Drag on sequence | Pan | `←`/`→` held |
| Click overlay chip | Toggle overlay | `g`/`x`/etc |
| Right-click | Context menu | `:` at position |
| Double-click gene | Focus gene detail | `Enter` on gene |
| Pinch (touch) | Zoom | `Ctrl++`/`Ctrl+-` |
| Two-finger pan (touch) | Scroll | Arrow keys |

---

## Data Architecture

### Browser SQLite Strategy

**The Problem**: We have a rich SQLite database (`phage.db`) with phage genomes, genes, and precomputed data. How do we use it in the browser efficiently?

**Solution**: sql.js (SQLite compiled to WebAssembly) with aggressive caching.

#### Build Pipeline

```
phage.db (source, ~50MB)
    │
    ▼
┌─────────────────────────────────────────┐
│         Build Script                     │
│  1. Copy phage.db                       │
│  2. Strip unused tables/columns         │
│  3. Optimize (VACUUM, reindex)          │
│  4. Compress with Brotli (quality 11)   │
│  5. Split into chunks (optional, 2MB)   │
│  6. Generate manifest.json              │
└─────────────────────────────────────────┘
    │
    ▼
public/
├── phage.db.br          (or chunks/)
├── phage.db.manifest.json
└── phage.db.hash        (for cache invalidation)
```

#### Runtime Loading Strategy

```typescript
class PhageDatabaseLoader {
  private static instance: PhageDatabaseLoader;
  private db: SqlJsDatabase | null = null;

  async initialize(): Promise<void> {
    // 1. Check IndexedDB cache first
    const cached = await this.checkCache();
    if (cached) {
      this.db = await this.loadFromCache(cached);
      // Background refresh check
      this.checkForUpdates();
      return;
    }

    // 2. Fetch compressed database
    const response = await fetch('/phage.db.br', {
      headers: { 'Accept-Encoding': 'br, gzip' }
    });

    // 3. Decompress (browser handles Brotli automatically)
    const buffer = await response.arrayBuffer();

    // 4. Initialize sql.js
    const SQL = await initSqlJs({
      locateFile: file => `/wasm/${file}`
    });

    this.db = new SQL.Database(new Uint8Array(buffer));

    // 5. Cache in IndexedDB for next time
    await this.saveToCache(buffer);

    // 6. Setup prepared statements for common queries
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.statements = {
      getPhage: this.db.prepare(`
        SELECT id, name, family, host, genome_length, gc_content
        FROM phages WHERE id = ?
      `),
      getGenes: this.db.prepare(`
        SELECT id, name, locus_tag, start_pos, end_pos, strand, product
        FROM genes WHERE phage_id = ? ORDER BY start_pos
      `),
      getSequence: this.db.prepare(`
        SELECT sequence FROM sequences WHERE phage_id = ?
      `),
      // ... more statements
    };
  }
}
```

#### Lazy Loading & Streaming

For large datasets, we implement lazy loading:

```typescript
interface LazySequenceLoader {
  // Load sequence in chunks on demand
  getChunk(phageId: string, start: number, length: number): Promise<string>;

  // Preload ahead of scroll position
  prefetch(phageId: string, position: number, direction: 'forward' | 'backward'): void;

  // Get cached extent
  getCachedRange(phageId: string): { start: number; end: number } | null;
}

class StreamingSequenceLoader implements LazySequenceLoader {
  private cache = new Map<string, Map<number, string>>(); // phageId -> chunkIndex -> data
  private chunkSize = 10000; // 10kb chunks

  async getChunk(phageId: string, start: number, length: number): Promise<string> {
    const startChunk = Math.floor(start / this.chunkSize);
    const endChunk = Math.floor((start + length) / this.chunkSize);

    const chunks: string[] = [];
    for (let i = startChunk; i <= endChunk; i++) {
      let chunk = this.cache.get(phageId)?.get(i);
      if (!chunk) {
        chunk = await this.fetchChunk(phageId, i);
        this.cacheChunk(phageId, i, chunk);
      }
      chunks.push(chunk);
    }

    const fullData = chunks.join('');
    const offset = start - (startChunk * this.chunkSize);
    return fullData.slice(offset, offset + length);
  }

  prefetch(phageId: string, position: number, direction: 'forward' | 'backward'): void {
    const currentChunk = Math.floor(position / this.chunkSize);
    const prefetchCount = 3;

    for (let i = 1; i <= prefetchCount; i++) {
      const targetChunk = direction === 'forward'
        ? currentChunk + i
        : currentChunk - i;

      if (targetChunk >= 0 && !this.cache.get(phageId)?.has(targetChunk)) {
        // Low priority fetch
        requestIdleCallback(() => this.fetchChunk(phageId, targetChunk));
      }
    }
  }
}
```

### State Persistence

Zustand store with web-safe persistence:

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface WebPhageStore extends PhageStore {
  // Web-specific additions
  recentPhages: string[];
  viewHistory: NavigationEntry[];
  savedViews: SavedView[];
}

const useWebPhageStore = create<WebPhageStore>()(
  persist(
    (set, get) => ({
      // ... existing store logic

      // Web-specific
      recentPhages: [],
      addToRecent: (id: string) => set(state => ({
        recentPhages: [id, ...state.recentPhages.filter(p => p !== id)].slice(0, 20)
      })),

      viewHistory: [],
      pushHistory: (entry: NavigationEntry) => set(state => ({
        viewHistory: [...state.viewHistory.slice(-99), entry]
      })),

      savedViews: [],
      saveCurrentView: (name: string) => {
        const snapshot = get().createSnapshot();
        set(state => ({
          savedViews: [...state.savedViews, { name, ...snapshot, createdAt: Date.now() }]
        }));
      },
    }),
    {
      name: 'phage-explorer-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist these fields
        currentThemeId: state.currentTheme.id,
        experienceLevel: state.experienceLevel,
        recentPhages: state.recentPhages,
        savedViews: state.savedViews,
        preferences: state.preferences,
      }),
    }
  )
);
```

### Offline Strategy

Service Worker for complete offline support:

```typescript
// service-worker.ts
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// Precache app shell (injected at build time)
precacheAndRoute(self.__WB_MANIFEST);

// Database file - cache first, update in background
registerRoute(
  ({ url }) => url.pathname.endsWith('.db.br'),
  new StaleWhileRevalidate({
    cacheName: 'phage-database',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 1,
        maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
      }),
    ],
  })
);

// WASM files - cache first (immutable)
registerRoute(
  ({ url }) => url.pathname.endsWith('.wasm'),
  new CacheFirst({
    cacheName: 'wasm-modules',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  })
);

// Fonts - cache first
registerRoute(
  ({ url }) => url.pathname.startsWith('/fonts/'),
  new CacheFirst({
    cacheName: 'fonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// API calls (if any) - network first with fallback
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 3,
  })
);

// Handle offline page
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html'))
    );
  }
});
```

---

## Rendering Pipeline

### Sequence Grid Renderer

The sequence grid is the most performance-critical component. We use Canvas 2D with careful optimization.

#### Architecture

```typescript
interface SequenceGridRenderer {
  // Core rendering
  render(state: SequenceGridState): void;

  // Lifecycle
  initialize(canvas: HTMLCanvasElement): void;
  dispose(): void;

  // Interaction
  hitTest(x: number, y: number): HitTestResult | null;

  // Optimization
  setDirtyRegion(region: Rect): void;
  invalidate(): void;
}

class CanvasSequenceGridRenderer implements SequenceGridRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreen: OffscreenCanvas;
  private offscreenCtx: OffscreenCanvasRenderingContext2D;

  // Glyph cache for fast text rendering
  private glyphAtlas: GlyphAtlas;

  // Dirty tracking for partial updates
  private dirtyRegions: Rect[] = [];
  private fullRedrawNeeded = true;

  // Rendering state
  private lastState: SequenceGridState | null = null;
  private rafId: number | null = null;

  initialize(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {
      alpha: false,  // No transparency needed
      desynchronized: true,  // Allow async rendering
    })!;

    // Setup high-DPI rendering
    this.setupHiDPI();

    // Create offscreen buffer for double-buffering
    this.offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    this.offscreenCtx = this.offscreen.getContext('2d')!;

    // Initialize glyph atlas
    this.glyphAtlas = new GlyphAtlas({
      font: '14px "JetBrains Mono", monospace',
      characters: 'ACGTN*' + 'ACDEFGHIKLMNPQRSTVWY',
      cellSize: { width: 10, height: 18 },
    });

    // Setup resize observer
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
  }

  private setupHiDPI(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    this.ctx.scale(dpr, dpr);

    // Store for coordinate conversion
    this.dpr = dpr;
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
  }

  render(state: SequenceGridState): void {
    // Cancel pending frame
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }

    // Schedule render on next frame
    this.rafId = requestAnimationFrame(() => {
      this.doRender(state);
      this.rafId = null;
    });
  }

  private doRender(state: SequenceGridState): void {
    const { sequence, scrollPosition, viewMode, theme, width, height } = state;

    // Calculate visible range
    const cellWidth = 10;
    const cellHeight = 18;
    const cols = Math.ceil(width / cellWidth);
    const rows = Math.ceil(height / cellHeight);

    // Get sequence slice
    const startPos = scrollPosition;
    const endPos = Math.min(startPos + (cols * rows), sequence.length);
    const visibleSequence = sequence.slice(startPos, endPos);

    // Clear with background color
    this.offscreenCtx.fillStyle = theme.colors.background;
    this.offscreenCtx.fillRect(0, 0, width, height);

    // Render sequence using glyph atlas (batched)
    const colorBatches = this.batchByColor(visibleSequence, viewMode, theme);

    for (const [color, positions] of colorBatches) {
      this.offscreenCtx.fillStyle = color;

      for (const { char, x, y, bgColor } of positions) {
        // Draw background
        this.offscreenCtx.fillStyle = bgColor;
        this.offscreenCtx.fillRect(x, y, cellWidth, cellHeight);

        // Draw character from atlas
        this.glyphAtlas.drawGlyph(this.offscreenCtx, char, x, y);
      }
    }

    // Apply post-processing (scanlines, etc.)
    this.applyPostProcessing(this.offscreenCtx, state);

    // Copy to main canvas
    this.ctx.drawImage(this.offscreen, 0, 0);

    // Update state reference
    this.lastState = state;
    this.fullRedrawNeeded = false;
    this.dirtyRegions = [];
  }

  private batchByColor(
    sequence: string,
    viewMode: 'dna' | 'aa',
    theme: Theme
  ): Map<string, CharPosition[]> {
    const batches = new Map<string, CharPosition[]>();
    const colorGetter = viewMode === 'dna'
      ? (c: string) => theme.nucleotides[c]
      : (c: string) => theme.aminoAcids[c];

    for (let i = 0; i < sequence.length; i++) {
      const char = sequence[i];
      const colors = colorGetter(char);

      // Group by foreground color for batched text rendering
      const batch = batches.get(colors.fg) || [];
      batch.push({
        char,
        x: (i % this.cols) * this.cellWidth,
        y: Math.floor(i / this.cols) * this.cellHeight,
        bgColor: colors.bg,
      });
      batches.set(colors.fg, batch);
    }

    return batches;
  }
}
```

#### Glyph Atlas

Pre-rendered character sprites for fast text drawing:

```typescript
class GlyphAtlas {
  private atlas: HTMLCanvasElement;
  private glyphPositions: Map<string, { x: number; y: number }>;

  constructor(options: GlyphAtlasOptions) {
    const { font, characters, cellSize } = options;

    // Create atlas canvas
    const cols = Math.ceil(Math.sqrt(characters.length));
    const rows = Math.ceil(characters.length / cols);

    this.atlas = document.createElement('canvas');
    this.atlas.width = cols * cellSize.width;
    this.atlas.height = rows * cellSize.height;

    const ctx = this.atlas.getContext('2d')!;
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff'; // Will be composited with color

    // Render each character
    this.glyphPositions = new Map();
    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      const x = (i % cols) * cellSize.width;
      const y = Math.floor(i / cols) * cellSize.height;

      ctx.fillText(char, x + 1, y + 1); // 1px padding
      this.glyphPositions.set(char, { x, y });
    }
  }

  drawGlyph(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    char: string,
    destX: number,
    destY: number
  ): void {
    const pos = this.glyphPositions.get(char);
    if (!pos) return;

    ctx.drawImage(
      this.atlas,
      pos.x, pos.y, this.cellWidth, this.cellHeight,
      destX, destY, this.cellWidth, this.cellHeight
    );
  }
}
```

### WebGL Shader Effects

For post-processing effects (phosphor glow, scanlines, chromatic aberration):

```glsl
// phosphor-bloom.frag
precision mediump float;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uBloomIntensity;
uniform vec3 uGlowColor;

varying vec2 vTexCoord;

void main() {
    vec4 color = texture2D(uTexture, vTexCoord);

    // Gaussian blur for bloom
    vec4 bloom = vec4(0.0);
    float weights[5];
    weights[0] = 0.227027;
    weights[1] = 0.1945946;
    weights[2] = 0.1216216;
    weights[3] = 0.054054;
    weights[4] = 0.016216;

    vec2 texOffset = 1.0 / uResolution;

    for (int i = -4; i <= 4; i++) {
        for (int j = -4; j <= 4; j++) {
            vec2 offset = vec2(float(i), float(j)) * texOffset * 2.0;
            float weight = weights[abs(i)] * weights[abs(j)];
            bloom += texture2D(uTexture, vTexCoord + offset) * weight;
        }
    }

    // Add bloom with glow color tint
    vec3 glowContribution = bloom.rgb * uGlowColor * uBloomIntensity;

    gl_FragColor = vec4(color.rgb + glowContribution, 1.0);
}

// scanlines.frag
precision mediump float;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uScanlineIntensity;
uniform float uScanlineCount;

varying vec2 vTexCoord;

void main() {
    vec4 color = texture2D(uTexture, vTexCoord);

    // Scanline pattern
    float scanline = sin(vTexCoord.y * uResolution.y * 3.14159 * uScanlineCount);
    scanline = (scanline + 1.0) * 0.5; // Normalize to 0-1
    scanline = mix(1.0, scanline, uScanlineIntensity);

    // Apply with slight color shift for CRT feel
    vec3 scanlined = color.rgb * scanline;

    // Subtle vignette
    vec2 center = vTexCoord - 0.5;
    float vignette = 1.0 - dot(center, center) * 0.5;

    gl_FragColor = vec4(scanlined * vignette, 1.0);
}

// chromatic-aberration.frag
precision mediump float;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uAberrationAmount;

varying vec2 vTexCoord;

void main() {
    vec2 direction = vTexCoord - 0.5;
    float dist = length(direction);
    vec2 offset = direction * dist * uAberrationAmount;

    float r = texture2D(uTexture, vTexCoord + offset).r;
    float g = texture2D(uTexture, vTexCoord).g;
    float b = texture2D(uTexture, vTexCoord - offset).b;

    gl_FragColor = vec4(r, g, b, 1.0);
}
```

### 3D Molecular Renderer

WebGL-based 3D visualization for protein structures:

```typescript
interface MolecularRenderer {
  initialize(canvas: HTMLCanvasElement): void;
  loadStructure(pdb: string | ArrayBuffer): Promise<void>;
  setRenderMode(mode: 'wireframe' | 'cartoon' | 'surface' | 'ascii'): void;
  setRotation(quaternion: Quaternion): void;
  render(): void;
}

class WebGLMolecularRenderer implements MolecularRenderer {
  private gl: WebGL2RenderingContext;
  private programs: Map<string, WebGLProgram>;
  private buffers: MolecularBuffers;

  // ASCII rendering mode for cyberpunk aesthetic
  private asciiFramebuffer: WebGLFramebuffer;
  private asciiTexture: WebGLTexture;
  private asciiCharacters = ' .:-=+*#%@';

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
    })!;

    // Compile shader programs
    this.programs = new Map([
      ['wireframe', this.compileProgram(wireframeVert, wireframeFrag)],
      ['cartoon', this.compileProgram(cartoonVert, cartoonFrag)],
      ['surface', this.compileProgram(surfaceVert, surfaceFrag)],
      ['ascii-prepass', this.compileProgram(asciiPrepassVert, asciiPrepassFrag)],
      ['ascii-render', this.compileProgram(asciiRenderVert, asciiRenderFrag)],
    ]);

    // Setup ASCII rendering pipeline
    this.setupAsciiPipeline();
  }

  private setupAsciiPipeline(): void {
    const gl = this.gl;

    // Create framebuffer for first pass (renders to texture)
    this.asciiFramebuffer = gl.createFramebuffer()!;
    this.asciiTexture = gl.createTexture()!;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.asciiFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.asciiTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      this.canvas.width / 8, this.canvas.height / 16, // ASCII cell size
      0, gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      this.asciiTexture, 0
    );
  }

  render(): void {
    const gl = this.gl;

    if (this.renderMode === 'ascii') {
      // First pass: render to low-res framebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.asciiFramebuffer);
      gl.viewport(0, 0, this.asciiWidth, this.asciiHeight);
      this.renderGeometry(this.programs.get('ascii-prepass')!);

      // Second pass: sample and render ASCII characters
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.renderAscii();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.renderGeometry(this.programs.get(this.renderMode)!);
    }
  }

  private renderAscii(): void {
    // Sample the prepass texture and draw ASCII characters
    // Using a fragment shader that samples brightness and maps to character
    const gl = this.gl;
    const program = this.programs.get('ascii-render')!;

    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, this.asciiTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uPrepass'), 0);
    gl.uniform1fv(
      gl.getUniformLocation(program, 'uCharThresholds'),
      this.calculateCharThresholds()
    );

    // Render full-screen quad
    this.drawFullscreenQuad();
  }
}
```

---

## Component System

### Primitive Components

Reusable UI primitives with cyberpunk styling:

```tsx
// Button with glow effect
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  size: 'sm' | 'md' | 'lg';
  glow?: boolean;
  hotkey?: string;
  children: React.ReactNode;
  onClick: () => void;
}

const Button: React.FC<ButtonProps> = ({
  variant,
  size,
  glow = false,
  hotkey,
  children,
  onClick,
}) => {
  return (
    <button
      className={cn(
        styles.button,
        styles[variant],
        styles[size],
        glow && styles.glow
      )}
      onClick={onClick}
    >
      {children}
      {hotkey && (
        <kbd className={styles.hotkey}>{hotkey}</kbd>
      )}
    </button>
  );
};

// CSS Module
.button {
  font-family: var(--font-mono);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out-expo);

  &:hover {
    border-color: var(--accent-primary);
    background: var(--elevated);
  }

  &:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }
}

.glow {
  box-shadow:
    0 0 5px var(--glow-color),
    inset 0 0 5px rgba(var(--glow-color-rgb), 0.1);

  &:hover {
    box-shadow:
      0 0 10px var(--glow-color),
      0 0 20px rgba(var(--glow-color-rgb), 0.3),
      inset 0 0 10px rgba(var(--glow-color-rgb), 0.2);
  }
}

.hotkey {
  margin-left: 0.5em;
  padding: 0.1em 0.4em;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 2px;
  font-size: 0.85em;
  opacity: 0.7;
}
```

### Panel System

Modal and drawer system with consistent behavior:

```tsx
interface PanelProps {
  id: string;
  position: 'left' | 'right' | 'bottom' | 'center';
  size: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  title: string;
  hotkey?: string;
  children: React.ReactNode;
  onClose: () => void;
}

const Panel: React.FC<PanelProps> = ({
  id,
  position,
  size,
  title,
  hotkey,
  children,
  onClose,
}) => {
  // Focus trap for accessibility
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  // Keyboard handling
  useHotkey('Escape', onClose);

  return (
    <div
      className={cn(styles.overlay, styles[position])}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={panelRef}
        className={cn(styles.panel, styles[size])}
        initial={getInitialPosition(position)}
        animate={{ x: 0, y: 0, opacity: 1 }}
        exit={getInitialPosition(position)}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <header className={styles.header}>
          <h2 id={`${id}-title`} className={styles.title}>
            <span className={styles.titleIcon}>◉</span>
            {title}
          </h2>
          <div className={styles.controls}>
            {hotkey && <kbd className={styles.hotkey}>{hotkey}</kbd>}
            <button
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className={styles.content}>
          {children}
        </div>

        <div className={styles.scanlines} aria-hidden="true" />
      </motion.div>
    </div>
  );
};

// Panel positions
const getInitialPosition = (position: string) => {
  switch (position) {
    case 'left': return { x: -100, opacity: 0 };
    case 'right': return { x: 100, opacity: 0 };
    case 'bottom': return { y: 100, opacity: 0 };
    case 'center': return { scale: 0.95, opacity: 0 };
  }
};
```

### Overlay Stack Manager

Manage multiple overlays with proper z-indexing and focus:

```typescript
interface OverlayEntry {
  id: string;
  type: 'panel' | 'modal' | 'toast' | 'tooltip';
  component: React.ComponentType<any>;
  props: Record<string, any>;
  priority: number;
}

class OverlayStackManager {
  private stack: OverlayEntry[] = [];
  private listeners = new Set<(stack: OverlayEntry[]) => void>();

  push(entry: OverlayEntry): void {
    // Prevent duplicates
    if (this.stack.some(e => e.id === entry.id)) {
      this.bringToFront(entry.id);
      return;
    }

    this.stack.push(entry);
    this.sort();
    this.notify();
  }

  pop(id?: string): void {
    if (id) {
      this.stack = this.stack.filter(e => e.id !== id);
    } else {
      this.stack.pop();
    }
    this.notify();
  }

  toggle(entry: OverlayEntry): void {
    if (this.stack.some(e => e.id === entry.id)) {
      this.pop(entry.id);
    } else {
      this.push(entry);
    }
  }

  private sort(): void {
    // Sort by priority (higher = on top), then by order of addition
    this.stack.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return 0; // Maintain order for same priority
    });
  }

  // Get topmost overlay for focus management
  getTopmost(): OverlayEntry | null {
    return this.stack[this.stack.length - 1] || null;
  }

  // Check if any modal is blocking
  hasBlockingModal(): boolean {
    return this.stack.some(e => e.type === 'modal');
  }
}

// React hook for consuming
function useOverlayStack() {
  const [stack, setStack] = useState<OverlayEntry[]>([]);

  useEffect(() => {
    const unsubscribe = overlayManager.subscribe(setStack);
    return unsubscribe;
  }, []);

  return {
    stack,
    push: overlayManager.push.bind(overlayManager),
    pop: overlayManager.pop.bind(overlayManager),
    toggle: overlayManager.toggle.bind(overlayManager),
  };
}
```

---

## Performance Architecture

### Rendering Budget

**Frame Budget**: 16.67ms at 60fps

| Phase | Budget | Notes |
|-------|--------|-------|
| Input handling | 1ms | Event dispatch, state updates |
| Layout | 2ms | React reconciliation |
| Paint | 8ms | Canvas/WebGL rendering |
| Composite | 2ms | Layer composition |
| Idle | 3.67ms | Buffer for variance |

### Virtual Scrolling

For large sequences (100k+ bases):

```typescript
interface VirtualScrollConfig {
  itemHeight: number;
  containerHeight: number;
  overscan: number; // Extra items to render outside viewport
}

class VirtualScroller {
  private config: VirtualScrollConfig;
  private scrollTop = 0;
  private totalItems = 0;

  getVisibleRange(): { start: number; end: number } {
    const { itemHeight, containerHeight, overscan } = this.config;

    const start = Math.max(0, Math.floor(this.scrollTop / itemHeight) - overscan);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const end = Math.min(this.totalItems, start + visibleCount + overscan * 2);

    return { start, end };
  }

  getOffsetForIndex(index: number): number {
    return index * this.config.itemHeight;
  }

  getTotalHeight(): number {
    return this.totalItems * this.config.itemHeight;
  }

  // Smooth scrolling with momentum
  scrollTo(position: number, behavior: 'instant' | 'smooth' = 'smooth'): void {
    if (behavior === 'instant') {
      this.scrollTop = position;
      this.notify();
    } else {
      this.animateScroll(position);
    }
  }

  private animateScroll(target: number): void {
    const start = this.scrollTop;
    const distance = target - start;
    const duration = Math.min(300, Math.abs(distance) * 0.5);
    const startTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(progress);

      this.scrollTop = start + distance * eased;
      this.notify();

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }
}
```

### Worker Thread Orchestration

Offload heavy computation to workers:

```typescript
// Main thread orchestrator
class ComputeOrchestrator {
  private workers: Map<string, Worker> = new Map();
  private pendingJobs: Map<string, JobPromise> = new Map();

  constructor() {
    // Create worker pool
    this.workers.set('analysis', new Worker(
      new URL('./workers/analysis.worker.ts', import.meta.url),
      { type: 'module' }
    ));
    this.workers.set('simulation', new Worker(
      new URL('./workers/simulation.worker.ts', import.meta.url),
      { type: 'module' }
    ));
    this.workers.set('wasm', new Worker(
      new URL('./workers/wasm.worker.ts', import.meta.url),
      { type: 'module' }
    ));

    // Setup message handlers
    for (const [name, worker] of this.workers) {
      worker.onmessage = (e) => this.handleMessage(name, e.data);
    }
  }

  async runAnalysis<T>(
    type: string,
    data: any,
    options: { priority?: 'high' | 'normal' | 'low' } = {}
  ): Promise<T> {
    const jobId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingJobs.set(jobId, { resolve, reject });

      const worker = this.workers.get('analysis')!;
      worker.postMessage({
        jobId,
        type,
        data,
        priority: options.priority || 'normal',
      });
    });
  }

  // Stream results for long-running computations
  runWithProgress<T>(
    type: string,
    data: any,
    onProgress: (progress: number, partial?: T) => void
  ): Promise<T> {
    const jobId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingJobs.set(jobId, {
        resolve,
        reject,
        onProgress,
      });

      const worker = this.workers.get('wasm')!;
      worker.postMessage({
        jobId,
        type,
        data,
        streamResults: true,
      });
    });
  }

  private handleMessage(workerName: string, message: WorkerMessage): void {
    const job = this.pendingJobs.get(message.jobId);
    if (!job) return;

    switch (message.type) {
      case 'progress':
        job.onProgress?.(message.progress, message.partial);
        break;
      case 'complete':
        job.resolve(message.result);
        this.pendingJobs.delete(message.jobId);
        break;
      case 'error':
        job.reject(new Error(message.error));
        this.pendingJobs.delete(message.jobId);
        break;
    }
  }
}

// Worker script (analysis.worker.ts)
import { expose } from 'comlink';
import { initWasm, gcSkew, complexity, kmerAnomaly } from '@phage-explorer/wasm-compute';

let wasmReady = false;

async function initialize() {
  await initWasm();
  wasmReady = true;
}

const api = {
  async gcSkew(sequence: string, windowSize: number) {
    if (!wasmReady) await initialize();
    return gcSkew(sequence, windowSize);
  },

  async complexity(sequence: string, k: number) {
    if (!wasmReady) await initialize();
    return complexity(sequence, k);
  },

  async kmerAnomaly(sequence: string, k: number, threshold: number) {
    if (!wasmReady) await initialize();
    return kmerAnomaly(sequence, k, threshold);
  },
};

expose(api);
```

### Memory Management

For large datasets:

```typescript
class MemoryManager {
  private cache = new Map<string, WeakRef<any>>();
  private registry = new FinalizationRegistry((key: string) => {
    this.cache.delete(key);
  });

  // LRU cache with size limit
  private lru = new LRUCache<string, any>({
    max: 100,
    maxSize: 50 * 1024 * 1024, // 50MB
    sizeCalculation: (value) => {
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (typeof value === 'string') return value.length * 2;
      return JSON.stringify(value).length * 2;
    },
    dispose: (value, key) => {
      console.debug(`[Memory] Evicted: ${key}`);
    },
  });

  cache<T>(key: string, factory: () => T): T {
    // Check LRU first
    const cached = this.lru.get(key);
    if (cached !== undefined) return cached;

    // Compute and cache
    const value = factory();
    this.lru.set(key, value);

    return value;
  }

  // For large objects that can be garbage collected
  weakCache<T extends object>(key: string, factory: () => T): T {
    const ref = this.cache.get(key);
    if (ref) {
      const value = ref.deref();
      if (value) return value;
    }

    const value = factory();
    this.cache.set(key, new WeakRef(value));
    this.registry.register(value, key);

    return value;
  }

  // Monitor memory usage
  getStats(): MemoryStats {
    return {
      lruSize: this.lru.size,
      lruCalculatedSize: this.lru.calculatedSize,
      weakCacheSize: this.cache.size,
      jsHeapSize: (performance as any).memory?.usedJSHeapSize,
    };
  }
}
```

---

## Novel Web Capabilities

### Features Only Possible in Browser

#### 1. WebGPU Compute (Experimental)

Massive parallelism for heavy analysis:

```typescript
async function gpuKmerCount(sequence: string, k: number): Promise<Map<string, number>> {
  if (!navigator.gpu) {
    // Fallback to WASM
    return wasmKmerCount(sequence, k);
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  // Encode sequence as buffer
  const sequenceBuffer = device.createBuffer({
    size: sequence.length,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint8Array(sequenceBuffer.getMappedRange()).set(
    sequence.split('').map(c => c.charCodeAt(0))
  );
  sequenceBuffer.unmap();

  // Create output buffer for k-mer counts
  const outputBuffer = device.createBuffer({
    size: Math.pow(4, k) * 4, // 4^k possible k-mers, 4 bytes per count
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Compute shader
  const shaderModule = device.createShaderModule({
    code: `
      @group(0) @binding(0) var<storage, read> sequence: array<u32>;
      @group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;

      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let idx = gid.x;
        if (idx >= arrayLength(&sequence) - ${k}u) { return; }

        var kmer: u32 = 0u;
        for (var i = 0u; i < ${k}u; i++) {
          let base = sequence[idx + i];
          let code = select(0u, select(1u, select(2u, 3u, base == 84u), base == 71u), base == 67u);
          kmer = kmer * 4u + code;
        }

        atomicAdd(&counts[kmer], 1u);
      }
    `,
  });

  // ... setup pipeline and dispatch
}
```

#### 2. WebRTC Collaborative Sessions

Real-time collaboration on phage analysis:

```typescript
interface CollaborativeSession {
  id: string;
  peers: Map<string, RTCPeerConnection>;
  dataChannels: Map<string, RTCDataChannel>;
  sharedState: SharedPhageState;
}

class CollaborationManager {
  private session: CollaborativeSession | null = null;

  async createSession(): Promise<string> {
    const sessionId = crypto.randomUUID();

    // Create signaling via edge function
    const { offer, sessionToken } = await fetch('/api/collab/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }).then(r => r.json());

    this.session = {
      id: sessionId,
      peers: new Map(),
      dataChannels: new Map(),
      sharedState: this.createSharedState(),
    };

    return sessionId;
  }

  async joinSession(sessionId: string): Promise<void> {
    // Get signaling info
    const { offer } = await fetch(`/api/collab/join/${sessionId}`).then(r => r.json());

    // Create peer connection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    // Setup data channel for state sync
    const dc = pc.createDataChannel('phage-state', {
      ordered: true,
    });

    dc.onmessage = (e) => {
      const message = JSON.parse(e.data);
      this.handlePeerMessage(message);
    };

    // ... complete WebRTC handshake
  }

  broadcastStateChange(change: StateChange): void {
    const message = JSON.stringify({
      type: 'state-change',
      ...change,
      timestamp: Date.now(),
    });

    for (const dc of this.session?.dataChannels.values() ?? []) {
      if (dc.readyState === 'open') {
        dc.send(message);
      }
    }
  }
}
```

#### 3. Web Animations API for Smooth Transitions

Hardware-accelerated animations:

```typescript
function animatePhageSwitch(
  oldElement: HTMLElement,
  newElement: HTMLElement
): Animation[] {
  // Coordinated transition: old fades out while new fades in

  const oldAnim = oldElement.animate([
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0, transform: 'scale(0.95)' },
  ], {
    duration: 150,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    fill: 'forwards',
  });

  const newAnim = newElement.animate([
    { opacity: 0, transform: 'scale(1.05)' },
    { opacity: 1, transform: 'scale(1)' },
  ], {
    duration: 200,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    delay: 100, // Slight overlap
    fill: 'forwards',
  });

  // Glitch effect during transition
  const glitchAnim = newElement.animate([
    { filter: 'none' },
    { filter: 'hue-rotate(90deg) saturate(2)', offset: 0.3 },
    { filter: 'hue-rotate(-90deg) saturate(0.5)', offset: 0.6 },
    { filter: 'none' },
  ], {
    duration: 150,
    delay: 100,
  });

  return [oldAnim, newAnim, glitchAnim];
}
```

#### 4. Clipboard API for Rich Copying

Copy sequence data with formatting:

```typescript
async function copySequenceRich(
  sequence: string,
  format: 'text' | 'fasta' | 'html'
): Promise<void> {
  const clipboardItems: ClipboardItem[] = [];

  if (format === 'html' || format === 'text') {
    // HTML with colored bases
    const html = sequence.split('').map(base => {
      const color = nucleotideColors[base] || '#888';
      return `<span style="color:${color};font-family:monospace">${base}</span>`;
    }).join('');

    clipboardItems.push(new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([sequence], { type: 'text/plain' }),
    }));
  }

  if (format === 'fasta') {
    const fasta = `>exported_sequence\n${
      sequence.match(/.{1,60}/g)?.join('\n') || sequence
    }`;

    clipboardItems.push(new ClipboardItem({
      'text/plain': new Blob([fasta], { type: 'text/plain' }),
    }));
  }

  await navigator.clipboard.write(clipboardItems);
}
```

#### 5. WebCodecs for Video Export

Export analysis as video:

```typescript
async function exportAnalysisVideo(
  simulation: Simulation,
  options: VideoExportOptions
): Promise<Blob> {
  const { width, height, fps, duration } = options;

  // Check for WebCodecs support
  if (!('VideoEncoder' in window)) {
    throw new Error('WebCodecs not supported');
  }

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      // Collect encoded chunks
      encodedChunks.push({ chunk, metadata });
    },
    error: (e) => console.error('Encoding error:', e),
  });

  await encoder.configure({
    codec: 'vp09.00.10.08', // VP9
    width,
    height,
    bitrate: 5_000_000,
    framerate: fps,
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // Render each frame
  const frameCount = Math.ceil(duration * fps);
  for (let i = 0; i < frameCount; i++) {
    const time = i / fps;

    // Render simulation state at this time
    simulation.seekTo(time);
    renderFrame(ctx, simulation);

    // Encode frame
    const frame = new VideoFrame(canvas, {
      timestamp: i * (1_000_000 / fps), // microseconds
    });
    encoder.encode(frame);
    frame.close();

    // Report progress
    onProgress(i / frameCount);
  }

  await encoder.flush();
  encoder.close();

  // Mux into WebM container
  return muxToWebM(encodedChunks);
}
```

#### 6. File System Access API

Direct file system integration:

```typescript
async function openPhageFile(): Promise<PhageData> {
  // Modern File System Access API
  if ('showOpenFilePicker' in window) {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Phage Files',
        accept: {
          'application/x-genbank': ['.gb', '.gbk'],
          'text/x-fasta': ['.fasta', '.fa', '.fna'],
          'application/json': ['.json'],
        },
      }],
    });

    const file = await handle.getFile();
    return parsePhageFile(file);
  }

  // Fallback to input element
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gb,.gbk,.fasta,.fa,.fna,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        resolve(await parsePhageFile(file));
      } else {
        reject(new Error('No file selected'));
      }
    };
    input.click();
  });
}

async function saveAnalysisResults(data: AnalysisResults): Promise<void> {
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: `phage-analysis-${Date.now()}.json`,
      types: [{
        description: 'JSON',
        accept: { 'application/json': ['.json'] },
      }],
    });

    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }
}
```

---

## Deployment Strategy

### Vercel Configuration

```typescript
// vercel.json
{
  "framework": "vite",
  "buildCommand": "bun run build:web",
  "outputDirectory": "packages/web/dist",
  "routes": [
    // Static assets with aggressive caching
    {
      "src": "/assets/(.*)",
      "headers": {
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    },
    // WASM files
    {
      "src": "/(.*\\.wasm)",
      "headers": {
        "Content-Type": "application/wasm",
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    },
    // Database file
    {
      "src": "/phage.db.br",
      "headers": {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"
      }
    },
    // SPA fallback
    {
      "src": "/(.*)",
      "dest": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

### Edge Functions

Minimal edge functions for optional features:

```typescript
// api/telemetry.ts
import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const events = await req.json();

  // Batch write to KV store
  const pipeline = kv.pipeline();
  for (const event of events) {
    pipeline.lpush(`telemetry:${event.type}`, JSON.stringify({
      ...event,
      timestamp: Date.now(),
    }));
  }
  await pipeline.exec();

  return new Response('OK');
}

// api/share.ts
export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  const { state } = await req.json();

  // Compress state
  const compressed = await compress(JSON.stringify(state));
  const base64 = btoa(String.fromCharCode(...compressed));

  // Store in KV with TTL
  const shareId = crypto.randomUUID().slice(0, 8);
  await kv.set(`share:${shareId}`, base64, { ex: 7 * 24 * 60 * 60 }); // 7 days

  return Response.json({
    shareUrl: `https://phage-explorer.com/s/${shareId}`
  });
}
```

### CDN and Asset Optimization

```typescript
// build.config.ts
export default defineConfig({
  build: {
    // Chunk splitting strategy
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-state': ['zustand', 'immer'],
          'rendering': ['./src/rendering/index.ts'],
          'wasm': ['@phage-explorer/wasm-compute'],
        },
      },
    },

    // Asset inlining threshold
    assetsInlineLimit: 4096,

    // CSS code splitting
    cssCodeSplit: true,

    // Minification
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
  },

  // Preload key assets
  plugins: [
    {
      name: 'preload-wasm',
      transformIndexHtml(html) {
        return html.replace(
          '</head>',
          `<link rel="modulepreload" href="/wasm/phage_compute_bg.wasm">
           <link rel="preload" href="/phage.db.br" as="fetch" crossorigin>
           </head>`
        );
      },
    },
  ],
});
```

---

## Phased Execution Plan

### Phase 0: Foundation (Week 1-2)

**Deliverables**:
- [ ] `packages/web` scaffold with Vite + React
- [ ] Path aliases to shared packages (`@phage-explorer/*`)
- [ ] Basic layout shell (header, main, footer)
- [ ] Theme system ported from TUI
- [ ] Keyboard manager with hotkey registration
- [ ] CSS reset and base typography

**Verification**:
- App boots in browser
- Theme switching works
- Basic keyboard shortcuts respond
- Build produces valid bundle

### Phase 1: Data Layer (Week 2-3)

**Deliverables**:
- [ ] sql.js integration in `db-runtime`
- [ ] Build script for compressed database
- [ ] IndexedDB caching layer
- [ ] Service worker for offline
- [ ] Zustand store hydration from browser

**Verification**:
- Database loads and queries work
- Second visit uses cached database
- Offline mode functional
- State persists across sessions

### Phase 2: Core Visualization (Week 3-5)

**Deliverables**:
- [ ] Canvas-based sequence grid renderer
- [ ] Glyph atlas for fast text
- [ ] Virtual scrolling for large sequences
- [ ] Gene map SVG/canvas renderer
- [ ] Sparkline components ported
- [ ] WebGL post-processing pipeline

**Verification**:
- 60fps scrolling on 100k+ base sequences
- All nucleotide/amino acid colors correct
- Gene map shows correct positions
- Scanlines and glow effects render

### Phase 3: Overlays & Panels (Week 5-7)

**Deliverables**:
- [ ] Command palette component
- [ ] Analysis menu drawer
- [ ] Simulation hub modal
- [ ] Layer 1 overlays (GC, complexity, etc.)
- [ ] Multi-overlay management
- [ ] Help overlay with hotkey reference

**Verification**:
- All hotkeys from TUI work
- Overlays toggle correctly
- Multiple overlays stack visually
- Panel animations smooth

### Phase 4: Simulations (Week 7-9)

**Deliverables**:
- [ ] Web Worker orchestration
- [ ] Ribosome traffic simulation
- [ ] Lysogeny circuit simulation
- [ ] Plaque automata
- [ ] Evolution replay
- [ ] Time controls and playback

**Verification**:
- Simulations run without blocking UI
- Progress indicators work
- Snapshots can be saved/restored
- Deterministic with seed

### Phase 5: Advanced Features (Week 9-11)

**Deliverables**:
- [ ] CRISPR pressure analysis
- [ ] HGT tracer
- [ ] Synteny alignment
- [ ] Tropism atlas
- [ ] Pangenome viewer
- [ ] WebGPU acceleration (feature flag)

**Verification**:
- Heavy analyses complete in reasonable time
- Progress streaming works
- Results match TUI implementation
- GPU acceleration provides speedup

### Phase 6: Polish & Launch (Week 11-13)

**Deliverables**:
- [ ] Performance audit and optimization
- [ ] Accessibility review (WCAG 2.1 AA)
- [ ] First-run onboarding flow
- [ ] "TUI mode" skin option
- [ ] Error boundary and recovery
- [ ] Telemetry integration
- [ ] Documentation

**Verification**:
- Lighthouse score >90 all categories
- Screen reader navigable
- Keyboard-only usable
- Error states graceful
- Cold start <2s on broadband

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| sql.js performance | Medium | High | Precompute heavy queries, lazy load, consider SQLite streaming |
| WASM compatibility | Low | High | Feature detection, JS fallback for critical paths |
| Bundle size | Medium | Medium | Aggressive code splitting, lazy routes, compression |
| Mobile performance | High | Medium | Reduced motion mode, simpler shaders, touch gestures |
| Safari quirks | Medium | Medium | Thorough cross-browser testing, polyfills where needed |
| Memory pressure | Medium | High | WeakRef caching, explicit cleanup, memory budgeting |
| Offline sync | Low | Low | Conflict resolution strategy, last-write-wins |
| WebGPU availability | High | Low | Feature flag, graceful degradation to WebGL |

---

## Success Metrics

### Performance

| Metric | Target | Measurement |
|--------|--------|-------------|
| First Contentful Paint | <1.0s | Lighthouse |
| Largest Contentful Paint | <1.5s | Lighthouse |
| Time to Interactive | <2.0s | Lighthouse |
| Cumulative Layout Shift | <0.1 | Lighthouse |
| First Input Delay | <50ms | Web Vitals |
| Keypress to Paint | <16ms | Custom |
| Scroll FPS | 60fps | Performance API |

### Functionality

| Metric | Target |
|--------|--------|
| Hotkey parity with TUI | 100% |
| Overlay parity with TUI | 100% |
| Simulation parity with TUI | 100% |
| Offline functionality | Full app usable |

### Adoption

| Metric | Target (3 months) |
|--------|-------------------|
| Monthly Active Users | 1,000 |
| Avg. Session Duration | >5 min |
| Feature Adoption (simulations) | >30% of users |
| Return Rate | >40% |

---

## Appendices

### A. Keyboard Shortcut Reference

[Full table of all shortcuts organized by category - see Interaction Model section]

### B. Theme Color Specifications

[Complete color values for all 10 themes - see Visual Language section]

### C. WASM Module API

```typescript
// Exported from @phage-explorer/wasm-compute
export function gcSkew(sequence: string, windowSize: number): Float64Array;
export function complexity(sequence: string, k: number): Float64Array;
export function kmerAnomaly(sequence: string, k: number, threshold: number): AnomalyResult;
export function bendability(sequence: string): Float64Array;
export function promoterScan(sequence: string, model: string): PromoterHit[];
export function repeatFinder(sequence: string, minLength: number): RepeatRegion[];
// ... etc
```

### D. Database Schema

```sql
-- Core tables shipped to browser
CREATE TABLE phages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT,
  host TEXT,
  genome_length INTEGER,
  gc_content REAL
);

CREATE TABLE genes (
  id TEXT PRIMARY KEY,
  phage_id TEXT REFERENCES phages(id),
  name TEXT,
  locus_tag TEXT,
  start_pos INTEGER NOT NULL,
  end_pos INTEGER NOT NULL,
  strand TEXT CHECK(strand IN ('+', '-')),
  product TEXT
);

CREATE TABLE sequences (
  phage_id TEXT PRIMARY KEY REFERENCES phages(id),
  sequence TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_genes_phage ON genes(phage_id);
CREATE INDEX idx_genes_position ON genes(phage_id, start_pos);
```

### E. Browser Compatibility Matrix

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Canvas 2D | ✅ | ✅ | ✅ | ✅ |
| WebGL 2.0 | ✅ | ✅ | ✅ | ✅ |
| WebGPU | ✅ 113+ | 🚧 | 🚧 | ✅ 113+ |
| WASM | ✅ | ✅ | ✅ | ✅ |
| SharedArrayBuffer | ✅ | ✅ | ✅ 15.2+ | ✅ |
| Service Worker | ✅ | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ✅ | ✅ | ✅ |
| OffscreenCanvas | ✅ | ✅ | ✅ 16.4+ | ✅ |
| Web Animations | ✅ | ✅ | ✅ | ✅ |
| Clipboard API | ✅ | ✅ | ✅ 13.1+ | ✅ |
| File System Access | ✅ | ❌ | ❌ | ✅ |
| WebCodecs | ✅ | 🚧 | ❌ | ✅ |

Legend: ✅ Supported | ❌ Not Supported | 🚧 Experimental/Behind Flag

---

## Conclusion

This plan transforms Phage Explorer from a terminal application into a best-in-class web experience that:

1. **Preserves** the keyboard-first, low-latency interaction model
2. **Amplifies** the cyberpunk aesthetic with GPU-accelerated effects
3. **Extends** capabilities with web-only features (collaboration, export, offline)
4. **Maintains** a single codebase for core logic and computation
5. **Deploys** seamlessly on Vercel with no backend infrastructure

The phased approach allows incremental delivery while maintaining quality gates at each stage. Success will be measured by both technical metrics (performance, compatibility) and user adoption metrics.

Let's build something beautiful. 🧬✨
