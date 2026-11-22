import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  COMPATIBILITY_LIMITS, compatibilityPairWitnesses, exportCompatibilityPairsTsv, exportCompatibilitySitesTsv,
  isIncompatiblePair, type CompatibilityInput,
} from '../../../../core/src/analysis/alignment-compatibility';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { AlignmentCompatibilitySession, readCompatibilityFile, type AlignmentCompatibilityWorker } from '../../workers/AlignmentCompatibilitySession';
import { replaySavedResearch } from '../../db/research-storage';
import { downloadString } from '../../utils/export';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { SavedResearchPanel } from './SavedResearchPanel';

interface Draft {
  name: string; kind: CompatibilityInput['source']['kind']; reference: string; version: string; license: string;
  fasta: string; method: string; alignmentReference: string; homologous: boolean; whole: boolean; start: string; end: string;
}
const initial: Draft = { name: 'Aligned DNA experiment', kind: 'local', reference: '', version: '', license: '',
  fasta: '', method: '', alignmentReference: '', homologous: false, whole: true, start: '1', end: '' };
const sample: Draft = { name: 'Synthetic four-gamete demonstration', kind: 'demo', reference: 'Four hand-constructed taxa; not experimental data', version: 'synthetic-1', license: 'CC0',
  fasta: '>synthetic_a\nAA\n>synthetic_b\nAG\n>synthetic_c\nGA\n>synthetic_d\nGG\n',
  method: 'Hand-constructed homologous-column hypothesis', alignmentReference: 'Two declared columns with exactly AA, AG, GA and GG; synthetic demonstration only',
  homologous: true, whole: true, start: '1', end: '' };
const matrixColor = (value: number): string => value < 0.25 ? '#64748b' : value < 0.75 ? '#2563eb' : '#e11d48';
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '.6rem' };
const control: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box' };
const actionRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' };
const tableStyle: React.CSSProperties = { width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '.85rem' };

/** Self-contained alignment evidence stays independent of the browsed catalog genome. */
export function AlignmentCompatibilityPanel(): React.ReactElement {
  const sessionRef = useRef<AlignmentCompatibilitySession | null>(null);
  if (!sessionRef.current) sessionRef.current = new AlignmentCompatibilitySession(() =>
    new Worker(new URL('../../workers/alignment-compatibility.worker.ts', import.meta.url), { type: 'module' }) as unknown as AlignmentCompatibilityWorker);
  const session = sessionRef.current;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [draft, setDraft] = useState<Draft>(initial), [fastaFile, setFastaFile] = useState<File | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [onlyIncompatible, setOnlyIncompatible] = useState(false);
  const [chosen, setChosen] = useState<{ id: string; index: number } | null>(null);
  const [paging, setPaging] = useState<{ id: string; page: number } | null>(null);
  useEffect(() => { session.activate(); return () => session.deactivate(); }, [session]);
  const accepted = snapshot.accepted, result = accepted?.result, resultId = accepted?.record.resultId ?? '';
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    session.cancel(); setError(null); setDraft(previous => ({ ...previous, [key]: value }));
    if (key === 'fasta') setFastaFile(null);
  };
  const analyze = () => {
    const captured = { ...draft }, file = fastaFile; setError(null);
    void session.run(async signal => {
      if (!captured.homologous) throw new Error('Declare that the supplied alignment columns are intended to be homologous before calculating.');
      const fasta = file ? await readCompatibilityFile(file, signal, COMPATIBILITY_LIMITS.inputBytes) : captured.fasta;
      const input: CompatibilityInput = { format: 'phage-explorer-alignment-compatibility', version: 1, name: captured.name,
        source: { kind: captured.kind, reference: captured.reference, version: captured.version, license: captured.license.trim() || null },
        alignment: { fasta, homologous: true, method: captured.method, reference: captured.alignmentReference } };
      return { kind: 'analyze', input, options: captured.whole ? undefined : { start: Number(captured.start) - 1, end: Number(captured.end) } };
    });
  };
  const reopen = (file: File) => { setError(null); void session.run(async signal => ({ kind: 'replay', content: await readCompatibilityFile(file, signal) })); };
  const exportResult = (kind: 'record' | 'sites' | 'pairs') => {
    if (!accepted) return;
    try {
      setError(null);
      const stem = accepted.input.name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 70) || 'alignment-compatibility';
      const content = kind === 'record' ? serializeAnalysisRecord(accepted.record)
        : kind === 'sites' ? exportCompatibilitySitesTsv(accepted) : exportCompatibilityPairsTsv(accepted);
      downloadString(content, stem + (kind === 'record' ? '.json' : '-' + kind + '.tsv'), kind === 'record' ? 'application/json' : 'text/tab-separated-values');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const matrix = useMemo(() => {
    if (!result) return null;
    const size = result.sites.length, values = new Float32Array(size * size).fill(-1);
    for (const pair of result.pairs) values[pair[0] * size + pair[1]] = values[pair[1] * size + pair[0]] = isIncompatiblePair(pair) ? 1 : 0;
    return { rows: size, cols: size, values, min: -1, max: 1 };
  }, [result]);
  const rows = useMemo(() => result?.pairs.map((pair, index) => ({ pair, index })).filter(row => !onlyIncompatible || isIncompatiblePair(row.pair)) ?? [], [result, onlyIncompatible]);
  const page = Math.min(paging?.id === resultId ? paging.page : 0, Math.max(0, Math.ceil(rows.length / 25) - 1));
  const selectedIndex = chosen?.id === resultId ? chosen.index : Math.max(0, result?.pairs.findIndex(isIncompatiblePair) ?? 0);
  const selectedPair = result?.pairs[selectedIndex];
  const witnesses = result && selectedPair ? compatibilityPairWitnesses(result, selectedPair) : [];

  return <section aria-label="Aligned DNA site compatibility" style={{ border: '1px solid var(--color-border)', padding: '.85rem', display: 'grid', gap: '.8rem', minWidth: 0 }}>
    <header>
      <h3 style={{ margin: '0 0 .4rem' }}>Aligned DNA · four-gamete evidence</h3>
      <p style={{ margin: 0 }}>Import a homologous multiple alignment to count exact site alleles and all four paired haplotypes.
        These are observed incompatibilities under stated assumptions; they do not identify recombination events, donors or biological breakpoints.</p>
    </header>
    <details open>
      <summary>Supply an alignment and its provenance</summary>
      <fieldset disabled={libraryBusy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div style={{ ...grid, marginTop: '.6rem' }}>
        <label>Alignment experiment name<input style={control} value={draft.name} maxLength={200} onChange={event => change('name', event.target.value)} /></label>
        <label>Declared source kind<select style={control} value={draft.kind} onChange={event => change('kind', event.target.value as Draft['kind'])}>
          <option value="local">User-supplied source</option><option value="external">Published / external source declaration</option><option value="demo">Synthetic demonstration</option>
        </select></label>
        <label>Source reference or provenance<input style={control} value={draft.reference} maxLength={2000} onChange={event => change('reference', event.target.value)} /></label>
        <label>Source version<input style={control} value={draft.version} maxLength={200} onChange={event => change('version', event.target.value)} /></label>
        <label>License or permissions (optional)<input style={control} value={draft.license} maxLength={2000} onChange={event => change('license', event.target.value)} /></label>
        <label>Alignment method<input style={control} value={draft.method} maxLength={2000} onChange={event => change('method', event.target.value)} /></label>
        <label>Alignment evidence or explicit hypothesis<input style={control} value={draft.alignmentReference} maxLength={2000} onChange={event => change('alignmentReference', event.target.value)} /></label>
      </div>
      <label style={{ display: 'block', marginTop: '.6rem' }}>Aligned DNA FASTA<textarea style={{ ...control, minHeight: '7rem', fontFamily: 'monospace' }} value={draft.fasta}
        maxLength={COMPATIBILITY_LIMITS.inputBytes} placeholder={'>taxon_a\nACGT…\n>taxon_b\nACGT…'} onChange={event => change('fasta', event.target.value)} /></label>
      <div style={actionRow}>
        <label>Aligned FASTA file<input type="file" accept=".fa,.fasta,.fna,.fas,.aln,.txt" onChange={event => {
          const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; session.cancel(); setError(null); setFastaFile(file);
        }} /></label>
        {fastaFile && <span>Selected file: {fastaFile.name} ({fastaFile.size.toLocaleString()} bytes). This file supplies the next calculation.
          <button type="button" onClick={() => { session.cancel(); setFastaFile(null); }}>Use pasted alignment instead</button></span>}
        <button type="button" onClick={() => { session.cancel(); setError(null); setFastaFile(null); setDraft(sample); }}>Load synthetic four-gamete example</button>
      </div>
      <label style={{ display: 'block', marginTop: '.6rem' }}><input type="checkbox" checked={draft.homologous} onChange={event => change('homologous', event.target.checked)} />
        I declare that these supplied columns are intended to be homologous. The app does not align or validate homology.</label>
      <label style={{ display: 'block' }}><input type="checkbox" checked={draft.whole} onChange={event => change('whole', event.target.checked)} /> Compare the complete supplied alignment</label>
      {!draft.whole && <div style={actionRow}>
        <label>First alignment column (1-based inclusive)<input type="number" min={1} max={COMPATIBILITY_LIMITS.columns} step={1} value={draft.start} onChange={event => change('start', event.target.value)} /></label>
        <label>Last alignment column (1-based inclusive)<input type="number" min={1} max={COMPATIBILITY_LIMITS.columns} step={1} value={draft.end} onChange={event => change('end', event.target.value)} /></label>
      </div>}
      <p style={{ fontSize: '.85rem' }}>Four to 64 taxa, equal alignment lengths, at most 100,000 columns and 2 MiB exact input plus metadata.
        A gap or ambiguous base in any taxon excludes the entire column. Only biallelic columns with both alleles present at least twice are compared.
        At most 256 eligible columns (32,640 pairs); choose a narrower original alignment interval if needed. No pairs are sampled.</p>
      <div style={actionRow}>
        <button type="button" disabled={snapshot.busy} onClick={analyze}>Calculate aligned-site compatibility</button>
        {snapshot.busy && <button type="button" onClick={session.cancel}>Cancel aligned-site calculation</button>}
        <label>Reopen and verify compatibility experiment JSON<input type="file" accept=".json" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) reopen(file);
        }} /></label>
      </div>
      <p style={{ fontSize: '.8rem', marginBottom: 0 }}>Inputs stay in this browser. Only explicit Save persists a private snapshot. Complete JSON is limited to 10 MiB;
        an oversized experiment is rejected before acceptance. Reopening recomputes all evidence from the embedded exact source.</p>
      </fieldset>
    </details>
    {snapshot.busy && <p role="status">{snapshot.phase}</p>}
    {!snapshot.busy && snapshot.notice && <p role="status">{snapshot.notice}</p>}
    {(error || snapshot.error) && <p role="alert">{error || snapshot.error}</p>}
    {accepted && result && <section data-testid="compatibility-result" data-result-id={resultId} aria-label="Accepted aligned-site experiment" style={{ display: 'grid', gap: '.7rem', minWidth: 0 }}>
      <div style={{ overflowWrap: 'anywhere' }}>
        <strong>{accepted.input.name}</strong>{accepted.verified ? ' · Verified replay' : ''}
        <p style={{ margin: '.3rem 0' }}>{accepted.input.source.kind === 'demo' ? 'Synthetic demonstration' : 'User-declared source'}: {accepted.input.source.reference} · version {accepted.input.source.version}
          {accepted.input.source.license ? ' · ' + accepted.input.source.license : ' · No license supplied'}</p>
        <p style={{ margin: '.3rem 0' }}>Alignment: {accepted.input.alignment.method}. {accepted.input.alignment.reference}</p>
        <p style={{ margin: '.3rem 0' }}>{result.taxa.length} taxa; original alignment columns {accepted.options.start + 1}–{accepted.options.end} of {result.alignmentColumns.toLocaleString()}.</p>
        <small>Result identity: <code>{resultId}</code></small>
      </div>
      <div data-testid="compatibility-summary">
        <strong>{result.coverage.incompatiblePairs.toLocaleString()} incompatible pairs</strong> / {result.coverage.comparedPairs.toLocaleString()} compared pairs · {result.coverage.eligibleColumns} eligible columns / {result.coverage.selectedColumns.toLocaleString()} selected columns.
        <p>{result.status === 'insufficient-sites' ? 'Fewer than two eligible columns: no site-pair assessment is available.'
          : result.status === 'no-incompatibility-observed' ? 'No four-gamete incompatibility observed in these eligible pairs. This does not establish absence of recombination.'
            : 'All four haplotypes occur in the highlighted pairs. Recurrent mutation, alignment errors and sequencing errors remain possible explanations.'}</p>
      </div>
      <details>
        <summary>Complete-column coverage and exclusions</summary>
        <table style={tableStyle}><thead><tr><th>Classification</th><th>Columns</th><th>Original positions (first 20)</th></tr></thead>
          <tbody>{(['missing', 'monomorphic', 'multiallelic', 'singleton'] as const).map(reason => <tr key={reason}>
            <th scope="row">{reason === 'missing' ? 'Any gap / ambiguous call' : reason === 'singleton' ? 'Biallelic singleton' : reason}</th>
            <td>{result.excluded[reason].length.toLocaleString()}</td><td>{result.excluded[reason].slice(0, 20).map(column => column + 1).join(', ') || 'None'}{result.excluded[reason].length > 20 ? ' …' : ''}</td>
          </tr>)}</tbody></table>
        <p>Export sites TSV for every selected original column, its exact A/C/G/T and non-ACGT counts, and its exclusion reason.</p>
      </details>
      {matrix && result.pairs.length > 0 && <div>
        <div style={{ overflowX: 'auto' }}><HeatmapCanvas width={320} height={280} matrix={matrix} colorScale={matrixColor}
          ariaLabel="Observed four-gamete pair matrix" onClick={hover => {
            if (hover.row === hover.col) return;
            const left = Math.min(hover.row, hover.col), right = Math.max(hover.row, hover.col);
            const index = result.pairs.findIndex(pair => pair[0] === left && pair[1] === right);
            if (index >= 0) setChosen({ id: resultId, index });
          }} /></div>
        <p style={{ fontSize: '.8rem' }}>Red: all four haplotypes observed. Blue: fewer than four. Gray: the same site (not compared).
          Rows and columns follow eligible positions in increasing original alignment order. Select a cell or a table row for exact taxon witnesses.</p>
      </div>}
      {result.pairs.length > 0 && <>
        <label><input type="checkbox" checked={onlyIncompatible} onChange={event => { setOnlyIncompatible(event.target.checked); setPaging({ id: resultId, page: 0 }); }} /> Show only incompatible pairs</label>
        <div style={{ overflowX: 'auto' }}><table style={tableStyle} aria-label="Observed site-pair counts">
          <thead><tr><th>Original columns</th><th>Allele 0/1</th><th>00</th><th>01</th><th>10</th><th>11</th><th>Four gametes</th></tr></thead>
          <tbody>{rows.slice(page * 25, page * 25 + 25).map(({ pair, index }) => <tr key={index}>
            <td><button type="button" aria-label={'Inspect alignment columns ' + (result.sites[pair[0]].column + 1) + ' and ' + (result.sites[pair[1]].column + 1)} onClick={() => setChosen({ id: resultId, index })}>{result.sites[pair[0]].column + 1} · {result.sites[pair[1]].column + 1}</button></td>
            <td>{result.sites[pair[0]].alleles.join('/')} · {result.sites[pair[1]].alleles.join('/')}</td>
            {pair.slice(2).map((count, index) => <td key={index}>{count}</td>)}<td>{isIncompatiblePair(pair) ? 'Yes' : 'No'}</td>
          </tr>)}</tbody></table></div>
        <div style={actionRow}>
          <button type="button" disabled={page === 0} onClick={() => setPaging({ id: resultId, page: page - 1 })}>Previous pair page</button>
          <span>{rows.length ? page * 25 + 1 : 0}–{Math.min(rows.length, page * 25 + 25)} of {rows.length.toLocaleString()} displayed pairs. Exports always include every compared pair.</span>
          <button type="button" disabled={(page + 1) * 25 >= rows.length} onClick={() => setPaging({ id: resultId, page: page + 1 })}>Next pair page</button>
        </div>
      </>}
      {selectedPair && <section aria-label="Selected pair haplotypes">
        <h4 style={{ margin: '.4rem 0' }}>Original alignment columns {result.sites[selectedPair[0]].column + 1} and {result.sites[selectedPair[1]].column + 1}</h4>
        <table style={tableStyle}><thead><tr><th>Haplotype</th><th>Taxa count</th><th>Exact taxon IDs</th></tr></thead><tbody>{witnesses.map(row => <tr key={row.haplotype}>
          <th scope="row">{row.haplotype}</th><td>{row.count}</td><td style={{ overflowWrap: 'anywhere' }}>{row.taxa.join(', ') || 'Not observed'}</td>
        </tr>)}</tbody></table>
      </section>}
      <div style={actionRow}>
        <button type="button" onClick={() => exportResult('record')}>Export complete compatibility experiment</button>
        <button type="button" onClick={() => exportResult('sites')}>Export all selected sites TSV</button>
        <button type="button" onClick={() => exportResult('pairs')}>Export all compared pairs TSV</button>
      </div>
      <details><summary>Method assumptions and interpretation</summary><ul>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        <a href="https://doi.org/10.1093/genetics/111.1.147" target="_blank" rel="noopener noreferrer">Hudson and Kaplan (1985), Genetics 111:147–164</a></details>
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
    <SavedResearchPanel kind="compatibility" suggestedName={accepted?.input.name ?? draft.name}
      capture={accepted ? () => serializeAnalysisRecord(accepted.record) : null} disabled={snapshot.busy}
      onActivityChange={setLibraryBusy}
      restore={(content, signal) => replaySavedResearch(signal, { run: () => session.run({ kind: 'replay', content }), cancel: session.cancel, error: () => session.getSnapshot().error })} />
  </section>;
}
