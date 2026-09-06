/**
 * RepeatsOverlay - Repeat & Palindrome Finder
 *
 * Displays direct repeats, inverted repeats, and palindromic sequences.
 */

import React, { useEffect, useState } from 'react';
import { serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { AnalysisResult } from '../../workers/types';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';

interface RepeatsOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function RepeatsOverlay({
  repository,
  currentPhage,
}: RepeatsOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    phage: PhageFull; repository: PhageRepository | null; sequence: string;
    data: Extract<AnalysisResult, { type: 'repeats' }>;
  } | null>(null);
  const currentSnapshot = snapshot?.phage === currentPhage && snapshot?.repository === repository ? snapshot : null;
  const result = currentSnapshot?.data ?? null;
  const sequence = currentSnapshot?.sequence ?? '';
  const repeats = result?.repeats ?? [];
  const search = result?.search;
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayRepeats,
    () => toggle('repeats'),
    { modes: ['NORMAL'] }
  );

  // Keep reading and computing in one selection-scoped request. Numeric IDs
  // can be reused by another repository; retaining a separate ID-only sequence
  // cache can relabel old bases as a result for the new repository.
  useEffect(() => {
    if (!isOpen('repeats')) return;
    setError(null);
    setExportError(null);
    setSnapshot(null);
    setAnalysisLoading(false);
    if (!repository || !currentPhage) {
      setSequenceLoading(false);
      return;
    }
    let cancelled = false;
    let reading = true;
    setSequenceLoading(true);
    (async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (cancelled) return;
        const sequence = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (cancelled) return;
        reading = false;
        setSequenceLoading(false);
        if (!sequence) return;
        setAnalysisLoading(true);
        const result = await getOrchestrator().runAnalysisWithSharedBuffer(
          currentPhage.id,
          sequence,
          'repeats',
          { minLength: 8, maxGap: 5000 },
          { accession: currentPhage.accession, source: currentPhage.localGenome ? 'local' : 'catalog' }
        );

        if (cancelled) return;
        if (result.type !== 'repeats') throw new Error('Unexpected analysis result');
        setSnapshot({ phage: currentPhage, repository, sequence, data: result });
      } catch (cause: unknown) {
        if (cancelled) return;
        setSnapshot(null);
        setError(`${reading ? 'Could not load sequence' : 'Repeat analysis failed'}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!cancelled) {
          setSequenceLoading(false);
          setAnalysisLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentPhage, repository]);

  const direct = repeats.filter(r => r.type === 'direct');
  const inverted = repeats.filter(r => r.type === 'inverted');
  const palindromes = repeats.filter(r => r.type === 'palindrome');
  const tandem = repeats.filter(r => r.type === 'tandem');

  if (!isOpen('repeats')) {
    return null;
  }

  const typeColors = {
    direct: colors.primary,
    inverted: colors.warning,
    palindrome: colors.accent,
    tandem: colors.info,
  };

  const typeIcons = {
    direct: '→→',
    inverted: '→←',
    palindrome: '↔',
    tandem: '⟲',
  };

  return (
    <Overlay
      id="repeats"
      title="REPEATS & PALINDROMES"
      hotkey="r"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Loading State */}
        {(sequenceLoading || analysisLoading) && (
          <OverlayLoadingState message={sequenceLoading ? 'Loading sequence data...' : 'Analyzing repeats...'}>
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        )}
        {error && <OverlayErrorState message="Repeat analysis unavailable" details={error} />}
        {result?.evidenceRecord && <>
          <button type="button" onClick={() => {
            try {
              downloadString(serializeAnalysisRecord(result.evidenceRecord!), 'repeat-analysis.json', 'application/json');
              setExportError(null);
            } catch (cause) { setExportError(cause instanceof Error ? cause.message : 'Could not export analysis'); }
          }}>Export repeat experiment</button>
          <AnalysisRecordDetails record={result.evidenceRecord} />
        </>}
        {(result?.evidenceError || exportError) && <p role="alert">{result?.evidenceError ?? exportError}</p>}

        {/* Description */}
        {!sequenceLoading && !analysisLoading && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}>
            <strong style={{ color: colors.primary }}>Repeat Analysis</strong> finds exact sequence
            matches, not experimentally confirmed structures or regulatory functions. Positions are
            1-based arm starts; lengths give the reported span (or matched arm for sampled pairs).
            This scan treats the sequence as linear, including imported circular genomes.
            {search && <p>
              Pairs: {search.minLength} bp arms, up to {search.maxGap.toLocaleString()} bp between arms,
              one candidate every {search.step} bp and first matching partner, up to {search.maxPairedResults} results.
              {search.detailedScan
                ? ` Detailed scan: arms ≥${search.minArmLength} bp, spacers ≤${search.palindromeMaxGap} bp; up to ${search.maxPerDetail} inverted/palindromic and ${search.maxPerDetail} tandem results.`
                : ' Detailed palindrome and tandem scans are unavailable above 120,000 bp.'}
              {' '}Unresolved bases break arms and units, but may occur in spacers.
            </p>}
          </div>
        )}

        {/* Stats */}
        {result && !error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.primary, fontSize: '0.75rem' }}>Direct Repeats</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{direct.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.warning, fontSize: '0.75rem' }}>Inverted Repeats</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{inverted.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.accent, fontSize: '0.75rem' }}>Palindromes</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{palindromes.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.info, fontSize: '0.75rem' }}>Tandem Repeats</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{tandem.length}</div>
            </div>
          </div>
        )}

        {/* Repeats table */}
        {result && !error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{
            maxHeight: '300px',
            overflowY: 'auto',
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
          }}>
            <table aria-label="Repeat matches" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ backgroundColor: colors.backgroundAlt, position: 'sticky', top: 0 }}>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Type</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Position(s)</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Sequence</th>
                  <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>Length</th>
                </tr>
              </thead>
              <tbody>
                {repeats.map((repeat, idx) => (
                  <tr
                    key={idx}
                    style={{
                      borderTop: `1px solid ${colors.borderLight}`,
                      backgroundColor: idx % 2 === 0 ? 'transparent' : colors.backgroundAlt,
                    }}
                  >
                    <td style={{ padding: '0.5rem' }}>
                      <span style={{ color: typeColors[repeat.type], fontWeight: 'bold' }}>
                        {typeIcons[repeat.type]} {repeat.type.charAt(0).toUpperCase() + repeat.type.slice(1)}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.text }}>
                      {(repeat.position1 + 1).toLocaleString()}
                      {repeat.position2 !== undefined && ` ↔ ${(repeat.position2 + 1).toLocaleString()}`}
                    </td>
                    <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.accent }}>
                      {repeat.sequence}
                      {repeat.armLength !== undefined && <div style={{ color: colors.textDim }}>
                        Arms: {repeat.armLength} bp; spacer: {repeat.gap} bp
                      </div>}
                      {repeat.copies !== undefined && <div style={{ color: colors.textDim }}>
                        {repeat.copies} copies of {repeat.sequence.length} bp
                      </div>}
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>
                      {repeat.length} bp
                    </td>
                  </tr>
                ))}
                {repeats.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
                      No repeats found within these search limits
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        {!error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '2rem',
            color: colors.textMuted,
            fontSize: '0.85rem',
          }}>
            <span><span style={{ color: colors.primary }}>→→</span> Direct (same strand)</span>
            <span><span style={{ color: colors.warning }}>→←</span> Inverted (reverse complement)</span>
            <span><span style={{ color: colors.accent }}>↔</span> Palindrome (self-complementary)</span>
            <span><span style={{ color: colors.info }}>⟲</span> Tandem (consecutive copies)</span>
          </div>
        )}

        {!error && !sequenceLoading && !analysisLoading && sequence.length === 0 && (
          <OverlayEmptyState
            message="No sequence data available"
            hint="Select a phage to analyze repeats and palindromes."
          />
        )}
      </div>
    </Overlay>
  );
}

export default RepeatsOverlay;
