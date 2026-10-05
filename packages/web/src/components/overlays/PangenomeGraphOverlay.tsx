/** Private sequence-graph workspace, with the existing annotation illustration kept explicitly separate. */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { constructPangenomeGraph, exportPangenomeOriginalFasta, mapPangenomeNodeToOriginal, exportAlignmentGfa, exportPangenomeAlignment, serializePangenomeInput, serializeAnalysisRecord,
  type AlignmentGraphOptions, type AlignmentPangenome, type AlignmentVariant } from '@phage-explorer/core';
import { useHotkey } from '../../hooks';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../../hooks/useTheme';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';
import { PangenomeSession, pangenomeRequestFromLocalGenomes, type PangenomeRequest } from '../../workers/PangenomeSession';
import { useLocalGenomes } from '../../db/local-genomes';
import { PangenomeCdsPanel } from './PangenomeCdsPanel';
import { SavedResearchPanel } from './SavedResearchPanel';

// Memory only, retained across panel close/reopen. Closing still cancels work.
const session = new PangenomeSession(() => new Worker(new URL('../../workers/pangenome.worker.ts', import.meta.url), { type: 'module' }));
const BLOCKS_PER_PAGE = 24;
const shortSequence = (sequence: string) => sequence ? sequence.length > 240 ? `${sequence.slice(0, 240)}… (${sequence.length} bases; full allele in export)` : sequence : '∅';

function SequenceGraph({ graph, pathId, page, inspect }: {
  graph: AlignmentPangenome; pathId: string; page: number; inspect: (id: string) => void;
}): React.ReactElement {
  const { theme } = useTheme(), colors = theme.colors;
  const start = page * BLOCKS_PER_PAGE;
  const visible = graph.nodes.filter(n => n.block >= start && n.block < start + BLOCKS_PER_PAGE);
  const levels = new Map<number, number>();
  const positions = new Map(visible.map(node => {
    const level = levels.get(node.block) ?? 0; levels.set(node.block, level + 1);
    return [node.id, { x: 50 + (node.block - start) * 84, y: 40 + level * 42 }];
  }));
  const width = Math.max(320, Math.min(BLOCKS_PER_PAGE, graph.diagnostics.blocks - start) * 84 + 20);
  const height = Math.max(130, Math.max(1, ...levels.values()) * 42 + 30);
  return <figure style={{ margin: 0 }}>
    <div style={{ overflow: 'auto', maxHeight: 520, border: `1px solid ${colors.borderLight}` }}>
      <svg width={width} height={height} role="img" aria-label="Alignment-derived sequence graph">
        <title>Exact sequence segments and input paths; horizontal spacing is by alignment block, not genomic distance.</title>
        {graph.edges.map(edge => {
          const from = positions.get(edge.from), to = positions.get(edge.to);
          if (!from || !to) return null;
          const selected = edge.pathIds.includes(pathId);
          return <line key={`${edge.from}:${edge.to}`} x1={from.x + 25} y1={from.y} x2={to.x - 25} y2={to.y}
            stroke={selected ? colors.accent : colors.textDim} strokeWidth={selected ? 3 : 1} opacity={selected ? 1 : 0.4} />;
        })}
        {visible.map(node => {
          const position = positions.get(node.id)!;
          return <g key={node.id} role="button" tabIndex={0} aria-label={`Inspect node ${node.id}`} onClick={() => inspect(node.id)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(node.id); } }}>
            <rect x={position.x - 25} y={position.y - 13} width={50} height={26} rx={4}
              fill={colors.backgroundAlt} stroke={node.pathIds.includes(pathId) ? colors.accent : node.core ? colors.primary : colors.textDim}
              strokeWidth={node.pathIds.includes(pathId) ? 3 : 1} strokeDasharray={node.ambiguous ? '3 2' : undefined} />
            <text x={position.x} y={position.y + 4} textAnchor="middle" fontSize={11} fill={colors.text}>{node.id}</text>
            <title>{node.sequence.length} bases; {node.pathIds.length} input paths; {node.core ? 'shared unambiguous' : node.ambiguous ? 'contains ambiguity' : 'variable membership'}</title>
          </g>;
        })}
      </svg>
    </div>
    <figcaption>Highlighted links follow the selected input sequence. Dashed nodes contain ambiguity. Only links with both ends on this page are drawn;
      exports contain the complete graph. A path skipping a node is not automatically a biological deletion.</figcaption>
  </figure>;
}

export function PangenomeGraphOverlay(): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay(), { theme } = useTheme(), colors = theme.colors;
  const open = isOpen('pangenomeGraph');
  const phage = usePhageStore(state => state.currentPhage);
  const localGenomes = useLocalGenomes(state => state.genomes);
  const [localIds, setLocalIds] = useState<string[]>([]);
  useEffect(() => { setLocalIds(ids => ids.filter(id => localGenomes.some(g => g.phage.localGenome?.contentId === id))); }, [localGenomes]);
  const [illustratedPhageId, setIllustratedPhageId] = useState<number | null>(null);
  const illustration = useMemo(() => phage && phage.id === illustratedPhageId
    ? constructPangenomeGraph(phage, [], { demonstration: true }) : null, [phage, illustratedPhageId]);
  useEffect(() => { setIllustratedPhageId(null); }, [phage?.id]);
  useHotkey(ActionIds.OverlayPangenomeGraph, () => toggle('pangenomeGraph'));
  const { accepted, busy: computeBusy, phase, error, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const busy = computeBusy || libraryBusy;
  const [pasted, setPasted] = useState('');
  const [draft, setDraft] = useState<AlignmentGraphOptions | null>(null);
  const [pathId, setPathId] = useState('');
  const [blockPage, setBlockPage] = useState(0);
  const [nodeId, setNodeId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [variantPage, setVariantPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<AlignmentVariant['type'] | 'all'>('all');
  const [pathOnly, setPathOnly] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { if (open) session.activate(); else session.deactivate(); return session.deactivate; }, [open]);
  useEffect(() => {
    if (accepted) setDraft({ ...accepted.options });
    setPathId(accepted?.graph?.paths.find(p => p.sequenceId === accepted.options.referenceId)?.id ?? '');
    setNodeId(''); setVariantId(''); setBlockPage(0); setVariantPage(0); setExportError(null);
  }, [accepted]);
  useEffect(() => { setVariantPage(0); }, [typeFilter, pathOnly, pathId]);
  const graph = accepted?.graph, record = accepted?.record;
  const variants = useMemo(() => graph?.variants.filter(v => (typeFilter === 'all' || v.type === typeFilter) &&
    (!pathOnly || v.pathIds.includes(pathId))) ?? [], [graph, typeFilter, pathOnly, pathId]);
  if (!open) return null;
  const selectedNode = graph?.nodes.find(n => n.id === nodeId);
  const selectedVariant = graph?.variants.find(v => v.id === variantId);
  const originalSegments = graph && selectedNode?.pathIds.includes(pathId)
    ? mapPangenomeNodeToOriginal(graph, pathId, selectedNode.id) : null;
  const pathName = (id: string) => graph?.paths.find(p => p.id === id)?.sequenceId ?? id;
  const changed = !!draft && !!accepted && (['referenceId', 'alignment', 'terminalGaps', 'normalization'] as const).some(key => draft[key] !== accepted.options[key]);
  const blockPages = Math.max(1, Math.ceil((graph?.diagnostics.blocks ?? 0) / BLOCKS_PER_PAGE));
  const variantPages = Math.max(1, Math.ceil(variants.length / 100)), currentVariantPage = Math.min(variantPage, variantPages - 1);
  const loadFile = (file: File | undefined) => {
    if (!file) return;
    const request: Promise<PangenomeRequest> = file.size > 10 * 1024 * 1024 ? Promise.reject(new Error('Pangenome file exceeds 10 MiB.'))
      : file.text().then(content => ({ kind: 'import', content, filename: file.name }));
    void session.run(request);
  };
  const save = (kind: 'input' | 'record' | 'gfa' | 'alignment' | 'original') => {
    if (!accepted) return;
    try {
      if (kind === 'input') downloadString(serializePangenomeInput(accepted.input), 'pangenome-input.json', 'application/json');
      else if (kind === 'record' && record) downloadString(serializeAnalysisRecord(record), 'pangenome-analysis.json', 'application/json');
      else if (kind === 'gfa' && graph) downloadString(exportAlignmentGfa(graph), 'pangenome.gfa', 'text/plain');
      else if (kind === 'alignment' && graph) downloadString(exportPangenomeAlignment(graph), 'pangenome-alignment.fasta', 'text/plain');
      else if (kind === 'original' && graph) downloadString(exportPangenomeOriginalFasta(graph), 'pangenome-original.fasta', 'text/plain');
      setExportError(null);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const restoreLocal = async (content: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const previous = session.getSnapshot().accepted;
    const cancel = () => session.cancel(); signal.addEventListener('abort', cancel, { once: true });
    try {
      await session.run({ kind: 'import', content, filename: 'saved-pangenome-analysis.json' });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const next = session.getSnapshot();
      if (next.error) throw new Error(next.error);
      if (next.accepted === previous || !next.accepted?.verified) throw new DOMException('Pangenome restore cancelled', 'AbortError');
    } finally { signal.removeEventListener('abort', cancel); }
  };
  return <Overlay id="pangenomeGraph" title="SEQUENCE PANGENOME & VARIANTS" size="xl"
    provenanceBadge={<span data-testid="pangenome-source">{!accepted ? 'No sequence input' : accepted.input.source === 'demo' ? 'Synthetic sequence example' : 'Local sequence input'}</span>}>
    <div style={{ display: 'grid', gap: '1rem', color: colors.text, overflowWrap: 'anywhere', minWidth: 0 }}>
      <p>Build graphs from your own sequences, not annotation templates. Inputs remain in browser memory and are not uploaded by this tool.
        This workspace is independent of the catalog selection. Save a completed experiment locally or export JSON before reloading.</p>
      <SavedResearchPanel kind="pangenome" suggestedName={accepted?.input.name ?? 'Pangenome experiment'} disabled={computeBusy}
        capture={record ? () => serializeAnalysisRecord(record) : null} restore={restoreLocal} onActivityChange={setLibraryBusy} />
      {!accepted && <p>Comparative sequence evidence has not been supplied. Import sequences below to construct a real graph.</p>}
      {localGenomes.length > 0 && <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}>
        <legend>Compare genomes already imported into the explorer</legend>
        <p>Choose 2–24 genomes. Content IDs keep different records with the same accession separate. This takes a private sequence snapshot;
          no annotations, catalog data or current sequence selection are modified.</p>
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>{localGenomes.map(genome => {
          const id = genome.phage.localGenome!.contentId;
          return <label key={id} style={{ display: 'block' }}><input type="checkbox" checked={localIds.includes(id)}
            disabled={!localIds.includes(id) && localIds.length >= 24}
            onChange={event => setLocalIds(ids => event.target.checked ? [...ids, id] : ids.filter(value => value !== id))} />
            {genome.phage.name} · {genome.phage.accession} · {genome.sequence.length.toLocaleString()} bases · {id.slice(0, 12)}
          </label>;
        })}</div>
        <button type="button" disabled={localIds.length < 2} onClick={() => {
          try { setExportError(null); void session.run(pangenomeRequestFromLocalGenomes(localGenomes, localIds)); }
          catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
        }}>Load selected genomes into pangenome workspace</button>
      </fieldset>}
      <label htmlFor="pangenome-input">Import pangenome FASTA, dataset JSON or saved analysis</label>
      <input id="pangenome-input" type="file" accept=".fa,.fasta,.fna,.aln,.json,text/plain,application/json" disabled={busy}
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; loadFile(file); }} />
      <details><summary>Paste sequences or inspect supported input</summary>
        <p>Supply 2–24 DNA FASTA records with unique identifiers. Existing alignments may use - for gaps; IUPAC ambiguity is retained.
          For unaligned input, choose global locus or related-genome wavefront alignment after loading. RNA, protein sequences, dots and question marks are rejected.</p>
        <label htmlFor="pangenome-paste">Paste pangenome FASTA</label>
        <textarea id="pangenome-paste" rows={5} value={pasted} disabled={busy} onChange={event => setPasted(event.target.value)} style={{ width: '100%' }} />
        <button type="button" disabled={busy || !pasted.trim()} onClick={() => void session.run({ kind: 'import', content: pasted, filename: 'Pasted sequence input' })}>Load pasted sequences</button>
        <p>Sequence datasets: 4 MiB, 250,000 columns, 4,000,000 total cells. Global alignment: 12,000,000 total dynamic-programming cells;
          wavefront mode handles related collinear genomes within explicit work budgets. Graphs are bounded to 4,000 blocks and 12,000 nodes. Saved analyses: 10 MiB.</p>
      </details>
      <div><button type="button" disabled={busy} onClick={() => void session.run({ kind: 'demo' })}>Load synthetic sequence example</button>
        <button type="button" disabled={!computeBusy} onClick={session.cancel}>Cancel pangenome work</button></div>
      {computeBusy && <p role="status">{phase}. The last accepted input and result remain unchanged.</p>}
      {notice && <p role="status">{notice}</p>}
      {(error || exportError) && <p role="alert">{error ?? exportError}</p>}
      {accepted && draft && <>
        <h3 data-testid="pangenome-input-name">{accepted.input.name}</h3>
        <p>{accepted.input.sequences.length} sequences loaded; {accepted.input.source === 'demo' ? 'synthetic example, not observations' : 'user-supplied data, not independently validated'}.</p>
        <form onSubmit={event => { event.preventDefault(); void session.run({ kind: 'analyze', input: accepted.input, options: draft }); }}>
          <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem', border: `1px solid ${colors.borderLight}` }}>
            <legend>Explicit graph construction settings</legend>
            <label htmlFor="pangenome-reference">Pangenome reference sequence</label>
            <select id="pangenome-reference" value={draft.referenceId} onChange={event => setDraft({ ...draft, referenceId: event.target.value })}>
              {accepted.input.sequences.map(s => <option key={s.id} value={s.id}>{s.description || s.id} · {s.id}</option>)}
            </select>
            <label htmlFor="pangenome-alignment">Pangenome alignment mode</label>
            <select id="pangenome-alignment" value={draft.alignment} onChange={event => {
              const alignment = event.target.value as AlignmentGraphOptions['alignment'];
              const { normalization: _normalization, ...base } = draft;
              setDraft(alignment === 'wavefront' ? { ...draft, alignment } : { ...base, alignment });
            }}>
              <option value="provided">Use supplied multiple-sequence alignment</option><option value="global">Align ungapped loci (exact global unit-edit alignment)</option>
              <option value="wavefront">Align related collinear genomes (exact wavefront)</option>
            </select>
            {draft.alignment === 'wavefront' && <>
              <label htmlFor="pangenome-normalization">Strand and origin handling</label>
              <select id="pangenome-normalization" value={draft.normalization ?? ''} onChange={event => {
                const { normalization: _normalization, ...base } = draft;
                const normalization = event.target.value as AlignmentGraphOptions['normalization'];
                setDraft(normalization ? { ...base, normalization } : base);
              }}>
                <option value="">Keep submitted strand and origin</option>
                <option value="strand">Normalize whole-sequence strand (linear or partial input)</option>
                <option value="circular">Normalize strand and origin (all inputs are complete circles)</option>
              </select>
              <p>Exact equivalent representations are recognized first. Otherwise unique 15-mer anchors select a strand/origin;
                this is not exhaustive circular optimization or internal inversion detection. Weak or conflicting anchors stop the analysis.</p>
              {draft.normalization === 'circular' && <p role="note">You are asserting that every input is a complete circular molecule.
                Choose complete-sequence terminal alleles below; do not use this mode for linear or partial assemblies.</p>}
            </>}
            <label htmlFor="pangenome-terminals">Terminal gap interpretation</label>
            <select id="pangenome-terminals" value={draft.terminalGaps} onChange={event => setDraft({ ...draft, terminalGaps: event.target.value as AlignmentGraphOptions['terminalGaps'] })}>
              <option value="missing">Missing coverage: exclude terminal differences</option><option value="alleles">Complete sequences: treat terminal gaps as alleles</option>
            </select>
            <p>Equal lengths do not establish homology. Global mode is a bounded locus aligner, not a rearrangement-aware whole-genome method.
              Wavefront mode computes an exact unit-edit alignment conditional on the selected normalization. Internal inversions and rearrangements remain unsupported.
              It permits 4 million frontier entries and 50 million symbol comparisons per pair, with dataset totals of 12 million and 100 million.
              Divergent inputs exceeding these budgets require an external alignment, not an approximate fallback.
              {changed && ' Edited settings are not applied: existing results and exports retain their submitted parameters.'}</p>
            <button type="submit" disabled={draft.normalization === 'circular' && draft.terminalGaps !== 'alleles'}>Build sequence graph</button>
          </fieldset>
        </form>
        <div><button type="button" disabled={busy} onClick={() => save('input')}>Export pangenome dataset</button>
          <button type="button" disabled={busy || !record} onClick={() => save('record')}>Export pangenome analysis</button>
          <button type="button" disabled={busy || !graph} onClick={() => save('gfa')}>Export sequence graph GFA</button>
          <button type="button" disabled={busy || !graph} onClick={() => save('alignment')}>Export graph alignment FASTA</button>
          <button type="button" disabled={busy || !graph} onClick={() => save('original')}>Export original sequence FASTA</button></div>
        <PangenomeCdsPanel accepted={accepted} options={draft} localGenomes={localGenomes} busy={busy} run={session.run} />
      </>}
      {phage && <section aria-label="Annotation illustration" style={{ border: `1px solid ${colors.borderLight}`, padding: '.75rem' }}>
        <h3>Separate educational illustration</h3>
        <p>The legacy annotation-template illustration is not a graph computed from your sequence input. Opening it never replaces or exports evidence from the sequence workspace.</p>
        {!illustration ? <button type="button" onClick={() => setIllustratedPhageId(phage.id)}>Show illustrative pangenome</button> : <>
          <strong>DEMONSTRATION — invented companion variants, not sequence evidence</strong>
          <p role="note" aria-label="Demonstration assumptions">{illustration.assumptions}</p>
          <p>{illustration.summary}</p>
          <div style={{ overflowX: 'auto' }}><table aria-label="Illustrative variant examples"><thead><tr><th>Illustration</th><th>Template type</th><th>Invented interval</th></tr></thead>
            <tbody>{illustration.variantCards.map(card => <tr key={card.id}><td>{card.id}</td><td>{card.type}</td><td>[{card.locusStartBp}, {card.locusEndBp})</td></tr>)}</tbody></table></div>
          <button type="button" onClick={() => setIllustratedPhageId(null)}>Return to available data</button>
        </>}
      </section>}
      {graph && record && <section data-testid="pangenome-result" data-result-id={record.resultId} style={{ minWidth: 0 }}>
        <h3>Sequence-derived graph</h3>
        <p data-testid="pangenome-summary">{graph.nodes.length} sequence nodes; {graph.edges.length} links; {graph.paths.length} {graph.diagnostics.normalization ? 'reversibly normalized paths' : 'exact input paths'};
          {` ${graph.variants.length} reference-relative variants.`}</p>
        <p data-testid="pangenome-reference-used">Submitted reference: {graph.options.referenceId} ({graph.referenceLength} bases).
          Alignment: {graph.options.alignment}. Terminal gaps: {graph.options.terminalGaps}. Normalization: {graph.options.normalization ?? 'none'}.</p>
        <p>{graph.diagnostics.sharedUnambiguousBases} unambiguous bases shared by every input path; {graph.diagnostics.allGapColumns} all-gap columns omitted.
          These are properties of this input set, not species-wide core/accessory estimates.</p>
        {graph.diagnostics.wavefront && <details><summary>Exact alignment distances and work</summary>
          <p>{graph.diagnostics.wavefront.states.toLocaleString()} frontier entries; {graph.diagnostics.wavefront.comparisons.toLocaleString()} symbol comparisons.
            Edit distance counts literal symbol substitutions, insertions and deletions, not biological events or evolutionary time.</p>
          <table aria-label="Wavefront alignment distances"><thead><tr><th>Sequence</th><th>Edit distance</th><th>Frontier entries</th></tr></thead>
            <tbody>{graph.diagnostics.wavefront.pairs.map(pair => <tr key={pair.sequenceId}>
              <td>{accepted?.input.sequences.find(s => s.id === pair.sequenceId)?.description || pair.sequenceId}</td>
              <td>{pair.distance}</td><td>{pair.states.toLocaleString()}</td>
            </tr>)}</tbody>
          </table>
        </details>}
        {graph.diagnostics.normalization && <section aria-label="Sequence normalization evidence">
          <h4>Submitted-to-aligned coordinate transforms</h4>
          <p>The reference retains its submitted origin. For each query, reverse-complement when strand is −, then rotate left by the
            0-based offset shown below. These transforms are included in the experiment and GFA; original FASTA reverses them.</p>
          <div style={{ overflowX: 'auto' }}><table aria-label="Sequence strand and origin transforms">
            <thead><tr><th>Sequence</th><th>Strand</th><th>Offset</th><th>Evidence</th></tr></thead>
            <tbody>{graph.diagnostics.normalization.sequences.map(entry => <tr key={entry.sequenceId}>
              <td>{entry.sequenceId}</td><td>{entry.transform.strand}</td><td>{entry.transform.offset}</td>
              <td>{!entry.evidence ? 'Submitted reference (unchanged)' : entry.evidence.method === 'exact-equivalence'
                ? `Exact symbol equivalence; ${entry.evidence.equivalentForwardOrigins} forward / ${entry.evidence.equivalentReverseOrigins} reverse origins`
                : `Unique non-overlapping 15-mers: ${entry.evidence.forwardSupport} forward / ${entry.evidence.reverseSupport} reverse`}</td>
            </tr>)}</tbody>
          </table></div>
          <p>Anchor support is not a confidence probability. Multiple exact transforms do not identify a biological origin.
            GFA/alignment FASTA paths use the normalized representation, not necessarily the original strand or start.</p>
        </section>}
        <label htmlFor="pangenome-path">Highlight input sequence path</label>
        <select id="pangenome-path" value={pathId} onChange={event => setPathId(event.target.value)}>
          {graph.paths.map(p => <option key={p.id} value={p.id}>{p.sequenceId} ({p.length} bases)</option>)}
        </select>
        <SequenceGraph graph={graph} pathId={pathId} page={blockPage} inspect={setNodeId} />
        <div><button type="button" disabled={blockPage === 0} onClick={() => setBlockPage(blockPage - 1)}>Previous graph blocks</button>
          <span> Blocks page {blockPage + 1}/{blockPages} </span>
          <button type="button" disabled={blockPage + 1 >= blockPages} onClick={() => setBlockPage(blockPage + 1)}>Next graph blocks</button></div>
        <label htmlFor="pangenome-node">Inspect sequence node</label>
        <select id="pangenome-node" value={selectedNode && Math.floor(selectedNode.block / BLOCKS_PER_PAGE) === blockPage ? nodeId : ''} onChange={event => setNodeId(event.target.value)}>
          <option value="">Select a node in this graph page</option>
          {graph.nodes.filter(node => Math.floor(node.block / BLOCKS_PER_PAGE) === blockPage).map(node => <option key={node.id} value={node.id}>{node.id} · {node.sequence.length} bases</option>)}
        </select>
        {selectedNode && <aside aria-label="Sequence node details">
          <h4>{selectedNode.id}: {selectedNode.sequence.length} bases</h4>
          <p>Alignment columns [{selectedNode.alignmentStart}, {selectedNode.alignmentEnd}); reference span [{selectedNode.referenceStart}, {selectedNode.referenceEnd}).
            Traversed by: {selectedNode.pathIds.map(pathName).join(', ')}.</p>
          <code>{shortSequence(selectedNode.sequence)}</code>
          {originalSegments && <p aria-label="Original input node coordinates">Original coordinates on {pathName(pathId)}:
            {' '}{originalSegments.map(segment => `[${segment.start}, ${segment.end}) strand ${segment.strand}`).join(' then ')}.
            {' '}Coordinates are 0-based, half-open and listed in path traversal order; reverse-strand segments are reverse-complemented.</p>}
          {!originalSegments && <p>The highlighted path does not traverse this node. Choose a supporting input path to inspect its original coordinates.</p>}
        </aside>}
        <h3>Reference-relative variant cards</h3>
        <p>Coordinates are 0-based, half-open [start, end). Insertions have start = end at the reference boundary; ∅ is an empty allele.
          These are sequence differences, not inferred structural rearrangements, gene impacts or donor assignments.</p>
        <label htmlFor="pangenome-variant-type">Variant type</label>
        <select id="pangenome-variant-type" value={typeFilter} onChange={event => setTypeFilter(event.target.value as typeof typeFilter)}>
          {['all', 'snv', 'substitution', 'insertion', 'deletion', 'replacement'].map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <label><input type="checkbox" checked={pathOnly} onChange={event => setPathOnly(event.target.checked)} /> Only differences for the highlighted sequence</label>
        <div style={{ overflowX: 'auto' }}><table aria-label="Reference-relative variants" style={{ width: '100%' }}>
          <thead><tr><th>Variant</th><th>Type</th><th>Reference interval</th><th>Reference allele</th><th>Alternate allele</th><th>Input sequences</th></tr></thead>
          <tbody>{variants.slice(currentVariantPage * 100, (currentVariantPage + 1) * 100).map(v => <tr key={v.id} data-testid="pangenome-variant">
            <td><button type="button" onClick={() => {
              setVariantId(v.id);
              const node = graph.nodes.find(n => n.referenceStart <= v.referenceStart && n.referenceEnd >= v.referenceStart);
              if (node) { setBlockPage(Math.floor(node.block / BLOCKS_PER_PAGE)); setNodeId(node.id); }
            }}>{v.id}</button></td><td>{v.type}</td><td>[{v.referenceStart}, {v.referenceEnd})</td>
            <td><code>{v.reference.length > 30 ? `${v.reference.slice(0, 30)}…` : v.reference || '∅'}</code></td>
            <td><code>{v.alternate.length > 30 ? `${v.alternate.slice(0, 30)}…` : v.alternate || '∅'}</code></td>
            <td>{v.pathIds.map(pathName).join(', ')}</td>
          </tr>)}</tbody>
        </table></div>
        {variants.length === 0 && <p>No callable differences pass the display filter. Missing or ambiguous sequence is not evidence of biological identity.</p>}
        {variantPages > 1 && <div><button type="button" disabled={currentVariantPage === 0} onClick={() => setVariantPage(currentVariantPage - 1)}>Previous variants</button>
          <span> {currentVariantPage + 1}/{variantPages} </span><button type="button" disabled={currentVariantPage + 1 >= variantPages} onClick={() => setVariantPage(currentVariantPage + 1)}>Next variants</button></div>}
        {selectedVariant && <aside aria-label="Variant allele details"><h4>{selectedVariant.id}: exact allele evidence</h4>
          <p>Reference: <code>{shortSequence(selectedVariant.reference)}</code></p><p>Alternate: <code>{shortSequence(selectedVariant.alternate)}</code></p>
          <p>Net length change: {selectedVariant.alternate.length - selectedVariant.reference.length} bases. Supporting input sequences: {selectedVariant.pathIds.map(pathName).join(', ')}.</p>
        </aside>}
        <h3>Comparison coverage</h3>
        <div style={{ overflowX: 'auto' }}><table aria-label="Pangenome comparison coverage"><thead><tr><th>Sequence</th><th>Comparable columns</th><th>Ambiguous columns</th><th>Missing terminal columns</th></tr></thead>
          <tbody>{graph.diagnostics.comparisons.map(c => <tr key={c.pathId}><td>{pathName(c.pathId)}</td><td>{c.comparableColumns}</td><td>{c.ambiguousColumns}</td><td>{c.missingTerminalColumns}</td></tr>)}</tbody>
        </table></div>
        <details><summary>Method assumptions and limitations</summary>{graph.diagnostics.limitations.map(limit => <p key={limit}>{limit}</p>)}</details>
        <AnalysisRecordDetails record={record} />
      </section>}
    </div>
  </Overlay>;
}
