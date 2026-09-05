import React from 'react';
import type { CSSProperties } from 'react';
import type { AnalysisRecord } from '@phage-explorer/core';

/**
 * Provenance badge: says where an overlay's numbers came from.
 *
 * ## Why this exists
 *
 * An audit of all 46 analysis overlays found that 36 compute from the loaded
 * genome, gene table or shipped annotations -- and the other 10 do not, while
 * looking exactly the same. Same menu, same category, same chrome. Two of them
 * displayed a green "REAL DATA" banner over inputs that were a hash of the
 * phage name.
 *
 * For a tool whose stated purpose is research and teaching, that is worse than
 * a missing feature: a fabricated number is indistinguishable from a measured
 * one, so discovering a single fake panel costs the user their trust in the 36
 * real ones.
 *
 * ## The contract
 *
 * Four levels, and they are genuinely different claims:
 *
 * - `measured`   computed from this phage's sequence, genes or annotations
 * - `external`   fetched live from a named third-party service
 * - `heuristic`  a rule-based estimate, not a measurement
 * - `simulated`  a model the user parameterised; its inputs are real
 * - `demo`       synthetic input, not derived from the user's phage at all
 *
 * "Heuristic" is not a euphemism for "fake" and "demo" is not a euphemism for
 * "heuristic". A keyword scan over real gene products is heuristic. A random
 * abundance table is demo. Collapsing those two is how the current situation
 * arose.
 *
 * The badge renders in the overlay header, always visible, never behind a
 * scroll or a tooltip.
 */

export type ProvenanceLevel =
  | 'measured'
  | 'external'
  | 'heuristic'
  | 'simulated'
  | 'demo';

interface ProvenanceStyle {
  label: string;
  /** Shown on hover and to assistive technology. */
  meaning: string;
  color: string;
  background: string;
  border: string;
}

/**
 * Colours follow the project's documented semantics (README, "UI Design
 * System"): green for good/real, blue for informational, yellow for caution,
 * purple for notable, red for warning. `demo` deliberately takes the warning
 * colour, because an unlabelled demo panel is the defect this primitive exists
 * to prevent.
 */
const PROVENANCE_STYLES: Record<ProvenanceLevel, ProvenanceStyle> = {
  measured: {
    label: 'Measured',
    meaning: 'Computed from this phage’s sequence, genes or annotations.',
    color: 'var(--color-success, #16a34a)',
    background: 'var(--color-success-bg, rgba(22, 163, 74, 0.12))',
    border: 'var(--color-success, #16a34a)',
  },
  external: {
    label: 'External data',
    meaning: 'Fetched live from a third-party service.',
    color: 'var(--color-info, #2563eb)',
    background: 'var(--color-info-bg, rgba(37, 99, 235, 0.12))',
    border: 'var(--color-info, #2563eb)',
  },
  heuristic: {
    label: 'Heuristic',
    meaning:
      'A rule-based estimate over real data, not a measurement. Treat as a hint, not a result.',
    color: 'var(--color-warning, #b7791f)',
    background: 'var(--color-warning-bg, rgba(183, 121, 31, 0.12))',
    border: 'var(--color-warning, #b7791f)',
  },
  simulated: {
    label: 'Simulation',
    meaning: 'A model you parameterised. Its inputs are real; its output is not an observation.',
    color: 'var(--color-notable, #9333ea)',
    background: 'var(--color-notable-bg, rgba(147, 51, 234, 0.12))',
    border: 'var(--color-notable, #9333ea)',
  },
  demo: {
    label: 'Demo data',
    meaning:
      'Synthetic input, not derived from the phage you selected. Illustrates the method, not this genome.',
    color: 'var(--color-error, #dc2626)',
    background: 'var(--color-error-bg, rgba(220, 38, 38, 0.12))',
    border: 'var(--color-error, #dc2626)',
  },
};

export interface OverlayProvenanceProps {
  level: ProvenanceLevel;
  /**
   * What specifically the data is, e.g. "Pfam-A via PyHMMER" or "SRA sample
   * metadata". Appended after the level so the badge answers "from what?" and
   * not only "how trustworthy?".
   */
  source?: string;
  className?: string;
  style?: CSSProperties;
}

export function OverlayProvenance({
  level,
  source,
  className = '',
  style,
}: OverlayProvenanceProps): React.ReactElement {
  const spec = PROVENANCE_STYLES[level];
  const description = source ? `${spec.label}: ${source}. ${spec.meaning}` : spec.meaning;

  return (
    <span
      className={`overlay-provenance overlay-provenance--${level} ${className}`}
      title={description}
      aria-label={`Data provenance. ${description}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4em',
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '0.15em 0.55em',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
        color: spec.color,
        backgroundColor: spec.background,
        border: `1px solid ${spec.border}`,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '0.45em',
          height: '0.45em',
          borderRadius: '50%',
          backgroundColor: spec.color,
          flexShrink: 0,
        }}
      />
      {spec.label}
      {source ? (
        <span style={{ fontWeight: 400, textTransform: 'none', opacity: 0.85 }}>
          &middot; {source}
        </span>
      ) : null}
    </span>
  );
}

/** Exposed so menus and tests can enumerate levels without importing the map. */
export const PROVENANCE_LEVELS = Object.keys(PROVENANCE_STYLES) as ProvenanceLevel[];

export function provenanceMeaning(level: ProvenanceLevel): string {
  return PROVENANCE_STYLES[level].meaning;
}

export function provenanceLabel(level: ProvenanceLevel): string {
  return PROVENANCE_STYLES[level].label;
}

/** Field-level context from the same record that is copied or downloaded. */
export function AnalysisRecordDetails({ record }: { record: AnalysisRecord }): React.ReactElement {
  return <details aria-label="Analysis evidence and inputs" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
    <summary>Experiment inputs and evidence</summary>
    <p>{record.method.implementation} · method {record.method.id} version {record.method.version}</p>
    <p>Exact input and parameter identity: <code>{record.cacheKey}</code></p>
    <p>Checksums identify content; they do not validate the biological method.</p>
    <ul>{record.inputs.map(input => <li key={input.id}>
      {input.id}: {input.accession ?? input.source} · {input.description} <code>{input.sha256}</code>
    </li>)}</ul>
    <dl>{Object.entries(record.fields).map(([id, field]) => <React.Fragment key={id}>
      <dt>{field.label}: <strong>{field.kind}</strong>{field.units && ` · ${field.units}`}</dt>
      <dd>
        Coverage: {field.coverage.available}/{field.coverage.total} {field.coverage.unit}.
        {field.kind === 'unavailable' && <p>Unavailable: {field.missingInputs.join(' ')}</p>}
        {(field.kind === 'demo' || field.kind === 'simulation') && <p>{field.assumptions.join(' ')}</p>}
        <p>{field.limitations.join(' ')}</p>
      </dd>
    </React.Fragment>)}</dl>
  </details>;
}
