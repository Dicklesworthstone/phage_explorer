import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import type { ProteinReferenceBundle, ProteinReferenceInputs, ProteinAlignmentInput } from '../../../../core/src/protein-reference';
import type { PhageFull } from '../../../../core/src/types';
import { exportProteinStructureTsv, exportProteinAlignmentTsv, type ProteinStructureOptions,
  type ProteinAlignmentExperiment } from '../../../../core/src/analysis/tail-fiber-structure';
import { ProteinEvidenceSession, readProteinEvidenceFile, type ProteinEvidenceExperiment, type ProteinEvidenceOrigin } from '../../workers/ProteinEvidenceSession';
import { OverlayStatCard, OverlayStatGrid } from './primitives';

function download(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
const shown = (value: number | null, digits = 0) => value === null ? 'unavailable' : digits ? value.toFixed(digits) : String(value);

export function ProteinEvidenceResults({ experiment, origin, verified }: {
  experiment: ProteinEvidenceExperiment; origin: ProteinEvidenceOrigin; verified: boolean;
}): React.ReactElement {
  const { result, record, options, reference } = experiment;
  const [start, setStart] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { setStart(1); setExportError(null); }, [record.resultId]);
  const first = Math.max(1, Math.min(result.protein.length, Number.isSafeInteger(start) ? start : 1));
  const rows = result.residues.slice(first - 1, first + 24);
  const filename = 'protein-evidence-' + result.protein.accession.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '-' + record.resultId.slice(0, 12);
  const save = (section: 'json' | 'residues' | 'contacts') => {
    try {
      download(section === 'json' ? serializeAnalysisRecord(record) : exportProteinStructureTsv(record, section),
        filename + (section === 'json' ? '.json' : '-' + section + '.tsv'),
        section === 'json' ? 'application/json' : 'text/tab-separated-values');
      setExportError(null);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const interchain = !result.chain ? 'unavailable' : options.contactScope === 'chain' ? 'not compared' : String(result.coverage.interchainContacts);
  return <section aria-label="Protein evidence results">
    <h4>{result.protein.accession}: reference-derived residue evidence</h4>
    {origin.kind === 'current-cds'
      ? <p>Verified against the loaded genome {origin.genomeAccession}, CDS {origin.geneId}, deposited protein {origin.proteinAccession}.</p>
      : <p>Standalone {origin.kind === 'saved-experiment' ? 'saved experiment' : 'reference file'}: {origin.name}. This result describes its embedded protein reference; no current genome or selected CDS was verified.</p>}
    <p>{verified ? 'Fresh replay verified.' : 'Fresh analysis.'} {result.protein.length} complete protein residues; {result.alignment.rows} alignment rows.
      {' '}Unweighted entropy uses observed amino acids, excludes gaps, and requires at least two observations.</p>
    <OverlayStatGrid columns={4}>
      <OverlayStatCard label="Residues with entropy" value={result.coverage.entropyResidues + ' / ' + result.coverage.proteinResidues} />
      <OverlayStatCard label="Observed C-alpha residues" value={result.coverage.coordinateResidues + ' / ' + result.coverage.proteinResidues} />
      <OverlayStatCard label="Within-chain pairs" value={result.chain ? result.coverage.intrachainContacts : 'unavailable'} />
      <OverlayStatCard label="Between-chain pairs" value={interchain} />
    </OverlayStatGrid>
    <p>{result.chain
      ? 'PDB ' + result.chain.pdbId + ', revision ' + result.chain.entryVersion + ', assembly ' + result.chain.assemblyId +
        '; label chain ' + result.chain.labelAsymId + ', author chain ' + result.chain.authAsymId +
        '; source protein interval ' + result.chain.start + '–' + result.chain.end + '.'
      : 'No chain selected: geometry is unavailable; alignment evidence is retained.'}</p>
    <p>Distance cutoff {options.contactCutoffAngstrom} Å; within-chain sequence separation ≥ {options.minSequenceSeparation} residues;
      {' '}{options.contactScope === 'assembly' ? 'selected chain versus other supplied chains in the same assembly frame' : 'selected chain only'}.
      {' '}Zero pairs means none met these settings among the supplied observed C-alpha atoms.</p>
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <button type="button" onClick={() => save('json')}>Export protein experiment JSON</button>
      <button type="button" onClick={() => save('residues')}>Export residue TSV</button>
      <button type="button" onClick={() => save('contacts')}>Export contact TSV</button>
    </div>
    {exportError && <p role="alert">{exportError}</p>}
    <h4>Residue inspector</h4>
    <label>First protein residue <input aria-label="First protein residue" type="number" min={1} max={result.protein.length}
      value={first} onChange={event => setStart(Number(event.target.value))} /></label>
    <button type="button" disabled={first === 1} onClick={() => setStart(Math.max(1, first - 25))}>Previous residues</button>
    <button type="button" disabled={first + 24 >= result.protein.length} onClick={() => setStart(Math.min(result.protein.length, first + 25))}>Next residues</button>
    <p>Showing protein positions {first}–{Math.min(first + 24, result.protein.length)}. TSV contains every residue. Protein, alignment-column and label-sequence positions are one-based; author numbering and insertion codes retain the deposited labels.</p>
    <div style={{ overflowX: 'auto' }}>
      <table>
        <caption>Observed alignment and coordinate coverage per protein residue</caption>
        <thead><tr><th>Protein position</th><th>AA</th><th>Alignment column</th><th>Observed / rows</th><th>Gaps</th><th>Entropy (bits)</th><th>Label / author residue</th><th>Within-chain neighbors</th><th>Other-chain neighbors</th><th>Nearest compared CA (Å)</th></tr></thead>
        <tbody>{rows.map(residue => <tr key={residue.position}>
          <td>{residue.position}</td><td>{residue.aminoAcid}</td>
          <td>{residue.alignment?.column ?? 'unavailable'}</td>
          <td>{residue.alignment ? residue.alignment.observed + ' / ' + residue.alignment.total : 'unavailable'}</td>
          <td>{residue.alignment?.gaps ?? 'unavailable'}</td>
          <td>{shown(residue.alignment?.entropyBits ?? null, 4)}</td>
          <td>{residue.coordinate ? residue.coordinate.labelSeqId + ' / ' + residue.coordinate.authSeqId + residue.coordinate.insertionCode : 'unavailable'}</td>
          <td>{shown(residue.intrachainNeighbors)}</td>
          <td>{options.contactScope === 'chain' ? 'not compared' : shown(residue.interchainNeighbors)}</td>
          <td>{shown(residue.nearestNonlocalDistanceAngstrom, 3)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <details>
      <summary>Observed contact pairs ({result.contacts.length})</summary>
      <p>Showing at most 100 pairs; contact TSV contains all accepted pairs and their complete chain/residue identities.</p>
      <div style={{ overflowX: 'auto' }}><table>
        <caption>Observed C-alpha pairs within the requested cutoff</caption>
        <thead><tr><th>Kind</th><th>Query protein / chain / position</th><th>Partner protein / chain / position</th><th>Distance (Å)</th></tr></thead>
        <tbody>{result.contacts.slice(0, 100).map((contact, index) => <tr key={index}>
          <td>{contact.kind}</td><td>{contact.query.proteinId} / {contact.query.labelAsymId} / {contact.query.proteinPosition}</td>
          <td>{contact.partner.proteinId} / {contact.partner.labelAsymId} / {contact.partner.proteinPosition}</td>
          <td>{contact.distanceAngstrom.toFixed(3)}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <details>
      <summary>Method, sources and limitations</summary>
      <p>{record.method.id}, version {record.method.version}. {record.method.implementation}</p>
      <ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
      <ul>{reference.sources.map(source => <li key={source.id}>
        <a href={source.uri} target="_blank" rel="noreferrer">{source.id}</a>: {source.version}; {source.license}
      </li>)}</ul>
      <p>Reference identity: {reference.bundleSha256}</p><p>Result identity: {record.resultId}</p>
    </details>
  </section>;
}


export function ProteinAlignmentResults({ experiment, verified }: {
  experiment: ProteinAlignmentExperiment; verified: boolean;
}): React.ReactElement {
  const { input, result, record } = experiment;
  const [start, setStart] = useState(1), [error, setError] = useState<string | null>(null);
  useEffect(() => { setStart(1); setError(null); }, [record.resultId]);
  const first = Math.max(1, Math.min(result.protein.length, Number.isSafeInteger(start) ? start : 1));
  const rows = result.residues.slice(first - 1, first + 24);
  const filename = 'protein-alignment-' + result.protein.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '-' + record.resultId.slice(0, 12);
  const save = (format: 'json' | 'tsv') => {
    try {
      download(format === 'json' ? serializeAnalysisRecord(record) : exportProteinAlignmentTsv(record), filename + '.' + format,
        format === 'json' ? 'application/json' : 'text/tab-separated-values');
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section aria-label="Supplied protein alignment results">
    <h4>{input.name}: observed protein alignment diversity</h4>
    <p>{input.source.kind === 'demo' ? 'User-declared teaching demonstration.' : 'User-supplied local alignment.'}
      {' '}{verified ? 'Fresh replay verified.' : 'Fresh analysis.'} Target record: {result.protein.id}
      {result.protein.description ? ' — ' + result.protein.description : ''}.</p>
    <p>Declared source: {input.source.description}. Reference: {input.source.reference ?? 'No citation supplied'}.
      {' '}These are supplied labels and attribution; no current genome, accession or CDS mapping has been verified.</p>
    <OverlayStatGrid columns={4}>
      <OverlayStatCard label="Target residues" value={result.protein.length} />
      <OverlayStatCard label="Residues with entropy" value={result.coverage.entropyResidues + ' / ' + result.protein.length} />
      <OverlayStatCard label="Alignment rows / columns" value={result.alignment.rows + ' / ' + result.alignment.columns} />
      <OverlayStatCard label="Unknown target residues" value={result.coverage.unknownTargetResidues} />
    </OverlayStatGrid>
    <p>Each canonical amino acid contributes one observation. Gaps and X/B/Z/J are excluded and counted separately.
      {' '}Entropy is unavailable with fewer than two observations; zero means every observed amino acid is the same.
      {' '}This alignment supplies no structural geometry or host-interaction evidence.</p>
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <button type="button" onClick={() => save('json')}>Export alignment experiment JSON</button>
      <button type="button" onClick={() => save('tsv')}>Export alignment residue TSV</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <label>First aligned protein residue <input aria-label="First aligned protein residue" type="number" min={1} max={result.protein.length}
      value={first} onChange={event => setStart(Number(event.target.value))} /></label>
    <button type="button" disabled={first === 1} onClick={() => setStart(Math.max(1, first - 25))}>Previous alignment residues</button>
    <button type="button" disabled={first + 24 >= result.protein.length} onClick={() => setStart(Math.min(result.protein.length, first + 25))}>Next alignment residues</button>
    <p>Showing target positions {first}–{Math.min(first + 24, result.protein.length)}. Target positions and alignment columns are one-based.
      {' '}JSON and TSV retain every target residue, including missing observations.</p>
    <div style={{ overflowX: 'auto' }}><table>
      <caption>Observed amino-acid counts and diversity per target residue</caption>
      <thead><tr><th>Target position</th><th>AA</th><th>Alignment column</th><th>Observed / rows</th><th>Gaps</th><th>Unknowns</th><th>Counts</th><th>Entropy (bits)</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.position}>
        <td>{row.position}</td><td>{row.aminoAcid}</td><td>{row.column}</td><td>{row.observed} / {row.total}</td>
        <td>{row.gaps}</td><td>{row.unknown}</td><td>{Object.entries(row.counts).map(([aa, count]) => aa + ':' + count).join(', ') || 'No observations'}</td>
        <td>{shown(row.entropyBits, 4)}</td>
      </tr>)}</tbody>
    </table></div>
    <details><summary>Alignment method, attribution and limitations</summary>
      <p>{record.method.id}, version {record.method.version}. {record.method.implementation}</p>
      <ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
      <p>Input identity: {record.inputs[0].sha256}</p><p>Result identity: {record.resultId}</p>
    </details>
  </section>;
}

/** An ordinary local MSA is independent of the optional mapped-complex input. */
function ProteinAlignmentWorkbench({ context }: { context: object }): React.ReactElement {
  const session = useMemo(() => new ProteinEvidenceSession(() => new Worker(new URL('../../workers/protein-evidence.worker.ts', import.meta.url), { type: 'module' })), []);
  const [revision, setRevision] = useState(0), [proteinId, setProteinId] = useState('');
  const scope = useMemo(() => ({ context, revision }), [context, revision]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const state = snapshot.scope === scope ? snapshot : null;
  const [loaded, setLoaded] = useState<{ context: object; input: ProteinAlignmentInput; origin: Extract<ProteinEvidenceOrigin, { name: string }> } | null>(null);
  const [description, setDescription] = useState(''), [reference, setReference] = useState(''), [demonstration, setDemonstration] = useState(false);
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => { session.setScope(scope); }, [session, scope]);
  useEffect(() => {
    if (snapshot.scope !== scope || !snapshot.alignment || !snapshot.origin || snapshot.origin.kind === 'current-cds') return;
    setLoaded({ context, input: snapshot.alignment, origin: snapshot.origin });
    setProteinId(snapshot.alignmentAccepted?.options.proteinId ?? snapshot.alignment.rows[0].id);
  }, [snapshot.scope, snapshot.alignment, snapshot.alignmentAccepted, snapshot.origin, scope, context]);
  const current = loaded?.context === context ? loaded : null;
  const read = (file: File, replay: boolean) => {
    const source: ProteinAlignmentInput['source'] = { kind: demonstration ? 'demo' : 'local',
      description: description.trim() || file.name, reference: reference.trim() || null };
    void session.run(scope, async () => replay
      ? { kind: 'replay-alignment', content: await readProteinEvidenceFile(file, 'experiment') }
      : { kind: 'inspect-alignment', content: await readProteinEvidenceFile(file, 'alignment'), name: file.name, source },
    { kind: replay ? 'saved-experiment' : 'reference-file', name: file.name });
  };
  const select = (id: string) => { session.cancel(); setRevision(value => value + 1); setProteinId(id); };
  return <section aria-label="Supplied protein alignment workbench">
    <h4>Analyze your own aligned protein FASTA</h4>
    <p>Load 2–256 already aligned protein records to measure observed amino-acid diversity. No structure, embedding or known binding partner is required.
      {' '}Use canonical amino acids, X/B/Z/J for unknown residues and - for gaps. Files stay in this browser.</p>
    <fieldset disabled={!!state?.busy}>
      <legend>Attribution for the next FASTA import</legend>
      <label>Alignment source description <input aria-label="Alignment source description" value={description} maxLength={512}
        placeholder="Defaults to the selected filename" onChange={event => setDescription(event.target.value)} /></label>
      <label>Alignment source citation <input aria-label="Alignment source citation" value={reference} maxLength={512}
        placeholder="Optional source, publication or notebook reference" onChange={event => setReference(event.target.value)} /></label>
      <label><input type="checkbox" checked={demonstration} onChange={event => setDemonstration(event.target.checked)} /> Synthetic teaching alignment</label>
      <label>Load aligned protein FASTA <input aria-label="Load aligned protein FASTA" type="file" accept=".fa,.faa,.fasta,.fas,.afa,.txt,text/plain"
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) read(file, false); }} /></label>
      <label>Replay alignment experiment JSON <input aria-label="Replay alignment experiment JSON" type="file" accept=".json,application/json"
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) read(file, true); }} /></label>
    </fieldset>
    <p>Attribution fields apply when a FASTA is loaded; saved experiments retain their embedded attribution. Limits: 2 MiB, 20,000 columns and 1,000,000 alignment cells.</p>
    {current && <p>Loaded alignment: {current.input.name} · {current.input.rows.length} records · {current.input.rows[0].alignedSequence.length} columns.
      {' '}Source: {current.input.source.description}; {current.input.source.kind === 'demo' ? 'teaching demonstration' : 'local data'}.
      {' '}It is independent of the current genome and selected gene.</p>}
    <fieldset disabled={!current || !!state?.busy}>
      <legend>Target protein record</legend>
      <label>Alignment target protein <select aria-label="Alignment target protein" value={proteinId} onChange={event => select(event.target.value)}>
        {current?.input.rows.map(row => <option key={row.id} value={row.id}>{row.id}{row.description ? ' — ' + row.description : ''}</option>)}
      </select></label>
      <button type="button" disabled={!current || !proteinId} onClick={() => {
        if (current && proteinId) void session.run(scope, { kind: 'analyze-alignment', input: current.input, options: { proteinId } },
          { kind: 'reference-file', name: current.origin.name });
      }}>Analyze supplied protein alignment</button>
    </fieldset>
    {state?.busy && <button type="button" onClick={session.cancel}>Cancel alignment analysis</button>}
    {state?.phase && <p aria-live="polite">{state.phase}</p>}
    {state?.error && <p role="alert">{state.error}</p>}
    {state?.alignmentAccepted && <ProteinAlignmentResults experiment={state.alignmentAccepted} verified={state.verified} />}
  </section>;
}

type Settings = { proteinId: string; chain: string; cutoff: string; separation: string; contactScope: 'chain' | 'assembly' };
const defaults: Settings = { proteinId: '', chain: 'auto', cutoff: '8', separation: '3', contactScope: 'assembly' };

export function ProteinEvidencePanel({ repository, phage, selectedGeneId, inputs, onSelectGene }: {
  repository?: object | null; phage: PhageFull | null; selectedGeneId: number | null;
  inputs: ProteinReferenceInputs | null; onSelectGene: (id: number) => void;
}): React.ReactElement {
  const session = useMemo(() => new ProteinEvidenceSession(() => new Worker(new URL('../../workers/protein-evidence.worker.ts', import.meta.url), { type: 'module' })), []);
  const context = useMemo(() => ({ repository, phage, selectedGeneId }), [repository, phage, selectedGeneId]);
  const [revision, setRevision] = useState(0);
  const scope = useMemo(() => ({ context, revision }), [context, revision]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [mode, setMode] = useState<'current' | 'loaded'>('current');
  const [loaded, setLoaded] = useState<{ context: object; reference: ProteinReferenceBundle; origin: ProteinEvidenceOrigin } | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => { session.activate(); return session.deactivate; }, [session]);
  useEffect(() => { session.setScope(scope); }, [session, scope]);
  const state = snapshot.scope === scope ? snapshot : null;
  useEffect(() => {
    if (snapshot.scope !== scope || !snapshot.reference || !snapshot.origin || snapshot.origin.kind === 'current-cds') return;
    setLoaded({ context, reference: snapshot.reference, origin: snapshot.origin }); setMode('loaded');
    if (snapshot.accepted) {
      const options = snapshot.accepted.options;
      setSettings({ proteinId: options.proteinId, chain: options.chainLabelAsymId ?? 'none',
        cutoff: String(options.contactCutoffAngstrom), separation: String(options.minSequenceSeparation), contactScope: options.contactScope });
    } else setSettings(defaults);
  }, [snapshot.scope, snapshot.reference, snapshot.origin, snapshot.accepted, scope, context]);
  const current = inputs?.status === 'ready' ? inputs : null;
  const standalone = loaded?.context === context ? loaded : null;
  const useLoaded = mode === 'loaded' && standalone !== null;
  const reference = useLoaded ? standalone.reference : current?.bundle ?? null;
  const proteinId = useLoaded ? settings.proteinId || reference?.cds.proteinId || '' : current?.bundle.cds.proteinId || '';
  const selectedMatches = current !== null && selectedGeneId === current.gene.id;
  const invalidate = () => { session.cancel(); setRevision(value => value + 1); setInputError(null); };
  const update = (change: Partial<Settings>) => { invalidate(); setSettings(value => ({ ...value, ...change })); };
  const changeMode = (next: 'current' | 'loaded') => { invalidate(); setMode(next); setSettings(defaults); };
  const analyze = () => {
    if (!reference || (!useLoaded && !selectedMatches)) return;
    setInputError(null);
    const cutoff = Number(settings.cutoff), separation = Number(settings.separation);
    if (!settings.cutoff.trim() || !Number.isFinite(cutoff) || cutoff <= 0 || cutoff > 30
      || !settings.separation.trim() || !Number.isSafeInteger(separation) || separation < 1 || separation > 10000) {
      setInputError('Choose a positive cutoff at most 30 Å and an integer sequence separation from 1 to 10000.'); return;
    }
    const options: ProteinStructureOptions = { proteinId, contactCutoffAngstrom: cutoff, minSequenceSeparation: separation,
      contactScope: settings.contactScope, ...(settings.chain === 'auto' ? {} : { chainLabelAsymId: settings.chain === 'none' ? null : settings.chain }) };
    const origin: ProteinEvidenceOrigin = useLoaded
      ? { kind: 'reference-file', name: standalone.origin.kind === 'current-cds' ? standalone.reference.id : standalone.origin.name }
      : { kind: 'current-cds', genomeAccession: current!.bundle.cds.genomeAccession, geneId: current!.gene.id, proteinAccession: current!.protein.accession };
    void session.run(scope, { kind: 'analyze', reference, options }, origin);
  };
  const read = (file: File, kind: 'reference' | 'experiment') => {
    setInputError(null);
    void session.run(scope, async () => ({ kind: kind === 'reference' ? 'inspect' : 'replay',
      content: await readProteinEvidenceFile(file, kind) }), { kind: kind === 'reference' ? 'reference-file' : 'saved-experiment', name: file.name });
  };
  return <section aria-label="Protein evidence workbench">
    <h3>Protein alignment and structural evidence</h3>
    <p>Compute finite-sample amino-acid diversity and observed C-alpha neighborhoods from exact source-backed inputs. Files stay in this browser.
      {' '}The method reports mapped distances and missing coverage; it does not estimate surface area, affinity or mutation effects.</p>
    <ProteinAlignmentWorkbench context={context} />
    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
      <label>Load protein reference JSON <input aria-label="Load protein reference JSON" type="file" accept=".json,application/json"
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) read(file, 'reference'); }} /></label>
      <label>Replay protein experiment JSON <input aria-label="Replay protein experiment JSON" type="file" accept=".json,application/json"
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) read(file, 'experiment'); }} /></label>
    </div>
    <label>Protein evidence source <select aria-label="Protein evidence source" value={useLoaded ? 'loaded' : 'current'}
      onChange={event => changeMode(event.target.value as 'current' | 'loaded')}>
      <option value="current">Mapped CDS in current genome</option>
      <option value="loaded" disabled={!standalone}>Loaded standalone reference</option>
    </select></label>
    {!useLoaded && <p>{current
      ? 'Mapped reference: ' + current.protein.accession + ', CDS ' + current.gene.id + ', genome ' + current.bundle.cds.genomeAccession + '.'
      : inputs?.status === 'unavailable' ? inputs.reason : 'A verified current-genome reference is not available yet. You can load a standalone reference.'}</p>}
    {!useLoaded && current && !selectedMatches && <p>
      Select the mapped CDS before computing current-genome evidence. Selected gene: {selectedGeneId ?? 'none'}.
      {' '}<button type="button" onClick={() => onSelectGene(current.gene.id)}>Select mapped protein CDS</button>
    </p>}
    {useLoaded && <p>Loaded standalone reference: {standalone.reference.id}. It is independent of the current genome and selected gene.</p>}
    <fieldset disabled={!reference || !!state?.busy}>
      <legend>Protein evidence settings</legend>
      <label>Protein <select aria-label="Reference protein" value={proteinId} disabled={!useLoaded}
        onChange={event => update({ proteinId: event.target.value, chain: 'auto' })}>
        {reference?.proteins.map(protein => <option key={protein.id} value={protein.id}>{protein.accession} ({protein.sequence.length} residues)</option>)}
      </select></label>
      <label>Mapped chain <select aria-label="Mapped protein chain" value={settings.chain} onChange={event => update({ chain: event.target.value })}>
        <option value="auto">Choose unique mapped chain</option>
        <option value="none">Alignment only (no geometry)</option>
        {reference?.chains.filter(chain => chain.proteinId === proteinId).map(chain => <option key={chain.labelAsymId} value={chain.labelAsymId}>
          {chain.pdbId}: label {chain.labelAsymId}, author {chain.authAsymId}
        </option>)}
      </select></label>
      <label>CA distance cutoff (Å) <input aria-label="CA distance cutoff" type="number" min="0.001" max="30" step="0.5" value={settings.cutoff}
        onChange={event => update({ cutoff: event.target.value })} /></label>
      <label>Minimum within-chain sequence separation <input aria-label="Minimum within-chain sequence separation" type="number" min="1" max="10000" step="1"
        value={settings.separation} onChange={event => update({ separation: event.target.value })} /></label>
      <label>Contact scope <select aria-label="Protein contact scope" value={settings.contactScope} onChange={event => update({ contactScope: event.target.value as 'chain' | 'assembly' })}>
        <option value="assembly">Selected and other supplied assembly chains</option><option value="chain">Selected chain only</option>
      </select></label>
      <button type="button" disabled={!reference || (!useLoaded && !selectedMatches)} onClick={analyze}>
        {useLoaded ? 'Analyze loaded protein reference' : 'Analyze mapped protein CDS'}
      </button>
    </fieldset>
    {state?.busy && <button type="button" onClick={session.cancel}>Cancel protein analysis</button>}
    {state?.phase && <p aria-live="polite">{state.phase}</p>}
    {(inputError || state?.error) && <p role="alert">{inputError || state?.error}</p>}
    {state?.accepted && state.origin && <ProteinEvidenceResults experiment={state.accepted} origin={state.origin} verified={state.verified} />}
  </section>;
}
