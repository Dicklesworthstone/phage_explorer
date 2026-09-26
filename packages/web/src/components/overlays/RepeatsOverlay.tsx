/**
 * RepeatsOverlay - Repeat & Palindrome Finder
 *
 * Displays direct repeats, inverted repeats, and palindromic sequences.
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { parseRepeatReplay, compareRepeatReplay, type RepeatReplay, type RepeatReplayComparison } from '../../workers/analysis-evidence';

interface RepeatParameters {
  minLength: number;
  maxGap: number;
  replay?: RepeatReplay;
}

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
  const [minLengthInput, setMinLengthInput] = useState('8');
  const [maxGapInput, setMaxGapInput] = useState('5000');
  const [parameters, setParameters] = useState<RepeatParameters>({ minLength: 8, maxGap: 5000 });
  const controllerRef = useRef<AbortController | null>(null);
  const importGeneration = useRef(0);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    phage: PhageFull; repository: PhageRepository | null; sequence: string;
    parameters: RepeatParameters;
    data: Extract<AnalysisResult, { type: 'repeats' }>;
    replay: RepeatReplayComparison | null;
  } | null>(null);
  const currentSnapshot = snapshot?.phage === currentPhage && snapshot?.repository === repository && snapshot?.parameters === parameters ? snapshot : null;
  const result = currentSnapshot?.data ?? null;
  const sequence = currentSnapshot?.sequence ?? '';
  const repeats = result?.repeats ?? [];
  const search = result?.search;
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const minLength = Number(minLengthInput);
  const maxGap = Number(maxGapInput);
  const parameterError = !/^\d+$/.test(minLengthInput) || !Number.isSafeInteger(minLength) || minLength < 4 || minLength > 256
    ? 'Minimum arm length must be a whole number from 4 to 256 bp.'
    : !/^\d+$/.test(maxGapInput) || !Number.isSafeInteger(maxGap) || maxGap < 0 || maxGap > 100000
      ? 'Maximum pair gap must be a whole number from 0 to 100,000 bp.' : null;

  useHotkey(ActionIds.OverlayRepeats, () => toggle('repeats'), { modes: ['NORMAL'] });

  // Reading and computing share one selection/parameter-scoped cancellation.
  // Repository reads may not be interruptible, but an abandoned read must never
  // launch a worker or publish a result under a newer selection.
  useEffect(() => {
    if (!isOpen('repeats')) return () => { importGeneration.current++; };
    setImportLoading(false);
    setImportError(null);
    setError(null);
    setExportError(null);
    setSnapshot(null);
    setWasCancelled(false);
    setAnalysisLoading(false);
    if (!repository || !currentPhage) {
      setSequenceLoading(false);
      return () => { importGeneration.current++; };
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    let reading = true;
    setSequenceLoading(true);
    (async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (controller.signal.aborted) return;
        const sequence = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (controller.signal.aborted) return;
        if (parameters.replay && sequence !== parameters.replay.sequence) {
          throw new Error('Saved experiment sequence does not match the selected genome. Load its exact source genome before replaying.');
        }
        reading = false;
        setSequenceLoading(false);
        if (!sequence) return;
        setAnalysisLoading(true);
        const result = await getOrchestrator().runAnalysisWithSharedBuffer(
          currentPhage.id,
          sequence,
          'repeats',
          { minLength: parameters.minLength, maxGap: parameters.maxGap },
          { accession: currentPhage.accession, source: currentPhage.localGenome ? 'local' : 'catalog' },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.type !== 'repeats') throw new Error('Unexpected analysis result');
        const replay = parameters.replay
          ? result.evidenceRecord
            ? compareRepeatReplay(parameters.replay.record, result.evidenceRecord)
            : { matches: false, differences: ['fresh result evidence is unavailable'], implementationMatches: false, exactRecord: false }
          : null;
        setSnapshot({ phage: currentPhage, repository, sequence, parameters, data: result, replay });
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setError(`${reading ? 'Could not load sequence' : 'Repeat analysis failed'}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!controller.signal.aborted) {
          setSequenceLoading(false);
          setAnalysisLoading(false);
        }
      }
    })();
    return () => {
      importGeneration.current++;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [isOpen, currentPhage, repository, parameters]);

  const cancelAnalysis = () => {
    importGeneration.current++;
    setImportLoading(false);
    setImportError(null);
    controllerRef.current?.abort();
    setSequenceLoading(false);
    setAnalysisLoading(false);
    setSnapshot(null);
    setError(null);
    setExportError(null);
    setWasCancelled(true);
  };

  const restoreExperiment = async (file: File) => {
    const generation = ++importGeneration.current;
    setImportLoading(true);
    setImportError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Analysis record exceeds the 10 MiB limit.');
      const replay = await parseRepeatReplay(await file.text());
      if (generation !== importGeneration.current) return;
      setMinLengthInput(String(replay.options.minLength));
      setMaxGapInput(String(replay.options.maxGap));
      // Only validated settings are restored. The saved outputs are never
      // installed as live results: the normal cancellable worker path reruns.
      setParameters({ ...replay.options, replay });
    } catch (cause) {
      if (generation === importGeneration.current) {
        setImportError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === importGeneration.current) setImportLoading(false);
    }
  };

  const direct = repeats.filter(r => r.type === 'direct');
  const inverted = repeats.filter(r => r.type === 'inverted');
  const palindromes = repeats.filter(r => r.type === 'palindrome');
  const tandem = repeats.filter(r => r.type === 'tandem');

  if (!isOpen('repeats')) return null;

  const typeColors = {
    direct: colors.primary, inverted: colors.warning,
    palindrome: colors.accent, tandem: colors.info,
  };
  const typeIcons = { direct: '→→', inverted: '→←', palindrome: '↔', tandem: '⟲' };

  return (
    <Overlay id="repeats" title="REPEATS & PALINDROMES" hotkey="r" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <form aria-label="Repeat search parameters" onSubmit={event => {
          event.preventDefault();
          if (parameterError || !repository || !currentPhage) return;
          importGeneration.current++;
          // A new parameter snapshot also allows retrying the same experiment.
          setParameters({ minLength, maxGap });
        }} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '0.75rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            Minimum pair arm length (bp)
            <input type="number" min={4} max={256} step={1} required value={minLengthInput}
              onChange={event => setMinLengthInput(event.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            Maximum pair gap (bp)
            <input type="number" min={0} max={100000} step={1} required value={maxGapInput}
              onChange={event => setMaxGapInput(event.target.value)} />
          </label>
          <button type="submit" disabled={!!parameterError || !repository || !currentPhage}>
            {sequenceLoading || analysisLoading ? 'Restart analysis' : 'Run analysis'}
          </button>
          {(sequenceLoading || analysisLoading || importLoading) && <button type="button" onClick={cancelAnalysis}>Cancel analysis</button>}
          {parameterError && <p role="alert" style={{ width: '100%' }}>{parameterError}</p>}
        </form>
        <label>
          Restore repeat experiment (.json)
          <input type="file" accept=".json,application/json" disabled={!repository || !currentPhage}
            onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void restoreExperiment(file);
            }} />
        </label>
        {importLoading && <p role="status">Validating saved experiment...</p>}
        {importError && <p role="alert">Could not restore repeat experiment: {importError}</p>}
        <p style={{ color: colors.textDim, margin: 0, fontSize: '0.85rem' }}>
          These settings control sampled repeat pairs; detailed palindrome and tandem limits are shown below.
          Editing settings does not change a completed result until you run the analysis again.
        </p>
        {wasCancelled && <p role="status">Analysis cancelled. Run analysis to try again.</p>}
        {currentSnapshot?.replay && <div role={currentSnapshot.replay.matches ? 'status' : 'alert'}>
          {currentSnapshot.replay.matches
            ? 'Replay matched: repeat results, search limits and evidence fields agree.'
            : `Replay differs: ${currentSnapshot.replay.differences.join('; ')}. Showing the newly computed result.`}
          {!currentSnapshot.replay.implementationMatches && <p>The execution backend differs from the saved record.</p>}
          {currentSnapshot.replay.matches && <p>{currentSnapshot.replay.exactRecord
            ? 'The complete result identity also matches.'
            : 'The complete record identity differs (explicit defaults, transport, backend or input metadata may have changed).'}</p>}
          <p>Reproducing computed results does not establish biological accuracy.</p>
        </div>}

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

        {!sequenceLoading && !analysisLoading && (
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px', color: colors.textDim, fontSize: '0.9rem' }}>
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

        {result && !error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
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

        {result && !error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{ maxHeight: '300px', overflowY: 'auto', border: `1px solid ${colors.borderLight}`, borderRadius: '4px' }}>
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
                  <tr key={idx} style={{ borderTop: `1px solid ${colors.borderLight}`, backgroundColor: idx % 2 === 0 ? 'transparent' : colors.backgroundAlt }}>
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
                    <td style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>{repeat.length} bp</td>
                  </tr>
                ))}
                {repeats.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>No repeats found within these search limits</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!error && !sequenceLoading && !analysisLoading && sequence.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem', color: colors.textMuted, fontSize: '0.85rem' }}>
            <span><span style={{ color: colors.primary }}>→→</span> Direct (same strand)</span>
            <span><span style={{ color: colors.warning }}>→←</span> Inverted (reverse complement)</span>
            <span><span style={{ color: colors.accent }}>↔</span> Palindrome (self-complementary)</span>
            <span><span style={{ color: colors.info }}>⟲</span> Tandem (consecutive copies)</span>
          </div>
        )}

        {!wasCancelled && !error && !sequenceLoading && !analysisLoading && sequence.length === 0 && (
          <OverlayEmptyState message="No sequence data available" hint="Select a phage to analyze repeats and palindromes." />
        )}
      </div>
    </Overlay>
  );
}

export default RepeatsOverlay;
