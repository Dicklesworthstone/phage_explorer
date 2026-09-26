/** Local abundance workspace. Analysis is explicit, worker-backed and never falls back to synthetic input. */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { serializeAbundanceDataset, serializeAnalysisRecord, type AbundanceOptions, type AbundanceAnalysis } from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';
import { AbundanceSession } from '../../workers/AbundanceSession';
import type { AbundanceRequest } from '../../workers/abundance-runtime';

type NumericOption = Exclude<keyof AbundanceOptions, 'includeNegative'>;
type Draft = Record<NumericOption, string> & { includeNegative: boolean };
const CONTROLS: Array<{ id: NumericOption; label: string; min: number; max: number; step: number | 'any' }> = [
  { id: 'pseudocount', label: 'Pseudocount (input units)', min: 0, max: 1e12, step: 'any' },
  { id: 'numNiches', label: 'NMF factors', min: 1, max: 8, step: 1 },
  { id: 'correlationThreshold', label: 'Minimum absolute correlation', min: 0, max: 1, step: 'any' },
  { id: 'qvalueThreshold', label: 'Maximum BH-adjusted p-value', min: 0, max: 1, step: 'any' },
  { id: 'permutations', label: 'Pairing permutations', min: 19, max: 999, step: 1 },
  { id: 'seed', label: 'Abundance analysis seed', min: 0, max: 0xffffffff, step: 1 },
];
const toDraft = (options: AbundanceOptions): Draft => ({ ...Object.fromEntries(CONTROLS.map(({ id }) => [id, String(options[id])])),
  includeNegative: options.includeNegative }) as Draft;
const fromDraft = (draft: Draft): AbundanceOptions => ({ ...Object.fromEntries(CONTROLS.map(({ id }) =>
  [id, draft[id].trim() === '' ? NaN : Number(draft[id])])), includeNegative: draft.includeNegative }) as AbundanceOptions;

function AssociationNetwork({ analysis }: { analysis: AbundanceAnalysis }): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const positions = analysis.taxa.map((taxon, i) => ({ taxon, x: 250 + 175 * Math.cos(2 * Math.PI * i / analysis.taxa.length),
    y: 210 + 175 * Math.sin(2 * Math.PI * i / analysis.taxa.length) }));
  const byTaxon = new Map(positions.map(node => [node.taxon, node]));
  const visibleEdges = analysis.edges.slice(0, 300);
  return <figure style={{ margin: 0 }}>
    <svg viewBox="0 0 500 420" style={{ width: '100%', maxHeight: 360 }} role="img" aria-label="Exploratory abundance association network">
      {visibleEdges.map(edge => {
        const source = byTaxon.get(edge.source)!, target = byTaxon.get(edge.target)!;
        return <line key={`${edge.source}\0${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
          stroke={edge.correlation > 0 ? colors.primary : colors.warning} strokeWidth={1 + Math.abs(edge.correlation)}
          strokeDasharray={edge.correlation < 0 ? '5 4' : undefined} opacity={0.6} />;
      })}
      {positions.map((node, i) => <g key={node.taxon}>
        <circle cx={node.x} cy={node.y} r={10} fill={colors.backgroundAlt} stroke={colors.primary} />
        <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize={11} fill={colors.text}>{i + 1}</text>
        <title>{node.taxon}</title>
      </g>)}
    </svg>
    <figcaption>Solid: positive CLR association. Dashed: negative. Neither establishes an ecological interaction.
      {analysis.edges.length > visibleEdges.length && ` Showing ${visibleEdges.length}/${analysis.edges.length} edges; all are available in the table and export.`}
    </figcaption>
  </figure>;
}

export function NicheNetworkOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const { isOpen, toggle } = useOverlay();
  const open = isOpen('nicheNetwork');
  const session = useMemo(() => new AbundanceSession(() => new Worker(new URL('../../workers/abundance.worker.ts', import.meta.url), { type: 'module' })), []);
  const { accepted, loading, phase, error, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [taxon, setTaxon] = useState('');
  const [page, setPage] = useState(0);
  const [showAllPairs, setShowAllPairs] = useState(false);
  useHotkey(ActionIds.OverlayNicheNetwork, () => toggle('nicheNetwork'), { modes: ['NORMAL'] });
  useEffect(() => { if (open) session.activate(); else session.deactivate(); return session.deactivate; }, [open, session]);
  useEffect(() => {
    if (accepted) setDraft(toDraft(accepted.options));
    setFileError(null); setPage(0); setTaxon(accepted?.analysis?.taxa[0] ?? '');
  }, [accepted]);
  useEffect(() => { setPage(0); }, [showAllPairs]);
  if (!open) return null;

  const colors = theme.colors;
  const analysis = accepted?.analysis;
  const record = accepted?.record;
  const pairs = analysis ? showAllPairs ? analysis.associations : analysis.edges : [];
  const pageCount = Math.max(1, Math.ceil(pairs.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const profile = analysis?.profiles.find(item => item.taxon === taxon);
  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '.3rem' };
  const inputStyle: React.CSSProperties = { padding: '.5rem', minHeight: 44, width: '100%', color: colors.text,
    background: colors.background, border: `1px solid ${colors.borderLight}`, borderRadius: 4 };
  const draftChanged = draft && accepted && (CONTROLS.some(({ id }) => Number(draft[id]) !== accepted.options[id]) || draft.includeNegative !== accepted.options.includeNegative);
  const loadFile = (file: File | undefined, metadata: boolean) => {
    if (!file) return;
    setFileError(null);
    const prior = accepted;
    const options = draft ? fromDraft(draft) : {};
    const request: Promise<AbundanceRequest> = file.size > 10 * 1024 * 1024
      ? Promise.reject(new Error('File exceeds the 10 MiB limit.'))
      : file.text().then(content => {
        if (metadata) {
          if (!prior) throw new Error('Load an abundance dataset before its metadata.');
          return { kind: 'metadata', content, dataset: prior.dataset, options };
        }
        return { kind: 'import', content, filename: file.name };
      });
    void session.run(request);
  };
  const exportData = (result: boolean) => {
    try {
      if (!accepted) return;
      const content = result && accepted.record ? serializeAnalysisRecord(accepted.record) : serializeAbundanceDataset(accepted.dataset);
      downloadString(content, result ? 'abundance-analysis.json' : 'abundance-dataset.json', 'application/json');
      setFileError(null);
    } catch (cause) { setFileError(cause instanceof Error ? cause.message : 'Could not export abundance data.'); }
  };

  return <Overlay id="nicheNetwork" title="ABUNDANCE ASSOCIATIONS & NICHE FACTORS" size="xl"
    provenanceBadge={<span data-testid="abundance-header-source" style={{ fontSize: '.75rem', color: colors.textDim }}
      title="Input provenance applies to the accepted dataset. Statistical associations are not measured ecological interactions.">
      {!accepted ? 'No input data' : accepted.dataset.source.kind === 'demo' ? 'Synthetic example' : 'User-supplied local data'}
    </span>}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', color: colors.text, overflowWrap: 'anywhere' }}>
      <section aria-label="Abundance data source" style={{ padding: '.75rem', border: `1px solid ${colors.borderLight}` }}>
        <strong data-testid="abundance-source">{accepted ? accepted.dataset.source.kind === 'demo'
          ? 'SYNTHETIC EXAMPLE — not observed community data' : 'LOCAL DATA — user-supplied, not independently verified' : 'NO DATA LOADED'}</strong>
        <p>Files are processed locally in a worker and are not uploaded. This community dataset is independent of the selected catalog phage;
          matching a taxon name does not establish a host or ecological relationship.</p>
        <label style={fieldStyle}>Import abundance CSV, TSV, dataset JSON or saved analysis
          <input type="file" accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json" disabled={loading}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; loadFile(file, false); }} />
        </label>
        <button type="button" disabled={loading} onClick={() => void session.run({ kind: 'demo', seed: 42 })}>Load synthetic example</button>
        <button type="button" disabled={!loading} onClick={session.cancel}>Cancel abundance work</button>
        {loading && <p role="status">{phase}. The last accepted dataset and result remain unchanged.</p>}
        {notice && <p role="status">{notice}</p>}
        {(error || fileError) && <p role="alert">{error ?? fileError}</p>}
      </section>
      <details>
        <summary>Input layout, metadata and supported scope</summary>
        <p>CSV/TSV header: <code>taxon,S1,S2,S3</code>. Subsequent rows: taxon identifier followed by finite nonnegative counts.
          Quoted fields and Unicode identifiers are supported. Blank/NA measurements are not silently treated as zeros.</p>
        <p>Load separate metadata with <code>sampleId,habitat,host,location</code> headers, or a JSON array of sampleId objects.
          Metadata joins by sample ID, not row order. Missing optional fields may be left blank.</p>
        <p>Dataset JSON preserves name, source description/reference, metadata and explicit units. Export a dataset to inspect the schema.
          Units are counts or relative-abundance (each nonempty sample sums to one); CSV/TSV defaults to counts.</p>
        <p>Limits: 100 taxa, 500 samples, 4 MiB per dataset, 10 MiB per saved analysis, and a bounded pairwise computation budget.
          At least two nonempty taxa and three nonempty samples are needed. No reference index is bundled or queried.</p>
      </details>
      {accepted && <>
        <h3 data-testid="abundance-dataset-name">{accepted.dataset.name}</h3>
        <p>{accepted.dataset.source.description}{accepted.dataset.source.reference ? ` · ${accepted.dataset.source.reference}` : ' · No external reference supplied.'}</p>
        <p>{accepted.dataset.table.taxa.length} taxa × {accepted.dataset.table.samples.length} samples; units: {accepted.dataset.units}.
          {` ${accepted.dataset.metadata.length} sample metadata records.`}</p>
        <label style={fieldStyle}>Attach sample metadata CSV, TSV or JSON
          <input type="file" accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json" disabled={loading}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; loadFile(file, true); }} />
        </label>
        {draft && <form onSubmit={event => { event.preventDefault(); setFileError(null);
          void session.run({ kind: 'analyze', dataset: accepted.dataset, options: fromDraft(draft) }); }}>
          <fieldset disabled={loading} style={{ padding: '.75rem', border: `1px solid ${colors.borderLight}` }}>
            <legend>Explicit analysis parameters</legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '.75rem' }}>
              {CONTROLS.map(control => <label key={control.id} style={fieldStyle}>{control.label}
                <input type="number" required min={control.min} max={control.max} step={control.step} value={draft[control.id]}
                  style={inputStyle} onChange={event => setDraft({ ...draft, [control.id]: event.target.value })} />
              </label>)}
            </div>
            <label><input type="checkbox" checked={draft.includeNegative}
              onChange={event => setDraft({ ...draft, includeNegative: event.target.checked })} /> Include negative associations</label>
            <p>Seed controls the permutation draws and NMF initialization, not the input measurements.
              {draftChanged && ' Edited values have not been applied; the displayed result and exports still use the last submitted parameters.'}</p>
            <button type="submit">Run abundance analysis</button>
          </fieldset>
        </form>}
        <div><button type="button" disabled={loading} onClick={() => exportData(false)}>Export abundance dataset</button>
          <button type="button" disabled={loading || !record} onClick={() => exportData(true)}>Export abundance analysis</button></div>
      </>}
      {analysis && record && <section data-testid="abundance-result" data-result-id={record.resultId}>
        <h3>Exploratory associations, not inferred interactions</h3>
        <p data-testid="abundance-summary">{analysis.taxa.length} retained taxa; {analysis.samples.length} retained samples;
          {` ${analysis.associations.length} tested pairs; ${analysis.edges.length} retained edges.`}</p>
        <p>Computed with pseudocount {analysis.options.pseudocount}, {analysis.options.numNiches} NMF factors, seed {analysis.options.seed};
          {` ${analysis.diagnostics.permutationMode} pairing test (${analysis.diagnostics.permutationsUsed} pairings); `}
          |r| ≥ {analysis.options.correlationThreshold}, adjusted p ≤ {analysis.options.qvalueThreshold}.</p>
        <p>Matched metadata: {analysis.diagnostics.metadataSamples}/{analysis.samples.length} retained samples.
          Empty taxa excluded: {analysis.diagnostics.excludedTaxa.join(', ') || 'none'}.
          Empty samples excluded: {analysis.diagnostics.excludedSamples.join(', ') || 'none'}.
          Undefined constant CLR trajectories: {analysis.diagnostics.constantTaxa.join(', ') || 'none'}.</p>
        <AssociationNetwork analysis={analysis} />
        <label><input type="checkbox" checked={showAllPairs} onChange={event => setShowAllPairs(event.target.checked)} /> Show all tested pairs, including filtered associations</label>
        <div style={{ overflowX: 'auto' }}><table aria-label="Abundance association statistics" style={{ width: '100%' }}>
          <thead><tr><th>Taxon A</th><th>Taxon B</th><th>Pearson r</th><th>Permutation p</th><th>BH-adjusted p</th></tr></thead>
          <tbody>{pairs.slice(currentPage * 100, (currentPage + 1) * 100).map(pair => <tr key={`${pair.source}\0${pair.target}`} data-testid="abundance-association">
            <td>{pair.source}</td><td>{pair.target}</td><td>{pair.correlation.toPrecision(6)}</td><td>{pair.pvalue.toPrecision(6)}</td><td>{pair.qvalue.toPrecision(6)}</td>
          </tr>)}</tbody>
        </table></div>
        {pairs.length === 0 && <p>No associations pass the selected filters. This is not evidence that ecological interactions are absent.</p>}
        {pageCount > 1 && <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous pairs</button>
          <span> Page {currentPage + 1}/{pageCount} </span>
          <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next pairs</button></div>}
        <h3>Descriptive NMF factors and sample-linked habitats</h3>
        <div style={fieldStyle}>
          <label htmlFor="abundance-inspect-taxon">Inspect taxon</label>
          <select id="abundance-inspect-taxon" style={inputStyle} value={taxon} onChange={event => setTaxon(event.target.value)}>
            {analysis.taxa.map((name, index) => <option value={name} key={name}>{index + 1}. {name}</option>)}
          </select>
        </div>
        {profile && <div data-testid="abundance-profile">
          <p>Factor weights: {profile.factorWeights.map((value, index) => `F${index + 1} ${(100 * value).toFixed(2)}%`).join(' · ')}.
            These are descriptive memberships, not probabilities. Reconstruction residual: {analysis.nmfResult.error.toPrecision(6)}.</p>
          <table aria-label="Sample-linked habitat summaries"><thead><tr><th>Habitat</th><th>Matched samples</th><th>Mean relative abundance</th></tr></thead>
            <tbody>{profile.habitats.map(habitat => <tr key={habitat.habitat}><td>{habitat.habitat}</td><td>{habitat.samples}</td>
              <td>{(100 * habitat.meanRelativeAbundance).toFixed(4)}%</td></tr>)}</tbody></table>
          {profile.habitats.length === 0 && <p>No matched habitat metadata is available for this dataset.</p>}
        </div>}
        {analysis.diagnostics.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <AnalysisRecordDetails record={record} />
      </section>}
    </div>
  </Overlay>;
}
