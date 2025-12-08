import React, { useMemo, useRef, useState } from 'react';
import { SequenceView } from './SequenceView';
import { useHotkeys } from '../hooks';

export interface DiffStats {
  insertions: number;
  deletions: number;
  substitutions: number;
  matches: number;
  lengthA: number;
  lengthB: number;
  identity: number;
}

interface DiffHighlighterProps {
  sequence: string;
  diffSequence: string;
  diffMask?: Uint8Array | null;
  diffPositions?: number[];
  stats?: DiffStats;
  height?: number | string;
}

export function DiffHighlighter({
  sequence,
  diffSequence,
  diffMask = null,
  diffPositions = [],
  stats,
  height = 320,
}: DiffHighlighterProps): JSX.Element {
  const controlsRef = useRef<{ jumpToDiff: (direction: 'next' | 'prev') => number | null } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const goToDiff = (direction: 'next' | 'prev') => {
    const target = controlsRef.current?.jumpToDiff(direction) ?? null;
    if (target !== null) setActiveIndex(target);
  };

  useHotkeys([
    { combo: { key: ']' }, description: 'Next diff', action: () => goToDiff('next'), modes: ['NORMAL'] },
    { combo: { key: '[' }, description: 'Previous diff', action: () => goToDiff('prev'), modes: ['NORMAL'] },
  ]);

  const summary = useMemo(() => {
    if (!stats) return null;
    const totalChanges = stats.insertions + stats.deletions + stats.substitutions;
    return {
      totalChanges,
      identity: stats.identity,
    };
  }, [stats]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SequenceView
        sequence={sequence}
        diffSequence={diffSequence}
        diffMask={diffMask}
        diffPositions={diffPositions}
        diffEnabledOverride
        height={height}
        onControlsReady={(controls) => {
          controlsRef.current = controls;
        }}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.85rem',
        }}
      >
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <Badge label="Subs" value={stats?.substitutions ?? 0} color="#facc15" />
          <Badge label="Ins" value={stats?.insertions ?? 0} color="#22c55e" />
          <Badge label="Del" value={stats?.deletions ?? 0} color="#ef4444" />
          <Badge label="Match" value={stats?.matches ?? 0} color="#38bdf8" />
        </div>
        {summary && (
          <span style={{ color: '#9ca3af' }}>
            Identity: {summary.identity.toFixed(2)}% · Changes: {summary.totalChanges.toLocaleString()}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
          <button className="btn-secondary" type="button" onClick={() => goToDiff('prev')} aria-label="Previous diff">
            ← Prev diff
          </button>
          <button className="btn" type="button" onClick={() => goToDiff('next')} aria-label="Next diff">
            Next diff →
          </button>
        </div>
        {activeIndex !== null && (
          <span style={{ color: '#9ca3af' }}>At {activeIndex.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}

function Badge({ label, value, color }: { label: string; value: number; color: string }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.15rem 0.4rem',
        borderRadius: '6px',
        background: '#111827',
        border: `1px solid ${color}`,
        color: '#e5e7eb',
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 999, background: color, display: 'inline-block' }} />
      <span>{label}:</span>
      <strong>{value.toLocaleString()}</strong>
    </span>
  );
}

export default DiffHighlighter;

