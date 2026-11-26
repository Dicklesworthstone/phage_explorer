import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { GENOME_CDS_LIMITS } from '../../../../core/src/genome-cds-export';
import { useLocalGenomes } from '../../db/local-genomes';
import { readLocalTextFile } from '../../utils/fileSystem';
import { downloadString } from '../../utils/export';
import { GenomeCdsSession, type GenomeCdsSelection, type GenomeCdsDownloadKind, type GenomeCdsWorkResult } from '../../workers/GenomeCdsSession';

const PAGE_SIZE = 25;
const preview = (value: string | null) => value === null ? '—' : value.length > 200 ? value.slice(0, 200) + '…' : value;

export function GenomeCdsResults({ value, page = 0, busy = false, onPage = () => {}, onExport = () => {} }: {
  value: GenomeCdsWorkResult;
  page?: number;
  busy?: boolean;
  onPage?: (page: number) => void;
  onExport?: (kind: GenomeCdsDownloadKind) => void;
}): React.ReactElement {
  const { experiment, verified } = value, { result, record } = experiment;
  const pages = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(page, pages - 1));
  const first = currentPage * PAGE_SIZE, rows = result.rows.slice(first, first + PAGE_SIZE);
  return <section aria-label="Accepted CDS export" data-testid="genome-cds-result" data-result-id={record.resultId}>
    <h4>{verified ? 'Verified saved CDS export' : 'Prepared CDS export'}: {preview(result.source.name)}</h4>
    <p>{result.summary.selectedCds} selected / {result.summary.mappedCds} mapped CDS.{' '}
      {result.summary.cdsAvailable} DNA available / {result.summary.cdsUnavailable} unavailable;{' '}
      {result.summary.proteinsAvailable} proteins available / {result.summary.proteinsUnavailable} unavailable.</p>
    <p>Source file: {preview(experiment.input.name)} · accession {preview(result.source.accession)} · {result.source.genomeLength.toLocaleString()} bases.</p>
    <p>Genome content ID: <code>{result.source.contentId}</code></p>
    <p>Genome sequence SHA-256: <code>{result.source.sequenceSha256}</code></p>
    {result.source.format === 'catalog-snapshot' && <p>This is a captured catalog sequence and annotation snapshot, not an original GenBank record.</p>}
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <button type="button" className="btn" disabled={busy} onClick={() => onExport('json')}>Export CDS analysis JSON</button>
      <button type="button" className="btn" disabled={busy} onClick={() => onExport('tsv')}>Export CDS table TSV</button>
      <button type="button" className="btn" disabled={busy || result.summary.cdsAvailable === 0} onClick={() => onExport('cds')}>Export CDS DNA FASTA</button>
      <button type="button" className="btn" disabled={busy || result.summary.proteinsAvailable === 0} onClick={() => onExport('protein')}>Export protein FASTA</button>
    </div>
    <p>JSON preserves the exact supplied source and every selected row for portable replay. TSV includes unavailable reasons.
      FASTA contains available sequences with unique IDs; protein FASTA retains terminal stop symbols (*).
      No missing genes or exceptional recoding are inferred.</p>
    {result.rows.length === 0 ? <p>No mapped CDS annotations are available in this record. Unannotated FASTA does not supply genes to translate.</p> : <>
      <p>Showing CDS rows {first + 1}–{first + rows.length} of {result.rows.length}. Full labels and all rows are retained in JSON and TSV.</p>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" className="btn" disabled={currentPage === 0} onClick={() => onPage(currentPage - 1)}>Previous CDS rows</button>
        <button type="button" className="btn" disabled={currentPage + 1 >= pages} onClick={() => onPage(currentPage + 1)}>Next CDS rows</button>
      </div>
      <div style={{ overflowX: 'auto' }}><table>
        <caption>Annotated CDS sequences and conceptual protein availability</caption>
        <thead><tr><th>CDS ID</th><th>Annotation</th><th>CDS DNA</th><th>Protein</th><th>Unavailable reasons</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} data-testid="genome-cds-row" data-gene-id={row.geneId}>
          <td>{row.geneId}</td>
          <td>{preview(row.locusTag ?? row.name)}<br />{preview(row.product)}<br />Table {row.geneticCode}; codon_start {row.codonStart}</td>
          <td>{row.cds === null ? 'Unavailable' : `${row.cds.length.toLocaleString()} bases`}</td>
          <td>{row.protein === null ? 'Unavailable' : `${row.protein.length.toLocaleString()} symbols`}</td>
          <td>{row.extractionReasons.length === 0 && row.translationReasons.length === 0 ? 'None' : <ul>
            {row.extractionReasons.map((reason, index) => <li key={'dna-' + index}>DNA: {reason}</li>)}
            {row.translationReasons.map((reason, index) => <li key={'protein-' + index}>Protein: {reason}</li>)}
          </ul>}</td>
        </tr>)}</tbody>
      </table></div>
    </>}
    {result.importWarnings.length > 0 && <details><summary>{result.importWarnings.length} source annotation warnings</summary>
      <ul>{result.importWarnings.slice(0, 20).map((warning, index) => <li key={index}>{preview(warning)}</li>)}</ul>
      <p>All warnings and original annotations, including features excluded from mapping, remain in the analysis JSON.</p>
    </details>}
    <details><summary>CDS method and result identity</summary>
      <p>{record.method.id}, version {record.method.version}.</p>
      <ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
      <p>Input SHA-256: <code>{record.inputs[0].sha256}</code></p>
      <p>Result ID: <code>{record.resultId}</code></p>
    </details>
  </section>;
}

/** Reuses only sources already held in the local-genome workspace. */
export function GenomeCdsPanel(): React.ReactElement {
  const genomes = useLocalGenomes(state => state.genomes);
  const currentId = usePhageStore(state => state.currentPhage?.localGenome?.contentId ?? '');
  const [selected, setSelected] = useState(currentId);
  const [page, setPage] = useState(0), [downloadError, setDownloadError] = useState<string | null>(null);
  const session = useMemo(() => new GenomeCdsSession(() => new Worker(new URL('../../workers/genome-cds.worker.ts', import.meta.url), { type: 'module' })), []);
  const genome = genomes.find(item => item.phage.localGenome?.contentId === selected) ?? null;
  const scope = useMemo<GenomeCdsSelection | null>(() => genome ? {
    contentId: genome.phage.localGenome!.contentId, input: { ...genome.original },
  } : null, [genome, currentId]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const state = snapshot.scope === scope ? snapshot : null;
  const accepted = state ? session.getAccepted(scope) : null;
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => { session.setScope(scope); setPage(0); setDownloadError(null); }, [session, scope]);
  useEffect(() => {
    if (currentId && genomes.some(item => item.phage.localGenome?.contentId === currentId)) setSelected(currentId);
  }, [currentId, genomes]);
  useEffect(() => {
    if (!genomes.some(item => item.phage.localGenome?.contentId === selected)) setSelected(genomes[0]?.phage.localGenome?.contentId ?? '');
  }, [genomes, selected]);
  useEffect(() => { setPage(0); }, [accepted?.experiment.record.resultId]);

  const prepare = () => {
    if (!scope) return;
    setDownloadError(null);
    void session.run(scope, { kind: 'analyze', input: { ...scope.input }, options: { record: scope.contentId, geneIds: null } });
  };
  const replay = (file: File | undefined) => {
    if (!file || !scope) return;
    setDownloadError(null);
    void session.run(scope, async signal => ({ kind: 'replay', content: await readLocalTextFile(file, GENOME_CDS_LIMITS.recordBytes, signal) }));
  };
  const download = (kind: GenomeCdsDownloadKind) => {
    if (!scope) return;
    try {
      const file = session.export(scope, kind);
      if (!file) throw new Error('The selected genome changed or work is still running. Prepare the current source before exporting.');
      downloadString(file.content, file.filename, file.mimeType); setDownloadError(null);
    } catch (cause) { setDownloadError(cause instanceof Error ? cause.message : 'Could not export the CDS result.'); }
  };

  return <section aria-label="Annotated CDS and proteome export" style={{ display: 'grid', gap: 'var(--space-2)' }}>
    <h3>Export annotated CDS and proteins</h3>
    <p>Prepare all mapped CDS from an imported genome, including joined and reverse-strand transcripts. Each annotation keeps its declared translation table.
      Work stays in this browser; no catalog or external service is needed.</p>
    {!genomes.length && <p>Import an annotated genome above to prepare its CDS and protein sequences.</p>}
    <label>CDS export genome <select aria-label="CDS export genome" value={selected} disabled={!genomes.length}
      onChange={event => { session.cancel(); setSelected(event.target.value); }}>
      {!genomes.length && <option value="">No imported genomes</option>}
      {genomes.map(item => <option key={item.phage.localGenome!.contentId} value={item.phage.localGenome!.contentId}>
        {preview(item.phage.name)} · {preview(item.phage.accession)} · {item.phage.localGenome!.contentId.slice(0, 12)}
      </option>)}
    </select></label>
    {scope && genome && <p>Selected source: {preview(scope.input.name)} · {genome.sequence.length.toLocaleString()} bases. Content ID: <code>{scope.contentId}</code></p>}
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-primary" disabled={!scope || !state || state.busy} onClick={prepare}>Prepare CDS and protein export</button>
      {state?.busy && <button type="button" className="btn" onClick={session.cancel}>Cancel CDS export</button>}
    </div>
    <label>Replay CDS export JSON <input aria-label="Replay CDS export JSON" type="file" accept=".json,application/json"
      disabled={!scope || !state || state.busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; replay(file); }} /></label>
    <p>Saved JSON is recomputed before acceptance and must match the selected genome's content ID. Failed or cancelled work preserves the last accepted export.
      Limits: 10 MiB per input/output, 12,000 selected CDS and 8,000,000 extracted bases.</p>
    <p role="status" data-testid="genome-cds-status">{state?.busy ? state.phase : state?.notice ?? 'Choose an imported local genome.'}</p>
    {(state?.error || downloadError) && <p role="alert">{downloadError ?? state?.error}</p>}
    {accepted && <GenomeCdsResults value={accepted} page={page} busy={state?.busy} onPage={setPage} onExport={download} />}
  </section>;
}
