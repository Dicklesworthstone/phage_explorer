/**
 * QuickStats Component
 *
 * A compact bar showing key phage metrics at a glance.
 * Surfaces information that was previously hidden or required navigation.
 */

import React, { useMemo } from 'react';
import { usePhageStore } from '@phage-explorer/state';

interface QuickStatsProps {
  className?: string;
}

export function QuickStats({ className = '' }: QuickStatsProps): React.ReactElement | null {
  const currentPhage = usePhageStore((s) => s.currentPhage);

  const stats = useMemo(() => {
    if (!currentPhage) return null;

    const forwardGenes = currentPhage.genes?.filter((g) => g.strand !== '-').length ?? 0;
    const reverseGenes = currentPhage.genes?.filter((g) => g.strand === '-').length ?? 0;

    return {
      name: currentPhage.name,
      accession: currentPhage.accession,
      length: currentPhage.genomeLength ?? 0,
      gcContent: currentPhage.gcContent, // Use pre-calculated value from phage data
      geneCount: currentPhage.genes?.length ?? 0,
      forwardGenes,
      reverseGenes,
      baltimore: currentPhage.baltimoreGroup,
      host: currentPhage.host,
      hasPdb: (currentPhage.pdbIds?.length ?? 0) > 0,
    };
  }, [currentPhage]);

  if (!stats) {
    return null;
  }

  const formatNumber = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toLocaleString();
  };

  return (
    <div className={`quick-stats ${className}`} aria-label="Phage statistics">
      <div className="quick-stat">
        <span className="quick-stat__label">Length</span>
        <span className="quick-stat__value">{formatNumber(stats.length)} bp</span>
      </div>

      {stats.gcContent !== null && (
        <div className="quick-stat">
          <span className="quick-stat__label">GC Content</span>
          <span className="quick-stat__value">{(stats.gcContent * 100).toFixed(1)}%</span>
        </div>
      )}

      <div className="quick-stat">
        <span className="quick-stat__label">Genes</span>
        <span className="quick-stat__value">
          {stats.geneCount} <span style={{ opacity: 0.6, fontSize: '0.85em' }}>({stats.forwardGenes}+ / {stats.reverseGenes}-)</span>
        </span>
      </div>

      {stats.baltimore && (
        <div className="quick-stat">
          <span className="quick-stat__label">Baltimore</span>
          <span className="quick-stat__value quick-stat__value--highlight">{stats.baltimore}</span>
        </div>
      )}

      {stats.host && (
        <div className="quick-stat">
          <span className="quick-stat__label">Host</span>
          <span className="quick-stat__value" style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {stats.host}
          </span>
        </div>
      )}

      {stats.hasPdb && (
        <div className="quick-stat">
          <span className="quick-stat__label">Structure</span>
          <span className="quick-stat__value quick-stat__value--highlight">Available</span>
        </div>
      )}

      <div className="quick-stat">
        <span className="quick-stat__label">Accession</span>
        <span className="quick-stat__value" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85em' }}>
          {stats.accession}
        </span>
      </div>
    </div>
  );
}

export default QuickStats;
