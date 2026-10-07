/** Measured host-strain evidence, independent of the curated genome catalogue. */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  HOST_RANGE_METHOD, HOST_RANGE_LIMITS, parseHostRangeCSV, parseHostRangeExperiment,
  serializeHostRangeExperiment, hostRangeContexts, buildHostRangeMatrix,
  evaluateHostRangeCoverage, selectHostRangeCoverage,
  type HostRangeExperiment, type HostRangeObservation, type HostRangeQuery, type HostRangeCell,
} from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';

const HEADER = 'phage_id,host_id,assay,condition,replicate,outcome,source';
const PAGE_ROWS = 20;
const PAGE_COLUMNS = 20;
const EXAMPLE = `${HEADER}\nExample A,Strain 1,plaque,Synthetic condition,r1,positive,Generated fixture\nExample A,Strain 2,plaque,Synthetic condition,r1,negative,Generated fixture\nExample B,Strain 2,plaque,Synthetic condition,r1,positive,Generated fixture\nExample B,Strain 1,spot,Synthetic condition,r1,positive,Generated fixture\nExample C,Strain 3,plaque,Synthetic condition,r1,indeterminate,Generated fixture`;
function queryFor(rows: HostRangeObservation[]): HostRangeQuery {
  const context = hostRangeContexts(rows)[0];
  return { ...context, minReplicates: 1, phageIds: [...new Set(rows.map(row => row.phageId))], hostIds: [...new Set(rows.map(row => row.hostId))] };
}
function downloadJSON(contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'host-range-experiment.json';
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
export function HostRangeEvidencePanel(): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const heading = useId();
  const [raw, setRaw] = useState(HEADER + '\n');
  const [title, setTitle] = useState('Imported host-range observations');
  const [provenance, setProvenance] = useState<HostRangeExperiment['provenance']>('user-supplied');
  const [loaded, setLoaded] = useState<{ observations: HostRangeObservation[]; query: HostRangeQuery } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [maxSize, setMaxSize] = useState(3);
  const [detail, setDetail] = useState<HostRangeCell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  const matrix = useMemo(() => loaded ? buildHostRangeMatrix(loaded.observations, loaded.query) : null, [loaded]);
  const coverage = useMemo(() => loaded ? evaluateHostRangeCoverage(loaded.observations, loaded.query, selected) : null, [loaded, selected]);
  const contexts = useMemo(() => loaded ? hostRangeContexts(loaded.observations) : [], [loaded]);
  const report = (problem: unknown) => setError(problem instanceof Error ? problem.message : 'Unable to read host-range evidence.');
  const invalidate = () => {
    revision.current++; setLoaded(null); setSelected([]); setDetail(null); setError(null); setLoading(false); setSelectionMessage(null); setRowPage(0); setColumnPage(0);
  };
  const read = (text: string, kind: HostRangeExperiment['provenance']) => {
    if (text.trimStart().startsWith('{')) {
      const experiment = parseHostRangeExperiment(text);
      setTitle(experiment.title); setProvenance(experiment.provenance); setMaxSize(experiment.maxSize);
      setLoaded({ observations: experiment.observations, query: experiment.query }); setSelected(experiment.selectedPhageIds);
    } else {
      const observations = parseHostRangeCSV(text);
      setProvenance(kind); setLoaded({ observations, query: queryFor(observations) });
    }
  };
  const importFile = async (file: File) => {
    invalidate(); const request = revision.current; setLoading(true);
    try {
      if (file.size > HOST_RANGE_LIMITS.bytes) throw new Error('Maximum import size is 2 MB.');
      const contents = await file.text();
      if (request !== revision.current) return;
      read(contents, 'user-supplied'); setRaw(contents);
    } catch (problem) { if (request === revision.current) report(problem); }
    finally { if (request === revision.current) setLoading(false); }
  };
  const changeQuery = (changes: Partial<HostRangeQuery>) => {
    if (!loaded) return;
    const query = { ...loaded.query, ...changes };
    try {
      buildHostRangeMatrix(loaded.observations, query);
      setLoaded({ observations: loaded.observations, query }); setSelected([]); setDetail(null); setError(null); setSelectionMessage(null); setRowPage(0); setColumnPage(0);
    } catch (problem) { report(problem); }
  };
  const suggest = () => {
    if (!loaded) return;
    try {
      const result = selectHostRangeCoverage(loaded.observations, loaded.query, maxSize);
      setSelected(result.selectedPhageIds);
      setSelectionMessage(result.steps.length ? result.steps.map(step => `${step.phageId}: +${step.newlySupportedHostIds.length} observed host(s)`).join('; ') : 'No qualifying positive evidence for any target strain. No phages selected.');
    } catch (problem) { report(problem); }
  };
  const exportExperiment = () => {
    if (!loaded) return;
    try { downloadJSON(serializeHostRangeExperiment({ schemaVersion: 1, method: HOST_RANGE_METHOD, title, provenance,
      observations: loaded.observations, query: loaded.query, selectedPhageIds: selected, maxSize })); }
    catch (problem) { report(problem); }
  };
  const control: React.CSSProperties = { padding: '0.5rem', minHeight: 44, maxWidth: '100%', boxSizing: 'border-box', border: `1px solid ${colors.borderLight}`, borderRadius: 4, color: colors.text, background: colors.background };
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 };
  const cellStyle: React.CSSProperties = { padding: '0.5rem', border: `1px solid ${colors.borderLight}`, textAlign: 'left' };
  return (
    <section aria-labelledby={heading} style={{ color: colors.text, minWidth: 0 }} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <h3 id={heading}>Measured host-range evidence</h3>
      <p>Import categorical assay observations for exact host strain IDs. This workflow does not derive host coverage from genome labels, receptor guesses, or annotation similarity.</p>
      <p>Each row needs its assay, condition, independent replicate ID, explicit outcome, and source. Different assay conditions are never pooled. Spot clearing does not establish productive infection.</p>
      <form onSubmit={event => { event.preventDefault(); invalidate(); try { read(raw, provenance); } catch (problem) { report(problem); } }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          <label style={label}>Host-range file (CSV, TSV, or saved JSON)
            <input type="file" accept=".csv,.tsv,.json" style={control} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file); }} />
          </label>
          <button type="button" style={control} onClick={() => { invalidate(); setTitle('Synthetic host-range example'); setProvenance('synthetic'); setRaw(EXAMPLE); read(EXAMPLE, 'synthetic'); }}>Load synthetic example</button>
        </div>
        <label style={{ ...label, marginTop: '0.75rem' }}>Host-range CSV/TSV or experiment JSON
          <textarea value={raw} rows={6} spellCheck={false} maxLength={HOST_RANGE_LIMITS.bytes} style={{ ...control, fontFamily: 'monospace', width: '100%' }} onChange={event => { invalidate(); setRaw(event.target.value); }} />
        </label>
        <p style={{ overflowWrap: 'anywhere' }}>CSV header: <code>{HEADER}</code>. Assay: plaque or spot. Outcome: positive, negative, or indeterminate. Missing pairs remain untested, not negative.</p>
        <button type="submit" style={control} disabled={loading}>Load evidence</button>
      </form>
      {loading && <p role="status">Reading host-range evidence…</p>}
      {error && <p role="alert" style={{ color: colors.error }}>{error}</p>}
      {loaded && matrix && coverage && <>
        <p><strong>{provenance === 'synthetic' ? 'SYNTHETIC — NOT EXPERIMENTAL EVIDENCE' : 'USER-SUPPLIED — NOT INDEPENDENTLY VERIFIED'}</strong></p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          <label style={label}>Host-range experiment title<input value={title} maxLength={200} style={control} onChange={event => setTitle(event.target.value)} /></label>
          <label style={label}>Host-range provenance<select value={provenance} style={control} onChange={event => setProvenance(event.target.value as HostRangeExperiment['provenance'])}><option value="user-supplied">User supplied</option><option value="synthetic">Synthetic</option></select></label>
          <label style={label}>Assay and condition<select style={control} value={JSON.stringify([loaded.query.assay, loaded.query.condition])} onChange={event => { const [assay, condition] = JSON.parse(event.target.value); changeQuery({ assay, condition }); }}>
            {contexts.map(context => <option key={JSON.stringify(context)} value={JSON.stringify([context.assay, context.condition])}>{context.assay} — {context.condition}</option>)}
          </select></label>
          <label style={label}>Minimum independent replicates<input type="number" min={1} max={100} step={1} style={control} value={loaded.query.minReplicates} onChange={event => changeQuery({ minReplicates: Number(event.target.value) })} /></label>
        </div>
        <details><summary>Target strains and candidate phages</summary><p>Clear selections only after choosing a nonempty target and candidate set. Changing filters clears the previous phage selection.</p>
          {(['hostIds', 'phageIds'] as const).map(kind => <fieldset key={kind}><legend>{kind === 'hostIds' ? 'Target host strains' : 'Candidate phages'}</legend>
            {[...new Set(loaded.observations.map(row => kind === 'hostIds' ? row.hostId : row.phageId))].sort().map(id => <label key={id} style={{ display: 'inline-flex', padding: '0.5rem', gap: '0.25rem' }}><input type="checkbox" checked={loaded.query[kind].includes(id)} onChange={event => changeQuery({ [kind]: event.target.checked ? [...loaded.query[kind], id] : loaded.query[kind].filter(value => value !== id) })} />{id}</label>)}
          </fieldset>)}
        </details>
        <p>{matrix.includedObservations} observations in this view; {matrix.excludedObservations} excluded by assay, condition, or target filters. Cell text: status (positive / negative / indeterminate counts). Select a cell to inspect its sources.</p>
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}><table style={{ borderCollapse: 'collapse' }}>
          <caption>Measured host-range matrix</caption>
          <thead><tr><th scope="col" style={cellStyle}>Selected phage</th>{matrix.query.hostIds.slice(columnPage * PAGE_COLUMNS, (columnPage + 1) * PAGE_COLUMNS).map(host => <th scope="col" key={host} style={cellStyle}>{host}</th>)}</tr></thead>
          <tbody>{matrix.cells.slice(rowPage * PAGE_ROWS, (rowPage + 1) * PAGE_ROWS).map(row => <tr key={row[0].phageId}>
            <th scope="row" style={cellStyle}><label><input type="checkbox" aria-label={`Include ${row[0].phageId} in observed coverage`} checked={selected.includes(row[0].phageId)} onChange={event => { setSelectionMessage(null); setSelected(previous => event.target.checked ? [...previous, row[0].phageId] : previous.filter(id => id !== row[0].phageId)); }} /> {row[0].phageId}</label></th>
            {row.slice(columnPage * PAGE_COLUMNS, (columnPage + 1) * PAGE_COLUMNS).map(cell => <td key={cell.hostId} style={cellStyle}><button type="button" style={control} aria-label={`${cell.phageId} / ${cell.hostId}: ${cell.status}`} onClick={() => setDetail(cell)}>{cell.status} ({cell.positive}/{cell.negative}/{cell.indeterminate})</button></td>)}
          </tr>)}</tbody>
        </table></div>
        <nav aria-label="Evidence matrix pages" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" style={control} disabled={rowPage === 0} onClick={() => setRowPage(value => value - 1)}>Previous phages</button><span>Phage page {rowPage + 1} / {Math.ceil(matrix.cells.length / PAGE_ROWS)}</span><button type="button" style={control} disabled={(rowPage + 1) * PAGE_ROWS >= matrix.cells.length} onClick={() => setRowPage(value => value + 1)}>Next phages</button>
          <button type="button" style={control} disabled={columnPage === 0} onClick={() => setColumnPage(value => value - 1)}>Previous strains</button><span>Strain page {columnPage + 1} / {Math.ceil(matrix.query.hostIds.length / PAGE_COLUMNS)}</span><button type="button" style={control} disabled={(columnPage + 1) * PAGE_COLUMNS >= matrix.query.hostIds.length} onClick={() => setColumnPage(value => value + 1)}>Next strains</button>
        </nav>
        {detail && <section aria-label="Selected host-range evidence"><h4>{detail.phageId} / {detail.hostId}: {detail.status}</h4>{detail.observationIndices.length ? detail.observationIndices.map(index => { const row = loaded.observations[index]; return <p key={index} style={{ overflowWrap: 'anywhere' }}>{row.outcome}; replicate {row.replicate}; source: {row.source}; {row.assay}, {row.condition}</p>; }) : <p>No observations for this pair in this assay/condition.</p>}</section>}
        <section aria-label="Observed coverage"><h4>Observed coverage of selected phages</h4>
          <p>Supported: {coverage.supportedHostIds.length} / {loaded.query.hostIds.length} target strains ({(coverage.coverageFraction * 100).toFixed(1)}%). Negative across selected phages: {coverage.negativeHostIds.length}. Unresolved: {coverage.unresolvedHostIds.length}.</p>
          <p>Selected: {selected.join(', ') || 'none'}. Supported strains: {coverage.supportedHostIds.join(', ') || 'none'}. Unresolved strains: {coverage.unresolvedHostIds.join(', ') || 'none'}.</p>
          <label style={label}>Maximum greedy selection size<select style={control} value={maxSize} onChange={event => setMaxSize(Number(event.target.value))}>{Array.from({ length: 10 }, (_, i) => <option value={i + 1} key={i}>{i + 1}</option>)}</select></label>
          <button type="button" style={control} onClick={suggest}>Select by observed coverage</button>
          <p>Selection uses a deterministic greedy coverage heuristic, not a proven optimal solution. Single-phage positives do not demonstrate mixture compatibility, absence of antagonism, or therapeutic suitability.</p>
          {selectionMessage && <p role="status">{selectionMessage}</p>}
        </section>
        <button type="button" style={control} onClick={exportExperiment}>Export host-range experiment</button>
        <p>Export retains observations, exact sources, filters, selected phages, and selection-size setting. Imported result fields are ignored and recomputed. Data are processed locally; no automatic upload or persistence is performed.</p>
        <details><summary>Evidence limitations</summary>{matrix.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
      </>}
    </section>
  );
}
