/** Aligned FASTA -> unrooted NJ -> portable evidence. Never infers homology or a temporal root. */
import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { PHYLOGENY_LIMITS, resolvePhylogenyOptions, type AlignedPhylogenyResult, type PhylogenyOptions, type PhylogenySource } from '../../../../core/src/analysis/aligned-phylogeny';
import { AlignedPhylogenySession, readAlignedPhylogenyFile } from '../../workers/AlignedPhylogenySession';
import { downloadString } from '../../utils/export';
import { useTheme } from '../../hooks/useTheme';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

const example: PhylogenySource = {
  name: 'Synthetic aligned quartet — not experimental data', kind: 'demo',
  reference: 'Hand-constructed alignment: four shared substitutions separate A/B from C/D; one private substitution in B and D. No biological samples.',
  fasta: '>A\nAAAAAAAAAAAA\n>B\nAAAAAAAATAAA\n>C\nGGGGAAAAAAAA\n>D\nGGGGAAAAATAA\n',
};
const number = (value: number): string => value === 0 ? '0' : value.toPrecision(6);

/** Topology-only layout avoids clipping or disguising signed NJ branch lengths. */
function Topology({ result }: { result: AlignedPhylogenyResult }): React.ReactElement {
  const { theme } = useTheme();
  const { tree } = result;
  const links = tree.nodes.map(() => [] as number[]);
  tree.edges.forEach(edge => { links[edge.a].push(edge.b); links[edge.b].push(edge.a); });
  const depth = tree.nodes.map(() => 0), y = tree.nodes.map(() => 0);
  const parent = tree.nodes.map(() => -1); let leaf = 0, maxDepth = 1;
  const visit = (id: number, previous: number, level: number): void => {
    parent[id] = previous; depth[id] = level; maxDepth = Math.max(maxDepth, level);
    if (tree.nodes[id].label !== null) { y[id] = 25 + leaf++ * 25; return; }
    const children = links[id].filter(next => next !== previous);
    children.forEach(next => visit(next, id, level + 1));
    y[id] = children.reduce((sum, next) => sum + y[next], 0) / children.length;
  };
  visit(tree.serializationRoot, -1, 0);
  const x = (id: number) => tree.nodes[id].label !== null ? 570 : 25 + depth[id] / maxDepth * 500;
  const epsilon = Number.EPSILON * 256 * Math.max(...result.distances.flat());
  return <figure style={{ margin: 0 }}>
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 1180 ${leaf * 25 + 30}`} role="img" aria-label="Unrooted neighbor-joining topology, arbitrary display root, not to branch-length scale"
        style={{ width: '100%', minWidth: 720, display: 'block' }}>
        <desc>Lines encode connectivity only, not branch lengths. Dashed edges are nonpositive or numerically zero. Signed lengths and positive split supports are in the tables and exports.</desc>
        {tree.edges.map((edge, index) => {
          const a = parent[edge.b] === edge.a ? edge.a : edge.b, b = a === edge.a ? edge.b : edge.a;
          return <path key={index} d={`M${x(a)} ${y[a]}V${y[b]}H${x(b)}`} fill="none" strokeWidth={1.5}
            stroke={edge.length < -epsilon ? theme.colors.error : theme.colors.primary} strokeDasharray={edge.length <= epsilon ? '4 3' : undefined}>
            <title>{`Nodes ${edge.a}–${edge.b}: signed branch length ${edge.length}`}</title>
          </path>;
        })}
        {tree.nodes.filter(node => node.label !== null).map(node => <text key={node.id} x={585} y={y[node.id] + 4} fill={theme.colors.text} fontSize={13}>{node.label}</text>)}
      </svg>
    </div>
    <figcaption>Unrooted connectivity with an arbitrary display root. Spacing is not branch length or time. Dashed edges do not establish a resolved split; negative lengths remain in the exports.</figcaption>
  </figure>;
}

export function AlignedPhylogenyPanel(): React.ReactElement {
  const { theme } = useTheme(); const id = useId();
  const session = useMemo(() => new AlignedPhylogenySession(() => new Worker(new URL('../../workers/aligned-phylogeny.worker.ts', import.meta.url), { type: 'module' })), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { accepted, busy, phase, error, verified } = snapshot;
  const [source, setSource] = useState<PhylogenySource>({ name: '', fasta: '', kind: 'local', reference: '' });
  const [file, setFile] = useState<File | null>(null);
  const [distance, setDistance] = useState<PhylogenyOptions['distance']>('p-distance');
  const [bootstrap, setBootstrap] = useState('0'), [seed, setSeed] = useState('1');
  const [confirmed, setConfirmed] = useState(false), [localError, setLocalError] = useState<string | null>(null);
  const [distancePage, setDistancePage] = useState(0), [showDistances, setShowDistances] = useState(false);
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => {
    if (!accepted) return;
    setSource(accepted.source); setFile(null); setDistance(accepted.options.distance);
    setBootstrap(String(accepted.options.bootstrap)); setSeed(String(accepted.options.seed)); setConfirmed(true); setDistancePage(0);
  }, [accepted]);
  const invalidate = () => { session.invalidate(); setLocalError(null); };
  const editSource = <K extends keyof PhylogenySource>(key: K, value: PhylogenySource[K]) => {
    invalidate(); if (key === 'fasta') setConfirmed(false); setSource(previous => ({ ...previous, [key]: value }));
  };
  const report = (cause: unknown) => setLocalError(cause instanceof Error ? cause.message : String(cause));
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); invalidate();
    try {
      if (!confirmed) throw new Error('Confirm that these are homologous, already aligned DNA columns.');
      if (!/^\d+$/.test(bootstrap) || !/^\d+$/.test(seed)) throw new Error('Bootstrap count and seed must be explicit nonnegative decimal integers.');
      const options = resolvePhylogenyOptions({ distance, deletion: 'complete', bootstrap: Number(bootstrap), seed: Number(seed) });
      const captured = { ...source }, submittedFile = file;
      void session.run(async () => ({ kind: 'infer', options, source: { ...captured,
        fasta: submittedFile ? await readAlignedPhylogenyFile(submittedFile, PHYLOGENY_LIMITS.bytes) : captured.fasta } }));
    } catch (cause) { report(cause); }
  };
  const replay = (input: File) => {
    invalidate(); void session.run(async () => ({ kind: 'replay', content: await readAlignedPhylogenyFile(input, 10 * 1024 * 1024) }));
  };
  const exportResult = (format: 'experiment' | 'newick' | 'distances' | 'splits') => {
    if (!accepted || busy) return;
    try {
      const { result, record } = accepted;
      const content = format === 'experiment' ? serializeAnalysisRecord(record) : format === 'newick' ? result.newick + '\n'
        : format === 'splits' ? JSON.stringify({ resultId: record.resultId, bootstrap: result.bootstrap, splits: result.splits, warnings: result.warnings }, null, 2) + '\n'
        : ['taxon\t' + result.taxa.join('\t'), ...result.taxa.map((taxon, index) => taxon + '\t' + result.distances[index].join('\t'))].join('\n') + '\n';
      const suffix = format === 'newick' ? 'nwk' : format === 'distances' ? 'tsv' : 'json';
      downloadString(content, `aligned-phylogeny-${format}.${suffix}`, suffix === 'json' ? 'application/json' : 'text/plain'); setLocalError(null);
    } catch (cause) { report(cause); }
  };
  const result = accepted?.result;
  const pairs = result?.taxa.flatMap((a, i) => result.taxa.slice(i + 1).map((b, offset) => ({ a, b, distance: result.distances[i][i + offset + 1] }))) ?? [];
  const pages = Math.max(1, Math.ceil(pairs.length / 50)), page = Math.min(distancePage, pages - 1);
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '.25rem', minWidth: 0 };
  const control: React.CSSProperties = { minHeight: 44, maxWidth: '100%', boxSizing: 'border-box' };
  return <section aria-labelledby={`${id}-heading`} style={{ display: 'grid', gap: '.75rem', minWidth: 0, overflowWrap: 'anywhere', color: theme.colors.text }}
    onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <h3 id={`${id}-heading`}>Aligned DNA · unrooted phylogeny</h3>
    <p>Infer a neighbor-joining tree from your own aligned DNA. This workspace never searches a catalog or uploads the alignment.
      It neither aligns sequences nor supplies a biological root, molecular clock, selection estimate or population history. Export before closing; data are held in memory only.</p>
    <form onSubmit={submit} style={{ display: 'grid', gap: '.75rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))', gap: '.75rem' }}>
        <label style={label}>Alignment name<input style={control} required maxLength={200} value={source.name} onChange={e => editSource('name', e.target.value)} /></label>
        <label style={label}>Alignment source and homology provenance<input style={control} required maxLength={2000} value={source.reference} onChange={e => editSource('reference', e.target.value)} /></label>
        <label style={label}>Alignment provenance type<select style={control} value={source.kind} onChange={e => editSource('kind', e.target.value as PhylogenySource['kind'])}>
          <option value="local">User-supplied local alignment — not independently verified</option><option value="demo">Synthetic demonstration — not experimental evidence</option></select></label>
        <label style={label}>Sequence distance<select style={control} value={distance} onChange={e => { invalidate(); setDistance(e.target.value as PhylogenyOptions['distance']); }}>
          <option value="p-distance">Observed p-distance</option><option value="jc69">JC69 correction (rejects saturation)</option></select></label>
        <label style={label}>Site-bootstrap replicates (0 or 20–200)<input style={control} type="number" required min={0} max={200} step={1} value={bootstrap} onChange={e => { invalidate(); setBootstrap(e.target.value); }} /></label>
        <label style={label}>Phylogeny seed (0–4294967295)<input style={control} type="number" required min={0} max={0xffffffff} step={1} value={seed} onChange={e => { invalidate(); setSeed(e.target.value); }} /></label>
      </div>
      <label style={label}>Already aligned DNA FASTA<textarea rows={6} maxLength={PHYLOGENY_LIMITS.bytes} value={source.fasta} disabled={!!file} spellCheck={false} onChange={e => editSource('fasta', e.target.value)} /></label>
      <label style={label}>Or choose aligned FASTA (up to 2 MiB)<input style={control} type="file" accept=".fa,.fasta,.fas,.fna,.txt" onChange={e => { const selected = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (selected) { invalidate(); setFile(selected); setConfirmed(false); } }} /></label>
      {file && <p>Selected: {file.name}. <button type="button" onClick={() => { invalidate(); setFile(null); setConfirmed(false); }}>Use pasted alignment instead</button></p>}
      <p>3–64 unique FASTA IDs, equal nonzero sequence lengths, up to 100,000 columns. Every column with a gap, missing value or ambiguous base in any taxon is removed from every pair. A work budget may require fewer taxa, sites or bootstrap replicates.</p>
      <label style={{ display: 'flex', alignItems: 'center', minHeight: 44, gap: '.5rem' }}><input type="checkbox" checked={confirmed} onChange={e => { invalidate(); setConfirmed(e.target.checked); }} />I confirm these are homologous, already aligned DNA columns, not unaligned genomes.</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
        <button type="submit" style={control} disabled={busy}>Infer unrooted tree</button>
        <button type="button" style={control} onClick={() => { invalidate(); setSource({ ...example }); setFile(null); setDistance('p-distance'); setBootstrap('20'); setSeed('0'); setConfirmed(true); }}>Load synthetic quartet</button>
        <button type="button" style={control} disabled={!busy} onClick={session.cancel}>Cancel tree computation</button>
      </div>
    </form>
    <label style={label}>Restore verified phylogeny experiment JSON (up to 10 MiB)<input style={control} type="file" accept=".json,application/json" onChange={e => { const selected = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (selected) replay(selected); }} /></label>
    <p role="status" data-testid="aligned-phylogeny-status">{phase || 'No alignment has been analyzed.'}</p>
    {(localError || error) && <p role="alert">{localError ?? error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
      <button type="button" style={control} disabled={!accepted || busy} onClick={() => exportResult('experiment')}>Export phylogeny experiment JSON</button>
      <button type="button" style={control} disabled={!accepted || busy} onClick={() => exportResult('newick')}>Export unrooted Newick</button>
      <button type="button" style={control} disabled={!accepted || busy} onClick={() => exportResult('distances')}>Export distance matrix TSV</button>
      <button type="button" style={control} disabled={!accepted || busy} onClick={() => exportResult('splits')}>Export split supports JSON</button>
    </div>
    {accepted && result && <section aria-label="Accepted aligned phylogeny" data-result-id={accepted.record.resultId}>
      <h4>{accepted.source.name}</h4>
      <p><strong>{accepted.source.kind === 'demo' ? 'SYNTHETIC — NOT EXPERIMENTAL EVIDENCE' : 'USER-SUPPLIED ALIGNMENT — HOMOLOGY NOT INDEPENDENTLY VERIFIED'}</strong></p>
      <p>{accepted.source.reference}</p>
      <p>{verified ? 'Replay verified against fresh computation. ' : ''}{result.taxa.length} taxa; {result.usedSites}/{result.alignmentSites} columns retained; {result.variableSites} variable sites.
        {' '}{result.negativeEdges} negative and {result.zeroEdges} numerically zero edges; distance reconstruction RMSE {number(result.distanceResidualRMSE)}.</p>
      <Topology result={result} />
      <p>Site resampling: {result.bootstrap.completed}/{result.bootstrap.requested} completed; {result.bootstrap.saturated} saturated.
        {' '}{result.bootstrap.supportAvailable ? 'Reported support is a resampling proportion, not the probability a split is true.' : 'Split support is unavailable (disabled or at least one bootstrap was saturated).'}</p>
      <div style={{ overflowX: 'auto' }}><table aria-label="Positive-length unrooted splits"><thead><tr><th>Split side</th><th>Complement</th><th>Length</th><th>Bootstrap count</th><th>Proportion</th></tr></thead>
        <tbody>{result.splits.map(split => <tr key={JSON.stringify(split.side)}><td>{split.side.join(', ')}</td><td>{split.other.join(', ')}</td><td>{number(split.length)}</td><td>{split.bootstrapCount ?? 'Unavailable'}</td><td>{split.support === null ? 'Unavailable' : number(split.support)}</td></tr>)}</tbody></table></div>
      {!result.splits.length && <p>No positive-length internal splits were resolved. Drawn binary connections are not evidence of resolution.</p>}
      <details><summary>Signed branch lengths (display-node IDs, not ancestral identities)</summary><table aria-label="Signed NJ branch lengths"><thead><tr><th>First endpoint</th><th>Second endpoint</th><th>Signed length</th></tr></thead>
        <tbody>{result.tree.edges.map((edge, index) => <tr key={index}><td>{result.tree.nodes[edge.a].label ?? `Display node ${edge.a}`}</td><td>{result.tree.nodes[edge.b].label ?? `Display node ${edge.b}`}</td><td>{number(edge.length)}</td></tr>)}</tbody></table></details>
      <button type="button" style={control} aria-expanded={showDistances} onClick={() => setShowDistances(!showDistances)}>Inspect pairwise distances</button>
      {showDistances && <><table aria-label="Aligned DNA pairwise distances"><thead><tr><th>First taxon</th><th>Second taxon</th><th>{accepted.options.distance}</th></tr></thead><tbody>
        {pairs.slice(page * 50, (page + 1) * 50).map(pair => <tr key={`${pair.a}:${pair.b}`}><td>{pair.a}</td><td>{pair.b}</td><td>{number(pair.distance)}</td></tr>)}</tbody></table>
        <div><button type="button" disabled={!page} onClick={() => setDistancePage(page - 1)}>Previous distances</button> {page + 1}/{pages} <button type="button" disabled={page + 1 === pages} onClick={() => setDistancePage(page + 1)}>Next distances</button></div></>}
      <details><summary>Excluded alignment columns (0-based)</summary><p>{result.excludedColumns.length ? result.excludedColumns.join(', ') : 'None'}</p></details>
      <details open><summary>Method assumptions and limits</summary>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
      <p>Newick preserves signed lengths and an arbitrary serialization root. Do not feed that root into dated-tree diagnostics as a biological rooting decision. Independently justified rooting and compatible nonnegative lengths are separate prerequisites.</p>
      <AnalysisRecordDetails record={accepted.record} />
    </section>}
  </section>;
}
