/**
 * ModuleOverlay - Functional Module Coherence & Stoichiometry Checker
 *
 * Visualizes phage genome module completeness, stoichiometry balance,
 * and gene coherence with quality grading and actionable suggestions.
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { ThemePalette } from '../../theme/types';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
import {
  computeModuleCoherence,
  type ModuleReport,
  type ModuleStatus,
  type StoichiometryResult,
  type Suggestion,
  type QualityGrade,
} from '@phage-explorer/core';

// ============================================================================
// Styling Helpers
// ============================================================================

const GRADIENT = ['░', '▒', '▓', '█'];

function scoreColor(score: number, colors: { success: string; warning: string; error: string }): string {
  if (score >= 0.8) return colors.success;
  if (score >= 0.5) return colors.warning;
  return colors.error;
}

function gradeColor(grade: QualityGrade): string {
  switch (grade) {
    case 'A': return '#22c55e';
    case 'B': return '#84cc16';
    case 'C': return '#eab308';
    case 'D': return '#f97316';
    case 'F': return '#ef4444';
  }
}

function priorityColor(priority: 'high' | 'medium' | 'low'): string {
  switch (priority) {
    case 'high': return '#ef4444';
    case 'medium': return '#f97316';
    case 'low': return '#6b7280';
  }
}

function essentialityLabel(essentiality: 'critical' | 'common' | 'optional'): string {
  switch (essentiality) {
    case 'critical': return '●';
    case 'common': return '◐';
    case 'optional': return '○';
  }
}

// ============================================================================
// Sub-components
// ============================================================================

interface QualityBadgeProps {
  grade: QualityGrade;
}

function QualityBadge({ grade }: QualityBadgeProps): React.ReactElement {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '48px',
        height: '48px',
        borderRadius: '8px',
        backgroundColor: gradeColor(grade) + '22',
        border: `2px solid ${gradeColor(grade)}`,
        fontSize: '1.5rem',
        fontWeight: 'bold',
        color: gradeColor(grade),
      }}
    >
      {grade}
    </div>
  );
}

interface ModuleCardProps {
  status: ModuleStatus;
  colors: ThemePalette;
}

function ModuleCard({ status, colors }: ModuleCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        backgroundColor: colors.backgroundAlt,
        padding: '0.75rem',
        borderRadius: '4px',
        borderLeft: `3px solid ${scoreColor(status.score, colors)}`,
        cursor: 'pointer',
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <span style={{ color: colors.text, fontWeight: 'bold' }}>{status.label}</span>
        <span style={{ color: scoreColor(status.score, colors), fontFamily: 'monospace' }}>
          {status.count} / {status.min}{status.max ? `–${status.max}` : '+'}
        </span>
      </div>

      {/* Score bars */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem', fontSize: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: colors.textMuted, marginBottom: '2px' }}>Completeness</div>
          <div style={{ height: '4px', backgroundColor: colors.borderLight, borderRadius: '2px' }}>
            <div
              style={{
                height: '100%',
                width: `${status.completeness * 100}%`,
                backgroundColor: scoreColor(status.completeness, colors),
                borderRadius: '2px',
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: colors.textMuted, marginBottom: '2px' }}>Coherence</div>
          <div style={{ height: '4px', backgroundColor: colors.borderLight, borderRadius: '2px' }}>
            <div
              style={{
                height: '100%',
                width: `${status.coherence * 100}%`,
                backgroundColor: scoreColor(status.coherence, colors),
                borderRadius: '2px',
              }}
            />
          </div>
        </div>
      </div>

      {status.issues.length === 0 ? (
        <div style={{ color: colors.success, fontSize: '0.85rem' }}>✓ Coherent</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.2rem', color: colors.warning, fontSize: '0.85rem' }}>
          {status.issues.map((issue, idx) => (
            <li key={idx}>{issue}</li>
          ))}
        </ul>
      )}

      {expanded && status.matchedGenes.length > 0 && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: colors.textMuted }}>
          <div style={{ marginBottom: '0.25rem', fontWeight: 'bold' }}>Genes ({status.matchedGenes.length}):</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {status.matchedGenes.map((g, i) => (
              <span
                key={i}
                style={{
                  padding: '0.15rem 0.4rem',
                  backgroundColor: colors.background,
                  borderRadius: '3px',
                  fontSize: '0.7rem',
                }}
                title={`Role: ${g.role}, RBS: ${(g.rbsStrength * 100).toFixed(0)}%`}
              >
                {essentialityLabel(g.essentiality)} {g.name || g.product || g.locusTag || 'unnamed'}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface StoichiometryChartProps {
  results: StoichiometryResult[];
  colors: ThemePalette;
}

function StoichiometryChart({ results, colors }: StoichiometryChartProps): React.ReactElement {
  const applicableResults = results.filter(r => r.gene1Count > 0 || r.gene2Count > 0);

  if (applicableResults.length === 0) {
    return (
      <div style={{ color: colors.textMuted, fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>
        No stoichiometry data available (genes not annotated)
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {applicableResults.map((result, i) => {
        const maxCount = Math.max(result.gene1Count, result.gene2Count, 1);
        const bar1Width = (result.gene1Count / maxCount) * 100;
        const bar2Width = (result.gene2Count / maxCount) * 100;

        return (
          <div key={i} style={{ fontSize: '0.8rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: colors.text }}>{result.rule.description}</span>
              <span
                style={{
                  color: result.isBalanced ? colors.success : colors.warning,
                  fontFamily: 'monospace',
                }}
              >
                {result.gene1Count}:{result.gene2Count}
                {!result.isBalanced && ' ⚠'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '4px', height: '8px' }}>
              <div
                style={{
                  width: `${bar1Width}%`,
                  backgroundColor: result.isBalanced ? colors.success : colors.warning,
                  borderRadius: '2px',
                  transition: 'width 0.3s',
                }}
              />
              <div
                style={{
                  width: `${bar2Width}%`,
                  backgroundColor: result.isBalanced ? '#22c55e88' : '#f9730088',
                  borderRadius: '2px',
                  transition: 'width 0.3s',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface SuggestionsListProps {
  suggestions: Suggestion[];
  colors: ThemePalette;
}

function SuggestionsList({ suggestions, colors }: SuggestionsListProps): React.ReactElement {
  if (suggestions.length === 0) {
    return (
      <div style={{ color: colors.success, fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>
        ✓ No issues detected
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {suggestions.slice(0, 5).map((suggestion, i) => (
        <div
          key={i}
          style={{
            padding: '0.5rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            borderLeft: `3px solid ${priorityColor(suggestion.priority)}`,
            fontSize: '0.8rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                padding: '0.1rem 0.3rem',
                backgroundColor: priorityColor(suggestion.priority) + '22',
                color: priorityColor(suggestion.priority),
                borderRadius: '3px',
                fontSize: '0.65rem',
                fontWeight: 'bold',
                textTransform: 'uppercase',
              }}
            >
              {suggestion.priority}
            </span>
            <span style={{ color: colors.textMuted, fontSize: '0.7rem' }}>{suggestion.module}</span>
          </div>
          <div style={{ color: colors.text, marginTop: '0.25rem' }}>{suggestion.message}</div>
          {suggestion.action && (
            <div style={{ color: colors.textMuted, fontSize: '0.75rem', marginTop: '0.25rem' }}>
              → {suggestion.action}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface ModuleOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function ModuleOverlay({
  repository,
  currentPhage,
}: ModuleOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'overview' | 'stoichiometry' | 'suggestions'>('overview');

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayModules,
    () => toggle('modules'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('modules')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then(length => repository.getSequenceWindow(phageId, 0, length))
      .then(seq => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => {
        if (cancelled) return;
        setSequence('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Compute module analysis
  const report = useMemo((): ModuleReport | null => {
    if (!currentPhage?.genes || currentPhage.genes.length === 0) return null;
    return computeModuleCoherence(currentPhage.genes, sequence || undefined);
  }, [currentPhage, sequence]);

  if (!isOpen('modules')) return null;

  return (
    <Overlay
      id="modules"
      title={`MODULE COHERENCE${currentPhage ? ` — ${currentPhage.name}` : ''}`}
      hotkey="l"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {loading ? (
          <OverlayLoadingState message="Analyzing module coherence...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !report || !currentPhage ? (
          <OverlayEmptyState
            message={!currentPhage ? 'No phage selected' : 'No genes available for analysis'}
            hint={!currentPhage ? 'Select a phage to analyze.' : 'Module analysis requires annotated genes.'}
          />
        ) : (
          <>
            {/* Header with Quality Grade */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                padding: '1rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '8px',
              }}
            >
              <QualityBadge grade={report.qualityGrade} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: colors.text }}>
                  Quality Grade: {report.qualityGrade}
                </div>
                <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.85rem' }}>
                  <span style={{ color: colors.textMuted }}>
                    Overall: <strong style={{ color: scoreColor(report.overall, colors) }}>
                      {(report.overall * 100).toFixed(0)}%
                    </strong>
                  </span>
                  <span style={{ color: colors.textMuted }}>
                    Stoichiometry: <strong style={{ color: scoreColor(report.stoichiometryScore, colors) }}>
                      {(report.stoichiometryScore * 100).toFixed(0)}%
                    </strong>
                  </span>
                  <span style={{ color: colors.textMuted }}>
                    Coherence: <strong style={{ color: scoreColor(report.overallCoherence, colors) }}>
                      {(report.overallCoherence * 100).toFixed(0)}%
                    </strong>
                  </span>
                </div>
              </div>
              <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
                {currentPhage.genes.length} genes
              </div>
            </div>

            {/* View Mode Tabs */}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {(['overview', 'stoichiometry', 'suggestions'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    padding: '0.4rem 0.8rem',
                    backgroundColor: viewMode === mode ? colors.accent : colors.backgroundAlt,
                    color: viewMode === mode ? '#fff' : colors.text,
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode}
                  {mode === 'suggestions' && report.suggestions.length > 0 && (
                    <span
                      style={{
                        marginLeft: '0.4rem',
                        padding: '0.1rem 0.3rem',
                        backgroundColor: '#ef4444',
                        borderRadius: '10px',
                        fontSize: '0.65rem',
                        color: '#fff',
                      }}
                    >
                      {report.suggestions.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Module Ribbon */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div style={{ color: colors.textDim, fontSize: '0.8rem' }}>Module Ribbon</div>
              <div style={{ display: 'flex', fontFamily: 'monospace', fontSize: '1.2rem' }}>
                {report.statuses.map(s => {
                  const c = scoreColor(s.score, colors);
                  const gIdx = Math.min(GRADIENT.length - 1, Math.max(0, Math.round(s.score * (GRADIENT.length - 1))));
                  return (
                    <span key={s.id} style={{ color: c, flex: 1, textAlign: 'center' }}>
                      {GRADIENT[gIdx]}
                    </span>
                  );
                })}
              </div>
              <div style={{ display: 'flex', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                {report.statuses.map(s => (
                  <span key={`${s.id}-label`} style={{ color: colors.textDim, flex: 1, textAlign: 'center' }}>
                    {s.label.slice(0, 3)}
                  </span>
                ))}
              </div>
            </div>

            {/* View Mode Content */}
            {viewMode === 'overview' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '0.75rem',
                  maxHeight: '350px',
                  overflowY: 'auto',
                }}
              >
                {report.statuses.map(s => (
                  <ModuleCard key={s.id} status={s} colors={colors} />
                ))}
              </div>
            )}

            {viewMode === 'stoichiometry' && (
              <div
                style={{
                  padding: '1rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '8px',
                }}
              >
                <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                  Gene Pair Ratios (expected stoichiometry)
                </div>
                <StoichiometryChart results={report.stoichiometry} colors={colors} />
                <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: colors.textMuted }}>
                  <strong>Legend:</strong> Bars show relative gene counts. Balanced ratios are green;
                  imbalanced ratios (outside tolerance) are orange with ⚠ warning.
                </div>
              </div>
            )}

            {viewMode === 'suggestions' && (
              <div>
                <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  Improvement Suggestions ({report.suggestions.length})
                </div>
                <SuggestionsList suggestions={report.suggestions} colors={colors} />
              </div>
            )}

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                fontSize: '0.75rem',
                color: colors.textMuted,
                flexWrap: 'wrap',
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
              }}
            >
              <span>● Critical</span>
              <span>◐ Common</span>
              <span>○ Optional</span>
              <span style={{ marginLeft: 'auto' }}>Click cards to expand</span>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default ModuleOverlay;
