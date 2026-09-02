import React from 'react';
import { Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

/**
 * Provenance line for TUI overlays.
 *
 * The terminal counterpart of the web `OverlayProvenance` badge, and it exists
 * for the same reason: an audit of the analysis overlays found that some
 * compute from the loaded genome and others do not, while looking exactly the
 * same. In a terminal there is no chrome to distinguish them at all, so an
 * unlabelled heuristic reads as a measurement even more readily than on the web.
 *
 * One line rather than a badge, because that is what the medium affords. The
 * levels and their meanings are deliberately identical to the web component's:
 * two surfaces disagreeing about what a level means would be worse than
 * neither having one.
 *
 * `measured` is not rendered. It is the overwhelming majority, and a label on
 * every panel is a label nobody reads.
 */

export type ProvenanceLevel =
  | 'measured'
  | 'external'
  | 'heuristic'
  | 'simulated'
  | 'demo';

const LABELS: Record<ProvenanceLevel, string> = {
  measured: 'MEASURED',
  external: 'EXTERNAL DATA',
  heuristic: 'HEURISTIC',
  simulated: 'SIMULATION',
  demo: 'DEMO DATA',
};

const MEANINGS: Record<ProvenanceLevel, string> = {
  measured: 'computed from this genome',
  external: 'fetched from a third-party service',
  heuristic: 'rule-based estimate over real data, not a measurement',
  simulated: 'a model you parameterised; its output is not an observation',
  demo: 'synthetic input, not derived from this phage',
};

export interface OverlayProvenanceProps {
  level: ProvenanceLevel;
  /** What the data specifically is, e.g. "Pfam-A via PyHMMER". */
  source?: string;
}

export function OverlayProvenance({
  level,
  source,
}: OverlayProvenanceProps): React.ReactElement | null {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  if (level === 'measured') return null;

  // Same semantics as the web palette: warning for estimates, error for
  // synthetic input, info for third-party data.
  const color =
    level === 'demo'
      ? colors.error
      : level === 'external'
        ? colors.info
        : level === 'simulated'
          ? colors.accent
          : colors.warning;

  return (
    <Text color={color}>
      [{LABELS[level]}] {source ? `${source} — ` : ''}
      {MEANINGS[level]}
    </Text>
  );
}
