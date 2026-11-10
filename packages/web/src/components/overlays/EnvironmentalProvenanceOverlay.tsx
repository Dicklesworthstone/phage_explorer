/** Local sample evidence, with explicit public lookup and independently labelled catalogue comparison. */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisRecord, PhageFull } from '@phage-explorer/core';
import { BIOME_NAMES, serializeAnalysisRecord } from '@phage-explorer/core';
import { SketchCache, initMinHashWasm, type ContainmentMethod } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import {
  environmentalEvidenceTsv,
  serializeEnvironmentalDataset,
  type EnvironmentalAnalysis,
  type EnvironmentalDataset,
} from '../../../../core/src/analysis/environmental-evidence';
import type { PhageRepository } from '../../db';
import type { ThemePalette } from '../../theme/types';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks/useHotkey';
import { ActionIds } from '../../keyboard';
import { EnvironmentalSession, readEnvironmentalFile } from '../../workers/EnvironmentalSession';
import { fetchPublicEnvironmentalContext } from '../../api/environmental-evidence';
import { downloadString } from '../../utils/export';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

type ViewMode = 'overview' | 'biomes' | 'geography' | 'observations';
const VIEW_NAMES: Record<ViewMode, string> = { overview: 'Overview', biomes: 'Biomes', geography: 'Geography', observations: 'All observations' };
const OCCURRENCE = { detected: 'Detected', 'not-detected': 'Not detected in this assay', 'not-assayed': 'Not assayed' } as const;
const PAGE_SIZE = 50;

export function environmentalSourceLabel(dataset: EnvironmentalDataset): string {
  if (dataset.source.kind === 'demo') return 'SYNTHETIC EXAMPLE — not observed environmental data';
  if (dataset.source.kind === 'external') return 'EXTERNAL SOURCE — supplied source, not independently verified';
  return 'LOCAL INPUT — supplied observations, not independently verified';
}

function SourceLabel({ dataset }: { dataset: EnvironmentalDataset }): React.ReactElement {
  return <p data-testid="environmental-figure-source" style={{ fontSize: '.8rem', margin: '.25rem 0', overflowWrap: 'anywhere' }}>
    {environmentalSourceLabel(dataset)} · {dataset.query.label} · {dataset.source.study}
  </p>;
}

function dateDescription(value: string | null): string {
  if (value === null) return 'Not reported';
  return `${value} (${value.length === 4 ? 'year only' : value.length === 7 ? 'month precision' : 'day precision'})`;
}

/** The visible source stamp is part of each SVG, so it survives copying the figure. */
export function EnvironmentalBiomeFigure({ dataset, analysis, colors }: {
  dataset: EnvironmentalDataset; analysis: EnvironmentalAnalysis; colors: ThemePalette;
}): React.ReactElement {
  const height = 112 + analysis.biomes.length * 38;
  const maximum = Math.max(1, ...analysis.biomes.map(biome => biome.samples));
  return <figure style={{ margin: 0 }}>
    <SourceLabel dataset={dataset} />
    <svg viewBox={`0 0 720 ${height}`} role="img" aria-label="Environmental observations by biome and assay status"
      style={{ width: '100%', maxHeight: 470, background: colors.backgroundAlt }}>
      <title>{dataset.query.label}: sample counts by biome</title>
      <desc>Stacked counts of detected, not detected, and not assayed observations. These are sample counts, not ecological prevalence.</desc>
      <text x={14} y={22} fill={colors.text} fontSize={12}>{dataset.source.kind === 'demo' ? 'DEMO DATA — synthetic sample set' : `${dataset.source.kind.toUpperCase()} INPUT — sample metadata`}</text>
      <text x={14} y={42} fill={colors.textDim} fontSize={11}>Query: {dataset.query.label.slice(0, 80)}</text>
      {analysis.biomes.map((biome, index) => {
        const y = 59 + index * 38;
        const scale = 445 / maximum;
        return <g key={biome.biome}>
          <text x={14} y={y + 17} fill={colors.text} fontSize={12}>{BIOME_NAMES[biome.biome]}</text>
          <rect x={176} y={y} width={biome.detected * scale} height={24} fill={colors.primary} />
          <rect x={176 + biome.detected * scale} y={y} width={biome.notDetected * scale} height={24} fill={colors.secondary} />
          <rect x={176 + (biome.detected + biome.notDetected) * scale} y={y} width={biome.notAssayed * scale} height={24} fill={colors.textMuted} />
          <text x={633} y={y + 17} fill={colors.text} fontSize={12}>{biome.samples} samples</text>
          <title>{`${BIOME_NAMES[biome.biome]}: ${biome.detected} detected, ${biome.notDetected} not detected, ${biome.notAssayed} not assayed`}</title>
        </g>;
      })}
      <text x={14} y={height - 13} fill={colors.textDim} fontSize={11}>Counts describe supplied samples; missing assays are not observed zeros.</text>
    </svg>
    <figcaption style={{ fontSize: '.85rem' }}>
      <span style={{ color: colors.primary }}>■ Detected</span> · <span style={{ color: colors.secondary }}>■ Not detected</span> · <span style={{ color: colors.textMuted }}>■ Not assayed</span>.
      Each sample appears once. Counts are not k-mer containment or ecological prevalence.
    </figcaption>
  </figure>;
}

export function EnvironmentalGeographyFigure({ dataset, analysis, colors }: {
  dataset: EnvironmentalDataset; analysis: EnvironmentalAnalysis; colors: ThemePalette;
}): React.ReactElement {
  const points = analysis.locations.slice(0, 1000);
  const x = (longitude: number) => 40 + (longitude + 180) / 360 * 640;
  const y = (latitude: number) => 53 + (90 - latitude) / 180 * 300;
  return <figure style={{ margin: 0 }}>
    <SourceLabel dataset={dataset} />
    <svg viewBox="0 0 720 400" role="img" aria-label="Reported environmental sample coordinates"
      style={{ width: '100%', maxHeight: 420, background: colors.backgroundAlt }}>
      <title>{dataset.query.label}: reported sample locations</title>
      <desc>Coordinate grid of supplied sample positions. Countries without reported coordinates are not assigned a centroid. Marker size does not represent abundance or coordinate precision.</desc>
      <text x={14} y={22} fill={colors.text} fontSize={12}>{dataset.source.kind === 'demo' ? 'DEMO DATA — synthetic sample set' : `${dataset.source.kind.toUpperCase()} INPUT — reported coordinates only`}</text>
      <text x={14} y={42} fill={colors.textDim} fontSize={11}>Query: {dataset.query.label.slice(0, 80)}</text>
      {[-90, -60, -30, 0, 30, 60, 90].map(latitude => <g key={latitude}>
        <line x1={40} x2={680} y1={y(latitude)} y2={y(latitude)} stroke={colors.borderLight} />
        <text x={5} y={y(latitude) + 4} fill={colors.textDim} fontSize={10}>{latitude}°</text>
      </g>)}
      {[-180, -120, -60, 0, 60, 120, 180].map(longitude => <g key={longitude}>
        <line x1={x(longitude)} x2={x(longitude)} y1={53} y2={353} stroke={colors.borderLight} />
        <text x={x(longitude)} y={369} textAnchor="middle" fill={colors.textDim} fontSize={10}>{longitude}°</text>
      </g>)}
      {points.map(point => <circle key={point.sampleId} data-sample-id={point.sampleId}
        cx={x(point.longitude)} cy={y(point.latitude)} r={5}
        fill={point.occurrence === 'detected' ? colors.primary : point.occurrence === 'not-assayed' ? colors.textMuted : colors.backgroundAlt}
        stroke={point.occurrence === 'not-detected' ? colors.secondary : colors.text} strokeWidth={1.5}>
        <title>{`${point.sampleId}: ${point.latitude}, ${point.longitude}; ${OCCURRENCE[point.occurrence]}; ${point.uncertaintyKm === null ? 'uncertainty not reported' : `stated uncertainty ${point.uncertaintyKm} km`}`}</title>
      </circle>)}
      <text x={14} y={392} fill={colors.textDim} fontSize={11}>Fixed-size markers show reported centres; uncertainty remains in the observation table.</text>
    </svg>
    <figcaption>
      {analysis.totals.located}/{analysis.totals.samples} observations have coordinates; {analysis.totals.samples - analysis.totals.located} remain in the table without a map position.
      {analysis.locations.length > points.length && ` Showing the first ${points.length} markers; export contains every observation.`}
      {' '}Filled accent: detected; outline: not detected; muted: not assayed. Missing uncertainty is not zero uncertainty.
    </figcaption>
  </figure>;
}

export function EnvironmentalObservationTable({ dataset, page = 0 }: { dataset: EnvironmentalDataset; page?: number }): React.ReactElement {
  const start = page * PAGE_SIZE;
  return <div style={{ overflowX: 'auto' }}>
    <SourceLabel dataset={dataset} />
    <table aria-label="Environmental sample observations" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th>Sample / accession</th><th>Assay outcome</th><th>Abundance</th><th>Biome / country</th><th>Reported location / uncertainty</th><th>Collection date</th></tr></thead>
      <tbody>{dataset.samples.slice(start, start + PAGE_SIZE).map(sample => <tr key={sample.id} data-testid="environmental-observation">
        <td>{sample.id}<br />{sample.accession ?? 'No accession supplied'}</td>
        <td>{OCCURRENCE[sample.occurrence]}</td>
        <td>{sample.abundance === null ? 'Not measured' : String(sample.abundance)}</td>
        <td>{BIOME_NAMES[sample.biome]}<br />{sample.country ?? 'Country not reported'}</td>
        <td>{sample.location ? <>{sample.location.latitude}, {sample.location.longitude}<br />
          {sample.location.uncertaintyKm === null ? 'Uncertainty not reported' : `${sample.location.uncertaintyKm} km stated uncertainty`}</> : 'Coordinates not reported'}</td>
        <td>{dateDescription(sample.collectionDate)}</td>
      </tr>)}</tbody>
    </table>
    <p>Abundance units: {dataset.measurement.type}; normalization: {dataset.measurement.normalization}.
      A not-detected result is specific to the supplied assay and does not establish environmental absence.</p>
  </div>;
}

/** Pure result surface shared by the live workspace and scientific-label regression tests. */
export function EnvironmentalEvidenceResults({ dataset, analysis, record, view, colors, page = 0 }: {
  dataset: EnvironmentalDataset; analysis: EnvironmentalAnalysis; record: AnalysisRecord;
  view: ViewMode; colors: ThemePalette; page?: number;
}): React.ReactElement {
  return <section data-testid="environmental-result" data-result-id={record.resultId} style={{ display: 'grid', gap: '.75rem' }}>
    {view === 'overview' && <>
      <SourceLabel dataset={dataset} />
      <h3>Evidence for {dataset.query.label}</h3>
      <p>Query identifier: <code>{dataset.query.id}</code>{dataset.query.accession ? ` · ${dataset.query.accession}` : ' · No query accession supplied.'}</p>
      <dl data-testid="environmental-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '.75rem' }}>
        {([
          ['Samples', analysis.totals.samples], ['Assayed', analysis.totals.assayed], ['Detected', analysis.totals.detected],
          ['Not detected', analysis.totals.notDetected], ['Not assayed', analysis.totals.notAssayed],
          ['Located', analysis.totals.located], ['Dated', analysis.totals.dated],
        ] as const).map(([label, value]) => <div key={label} style={{ padding: '.75rem', background: colors.backgroundAlt }}>
          <dt>{label}</dt><dd style={{ margin: 0, fontSize: '1.3rem', fontWeight: 600 }}>{value}</dd>
        </div>)}
      </dl>
      <p>These are observations for the explicitly supplied query and sample panel. Sample coverage and assay sensitivity limit interpretation.
        No novelty score, host range, ecological specialization, or metagenomic containment is inferred.</p>
    </>}
    {view === 'biomes' && <>
      <EnvironmentalBiomeFigure dataset={dataset} analysis={analysis} colors={colors} />
      <div style={{ overflowX: 'auto' }}><table aria-label="Environmental biome summaries" style={{ width: '100%' }}>
        <thead><tr><th>Biome</th><th>Samples</th><th>Assayed</th><th>Detected</th><th>Not detected</th><th>Not assayed</th><th>Detected / assayed</th><th>Mean abundance / measured samples</th></tr></thead>
        <tbody>{analysis.biomes.map(biome => <tr key={biome.biome}><td>{BIOME_NAMES[biome.biome]}</td><td>{biome.samples}</td><td>{biome.assayed}</td>
          <td>{biome.detected}</td><td>{biome.notDetected}</td><td>{biome.notAssayed}</td>
          <td>{biome.detectionFraction === null ? 'Unavailable — no assays' : `${(biome.detectionFraction * 100).toFixed(1)}%`}</td>
          <td>{biome.meanAbundance === null ? 'Not measured' : `${biome.meanAbundance.toPrecision(5)} / ${biome.abundanceSamples}`}</td></tr>)}</tbody>
      </table></div>
      <p>Detection fractions describe this sample panel and are not population prevalence. Abundance means use only reported values, in {dataset.measurement.type} units.</p>
    </>}
    {view === 'geography' && <EnvironmentalGeographyFigure dataset={dataset} analysis={analysis} colors={colors} />}
    {view === 'observations' && <EnvironmentalObservationTable dataset={dataset} page={page} />}
    {analysis.warnings.map(warning => <p key={warning} role="note">{warning}</p>)}
    <AnalysisRecordDetails record={record} />
  </section>;
}

interface CatalogResult {
  score: number; nearest: string; containment: number; method: ContainmentMethod; uncertainty: number; referenceCount: number;
}

/** An explicit local comparison, independent of the imported environmental query. */
function CatalogueDistinctiveness({ repository, currentPhage, open }: {
  repository: PhageRepository | null; currentPhage: PhageFull | null; open: boolean;
}): React.ReactElement {
  const phages = usePhageStore(state => state.phages);
  const scope = useMemo(() => ({ repository, currentPhage, phages }), [repository, currentPhage, phages]);
  const [state, setState] = useState<{ scope: typeof scope; loading: boolean; result: CatalogResult | null; error: string | null } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const owned = state?.scope === scope ? state : null;
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, [scope, open]);
  const compare = async () => {
    if (!repository || !currentPhage || !open) return;
    controller.current?.abort();
    const owner = new AbortController(); controller.current = owner;
    const current = () => !owner.signal.aborted && controller.current === owner;
    setState({ scope, loading: true, result: null, error: null });
    try {
      await initMinHashWasm();
      if (!current()) return;
      const cache = new SketchCache();
      const candidates = [currentPhage, ...phages.filter(phage => phage.id !== currentPhage.id)];
      let referenceCount = 0;
      for (const phage of candidates) {
        const length = await repository.getFullGenomeLength(phage.id);
        if (!current()) return;
        if (!Number.isSafeInteger(length) || length < 1) throw new Error(`No complete sequence is available for ${phage.name}.`);
        const sequence = await repository.getSequenceWindow(phage.id, 0, length);
        if (!current()) return;
        if (sequence.length !== length) throw new Error(`Incomplete sequence for ${phage.name}; no partial comparison was accepted.`);
        const sketch = cache.getOrBuild(String(phage.id), sequence);
        if (sketch && phage.id !== currentPhage.id) referenceCount++;
      }
      const best = cache.maxContainment(String(currentPhage.id));
      if (!best) throw new Error('No comparable reference genome is available.');
      if (current()) setState({ scope, loading: false, error: null, result: {
        score: 1 - best.containment, containment: best.containment,
        nearest: phages.find(phage => String(phage.id) === best.referenceId)?.name ?? best.referenceId,
        method: best.method, uncertainty: best.uncertainty, referenceCount,
      } });
    } catch (cause) {
      if (current()) setState({ scope, loading: false, result: null, error: cause instanceof Error ? cause.message : 'Local comparison failed.' });
    } finally { if (current()) controller.current = null; }
  };
  return <details>
    <summary>Separate local genome comparison</summary>
    <p>This compares {currentPhage?.name ?? 'the selected genome'} with other genomes in the loaded catalog. It does not use the environmental dataset or contact an external service.</p>
    <button type="button" disabled={!repository || !currentPhage || owned?.loading} onClick={() => void compare()}>Compare selected genome with local catalog</button>
    {owned?.loading && <><p role="status">Reading and comparing catalog sequences…</p><button type="button" onClick={() => {
      controller.current?.abort(); controller.current = null; setState({ scope, loading: false, result: null, error: null });
    }}>Cancel catalog comparison</button></>}
    {owned?.error && <p role="alert">{owned.error}</p>}
    {owned?.result && <p data-testid="environmental-catalog-result">
      {(owned.result.score * 100).toFixed(1)}% of the selected genome's 16-mers are absent from its closest individual reference, {owned.result.nearest}
      {' '}(contains {(owned.result.containment * 100).toFixed(1)}%{owned.result.method === 'estimated' ? ` ± ${(owned.result.uncertainty * 100).toFixed(1)} percentage points` : ''}).
      {' '}{owned.result.referenceCount} other genomes compared; {owned.result.method === 'estimated' ? 'MinHash estimate' : 'exact 16-mer containment'}.
      This is not absence from the union of all references, environmental novelty, or environmental abundance.
    </p>}
  </details>;
}

export function EnvironmentalProvenanceOverlay({ repository, currentPhage }: {
  repository: PhageRepository | null; currentPhage: PhageFull | null;
}): React.ReactElement | null {
  const { theme } = useTheme();
  const { isOpen, toggle } = useOverlay();
  const open = isOpen('environmentalProvenance');
  const id = useId();
  const session = useMemo(() => new EnvironmentalSession(() => new Worker(new URL('../../workers/environmental.worker.ts', import.meta.url), { type: 'module' })), []);
  const { accepted, loading, phase, error, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [paste, setPaste] = useState('');
  const [abundanceFile, setAbundanceFile] = useState<File | null>(null);
  const [taxon, setTaxon] = useState('');
  const [view, setView] = useState<ViewMode>('overview');
  const [page, setPage] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  useHotkey(ActionIds.OverlayEnvironmentalProvenance, () => toggle('environmentalProvenance'), { modes: ['NORMAL'] });
  useEffect(() => { if (open) session.activate(); else session.deactivate(); return session.deactivate; }, [open, session]);
  useEffect(() => { setPage(0); setView('overview'); setExportError(null); }, [accepted]);
  if (!open) return null;
  const colors = theme.colors;
  const dataset = accepted?.dataset;
  const inputStyle: React.CSSProperties = { padding: '.5rem', color: colors.text, background: colors.background, border: `1px solid ${colors.borderLight}`, width: '100%', minWidth: 0 };
  const pageCount = Math.max(1, Math.ceil((dataset?.samples.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const save = (format: 'dataset' | 'record' | 'tsv') => {
    if (!accepted) return;
    try {
      if (format === 'dataset') downloadString(serializeEnvironmentalDataset(accepted.dataset), 'environmental-dataset.json', 'application/json');
      else if (format === 'record' && accepted.record) downloadString(serializeAnalysisRecord(accepted.record), 'environmental-evidence.json', 'application/json');
      else if (format === 'tsv' && accepted.analysis) downloadString(environmentalEvidenceTsv(accepted.dataset, accepted.analysis), 'environmental-observations.tsv', 'text/tab-separated-values');
      setExportError(null);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : 'Could not export environmental evidence.'); }
  };
  return <Overlay id="environmentalProvenance" title="ENVIRONMENTAL SAMPLE EVIDENCE" size="xl"
    provenanceBadge={<span data-testid="environmental-header-source" style={{ fontSize: '.75rem', color: colors.textDim }}>{dataset ? environmentalSourceLabel(dataset) : 'No environmental input loaded'}</span>}>
    <section aria-label="Environmental evidence workspace" style={{ display: 'grid', gap: '1rem', color: colors.text, minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{ padding: '.75rem', border: `1px solid ${colors.borderLight}` }}>
        <strong data-testid="environmental-source">{dataset ? environmentalSourceLabel(dataset) : 'NO ENVIRONMENTAL DATA LOADED'}</strong>
        <p>Import sample observations for an explicit query or taxon. Local files are processed in a worker and are not uploaded.
          Changing the catalog phage does not rename the query or transform sample metadata into genome matches.</p>
        <label htmlFor={`${id}-import`}>Import environmental dataset or saved evidence JSON</label>
        <input id={`${id}-import`} type="file" accept=".json,application/json" disabled={loading}
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void session.importFile(file); }} />
        <details style={{ marginTop: '.75rem' }}><summary>Paste environmental dataset JSON</summary>
          <label htmlFor={`${id}-paste`}>Environmental JSON input</label>
          <textarea id={`${id}-paste`} rows={7} style={inputStyle} value={paste} onChange={event => setPaste(event.target.value)} disabled={loading} />
          <button type="button" disabled={loading || !paste.trim()} onClick={() => void session.run({ kind: 'import', content: paste })}>Load pasted environmental data</button>
        </details>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginTop: '.75rem' }}>
          <button type="button" disabled={loading} onClick={() => void session.run({ kind: 'demo' })}>Load synthetic environmental example</button>
          <button type="button" disabled={!loading} onClick={session.cancel}>Cancel environmental work</button>
        </div>
        {loading && <p role="status" data-testid="environmental-progress">{phase}. The last accepted input and result remain unchanged.</p>}
        {notice && <p role="status" data-testid="environmental-notice">{notice}</p>}
        {(error || exportError) && <p role="alert">{error ?? exportError}</p>}
      </div>
      <details><summary>Use a taxon from an abundance dataset</summary>
        <p>Export a dataset from the Abundance associations &amp; niche factors view, then select that file and enter its exact taxon identifier.
          Sample metadata joins by sample ID. Counts and relative abundance remain their original units; they are not containment.</p>
        <label htmlFor={`${id}-abundance`}>Abundance dataset JSON</label>
        <input id={`${id}-abundance`} type="file" accept=".json,application/json" disabled={loading}
          onChange={event => { setAbundanceFile(event.currentTarget.files?.[0] ?? null); }} />
        <label htmlFor={`${id}-taxon`}>Exact abundance taxon identifier</label>
        <input id={`${id}-taxon`} type="text" style={inputStyle} value={taxon} disabled={loading} onChange={event => setTaxon(event.target.value)} />
        <button type="button" disabled={loading || !abundanceFile || !taxon.trim()} onClick={() => {
          const file = abundanceFile, selectedTaxon = taxon;
          if (!file) return;
          void session.run(async signal => {
            const content = await readEnvironmentalFile(file);
            if (signal.aborted) throw new DOMException('Abundance input cancelled', 'AbortError');
            return { kind: 'abundance', content, taxon: selectedTaxon };
          });
        }}>Load selected abundance taxon</button>
      </details>
      <details><summary>Optional public reference context</summary>
        <p>This explicit lookup contacts Serratus and NCBI SRA for broad phage-family sample metadata. It sends no local file, genome, or selected-phage name.
          The records are not sequence matches for the selected phage; SRA metadata carries no sequence to compare against. Every record remains not assayed for the dataset query.</p>
        <button type="button" disabled={loading} onClick={() => void session.run(async signal => ({ kind: 'import', content: JSON.stringify(await fetchPublicEnvironmentalContext(signal)) }))}>Fetch public phage-family context</button>
      </details>
      <details><summary>Dataset fields and interpretation</summary>
        <p>Version 1 uses <code>format: phage-explorer-environmental</code>, a dataset name, an explicit <code>query</code> with ID/label/accession,
          a <code>source</code> with kind/study/reference/version/license, and <code>measurement</code> with type/method/normalization.</p>
        <p>Each sample has a unique ID, nullable accession, biome, nullable country/location/date, an occurrence value of detected, not-detected or not-assayed,
          and nullable abundance. Location carries latitude, longitude and nullable uncertainty in kilometres. Dates preserve YYYY, YYYY-MM or YYYY-MM-DD precision.</p>
        <p>Missing coordinates are not placed at country centroids; missing dates are not assigned a day; an unassayed sample is not an observed zero.
          Export the explicitly labelled synthetic example to inspect the full input layout.</p>
      </details>
      {dataset && <section aria-label="Accepted environmental input">
        <h3 data-testid="environmental-dataset-name">{dataset.name}</h3>
        <p>Query: <strong>{dataset.query.label}</strong> (<code>{dataset.query.id}</code>){dataset.query.accession ? ` · ${dataset.query.accession}` : ''}.</p>
        <p>{dataset.samples.length} sample records · {dataset.measurement.type} · method: {dataset.measurement.method} · normalization: {dataset.measurement.normalization}.</p>
        <p>Study/source: {dataset.source.study} · version: {dataset.source.version} · license: {dataset.source.license ?? 'Not supplied'}.
          {' '}Reference: {dataset.source.reference ?? 'Not supplied'}.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
          <button type="button" disabled={loading} onClick={() => void session.run({ kind: 'analyze', dataset })}>Analyze environmental observations</button>
          <button type="button" disabled={loading} onClick={() => save('dataset')}>Export environmental dataset</button>
          <button type="button" disabled={loading || !accepted?.record} onClick={() => save('record')}>Export environmental evidence</button>
          <button type="button" disabled={loading || !accepted?.analysis} onClick={() => save('tsv')}>Export all observations TSV</button>
        </div>
        {!accepted?.analysis && <p role="status">Input accepted. Review query, source and sample scope, then analyze. No environmental conclusion has been computed.</p>}
      </section>}
      {dataset && accepted?.analysis && accepted.record && <>
        <div role="group" aria-label="Environmental evidence views" style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
          {(Object.keys(VIEW_NAMES) as ViewMode[]).map(mode => <button key={mode} type="button" aria-pressed={view === mode}
            onClick={() => setView(mode)}>{VIEW_NAMES[mode]}</button>)}
        </div>
        <EnvironmentalEvidenceResults dataset={dataset} analysis={accepted.analysis} record={accepted.record} view={view} colors={colors} page={currentPage} />
        {view === 'observations' && pageCount > 1 && <div>
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous observations</button>
          <span> Page {currentPage + 1}/{pageCount} </span>
          <button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next observations</button>
          <p>Showing at most {PAGE_SIZE} rows per page. JSON and TSV exports include every sample.</p>
        </div>}
      </>}
      <CatalogueDistinctiveness repository={repository} currentPhage={currentPhage} open={open} />
    </section>
  </Overlay>;
}
