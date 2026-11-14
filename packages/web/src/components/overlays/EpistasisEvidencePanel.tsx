/** Measured assay contrasts, independent of the selected catalog genome. */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { serializeAnalysisRecord, type AnalysisRecord } from '../../../../core/src/analysis-result';
import {
  EPISTASIS_ASSAY_LIMITS, createEpistasisAssayTemplate, exportEpistasisAssayTsv, resolveEpistasisAssayOptions,
  type EpistasisAssayDataset, type EpistasisAssayResult, type EpistasisAssayPair, type EpistasisAssayOptions,
} from '../../../../core/src/analysis/epistasis-evidence';
import { EpistasisEvidenceSession, EPISTASIS_FILE_LIMIT } from '../../workers/EpistasisEvidenceSession';
import { useTheme } from '../../hooks/useTheme';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const PAGE_SIZE = 50;
type ResultView = 'pairs' | 'observations';
const number = (value: number | null): string => value === null ? 'Unavailable' : Number(value.toPrecision(7)).toString();
function integerDraft(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Bootstrap count and seed must be nonnegative whole numbers.');
  return Number(value);
}
export function epistasisOptionsFromDraft(samples: string, seed: string): EpistasisAssayOptions {
  return resolveEpistasisAssayOptions({ bootstrapSamples: integerDraft(samples), seed: integerDraft(seed) });
}

function SourceLabel({ dataset }: { dataset: EpistasisAssayDataset | null }): React.ReactElement {
  return <p data-testid="epistasis-source" style={{ fontWeight: 600 }}>
    {dataset ? dataset.source.kind === 'demo' ? 'SYNTHETIC ASSAY EXAMPLE — not biological observations'
      : 'LOCAL ASSAY INPUT — source attribution supplied by the user'
      : 'NO ASSAY DATA LOADED'}
  </p>;
}
function PairDetails({ pair, units }: { pair: EpistasisAssayPair; units: string }): React.ReactElement {
  return <section aria-label="Selected epistasis contrast">
    <h4>{pair.variant}: {pair.status === 'estimated' ? 'estimated assay contrast' : 'unavailable assay contrast'}</h4>
    <p>Observed double response: {number(pair.observedDouble)}; additive null on the declared scale: {number(pair.expectedDouble)}.
      {' '}Contrast: {number(pair.contrast)} {units}. Positive and negative signs describe assay response relative to that null.</p>
    <div style={{ overflowX: 'auto' }}><table aria-label="Genotype components used for this contrast" style={{ width: '100%' }}>
      <thead><tr><th>Genotype</th><th>Observations used</th><th>Mean on declared scale</th></tr></thead>
      <tbody>{pair.components.map(row => <tr key={row.variant}><td>{row.variant}</td><td>{row.observations}</td><td>{number(row.transformedMean)}</td></tr>)}</tbody>
    </table></div>
    {pair.missingVariants.length > 0 && <p>Missing genotype groups: {pair.missingVariants.join(', ')}. No values are imputed.</p>}
    <p>Standard error: {number(pair.standardError)}. Bootstrap interval: {pair.interval95
      ? number(pair.interval95[0]) + ' to ' + number(pair.interval95[1]) : 'Unavailable'}.</p>
    <p>{pair.uncertainty.reason}</p>
    {pair.completeBlocks.length > 0 && <details><summary>{pair.completeBlocks.length} complete paired blocks</summary>
      <p style={{ overflowWrap: 'anywhere' }}>{pair.completeBlocks.join(', ')}</p></details>}
    {pair.incompleteBlocks.length > 0 && <details><summary>{pair.incompleteBlocks.length} excluded incomplete blocks</summary>
      <p>These sampling units are retained in the source table but do not contribute to this paired contrast.</p>
      <ul>{pair.incompleteBlocks.map(block => <li key={block.replicateId}>{block.replicateId}: missing {block.missingVariants.join(', ')}</li>)}</ul>
    </details>}
    {pair.warnings.map(warning => <p key={warning}>{warning}</p>)}
  </section>;
}

/** Pure accepted-result surface; no ambient phage identity is used. */
export function EpistasisEvidenceResults({ dataset, result, record, view, page = 0, selected = null, onSelect = () => {} }: {
  dataset: EpistasisAssayDataset; result: EpistasisAssayResult; record: AnalysisRecord;
  view: ResultView; page?: number; selected?: string | null; onSelect?: (variant: string) => void;
}): React.ReactElement {
  const pairs = result.pairs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const observations = result.observations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const chosen = result.pairs.find(pair => pair.variant === selected) ?? null;
  return <section data-testid="epistasis-result" data-result-id={record.resultId}>
    <h3>Accepted assay: {dataset.name}</h3>
    <p data-testid="epistasis-summary">{result.coverage.observations} observations · {result.coverage.variants} genotypes · {' '}
      {result.coverage.estimatedPairs} estimated / {result.coverage.doubleVariants} measured double-mutant contrasts · {' '}
      {result.coverage.unavailablePairs} unavailable</p>
    <p>Protein: {dataset.protein.id} · {dataset.protein.accession ?? 'No accession supplied'}.
      {' '}Accepted scale: {result.scale}; replicate design: {result.replicateDesign}.
      {' '}Bootstrap samples: {result.options.bootstrapSamples}; seed: {result.options.seed}.</p>
    <p><code>{result.formula}</code></p>
    <p>Contrast units: {result.contrastUnits}. Pointwise empirical intervals are conditional on the supplied sampling design;
      no multiple-testing adjustment, significance test or phenotype prediction is made.</p>
    {view === 'pairs' ? <div style={{ overflowX: 'auto' }}>
      <table aria-label="Measured epistasis contrasts" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Double mutant</th><th>Status</th><th>Observed double</th><th>Null double</th><th>Contrast</th><th>Standard error</th><th>95% percentile interval</th></tr></thead>
        <tbody>{pairs.map(pair => <tr key={pair.variant} data-testid="epistasis-pair">
          <td><button type="button" aria-pressed={selected === pair.variant} onClick={() => onSelect(pair.variant)}>{pair.variant}</button></td>
          <td>{pair.status}</td><td>{number(pair.observedDouble)}</td><td>{number(pair.expectedDouble)}</td>
          <td>{number(pair.contrast)}</td><td>{number(pair.standardError)}</td>
          <td>{pair.interval95 ? number(pair.interval95[0]) + ' to ' + number(pair.interval95[1]) : 'Unavailable'}</td>
        </tr>)}</tbody>
      </table>
      {result.pairs.length === 0 && <p>No measured double mutants were supplied. Single-mutant measurements alone do not identify an interaction contrast.</p>}
    </div> : <div style={{ overflowX: 'auto' }}>
      <table aria-label="All assay observations" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Variant</th><th>Independent replicate / block</th><th>Observed value</th><th>Assay units</th><th>Value on declared scale</th></tr></thead>
        <tbody>{observations.map(row => <tr key={row.variant + '\u0000' + row.replicateId} data-testid="epistasis-observation">
          <td>{row.variant}</td><td>{row.replicateId}</td><td>{String(row.value)}</td><td>{dataset.assay.units}</td><td>{number(row.transformedValue)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {view === 'pairs' && chosen && <PairDetails pair={chosen} units={result.contrastUnits} />}
    <details><summary>Assumptions and interpretation</summary><ul>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>
    <AnalysisRecordDetails record={record} />
  </section>;
}

export function EpistasisEvidencePanel(): React.ReactElement {
  const { theme } = useTheme(), id = useId();
  const session = useMemo(() => new EpistasisEvidenceSession(() => new Worker(
    new URL('../../workers/epistasis-evidence.worker.ts', import.meta.url), { type: 'module' })), []);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const mounted = useRef(false);
  const [draft, setDraft] = useState('');
  const [samples, setSamples] = useState('1000'), [seed, setSeed] = useState('1');
  const [view, setView] = useState<ResultView>('pairs'), [page, setPage] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true; session.activate();
    return () => { mounted.current = false; session.deactivate(); };
  }, [session]);
  const accepted = state.accepted, dataset = accepted?.dataset ?? null;
  const result = accepted?.result ?? null, record = accepted?.record ?? null;
  const count = result ? view === 'pairs' ? result.pairs.length : result.observations.length : 0;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const optionsChanged = record !== null && (samples !== String(accepted!.options.bootstrapSamples) || seed !== String(accepted!.options.seed));
  const perform = (work: () => Promise<boolean>, updateDraft = false) => {
    setFormError(null);
    void work().then(ok => {
      if (!ok || !mounted.current) return;
      const next = session.getSnapshot().accepted;
      setPage(0); setSelected(null);
      if (updateDraft && next) {
        setDraft(JSON.stringify(next.dataset, null, 2));
        setSamples(String(next.options.bootstrapSamples)); setSeed(String(next.options.seed));
      }
    }).catch(cause => {
      if (mounted.current) setFormError(cause instanceof Error ? cause.message : 'Could not complete assay operation.');
    });
  };
  const exportFile = (content: () => string, filename: string, mime: string) => {
    try { setFormError(null); downloadString(content(), filename, mime); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Could not export assay evidence.'); }
  };
  const analyze = () => {
    if (!dataset || state.busy) return;
    try {
      const options = epistasisOptionsFromDraft(samples, seed);
      perform(() => session.run({ kind: 'analyze', dataset, options }));
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Invalid assay analysis settings.'); }
  };
  return <section aria-label="Measured epistasis workspace" style={{ display: 'grid', gap: '.75rem', marginBottom: '1rem' }}>
    <h3 style={{ marginBottom: 0 }}>Measured mutant assays</h3>
    <p>Import replicate measurements for an explicit protein background, assay and conditions.
      A contrast requires WT, both single mutants and the double mutant. Everything is processed locally.</p>
    <SourceLabel dataset={dataset} />
    <label htmlFor={id + '-file'}>Import epistasis assay or saved evidence JSON</label>
    <input id={id + '-file'} type="file" accept=".json,application/json" disabled={state.busy} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) perform(() => session.importFile(file), true);
    }} />
    <details>
      <summary>Paste or edit an assay dataset</summary>
      <label htmlFor={id + '-draft'}>Epistasis assay JSON draft</label>
      <textarea id={id + '-draft'} value={draft} maxLength={EPISTASIS_FILE_LIMIT} rows={10} disabled={state.busy}
        spellCheck={false} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }}
        onChange={event => setDraft(event.target.value)} />
      <p>Editing this draft does not change accepted inputs or results. Load it explicitly before analyzing.
        Use WT, a single substitution such as A1V, or a double substitution such as A1V:C2S; positions are 1-based in the supplied protein.</p>
      <button type="button" disabled={state.busy || !draft.trim()} onClick={() => perform(() => session.run({ kind: 'import', content: draft }), true)}>
        Load assay draft
      </button>
    </details>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
      <button type="button" disabled={state.busy} onClick={() => perform(() => session.run({
        kind: 'import', content: JSON.stringify(createEpistasisAssayTemplate()),
      }), true)}>Load synthetic assay example</button>
      <button type="button" disabled={state.busy} onClick={() => exportFile(() => JSON.stringify(createEpistasisAssayTemplate(), null, 2),
        'synthetic-epistasis-assay.json', 'application/json')}>Download example JSON</button>
    </div>
    {dataset && <section aria-label="Accepted epistasis assay input" style={{ background: theme.colors.backgroundAlt, padding: '.75rem', borderRadius: 4 }}>
      <h4 data-testid="epistasis-dataset-name" style={{ marginTop: 0 }}>{dataset.name}</h4>
      <p>Protein {dataset.protein.id} · {dataset.protein.accession ?? 'No accession supplied'} · {dataset.protein.sequence.length} residues.
        {' '}{dataset.observations.length} supplied observations.</p>
      <p>Assay: {dataset.assay.name}; units: {dataset.assay.units}. Conditions: {dataset.assay.conditions}</p>
      <p>Scale: <strong>{dataset.assay.scale}</strong> — {dataset.assay.scale === 'identity'
        ? 'contrast of arithmetic means in the supplied assay units.'
        : 'logarithm of each positive observation before averaging; a multiplicative geometric-mean null.'}</p>
      <p>Replicate design: <strong>{dataset.assay.replicateDesign}</strong> — {dataset.assay.replicateDesign === 'paired'
        ? 'only matching complete WT/single/single/double blocks are used; excluded blocks remain inspectable.'
        : 'each variant group is treated as independent; technical replicates must already be summarized within their independent unit.'}</p>
      <p>Source: {dataset.source.description}<br />Reference: {dataset.source.reference ?? 'Not supplied'}<br />License / use restriction: {dataset.source.license}</p>
      <details><summary>Exact reference protein sequence</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{dataset.protein.sequence}</pre></details>
    </section>}
    <fieldset disabled={state.busy || !dataset} style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem' }}>
      <legend>Next analysis settings</legend>
      <label htmlFor={id + '-samples'}>Bootstrap samples (0 or 200–2000)<br />
        <input id={id + '-samples'} type="text" inputMode="numeric" value={samples} onChange={event => setSamples(event.target.value)} style={{ width: '9rem' }} /></label>
      <label htmlFor={id + '-seed'}>Bootstrap seed<br />
        <input id={id + '-seed'} type="text" inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} style={{ width: '9rem' }} /></label>
      <button type="button" onClick={analyze}>Analyze accepted assay</button>
    </fieldset>
    {optionsChanged && <p>Settings have changed for the next run. Displayed evidence and exports still use the accepted settings shown below.</p>}
    {state.busy && <div role="status">{state.phase}<br /><button type="button" onClick={session.cancel}>Cancel epistasis operation</button></div>}
    {state.notice && <p role="status" data-testid="epistasis-notice">{state.notice}</p>}
    {(formError || state.error) && <p role="alert">{formError ?? state.error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
      <button type="button" disabled={state.busy || !dataset} onClick={() => exportFile(() => JSON.stringify(dataset, null, 2),
        'epistasis-assay.json', 'application/json')}>Export accepted assay</button>
      <button type="button" disabled={state.busy || !record} onClick={() => exportFile(() => serializeAnalysisRecord(record!),
        'epistasis-evidence.json', 'application/json')}>Export epistasis evidence</button>
      <button type="button" disabled={state.busy || !record} onClick={() => exportFile(() => exportEpistasisAssayTsv(record!, 'pairs'),
        'epistasis-contrasts.tsv', 'text/tab-separated-values')}>Export all contrasts TSV</button>
      <button type="button" disabled={state.busy || !record} onClick={() => exportFile(() => exportEpistasisAssayTsv(record!, 'observations'),
        'epistasis-observations.tsv', 'text/tab-separated-values')}>Export all assay observations TSV</button>
      <button type="button" disabled={state.busy || !record} onClick={() => perform(() => session.run({
        kind: 'replay', content: serializeAnalysisRecord(record!),
      }), true)}>Verify accepted epistasis evidence</button>
    </div>
    {dataset && result && record && <>
      <nav aria-label="Epistasis result tables" style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
        <button type="button" aria-pressed={view === 'pairs'} onClick={() => { setView('pairs'); setPage(0); }}>Contrasts</button>
        <button type="button" aria-pressed={view === 'observations'} onClick={() => { setView('observations'); setPage(0); }}>All assay observations</button>
      </nav>
      <EpistasisEvidenceResults dataset={dataset} result={result} record={record} view={view} page={currentPage}
        selected={selected} onSelect={setSelected} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous assay rows</button>
        <span>{count ? currentPage * PAGE_SIZE + 1 : 0}–{Math.min((currentPage + 1) * PAGE_SIZE, count)} of {count}; page {currentPage + 1}/{pages}</span>
        <button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next assay rows</button>
      </div>
    </>}
    <p style={{ color: theme.colors.textDim, fontSize: '.85rem' }}>
      Dataset limit: {EPISTASIS_ASSAY_LIMITS.observations} observations and {EPISTASIS_ASSAY_LIMITS.pairs} measured double mutants.
      Missing values, missing genotypes and unsupported substitutions are never filled with predictions.
      Assay files and exports contain the supplied protein and measurements.
    </p>
  </section>;
}
