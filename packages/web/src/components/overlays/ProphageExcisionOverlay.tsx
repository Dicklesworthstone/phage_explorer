/**
 * ProphageExcisionOverlay - Prophage Excision Precision Mapper
 *
 * Predicts exact attL/attR attachment sites for temperate phages.
 * Finds integrase genes, searches for imperfect direct repeats at boundaries,
 * and models the excision product.
 *
 * Part of: phage_explorer-w71 (Layer 2: Prophage Excision Precision Mapper)
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import {
  analyzeProphageExcision,
  type ProphageExcisionAnalysis,
  type IntegraseGene,
  type AttachmentSite,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import type { ThemePalette } from '../../theme/types';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { IconDna, IconTarget, IconAlertTriangle, IconRepeat } from '../ui';

// Confidence color scale
function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.7) return '#22c55e'; // Green
  if (confidence >= 0.5) return '#84cc16'; // Lime
  if (confidence >= 0.3) return '#f59e0b'; // Orange
  return '#ef4444'; // Red
}

// Format position with commas
function formatPosition(pos: number): string {
  return pos.toLocaleString();
}

interface ProphageExcisionOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function ProphageExcisionOverlay({
  repository,
  currentPhage,
}: ProphageExcisionOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'summary' | 'integrases' | 'sites' | 'hotspots'>(
    'summary'
  );

  // Hotkey (Alt+X for eXcision) - avoid conflict with Defense Arms Race
  useHotkey(
    { key: 'x', modifiers: { alt: true } },
    'Prophage Excision',
    () => toggle('prophageExcision'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('prophageExcision')) return;
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

    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => setSequence(''))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Compute analysis
  const analysis = useMemo((): ProphageExcisionAnalysis | null => {
    if (!sequence || !currentPhage?.genes) return null;
    return analyzeProphageExcision(sequence, currentPhage.genes);
  }, [sequence, currentPhage?.genes]);

  if (!isOpen('prophageExcision')) return null;

  return (
    <Overlay
      id="prophageExcision"
      title="Prophage Excision Mapper"
      hotkey="Alt+X"
      size="lg"
    >
      <div
        style={{
          padding: '1rem',
          color: colors.text,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.85rem',
        }}
      >
        {/* Header */}
        <div
          style={{
            marginBottom: '1rem',
            paddingBottom: '0.75rem',
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.5rem',
            }}
          >
            <IconDna size={20} />
            <span style={{ fontWeight: 'bold' }}>
              {currentPhage?.name ?? 'No phage selected'}
            </span>
          </div>
          <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
            Predict attachment sites (attL/attR) and model excision product
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <AnalysisPanelSkeleton
            message="Analyzing prophage integration sites..."
            rows={5}
          />
        )}

        {/* No Data State */}
        {!loading && !analysis && (
          <div
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: colors.textMuted,
            }}
          >
            <IconAlertTriangle
              size={32}
              style={{ marginBottom: '0.5rem', opacity: 0.5 }}
            />
            <div>No sequence data available</div>
          </div>
        )}

        {/* Analysis Results */}
        {!loading && analysis && (
          <>
            {/* Summary Card */}
            <SummaryCard analysis={analysis} colors={colors} />

            {/* View Mode Tabs */}
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                marginTop: '1rem',
                marginBottom: '0.75rem',
              }}
            >
              {(['summary', 'integrases', 'sites', 'hotspots'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    border: `1px solid ${viewMode === mode ? colors.accent : colors.border}`,
                    borderRadius: '4px',
                    background:
                      viewMode === mode ? colors.accent + '20' : 'transparent',
                    color: viewMode === mode ? colors.accent : colors.text,
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>

            {/* View Content */}
            {viewMode === 'summary' && (
              <DiagnosticsView analysis={analysis} colors={colors} />
            )}
            {viewMode === 'integrases' && (
              <IntegrasesView integrases={analysis.integrases} colors={colors} />
            )}
            {viewMode === 'sites' && (
              <AttSitesView
                sites={analysis.attachmentSites}
                bestPrediction={analysis.bestPrediction}
                colors={colors}
              />
            )}
            {viewMode === 'hotspots' && (
              <HotspotsView
                hotspots={analysis.integrationHotspots}
                sequenceLength={sequence.length}
                colors={colors}
              />
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}

// Summary Card Component
function SummaryCard({
  analysis,
  colors,
}: {
  analysis: ProphageExcisionAnalysis;
  colors: ThemePalette;
}): React.ReactElement {
  const { bestPrediction, isTemperate, overallConfidence, integrases, excisionRisk, integrationHotspots } =
    analysis;

  return (
    <div
      style={{
        padding: '0.75rem',
        background: colors.backgroundAlt,
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
      }}
    >
      {/* Temperate Status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: isTemperate ? '#22c55e' : '#f59e0b',
            }}
          />
          <span style={{ fontWeight: 'bold' }}>
            {isTemperate ? 'Likely Temperate' : 'Lytic or Unknown'}
          </span>
        </div>
        <div
          style={{
            padding: '0.25rem 0.5rem',
            borderRadius: '4px',
            background: getConfidenceColor(overallConfidence) + '30',
            color: getConfidenceColor(overallConfidence),
            fontSize: '0.7rem',
            fontWeight: 'bold',
          }}
        >
          {(overallConfidence * 100).toFixed(0)}% confidence
        </div>
      </div>

      {/* Key Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '0.5rem',
          fontSize: '0.75rem',
        }}
      >
        <MetricBox
          label="Integrases"
          value={integrases.length.toString()}
          colors={colors}
        />
        <MetricBox
          label="Att Sites"
          value={(analysis.attachmentSites.length / 2).toFixed(0)}
          colors={colors}
        />
        <MetricBox
          label="Repeats"
          value={analysis.directRepeats.length.toString()}
          colors={colors}
        />
        <MetricBox
          label="Hotspots"
          value={integrationHotspots.length.toString()}
          colors={colors}
        />
      </div>

      {/* Best Prediction */}
      {bestPrediction.attL && bestPrediction.attR && (
        <div
          style={{
            marginTop: '0.75rem',
            paddingTop: '0.75rem',
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: '0.7rem',
              color: colors.textMuted,
              marginBottom: '0.5rem',
            }}
          >
            Best Predicted Integration
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <AttSiteChip site={bestPrediction.attL} colors={colors} />
            <span style={{ color: colors.textMuted }}>→</span>
            <AttSiteChip site={bestPrediction.attR} colors={colors} />
          </div>
          {bestPrediction.excisionProduct && (
            <div
              style={{
                marginTop: '0.5rem',
                fontSize: '0.7rem',
                color: colors.textMuted,
              }}
            >
              Excised region:{' '}
              {formatPosition(
                bestPrediction.excisionProduct.excisedRegion.start
              )}{' '}
              -{' '}
              {formatPosition(bestPrediction.excisionProduct.excisedRegion.end)}{' '}
              ({formatPosition(bestPrediction.excisionProduct.circularGenomeSize)}{' '}
              bp circular)
            </div>
          )}
          {excisionRisk && (
            <RiskMeter risk={excisionRisk} colors={colors} />
          )}
        </div>
      )}
    </div>
  );
}

function getRiskColor(label: 'low' | 'medium' | 'high'): string {
  switch (label) {
    case 'low':
      return '#22c55e';
    case 'medium':
      return '#f59e0b';
    case 'high':
    default:
      return '#ef4444';
  }
}

function RiskMeter({
  risk,
  colors,
}: {
  risk: NonNullable<ProphageExcisionAnalysis['excisionRisk']>;
  colors: ThemePalette;
}): React.ReactElement {
  const riskPct = Math.round(risk.risk * 100);
  const barColor = getRiskColor(risk.label);

  const drivers = [...risk.factors]
    .filter((f) => f.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  return (
    <div
      style={{
        marginTop: '0.75rem',
        paddingTop: '0.75rem',
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: '0.35rem',
        }}
      >
        <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>
          Excision risk (imprecise excision / boundary ambiguity)
        </div>
        <div style={{ fontSize: '0.7rem', fontWeight: 'bold', color: barColor }}>
          {risk.label.toUpperCase()} {riskPct}%
        </div>
      </div>

      <div
        style={{
          height: '8px',
          borderRadius: '999px',
          overflow: 'hidden',
          background: colors.background,
          border: `1px solid ${colors.border}`,
        }}
      >
        <div
          style={{
            width: `${riskPct}%`,
            height: '100%',
            background: barColor,
          }}
        />
      </div>

      {drivers.length > 0 && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: colors.textMuted }}>
          Drivers:{' '}
          {drivers
            .map((d) => `${d.factor}${d.notes ? ` (${d.notes})` : ''}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

function MetricBox({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemePalette;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.5rem',
        background: colors.background + '80',
        borderRadius: '4px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontWeight: 'bold', fontSize: '1rem' }}>{value}</div>
      <div style={{ color: colors.textMuted, fontSize: '0.65rem' }}>{label}</div>
    </div>
  );
}

function AttSiteChip({
  site,
  colors,
}: {
  site: AttachmentSite;
  colors: ThemePalette;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.25rem 0.5rem',
        background: site.type === 'attL' ? '#3b82f620' : '#8b5cf620',
        border: `1px solid ${site.type === 'attL' ? '#3b82f6' : '#8b5cf6'}`,
        borderRadius: '4px',
        fontSize: '0.7rem',
      }}
    >
      <span style={{ fontWeight: 'bold' }}>{site.type}</span>
      <span style={{ color: colors.textMuted }}>
        @{formatPosition(site.position)}
      </span>
    </div>
  );
}

// Diagnostics View
function DiagnosticsView({
  analysis,
  colors,
}: {
  analysis: ProphageExcisionAnalysis;
  colors: ThemePalette;
}): React.ReactElement {
  return (
    <div
      style={{
        background: colors.backgroundAlt,
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        padding: '0.75rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem',
          fontWeight: 'bold',
        }}
      >
        <IconTarget size={14} />
        Analysis Log
      </div>
      <div style={{ fontSize: '0.75rem' }}>
        {analysis.diagnostics.map((msg, i) => (
          <div
            key={i}
            style={{
              padding: '0.35rem 0',
              borderBottom:
                i < analysis.diagnostics.length - 1
                  ? `1px solid ${colors.border}`
                  : 'none',
              color: colors.textMuted,
            }}
          >
            • {msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// Integrases View
function IntegrasesView({
  integrases,
  colors,
}: {
  integrases: IntegraseGene[];
  colors: ThemePalette;
}): React.ReactElement {
  if (integrases.length === 0) {
    return (
      <div
        style={{
          padding: '2rem',
          textAlign: 'center',
          color: colors.textMuted,
          background: colors.backgroundAlt,
          borderRadius: '6px',
          border: `1px solid ${colors.border}`,
        }}
      >
        <IconAlertTriangle
          size={24}
          style={{ marginBottom: '0.5rem', opacity: 0.5 }}
        />
        <div>No integrase genes found</div>
        <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>
          This may be a purely lytic phage
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: colors.backgroundAlt,
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        overflow: 'hidden',
      }}
    >
      {integrases.map((int, i) => (
        <div
          key={int.gene.id}
          style={{
            padding: '0.75rem',
            borderBottom:
              i < integrases.length - 1 ? `1px solid ${colors.border}` : 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: '0.35rem',
            }}
          >
            <div>
              <span style={{ fontWeight: 'bold' }}>
                {int.gene.name || int.gene.locusTag || `Gene ${int.gene.id}`}
              </span>
              {int.gene.product && (
                <div
                  style={{
                    fontSize: '0.7rem',
                    color: colors.textMuted,
                    marginTop: '0.15rem',
                  }}
                >
                  {int.gene.product}
                </div>
              )}
              <div style={{ marginTop: '0.25rem' }}>
                <span
                  style={{
                    padding: '0.1rem 0.35rem',
                    borderRadius: '999px',
                    fontSize: '0.6rem',
                    background: colors.background + '80',
                    border: `1px solid ${colors.border}`,
                    color: colors.textMuted,
                  }}
                >
                  {int.integraseClass === 'unknown' ? 'class: unknown' : `class: ${int.integraseClass}`}
                </span>
              </div>
            </div>
            <div
              style={{
                padding: '0.2rem 0.4rem',
                borderRadius: '4px',
                background: getConfidenceColor(int.confidence) + '30',
                color: getConfidenceColor(int.confidence),
                fontSize: '0.65rem',
                fontWeight: 'bold',
              }}
            >
              {(int.confidence * 100).toFixed(0)}%
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: '0.75rem',
              fontSize: '0.7rem',
              color: colors.textMuted,
            }}
          >
            <span>
              {formatPosition(int.gene.startPos)} -{' '}
              {formatPosition(int.gene.endPos)}
            </span>
            <span>Strand: {int.gene.strand || '?'}</span>
          </div>
          <div
            style={{
              marginTop: '0.35rem',
              display: 'flex',
              gap: '0.35rem',
              flexWrap: 'wrap',
            }}
          >
            {int.matchedKeywords.map((kw) => (
              <span
                key={kw}
                style={{
                  padding: '0.15rem 0.35rem',
                  background: colors.accent + '20',
                  borderRadius: '3px',
                  fontSize: '0.6rem',
                  color: colors.accent,
                }}
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Att Sites View
function AttSitesView({
  sites,
  bestPrediction,
  colors,
}: {
  sites: AttachmentSite[];
  bestPrediction: ProphageExcisionAnalysis['bestPrediction'];
  colors: ThemePalette;
}): React.ReactElement {
  if (sites.length === 0) {
    return (
      <div
        style={{
          padding: '2rem',
          textAlign: 'center',
          color: colors.textMuted,
          background: colors.backgroundAlt,
          borderRadius: '6px',
          border: `1px solid ${colors.border}`,
        }}
      >
        <IconRepeat
          size={24}
          style={{ marginBottom: '0.5rem', opacity: 0.5 }}
        />
        <div>No attachment sites detected</div>
        <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>
          No direct repeats found at genome boundaries
        </div>
      </div>
    );
  }

  // Group by type
  const attLSites = sites.filter((s) => s.type === 'attL');
  const attRSites = sites.filter((s) => s.type === 'attR');

  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      {/* attL column */}
      <div style={{ flex: 1 }}>
        <div
          style={{
            padding: '0.5rem',
            background: '#3b82f620',
            borderRadius: '4px 4px 0 0',
            border: `1px solid #3b82f6`,
            borderBottom: 'none',
            fontWeight: 'bold',
            fontSize: '0.75rem',
            color: '#3b82f6',
          }}
        >
          attL Sites ({attLSites.length})
        </div>
        <div
          style={{
            background: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '0 0 4px 4px',
            maxHeight: '250px',
            overflowY: 'auto',
          }}
        >
          {attLSites.slice(0, 10).map((site, i) => (
            <AttSiteRow
              key={i}
              site={site}
              isBest={bestPrediction.attL?.position === site.position}
              colors={colors}
            />
          ))}
        </div>
      </div>

      {/* attR column */}
      <div style={{ flex: 1 }}>
        <div
          style={{
            padding: '0.5rem',
            background: '#8b5cf620',
            borderRadius: '4px 4px 0 0',
            border: `1px solid #8b5cf6`,
            borderBottom: 'none',
            fontWeight: 'bold',
            fontSize: '0.75rem',
            color: '#8b5cf6',
          }}
        >
          attR Sites ({attRSites.length})
        </div>
        <div
          style={{
            background: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '0 0 4px 4px',
            maxHeight: '250px',
            overflowY: 'auto',
          }}
        >
          {attRSites.slice(0, 10).map((site, i) => (
            <AttSiteRow
              key={i}
              site={site}
              isBest={bestPrediction.attR?.position === site.position}
              colors={colors}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AttSiteRow({
  site,
  isBest,
  colors,
}: {
  site: AttachmentSite;
  isBest: boolean;
  colors: ThemePalette;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.5rem',
        borderBottom: `1px solid ${colors.border}`,
        background: isBest ? colors.accent + '10' : 'transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '0.7rem' }}>
          @{formatPosition(site.position)}
        </span>
        <span
          style={{
            fontSize: '0.6rem',
            padding: '0.1rem 0.25rem',
            borderRadius: '3px',
            background: getConfidenceColor(site.confidence) + '30',
            color: getConfidenceColor(site.confidence),
          }}
        >
          {(site.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div
        style={{
          marginTop: '0.25rem',
          fontFamily: 'monospace',
          fontSize: '0.6rem',
          color: colors.textMuted,
          wordBreak: 'break-all',
        }}
      >
        {site.sequence.slice(0, 20)}
        {site.sequence.length > 20 && '...'}
      </div>
      <div style={{ marginTop: '0.2rem', fontSize: '0.6rem', color: colors.textMuted }}>
        partner @{formatPosition(site.partnerPosition)} · mismatches {site.hammingDistance}/{site.length}
      </div>
      {site.matchesKnownCore && (
        <div
          style={{
            marginTop: '0.2rem',
            fontSize: '0.55rem',
            color: '#22c55e',
          }}
        >
          ✓ Matches known att core
        </div>
      )}
      {isBest && (
        <div
          style={{
            marginTop: '0.2rem',
            fontSize: '0.55rem',
            color: colors.accent,
            fontWeight: 'bold',
          }}
        >
          ★ Best prediction
        </div>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  const hue = clamped * 120; // 0=red, 120=green
  return `hsl(${hue}, 70%, 45%)`;
}

function HotspotsView({
  hotspots,
  sequenceLength,
  colors,
}: {
  hotspots: ProphageExcisionAnalysis['integrationHotspots'];
  sequenceLength: number;
  colors: ThemePalette;
}): React.ReactElement {
  if (hotspots.length === 0) {
    return (
      <div
        style={{
          padding: '2rem',
          textAlign: 'center',
          color: colors.textMuted,
          background: colors.backgroundAlt,
          borderRadius: '6px',
          border: `1px solid ${colors.border}`,
        }}
      >
        <IconTarget size={24} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
        <div>No integration hotspots detected</div>
        <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>
          (This view only scans for a few well-known att core motifs.)
        </div>
      </div>
    );
  }

  const binSize = 2000;
  const bins = Math.max(1, Math.ceil(Math.max(1, sequenceLength) / binSize));
  const scores = new Array<number>(bins).fill(0);
  for (const h of hotspots) {
    const idx = Math.max(0, Math.min(bins - 1, Math.floor(h.position / binSize)));
    scores[idx] = Math.max(scores[idx], h.score);
  }

  return (
    <div
      style={{
        background: colors.backgroundAlt,
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        padding: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontWeight: 'bold' }}>
        <IconTarget size={14} />
        att Core Hotspots (best-effort)
      </div>

      {/* Heat strip */}
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', height: '10px', overflow: 'hidden', borderRadius: '4px', border: `1px solid ${colors.border}` }}>
          {scores.map((s, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                background: s > 0 ? scoreColor(s) : colors.background,
              }}
              title={`bin ${i + 1}/${bins} · score ${(s * 100).toFixed(0)}%`}
            />
          ))}
        </div>
        <div style={{ marginTop: '0.25rem', fontSize: '0.7rem', color: colors.textMuted }}>
          Bins: {binSize.toLocaleString()} bp · showing max hotspot score per bin
        </div>
      </div>

      {/* Table */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 60px 90px 1fr',
            background: colors.background + '80',
            borderBottom: `1px solid ${colors.border}`,
            padding: '0.5rem 0.75rem',
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            color: colors.textMuted,
          }}
        >
          <div>Pos</div>
          <div>Str</div>
          <div>Score</div>
          <div>Notes</div>
        </div>

        {hotspots.slice(0, 25).map((h, idx) => (
          <div
            key={`${h.position}-${h.strand}-${idx}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px 60px 90px 1fr',
              padding: '0.5rem 0.75rem',
              borderBottom: idx < Math.min(24, hotspots.length - 1) ? `1px solid ${colors.border}` : 'none',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              color: colors.text,
            }}
          >
            <div>@{formatPosition(h.position)}</div>
            <div style={{ color: colors.textMuted }}>{h.strand}</div>
            <div style={{ color: scoreColor(h.score), fontWeight: 'bold' }}>{Math.round(h.score * 100)}%</div>
            <div style={{ color: colors.textMuted }}>
              motif {h.motif} · integrase Δ {Number.isFinite(h.distanceFromIntegrase) ? `${Math.round(h.distanceFromIntegrase)}bp` : '—'} · tRNA Δ {Number.isFinite(h.distanceFromTrna) ? `${Math.round(h.distanceFromTrna)}bp` : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ProphageExcisionOverlay;
