import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PhageSummary } from '@phage-explorer/core';
import { REGION_COMPARISON_LIMITS, type RegionInterval } from '../../../../comparison/src/region-comparison-experiment';
import type { PhageRepository } from '../../db';
import { useLocalGenomes } from '../../db/local-genomes';
import { replaySavedResearch } from '../../db/research-storage';
import { readLocalTextFile } from '../../utils/fileSystem';
import { downloadString } from '../../utils/export';
import {
  RegionComparisonSession, type RegionComparisonDownload, type RegionComparisonScope, type RegionComparisonWorkResult,
} from '../../workers/RegionComparisonSession';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { SavedResearchPanel } from './SavedResearchPanel';

const PAGE_SIZE = 25;
const preview = (value: string | null) => value === null ? '—' : value.length > 160 ? value.slice(0, 160) + '…' : value;
function interval(start: number, end: number): string {
  return start === end ? start === 0 ? 'before base 1' : 'after base ' + start.toLocaleString()
    : (start + 1).toLocaleString() + '–' + end.toLocaleString();
}
interface RegionDraft { start: string; end: string; strand: '+' | '-' }
function initialDraft(phage: PhageSummary | null): RegionDraft {
  return { start: '1', end: phage?.genomeLength ? String(Math.min(phage.genomeLength, 1000)) : '', strand: '+' };
}
function submittedRegion(draft: RegionDraft, phage: PhageSummary | null, side: string): RegionInterval {
  const start = draft.start.trim() ? Number(draft.start) : NaN, end = draft.end.trim() ? Number(draft.end) : NaN;
  if (!phage || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start
    || end - start + 1 > REGION_COMPARISON_LIMITS.regionBases || phage.genomeLength !== null && end > phage.genomeLength) {
    throw new Error('Region ' + side + ' needs one-based inclusive integer bounds within its selected source, at most '
      + REGION_COMPARISON_LIMITS.regionBases.toLocaleString() + ' bases.');
  }
  return { start: start - 1, end, strand: draft.strand };
}

export function RegionComparisonResults({ value, page = 0, busy = false, onPage = () => {}, onExport = () => {} }: {
  value: RegionComparisonWorkResult;
  page?: number;
  busy?: boolean;
  onPage?: (page: number) => void;
  onExport?: (kind: RegionComparisonDownload) => void;
}): React.ReactElement {
  const { experiment, verified } = value, { result, record } = experiment;
  const pages = Math.max(1, Math.ceil(result.runs.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(page, pages - 1)), first = currentPage * PAGE_SIZE;
  const runs = result.runs.slice(first, first + PAGE_SIZE);
  return <section aria-label="Accepted source region comparison" data-testid="region-comparison-result" data-result-id={record.resultId}>
    <h4>{verified ? 'Verified saved region comparison' : 'Exact source region comparison'}</h4>
    {verified && <p>These saved sources and regions are independent of the current explorer selection.</p>}
    {([
      ['A', result.sourceA, result.regionA, experiment.inputA],
      ['B', result.sourceB, result.regionB, experiment.inputB],
    ] as const).map(([side, source, region, input]) => <div key={side} aria-label={'Accepted region source ' + side}>
      <p><strong>{side}: {preview(source.name)}</strong> · {preview(source.accession)} · source bases {interval(region.start, region.end)}
        {' '}· {region.strand === '+' ? 'forward strand (+)' : 'reverse complement (−)'} · {region.sequence.length.toLocaleString()} compared bases.</p>
      <p>Accepted source input: {preview(input.name)} · complete source: {source.genomeLength.toLocaleString()} bases · {source.format}.
        {source.format === 'catalog-snapshot' && ' Captured catalog bases and annotations; this is not an original GenBank file.'}</p>
      <details><summary>Source {side} identity</summary>
        <p>Content ID: <code>{source.contentId}</code></p><p>Sequence SHA-256: <code>{source.sequenceSha256}</code></p>
      </details>
    </div>)}
    <p>Edit distance: <strong>{result.stats.distance.toLocaleString()}</strong>. {result.stats.substitutions.toLocaleString()} substituted,
      {' '}{result.stats.insertions.toLocaleString()} inserted and {result.stats.deletions.toLocaleString()} deleted bases.
      {' '}Equal symbols: {result.stats.matches.toLocaleString()} / {result.stats.alignmentColumns.toLocaleString()} alignment columns;
      {' '}{result.stats.ambiguousColumns.toLocaleString()} columns contain ambiguous bases.</p>
    <p>The alignment uses the chosen strand and exact source interval. Ambiguous IUPAC symbols match literally; alternative optimal alignments
      can place edits differently in repeats. Source-coordinate ranges below are ascending even for a reverse-complemented region.</p>
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <button type="button" className="btn" disabled={busy} onClick={() => onExport('json')}>Export region analysis JSON</button>
      <button type="button" className="btn" disabled={busy} onClick={() => onExport('tsv')}>Export region edit TSV</button>
      <button type="button" className="btn" disabled={busy} onClick={() => onExport('fasta')}>Export aligned region FASTA</button>
    </div>
    <p>JSON retains both complete accepted source inputs, selected records, intervals, strands and results for standalone replay.
      TSV retains every mapped alignment run; FASTA contains both complete oriented, gapped sequences.</p>
    <p>Alignment runs {first + 1}–{first + runs.length} of {result.runs.length.toLocaleString()}, including unchanged runs.
      Displayed ranges are one-based and inclusive; empty sides name an interbase boundary. JSON and TSV retain zero-based, half-open coordinates.</p>
    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
      <button type="button" className="btn" disabled={currentPage === 0} onClick={() => onPage(currentPage - 1)}>Previous region runs</button>
      <button type="button" className="btn" disabled={currentPage + 1 >= pages} onClick={() => onPage(currentPage + 1)}>Next region runs</button>
    </div>
    <div style={{ overflowX: 'auto' }}><table aria-label="Source region alignment coordinates">
      <thead><tr><th>Operation</th><th>A source</th><th>B source</th><th>A oriented region</th><th>B oriented region</th></tr></thead>
      <tbody>{runs.map((run, index) => <tr key={first + index}>
        <td>{run.operation}</td><td>{interval(run.sourceStartA, run.sourceEndA)}</td><td>{interval(run.sourceStartB, run.sourceEndB)}</td>
        <td>{interval(run.startA, run.endA)}</td><td>{interval(run.startB, run.endB)}</td>
      </tr>)}</tbody>
    </table></div>
    <details><summary>Source annotation context ({result.annotationsA.length} A / {result.annotationsB.length} B)</summary>
      <p>Only actual annotated segments overlapping the interval are included. A clipped segment does not become a complete CDS.
        These annotations supply context, not inferred homology or translated proteins.</p>
      {([['A', result.annotationsA], ['B', result.annotationsB]] as const).map(([side, annotations]) => <div key={side}>
        <h5>Source {side}</h5>
        {annotations.length === 0 ? <p>No mapped annotation segments overlap this region.</p> : <ul>{annotations.slice(0, 20).map((row, index) => <li key={index}>
          {preview(row.gene.locusTag ?? row.gene.name)} · {preview(row.gene.product)} · {row.fullyContained ? 'fully contained' : 'partly outside the region'}
          {' '}· {row.segments.map(segment => interval(segment.sourceStart, segment.sourceEnd) + ' → ' + interval(segment.regionStart, segment.regionEnd)).join('; ')}
        </li>)}</ul>}
        {annotations.length > 20 && <p>Showing the first 20 annotations. Every context row and its complete original gene annotation remains in JSON.</p>}
      </div>)}
    </details>
    {result.annotationWarnings.length > 0 && <details><summary>{result.annotationWarnings.length} annotation warnings</summary>
      <ul>{result.annotationWarnings.slice(0, 20).map((warning, index) => <li key={index}>{preview(warning)}</li>)}</ul>
      <p>Every warning is retained in JSON. An annotation warning does not replace the exact DNA alignment.</p>
    </details>}
    <details><summary>Region method limits</summary><ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>
    <AnalysisRecordDetails record={record} />
  </section>;
}

/** The comparison overlay's source selectors also select these exact intervals.
 * Reopening an experiment needs neither a catalog connection nor a selected pair.
 */
export function RegionComparisonPanel({ repository, phageA, phageB, active = true, externalBusy = false, onStart, onActivityChange }: {
  repository: PhageRepository | null;
  phageA: PhageSummary | null;
  phageB: PhageSummary | null;
  active?: boolean;
  externalBusy?: boolean;
  onStart?: () => void;
  onActivityChange?: (busy: boolean) => void;
}): React.ReactElement {
  const genomes = useLocalGenomes(state => state.genomes);
  const contentIdA = phageA?.localGenome?.contentId, contentIdB = phageB?.localGenome?.contentId;
  const localA = contentIdA ? genomes.find(genome => genome.phage.localGenome?.contentId === contentIdA) ?? null : null;
  const localB = contentIdB ? genomes.find(genome => genome.phage.localGenome?.contentId === contentIdB) ?? null : null;
  const scope = useMemo<RegionComparisonScope>(() => ({ repository, phageA, phageB, localA, localB }), [repository, phageA, phageB, localA, localB]);
  const session = useMemo(() => new RegionComparisonSession(() =>
    new Worker(new URL('../../workers/region-comparison.worker.ts', import.meta.url), { type: 'module' })), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const state = snapshot.scope === scope ? snapshot : null, accepted = state ? session.getAccepted(scope) : null;
  const [draftA, setDraftA] = useState(() => initialDraft(phageA)), [draftB, setDraftB] = useState(() => initialDraft(phageB));
  const [page, setPage] = useState(0), [inputError, setInputError] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const busy = Boolean(state?.busy || libraryBusy || externalBusy);
  const canCompare = Boolean(phageA && phageB && (phageA.localGenome ? localA : repository) && (phageB.localGenome ? localB : repository));
  useEffect(() => { if (active) session.activate(); else session.deactivate(); return session.deactivate; }, [active, session]);
  useEffect(() => {
    session.setScope(scope); setDraftA(initialDraft(phageA)); setDraftB(initialDraft(phageB)); setPage(0); setInputError(null);
  }, [session, scope, phageA, phageB]);
  useEffect(() => { setPage(0); }, [accepted?.experiment.record.resultId]);
  useEffect(() => { onActivityChange?.(Boolean(state?.busy || libraryBusy)); }, [state?.busy, libraryBusy, onActivityChange]);
  useEffect(() => () => onActivityChange?.(false), [onActivityChange]);

  const run = () => {
    try {
      const regionA = submittedRegion(draftA, phageA, 'A'), regionB = submittedRegion(draftB, phageB, 'B');
      setInputError(null); onStart?.(); void session.analyze(scope, { regionA, regionB });
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : 'Invalid source region.'); }
  };
  const reopen = (file: File | undefined) => {
    if (!file) return;
    setInputError(null); onStart?.();
    void session.replay(scope, signal => readLocalTextFile(file, REGION_COMPARISON_LIMITS.recordBytes, signal));
  };
  const capture = (): string => {
    const file = session.export(scope, 'json');
    if (!file) throw new Error('Region sources changed or work is still running. Prepare the current result before saving.');
    return file.content;
  };
  const restore = async (content: string, signal: AbortSignal): Promise<void> => {
    setInputError(null); onStart?.();
    await replaySavedResearch(signal, {
      run: () => session.replay(scope, content), cancel: session.cancel, error: () => session.getSnapshot().error,
    });
  };
  const download = (kind: RegionComparisonDownload) => {
    try {
      const file = session.export(scope, kind);
      if (!file) throw new Error('Region sources changed or work is still running. Prepare the current result before exporting.');
      downloadString(file.content, file.filename, file.mimeType); setInputError(null);
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : 'Could not export the region comparison.'); }
  };
  return <details className="panel" aria-label="Source region comparison">
    <summary>Compare source regions and strands</summary>
    <p>Use comparison source genomes A and B, then enter the exact regions to align. The same source can be used twice.
      Accepted local source records and captured catalog sources travel with the saved result.</p>
    <p>Enter one-based, inclusive source coordinates. The initial draft covers up to the first 1,000 bases of each source.
      Minus strand reverse-complements the chosen interval; bounds always refer to the original source.
      Each interval is non-wrapping and at most {REGION_COMPARISON_LIMITS.regionBases.toLocaleString()} bases.</p>
    {([
      ['A', phageA, draftA, setDraftA], ['B', phageB, draftB, setDraftB],
    ] as const).map(([side, phage, draft, setDraft]) => <fieldset key={side} disabled={!active || !state || busy || !phage}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      <legend>Source region {side}: {phage ? preview(phage.name) + ' · ' + preview(phage.accession) : 'choose a source'}</legend>
      <label>Region {side} start (inclusive)<input type="number" min="1" max={phage?.genomeLength ?? undefined} step="1"
        value={draft.start} onChange={event => setDraft(previous => ({ ...previous, start: event.target.value }))} /></label>
      <label>Region {side} end (inclusive)<input type="number" min="1" max={phage?.genomeLength ?? undefined} step="1"
        value={draft.end} onChange={event => setDraft(previous => ({ ...previous, end: event.target.value }))} /></label>
      <label>Region {side} strand<select value={draft.strand}
        onChange={event => setDraft(previous => ({ ...previous, strand: event.target.value as '+' | '-' }))}>
        <option value="+">Forward (+)</option><option value="-">Reverse complement (−)</option>
      </select></label>
    </fieldset>)}
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-primary" disabled={!active || !state || busy || !canCompare} onClick={run}>Compare source regions</button>
      {state?.busy && <button type="button" className="btn" onClick={session.cancel}>Cancel region comparison</button>}
    </div>
    {!canCompare && <p>Choose both source genomes to run, or reopen a complete saved region experiment below.</p>}
    <label>Reopen source region comparison JSON <input aria-label="Reopen source region comparison JSON" type="file" accept=".json,application/json"
      disabled={!active || !state || busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; reopen(file); }} /></label>
    <p>Saved inputs are recomputed before acceptance, without changing the explorer selection. Failed or cancelled work preserves accepted evidence.
      A source change retires it. Inputs and the complete portable record must fit within 10 MiB; an exact alignment that exceeds its budget is refused.</p>
    <p role="status" data-testid="region-comparison-status">{state?.busy ? state.phase : state?.notice ?? 'Choose exact source intervals, or reopen saved evidence.'}</p>
    {(inputError || state?.error) && <p role="alert">{inputError ?? state?.error}</p>}
    <SavedResearchPanel kind="region-comparison" suggestedName={accepted
      ? accepted.experiment.result.sourceA.name + ' region vs ' + accepted.experiment.result.sourceB.name : 'Source region comparison'}
      disabled={!active || !state || Boolean(state.busy) || externalBusy} capture={accepted ? capture : null} restore={restore} onActivityChange={setLibraryBusy} />
    {accepted && <RegionComparisonResults value={accepted} page={page} busy={busy} onPage={setPage} onExport={download} />}
  </details>;
}
