/** Annotate through the existing producer/replay pipeline; never infer effects from variant labels. */
import React, { useMemo, useState } from 'react';
import { GENOME_IMPORT_LIMITS, type LocalGenome } from '../../../../core/src/genome-import';
import { exportCdsConsequenceFasta, exportCdsConsequenceTable, parseCdsGeneIds,
  type CdsEffect } from '../../../../core/src/analysis/cds-consequences';
import type { AlignmentGraphOptions } from '../../../../core/src/analysis/alignment-pangenome';
import type { PangenomeAccepted, PangenomeRequest } from '../../workers/PangenomeSession';
import { downloadString } from '../../utils/export';

interface Props {
  accepted: PangenomeAccepted;
  options: AlignmentGraphOptions;
  localGenomes: readonly LocalGenome[];
  busy: boolean;
  run: (request: PangenomeRequest | Promise<PangenomeRequest>) => Promise<void>;
}
const PAGE_SIZE = 50;
const EFFECTS: CdsEffect[] = ['unchanged', 'synonymous', 'amino-acid-change', 'inframe-indel',
  'frameshift', 'frame-restored', 'premature-stop', 'terminal-stop-lost', 'start-codon-lost', 'cds-deleted'];
const preview = (sequence: string | null) => sequence === null ? 'Unavailable' : sequence.length === 0
  ? 'Empty (deleted)' : sequence.length > 240 ? `${sequence.slice(0, 240)}… (${sequence.length} symbols; full sequence in export)` : sequence;

export function PangenomeCdsPanel({ accepted, options, localGenomes, busy, run }: Props): React.ReactElement {
  const [localId, setLocalId] = useState('');
  const [annotationRecord, setAnnotationRecord] = useState('');
  const [geneIds, setGeneIds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'changed' | 'unavailable' | CdsEffect>('all');
  const [queryId, setQueryId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [inspection, setInspection] = useState<{ resultId: string; index: number } | null>(null);
  const reference = accepted.input.sequences.find(row => row.id === options.referenceId);
  const candidates = useMemo(() => {
    const sequence = reference?.sequence.replaceAll('-', '');
    return localGenomes.filter(genome => genome.phage.localGenome?.format === 'genbank' && genome.sequence === sequence);
  }, [localGenomes, reference]);
  const local = candidates.find(genome => genome.phage.localGenome?.contentId === localId);
  const cds = accepted.cds;
  const resultId = accepted.record?.resultId ?? '';
  const genes = useMemo(() => new Map(cds?.genes.map(gene => [gene.geneId, gene]) ?? []), [cds]);
  const queries = useMemo(() => [...new Set(cds?.consequences.map(row => row.sequenceId) ?? [])], [cds]);
  const activeQuery = queries.includes(queryId) ? queryId : '';
  const rows = useMemo(() => (cds?.consequences ?? []).map((row, index) => ({ row, index })).filter(({ row }) => {
    const gene = genes.get(row.geneId);
    return (!activeQuery || row.sequenceId === activeQuery)
      && (!search.trim() || `${row.geneId} ${gene?.name ?? ''} ${gene?.product ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
      && (filter === 'all' || filter === 'unavailable' ? filter === 'all' || row.status === 'unavailable'
        : row.status === 'available' && (filter === 'changed' ? !row.effects.includes('unchanged') : row.effects.includes(filter)));
  }), [cds, genes, activeQuery, search, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  // A queued event from a prior result must not inspect a different new CDS at the same index.
  const inspected = inspection?.resultId === resultId ? cds?.consequences[inspection.index] : undefined;
  const inspectedGene = inspected ? genes.get(inspected.geneId) : undefined;
  const loadAnnotation = (file: File | undefined) => {
    if (!file || busy) return;
    try {
      setError(null);
      if (file.size > GENOME_IMPORT_LIMITS.bytes) throw new Error('GenBank annotation exceeds 10 MiB.');
      const selection = { annotationRecord: annotationRecord.trim() || null, geneIds: parseCdsGeneIds(geneIds) };
      const input = accepted.input, settings = { ...options };
      // Session ownership starts before File.text(): cancel/newer input cannot publish an old file.
      void run(file.text().then(text => ({ kind: 'annotate', input, options: settings,
        annotation: { name: file.name, text }, selection })));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const useImportedAnnotation = () => {
    if (busy || !local) return;
    try {
      setError(null);
      void run({ kind: 'annotate', input: accepted.input, options: { ...options }, annotation: { ...local.original },
        selection: { annotationRecord: local.phage.localGenome!.contentId, geneIds: parseCdsGeneIds(geneIds) } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const save = (kind: 'table' | 'cds' | 'protein') => {
    if (!cds || busy) return;
    try {
      setError(null);
      downloadString(kind === 'table' ? exportCdsConsequenceTable(cds) : exportCdsConsequenceFasta(cds, kind),
        kind === 'table' ? 'pangenome-cds-consequences.tsv' : `pangenome-${kind}.fasta`,
        kind === 'table' ? 'text/tab-separated-values;charset=utf-8' : 'text/plain;charset=utf-8');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section aria-label="Pangenome coding consequences" style={{ display: 'grid', gap: '.6rem', borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
    <h3>Reference CDS and protein consequences</h3>
    <p>Supply GenBank annotations for the selected reference. All substitutions and indels within each projected CDS are evaluated together,
      rather than assigning independent effects to individual variant cards. These are alignment-conditional sequence changes, not functional or phenotype predictions.</p>
    <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}>
      <legend>Build graph with coding annotations</legend>
      <p>Next reference: {reference?.description || reference?.id}. The GenBank bases and starting coordinate must match it exactly;
        an accession match alone is insufficient. Alignment controls above apply to the next annotated build.</p>
      <label>CDS IDs (blank for all mapped CDS) <input value={geneIds} placeholder="1,2,3" onChange={event => setGeneIds(event.target.value)} /></label>
      <label>Matching imported GenBank <select value={local?.phage.localGenome?.contentId ?? ''} onChange={event => setLocalId(event.target.value)}>
        <option value="">Choose an exact sequence-matched annotation</option>
        {candidates.map(genome => <option key={genome.phage.localGenome!.contentId} value={genome.phage.localGenome!.contentId}>
          {genome.phage.name} · {genome.phage.accession} · {genome.phage.localGenome!.contentId.slice(0, 12)}
        </option>)}
      </select></label>
      {local && <details><summary>Mapped CDS identifiers</summary>
        <p>Showing the first 300 mapped CDS. Blank selection analyzes all, subject to the computation budget; original annotations retain the full list.</p>
        <ul>{local.phage.genes.filter(gene => gene.type === 'CDS').slice(0, 300).map(gene =>
          <li key={gene.id}>{gene.id}: {gene.locusTag ?? gene.name ?? 'CDS'} · {gene.product ?? 'No product annotation'}</li>)}</ul></details>}
      <button type="button" disabled={!local || busy} onClick={useImportedAnnotation}>Build with imported CDS annotation</button>
      <label>Annotation record for file input (optional accession or full content ID) <input value={annotationRecord} onChange={event => setAnnotationRecord(event.target.value)} /></label>
      <label>Build with GenBank annotation file <input type="file" accept=".gb,.gbk,.genbank,.json,text/plain,application/json" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; loadAnnotation(file);
      }} /></label>
      <p>File input accepts GenBank or a local genome bundle, up to 10 MiB. Multiple exact matches require an explicit record.
        Parsing and rebuilding run in the existing cancellable worker. Unsupported annotations remain visible as unavailable, never assumed unchanged.</p>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {cds && <div data-testid="pangenome-cds-result" data-result-id={resultId}>
      <p role="status">{cds.summary.genes} reference CDS × {cds.summary.queries} queries:
        {' '}{cds.summary.available} available, {cds.summary.changed} changed, {cds.summary.unavailable} unavailable comparisons.</p>
      <p>Accepted annotation: {cds.reference.accession} · <code>{cds.reference.contentId}</code>.
        Reference: {cds.reference.sequenceId}. Submitted control changes do not relabel these results.</p>
      {cds.reference.warnings.length > 0 && <details><summary>Annotation coverage warnings ({cds.reference.warnings.length})</summary>
        {cds.reference.warnings.slice(0, 100).map((warning, index) => <p key={index}>{warning}</p>)}
        {cds.reference.warnings.length > 100 && <p>Showing the first 100 warnings; the complete list remains in the experiment JSON.</p>}
      </details>}
      <div><button type="button" disabled={busy} onClick={() => save('table')}>Export CDS consequences TSV</button>
        <button type="button" disabled={busy} onClick={() => save('cds')}>Export projected CDS FASTA</button>
        <button type="button" disabled={busy} onClick={() => save('protein')}>Export conceptual proteins FASTA</button></div>
      <p>Exports include all analyzed CDS, independent of display filters. FASTA includes supported reference and nonempty available query sequences;
        unavailable/deleted entries remain in TSV and experiment JSON. Protein '*' denotes a stop, not a deposited protein terminus.
        Save or export the complete pangenome experiment above to retain original sequences, annotation and replayable parameters.</p>
      <label>Filter coding consequences <select value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPage(0); }}>
        <option value="all">All comparisons</option><option value="changed">Changed, available comparisons</option><option value="unavailable">Unavailable comparisons</option>
        {EFFECTS.map(effect => <option key={effect} value={effect}>{effect}</option>)}
      </select></label>
      <label>Filter coding query <select value={activeQuery} onChange={event => { setQueryId(event.target.value); setPage(0); }}>
        <option value="">All queries</option>{queries.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <label>Find CDS by ID, name or product <input value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <p>{rows.length} of {cds.summary.comparisons} comparisons match. Page {currentPage + 1}/{pages}.</p>
      <div style={{ overflowX: 'auto' }}><table aria-label="Projected coding consequences"><thead><tr>
        <th>CDS</th><th>Query</th><th>Status/effects</th><th>Inserted/deleted bases</th><th>Missing/ambiguous bases</th>
      </tr></thead><tbody>{rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ row, index }) => <tr key={`${row.geneId}:${row.sequenceId}`}>
        <td><button type="button" onClick={() => setInspection({ resultId, index })}>{genes.get(row.geneId)?.name ?? row.geneId} · {row.geneId}</button></td>
        <td>{row.sequenceId}</td><td>{row.status === 'unavailable' ? `Unavailable: ${row.reasons.join(' ')}` : row.effects.join(', ')}</td>
        <td>{row.insertedBases} / {row.deletedBases}</td><td>{row.missingReferenceBases} / {row.ambiguousQueryBases}</td>
      </tr>)}</tbody></table></div>
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous CDS comparisons</button>
      <button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next CDS comparisons</button>
      {inspected && inspectedGene && <aside aria-label="Coding transcript details">
        <h4>{inspectedGene.name} · {inspected.sequenceId}</h4>
        <p>Genetic code {inspectedGene.geneticCode}, codon_start {inspectedGene.codonStart}.
          Reference transcript segments (0-based, half-open, traversal order): {inspectedGene.segments.map(segment => `[${segment.start}, ${segment.end}) ${segment.strand}`).join('; ')}.</p>
        {inspected.reasons.length > 0 && <p>Unavailable: {inspected.reasons.join(' ')}</p>}
        <p>Reference CDS: <code>{preview(inspectedGene.cds)}</code></p><p>Projected query CDS: <code>{preview(inspected.queryCds)}</code></p>
        <p>Reference translation: <code>{preview(inspectedGene.protein)}</code></p><p>Query translation: <code>{preview(inspected.queryProtein)}</code></p>
        <p>First protein difference: {inspected.firstProteinDifference === null ? 'None reported' : `${inspected.firstProteinDifference + 1} (1-based protein-symbol position)`}.
          Query trailing bases: {inspected.queryTrailingBases}.</p>
        <p>Gap runs at 0-based reference-CDS boundaries: {inspected.indels.map(indel => `${indel.kind} ${indel.length} at ${indel.cdsOffset}`).join('; ') || 'None'}.</p>
      </aside>}
    </div>}
  </section>;
}
