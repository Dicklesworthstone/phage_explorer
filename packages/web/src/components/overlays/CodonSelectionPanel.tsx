import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { CODON_GENETIC_CODES, type CodonAlignmentInput, type CodonEstimate, type CodonGeneticCode,
  type CodonSelectionOptions, type CodonPairResult } from '../../../../core/src/analysis/codon-selection';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { CodonSelectionSession, type CodonSelectionRequest } from '../../workers/CodonSelectionSession';
import { useTheme } from '../../hooks/useTheme';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const number = (v: number | null): string => v === null ? 'Unavailable' : v.toPrecision(8);
function EstimateCells({ value }: { value: CodonEstimate }): React.ReactElement {
  return <><td>{value.retained}/{value.endCodon - value.startCodon}</td>
    <td>{number(value.synonymousSites)} / {number(value.nonsynonymousSites)}</td>
    <td>{number(value.synonymousDifferences)} / {number(value.nonsynonymousDifferences)}</td>
    <td>{number(value.dN.value)} ({value.dN.status})</td><td>{number(value.dS.value)} ({value.dS.status})</td>
    <td>{number(value.omega)}{value.unavailableReason && <div>{value.unavailableReason}</div>}</td></>;
}
function WindowPlot({ pair }: { pair: CodonPairResult }): React.ReactElement {
  const { theme } = useTheme(), rows = pair.windows;
  const upper = Math.max(1e-12, ...rows.flatMap(w => [w.dN.value ?? 0, w.dS.value ?? 0]));
  const x = (i: number) => 50 + 530 * (i + .5) / rows.length;
  const y = (v: number) => 210 - 180 * v / upper;
  return <figure><svg viewBox="0 0 620 255" role="img" aria-label="Windowed synonymous and nonsynonymous distances" style={{ width: '100%', maxHeight: 320 }}>
    <path d="M50 25V210H600" stroke={theme.colors.textDim} fill="none" />
    {rows.map((w, i) => <g key={w.startCodon}>
      {w.dN.value !== null && <circle cx={x(i)} cy={y(w.dN.value)} r={3} fill={theme.colors.primary}><title>{`dN ${w.dN.value}, codons [${w.startCodon},${w.endCodon})`}</title></circle>}
      {w.dS.value !== null && <path d={`M${x(i)} ${y(w.dS.value) - 4}l4 4l-4 4l-4 -4Z`} fill={theme.colors.warning}><title>{`dS ${w.dS.value}, codons [${w.startCodon},${w.endCodon})`}</title></path>}
    </g>)}
    <text x={5} y={28} fill={theme.colors.text} fontSize={12}>{upper.toPrecision(4)}</text>
    <text x={50} y={234} fill={theme.colors.text} fontSize={12}>{pair.overall.startCodon}</text>
    <text x={530} y={234} fill={theme.colors.text} fontSize={12}>{pair.overall.endCodon}</text>
  </svg><figcaption>Circle: dN; diamond: dS. Alignment-codon windows, substitutions per corresponding opportunity site.
    Unavailable distances have no point; they are not zero. These are not selection-significance markers.</figcaption></figure>;
}
export function CodonSelectionPanel(): React.ReactElement {
  const id = useId(), { theme } = useTheme();
  const session = useMemo(() => new CodonSelectionSession(() => new Worker(new URL('../../workers/codon-selection.worker.ts', import.meta.url), { type: 'module' })), []);
  const { accepted, busy, phase, error, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [fasta, setFasta] = useState(''), [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [reference, setReference] = useState(''), [license, setLicense] = useState('');
  const [method, setMethod] = useState(''), [homology, setHomology] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [geneticCode, setGeneticCode] = useState<CodonGeneticCode>(11), [kind, setKind] = useState<'local' | 'demo'>('local');
  const [options, setOptions] = useState<CodonSelectionOptions | null>(null), [pairIndex, setPairIndex] = useState(0), [page, setPage] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => { setOptions(accepted?.options ?? null); setPairIndex(0); setPage(0); setExportError(null); }, [accepted]);
  const run = (request: CodonSelectionRequest | Promise<CodonSelectionRequest>) => { setExportError(null); void session.run(request); };
  const save = (analysis: boolean) => {
    if (!accepted || analysis && !accepted.record) return;
    try { downloadString(analysis ? serializeAnalysisRecord(accepted.record!) : JSON.stringify(accepted.input, null, 2),
      analysis ? 'aligned-codon-result.json' : 'codon-alignment.json', 'application/json'); setExportError(null); }
    catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '.25rem' };
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '.75rem' };
  const result = accepted?.result, pair = result?.pairs[pairIndex], pageCount = Math.ceil((pair?.windows.length ?? 0) / 50);
  const draftChanged = accepted && JSON.stringify(options) !== JSON.stringify(accepted.options);
  return <section aria-label="Private aligned codon comparison" style={{ display: 'grid', gap: '1rem', color: theme.colors.text, overflowWrap: 'anywhere' }}>
    <h3>Explicit coding-alignment dN/dS</h3>
    <p>Load homologous CDS sequences already aligned by codons in coding 5′→3′ orientation. The selected raw genome and diff reference are not used as an alignment.
      Inputs remain local. Counts and distances are descriptive; a large ratio alone is not evidence of positive selection. Export before closing.</p>
    <label htmlFor={`${id}-saved`}>Import codon dataset or saved comparison JSON</label>
    <input id={`${id}-saved`} type="file" accept=".json,application/json" disabled={busy} onChange={event => {
      const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!selected) return;
      run(selected.size > 10 * 1024 * 1024 ? Promise.reject(new Error('Saved codon input exceeds 10 MiB.')) : selected.text().then(content => ({ kind: 'import' as const, content })));
    }} />
    <button type="button" disabled={!busy} onClick={session.cancel}>Cancel codon work</button>
    <p role="status" data-testid="codon-status">{busy ? `${phase}. Accepted evidence remains unchanged.` : notice ?? 'No aligned CDS data loaded.'}</p>
    {(error || exportError) && <p role="alert">{error ?? exportError}</p>}
    <details open={!accepted}><summary>Prepare aligned CDS input</summary>
      <form onSubmit={event => {
        event.preventDefault(); if (!confirmed) return;
        const input: CodonAlignmentInput = { format: 'phage-explorer-codon-alignment', version: 1, name,
          source: { kind, description, reference, license }, alignment: { fasta, homologousCodons: true, orientation: 'coding-5to3', frame: 0, geneticCode, method, reference: homology } };
        run(file && file.size > 2 * 1024 * 1024 ? Promise.reject(new Error('Aligned FASTA exceeds 2 MiB.'))
          : (file ? file.text() : Promise.resolve(fasta)).then(content => ({ kind: 'load' as const, input: { ...input, alignment: { ...input.alignment, fasta: content } } })));
      }}><fieldset disabled={busy} style={{ display: 'grid', gap: '.75rem' }}><legend>Coding-alignment input draft</legend>
        <label style={label}>Aligned coding FASTA<textarea rows={5} value={fasta} disabled={!!file} spellCheck={false} onChange={event => setFasta(event.target.value)} /></label>
        <label style={label}>Or choose aligned coding FASTA<input type="file" accept=".fa,.fasta,.fna,.aln,.txt" onChange={event => setFile(event.currentTarget.files?.[0] ?? null)} /></label>
        {file && <button type="button" onClick={() => setFile(null)}>Use pasted coding alignment</button>}
        <p>2–32 sequences, at most 30000 codons. Whole-codon gaps (---) are retained; partial-codon gaps and frameshifts are rejected.
          Translate reverse-strand CDS into coding orientation before alignment. No strand, frame or homology is guessed.</p>
        <div style={grid}>{[
          ['Codon dataset name', name, setName], ['Coding source description', description, setDescription], ['Coding source reference', reference, setReference],
          ['Coding license or permissions', license, setLicense], ['Codon alignment method and version', method, setMethod], ['Homologous CDS provenance', homology, setHomology],
        ].map(([title, value, set]) => <label key={String(title)} style={label}>{String(title)}<input required value={String(value)} onChange={event => (set as React.Dispatch<React.SetStateAction<string>>)(event.target.value)} /></label>)}</div>
        <div><label htmlFor={`${id}-code`}>Declared coding genetic code</label><select id={`${id}-code`} value={geneticCode} onChange={event => setGeneticCode(Number(event.target.value) as CodonGeneticCode)}>
          {CODON_GENETIC_CODES.map(code => <option key={code} value={code}>NCBI table {code}</option>)}</select></div>
        <div><label htmlFor={`${id}-kind`}>Coding input provenance</label><select id={`${id}-kind`} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="local">User-supplied local sequences</option><option value="demo">Explicit synthetic example</option></select></div>
        <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I declare homologous codon columns, coding 5′→3′ orientation and frame-zero boundaries.</label>
        <button type="submit">Load and validate coding alignment</button>
      </fieldset></form>
    </details>
    {accepted && options && <>
      <h4 data-testid="codon-name">{accepted.input.name}</h4>
      <p>{accepted.input.source.kind === 'demo' ? 'Explicit synthetic input' : 'User-supplied local input'}: {accepted.input.source.description}. Source: {accepted.input.source.reference}.
        Permissions: {accepted.input.source.license}. Alignment: {accepted.input.alignment.method}; {accepted.input.alignment.reference}.
        NCBI table {accepted.input.alignment.geneticCode}. {accepted.sequences.length} sequences, {accepted.sequences[0].sequence.length / 3} aligned codons.</p>
      <form onSubmit={event => { event.preventDefault(); run({ kind: 'analyze', input: accepted.input, options }); }}>
        <fieldset disabled={busy} style={{ display: 'grid', gap: '.75rem' }}><legend>Codon comparison settings</legend><div style={grid}>
          <div><label htmlFor={`${id}-comparison`}>Coding comparison mode</label><select id={`${id}-comparison`} value={options.comparison} onChange={event => {
            const comparison = event.target.value as CodonSelectionOptions['comparison']; setOptions({ ...options, comparison, referenceId: comparison === 'reference' ? accepted.sequences[0].id : null });
          }}><option value="reference">Reference versus each other sequence</option><option value="all-pairs">All unordered pairs</option></select></div>
          {options.comparison === 'reference' && <div><label htmlFor={`${id}-reference`}>Coding reference sequence</label><select id={`${id}-reference`} value={options.referenceId!} onChange={event => setOptions({ ...options, referenceId: event.target.value })}>
            {accepted.sequences.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}</select></div>}
          <label style={label}>Start codon (zero-based)<input type="number" required min={0} step={1} value={options.startCodon} onChange={event => setOptions({ ...options, startCodon: event.target.valueAsNumber })} /></label>
          <label style={label}>End codon (exclusive)<input type="number" required min={1} max={accepted.sequences[0].sequence.length / 3} step={1} value={options.endCodon} onChange={event => setOptions({ ...options, endCodon: event.target.valueAsNumber })} /></label>
          <label style={label}>Window size in codons<input type="number" required min={1} max={10000} step={1} value={options.windowCodons} onChange={event => setOptions({ ...options, windowCodons: event.target.valueAsNumber })} /></label>
          <div><label htmlFor={`${id}-missing`}>Unusable codon handling</label><select id={`${id}-missing`} value={options.missing} onChange={event => setOptions({ ...options, missing: event.target.value as CodonSelectionOptions['missing'] })}>
            <option value="pairwise">Exclude unusable codons for each pair</option><option value="complete">Exclude unusable columns across all samples</option></select></div>
        </div><p>At most 128 pairs and 4096 windows. Window counts are pooled for each overall estimate; window ratios are not averaged.</p>
          {draftChanged && <p>Draft changes are not applied; displayed evidence and exports use accepted settings.</p>}
          <button type="submit">Run aligned codon comparison</button>
        </fieldset>
      </form>
      <div><button type="button" disabled={busy} onClick={() => save(false)}>Export accepted codon dataset</button>{' '}
        <button type="button" disabled={busy || !accepted.record} onClick={() => save(true)}>Export accepted codon comparison</button></div>
    </>}
    {result && accepted?.record && <section data-testid="codon-result" data-result-id={accepted.record.resultId}>
      <h4>Conditional coding-sequence estimates</h4>
      <div style={{ overflowX: 'auto' }}><table aria-label="Pooled codon comparisons"><thead><tr><th>Pair</th><th>Retained / total codons</th><th>Syn / nonsyn sites</th><th>Syn / nonsyn differences</th><th>dN</th><th>dS</th><th>dN/dS and limits</th></tr></thead>
        <tbody>{result.pairs.map((row, i) => <tr key={JSON.stringify([row.left, row.right])}><td><button type="button" onClick={() => { setPairIndex(i); setPage(0); }}>{row.left} versus {row.right}</button></td><EstimateCells value={row.overall} /></tr>)}</tbody></table></div>
      {pair && <>
        <h4>Window evidence: {pair.left} versus {pair.right}</h4><WindowPlot pair={pair} />
        <p data-testid="codon-exclusions">Excluded codons: {Object.entries(pair.overall.excluded).map(([reason, count]) => `${reason}: ${count}`).join('; ')}.
          Stop-filtered path codons: {pair.overall.pathFilteredCodons}; rejected shortest paths: {pair.overall.rejectedPaths}.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Codon window counts and distances"><thead><tr><th>Alignment codons [start,end)</th><th>Retained / total</th><th>Syn / nonsyn sites</th><th>Syn / nonsyn differences</th><th>dN</th><th>dS</th><th>dN/dS and limits</th></tr></thead>
          <tbody>{pair.windows.slice(page * 50, (page + 1) * 50).map(row => <tr key={row.startCodon}><td>[{row.startCodon},{row.endCodon})</td><EstimateCells value={row} /></tr>)}</tbody></table></div>
        {pageCount > 1 && <div><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous codon windows</button> {page + 1}/{pageCount} <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next codon windows</button></div>}
      </>}
      <details><summary>Accepted translation and settings</summary><pre style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify({ settings: result.options, translations: result.sequences }, null, 2)}</pre></details>
      {result.warnings.map(warning => <p key={warning}>{warning}</p>)}<AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}
