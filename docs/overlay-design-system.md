# Overlay Design System (Web)

This doc captures **conventions** (not hard rules) for building web overlays that feel consistent, premium, and maintainable. It exists to prevent “one-off” UI drift across overlays.

## Principles

- **Chrome is quiet**: overlays should feel like an analysis card, not a separate app.
- **Use tokens, not magic numbers**: spacing/typography/color should come from CSS variables.
- **Sans for UI, mono for data**: reserve monospace for sequences, coordinates, IDs, numeric readouts.
- **Standard states**: loading/empty/error should look consistent and be actionable.
- **Mobile-first constraints**: overlays must be usable on iPhone screens without fighting scroll or safe areas.

## Where the primitives live

- Overlay chrome primitives: `packages/web/src/components/overlays/primitives/OverlayChrome.tsx`
- Re-exports: `packages/web/src/components/overlays/primitives/index.ts`
- Overlay IDs + stack behavior: `packages/web/src/components/overlays/OverlayProvider.tsx`
- Overlay registration (eager vs lazy): `packages/web/src/components/overlays/OverlayManager.tsx`
- Core tokens: `packages/web/src/styles/variables.css`
- Typography policy: `packages/web/src/styles/typography.css`

## Tokens to use (and how)

Prefer CSS variables over inline values:

- **Spacing**: `var(--space-*)` (e.g. `--space-2`, `--space-6`)
- **Radii**: `var(--radius-*)`
- **Typography**: `--text-*`, `--font-*`, `--leading-*`, `--tracking-*`
- **Overlay typography**: `--overlay-*-size`, `--overlay-*-line-height`, `--overlay-*-weight`
- **Colors**: `--color-*` (avoid hard-coded hex in overlay components)

If you need a new token, add it to `packages/web/src/styles/variables.css` (and prefer reusing an existing one first).

## Layout primitives (use these first)

Instead of bespoke wrappers like `div style={{ display:'flex', flexDirection:'column', gap:'...' }}`, prefer these:

- `OverlayStack`: vertical spacing between blocks
- `OverlaySection` + `OverlaySectionHeader`: consistent bordered sections
- `OverlayToolbar`: top-of-section controls/filters
- `OverlayGrid`: responsive grids for cards
- `OverlayRow`, `OverlayKeyValue`: label/value rows and stat readouts
- `OverlayDescription`: body copy that matches overlay typography
- `OverlayStatCard` / `OverlayStatGrid`: consistent metrics presentation
- `OverlayLegend` / `OverlayLegendItem`: chart legends

The goal is that overlays can be “scan-read” with the same mental model across the app.

## Typography conventions

- **UI text** (titles, descriptions, buttons) should stay in the default sans stack.
- Use `.font-data` for:
  - DNA / AA sequences
  - coordinates / loci / accession IDs
  - numeric tables and dense stats
- Use `.key-hint` for shortcut badges (it’s mono + tabular numbers).

Avoid making an entire overlay monospace; it reads like a dev tool and reduces hierarchy.

## State primitives (loading / empty / error)

Within overlays, use the standardized primitives (from `packages/web/src/components/overlays/primitives`):

- `OverlayLoadingState`: use when async work is in flight
- `OverlayEmptyState`: use when there is no content (include a hint or next step when possible)
- `OverlayErrorState`: use for recoverable failures
  - `message` should be user-facing, brief, and non-technical
  - `details` is optional and should generally be dev-only
  - `onRetry` should be wired when retry is safe

Avoid custom spinners and ad-hoc error boxes unless the overlay truly needs a specialized state.

## Provenance: saying where the numbers came from

An audit of the 46 analysis overlays found that 36 compute from the loaded
genome, gene table or shipped annotations, and 10 do not — while looking exactly
the same. Same menu, same category, same chrome. Two displayed a green
"REAL DATA" banner over inputs that were a hash of the phage name.

For a tool meant for research and teaching this is worse than a missing feature:
a fabricated number is indistinguishable from a measured one, so discovering a
single fake panel costs the user their trust in the 36 real ones.

### The five levels

| Level | Means |
|---|---|
| `measured` | Computed from this phage's sequence, genes or annotations |
| `external` | Fetched live from a named third-party service |
| `heuristic` | A rule-based estimate over real data, not a measurement |
| `simulated` | A model the user parameterised; its inputs are real |
| `demo` | Synthetic input, not derived from the user's phage at all |

`heuristic` is not a euphemism for "fake" and `demo` is not a euphemism for
`heuristic`. A keyword scan over real gene products is heuristic. A random
abundance table is demo. Collapsing those two is how the original situation
arose.

### You do not add the badge to your overlay

Declare the level once, on the overlay's entry in
`packages/web/src/keyboard/actionRegistry.ts`:

```ts
[ActionIds.OverlayMyThing]: {
  // ...
  overlayId: 'myThing',
  provenance: 'heuristic',
  // Only for overlays that degrade when a live source is unavailable:
  provenanceFallback: 'demo',
},
```

Everything else follows from that:

- The shared `Overlay` component renders `OverlayProvenance` in the header for
  every overlay, reading the level from the registry. Editing 46 components
  would have labelled the 46 that exist and done nothing for the 47th.
- The Analysis Menu and the Command Palette both show it in the list, so the
  level is visible **before** the overlay is opened. The niche network carried
  an honest disclaimer inside its body and sat in the plain "Analysis" category,
  which meant the user only learned what it was after choosing it.
- `overlay-provenance.test.ts` fails if any registry entry with an `overlayId`
  omits a level, so a new overlay cannot reach the menu unlabelled.

`measured` is deliberately not badged. It is the overwhelming majority, and a
badge on every panel is a badge nobody reads.

### When the overlay can degrade

An overlay that fetches live data and falls back to synthetic data declares
`provenanceFallback`. The menu is drawn before the overlay opens, so the
achieved provenance is genuinely unknown at that moment; the honest statement is
the range, not the optimistic endpoint.

### Per-figure labels

The header badge covers the overlay. Where one panel is measured and another is
not — environmental provenance measures catalogue distinctiveness locally while
its map comes from SRA metadata — label each figure as well, and stamp canvases
in the pixels: a badge in the DOM is lost the moment someone crops a screenshot.

### Category placement

An overlay whose input is synthetic does not belong in `Analysis`. Use
`Education`. A test enforces that no overlay with `provenance: 'demo'` sits in
`Analysis`.

### The TUI

`packages/tui/src/components/OverlayProvenance.tsx` is the terminal equivalent:
one line rather than a badge, with identical level names and meanings. Two
surfaces disagreeing about what a level means would be worse than neither having
one. Applied to the TUI overlays whose level is not `measured`.

## Mobile vs desktop guidelines

### Mobile (≤ 640px / coarse pointer)

- Prefer smaller overlay shells (`size="sm"` in `Overlay`) and keep content scrollable.
- Avoid fixed-height canvases without a container that can shrink.
- Keep primary actions reachable (don’t bury critical buttons below long outputs).
- Respect safe areas (`env(safe-area-inset-*)`) and avoid placing controls under the iOS home indicator.

### Desktop

- Use more generous sectioning (`OverlaySection`) to improve scanability.
- Favor side-by-side layouts via `OverlayGrid` only when it meaningfully reduces scrolling.

## Interaction patterns

- Prefer registry-driven hotkeys and labels (ActionRegistry + `useHotkey`) over hardcoded shortcut text.
- Close behavior should remain predictable (`Esc` closes top overlay).
- Don’t register global hotkeys from inside lazy overlay components unless they are contextual to that overlay.

## Do / don’t quick examples

**Do**
- Use `OverlayStack` for vertical rhythm.
- Use `OverlaySectionHeader` for section titles and context badges.
- Use `.font-data` only on the specific spans/blocks that are data-heavy.

**Don’t**
- Add new one-off spacing values (e.g. `gap: '13px'`) in overlay content.
- Hardcode hex colors in overlay components.
- Render raw exceptions to users; prefer `OverlayErrorState` with a clear message.

