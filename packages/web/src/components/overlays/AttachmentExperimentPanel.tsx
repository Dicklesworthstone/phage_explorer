/** Conditional integration and excision from explicit sourced sequences and declared attachment cores. */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import {
  ATTACHMENT_LIMITS, resolveAttachmentOptions, validateProphageExcisionInput,
  type AttachmentCoreSite, type AttachmentSequenceInput, type AttachmentReconstructionInput, type ProphageExcisionInput,
} from '../../../../core/src/analysis/prophage-excision';
import { ProphageAttachmentSession, isProphageExcisionWork, type ProphageAttachmentRequest,
  type ProphageAttachmentWork, type ProphageExcisionWork } from '../../workers/ProphageAttachmentSession';
import type { PhageRepository } from '../../db';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { SavedResearchPanel } from './SavedResearchPanel';
import { replaySavedResearch } from '../../db/research-storage';

type AttachmentRepository = Pick<PhageRepository, 'getFullGenomeLength' | 'getSequenceWindow'> & {
  getOfflineDataset?: () => { describe(): { contentVersion: string } } | null;
};
type AttachmentExperiment = NonNullable<ReturnType<ProphageAttachmentSession['getSnapshot']>['accepted']>;
export interface AttachmentSiteDraft { start: string; end: string; strand: '+' | '-'; evidence: string }
const siteDraft = (): AttachmentSiteDraft => ({ start: '', end: '', strand: '+', evidence: '' });

/** The form alone uses one-based inclusive positions; the shared producer uses zero-based half-open intervals. */
export function attachmentSiteFromDraft(draft: AttachmentSiteDraft, label: string): AttachmentCoreSite {
  const position = (value: string): number => {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(label + ' positions must be positive whole base numbers.');
    }
    return Number(value);
  };
  const start = position(draft.start) - 1, end = position(draft.end);
  if (end <= start || end - start > ATTACHMENT_LIMITS.coreBases) {
    throw new Error(label + ' core must contain 1–' + ATTACHMENT_LIMITS.coreBases + ' bases, with start at or before end.');
  }
  return { start, end, strand: draft.strand, evidence: draft.evidence.trim() };
}

export function attachmentFlankFromDraft(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Junction flank length must be a nonnegative whole number.');
  }
  return resolveAttachmentOptions({ flankLength: Number(value) }).flankLength;
}

function checkInput(signal: AbortSignal, isCurrent: () => boolean = () => true): void {
  if (signal.aborted) throw new DOMException('Attachment input cancelled.', 'AbortError');
  if (!isCurrent()) throw new Error('The selected genome or repository changed. Submit the current inputs again.');
}

/** Read one complete selected genome, bounded before allocation and tied to its exact source owner. */
export async function readAttachmentPhage(repository: AttachmentRepository, phage: Pick<PhageFull, 'id' | 'name' | 'accession' | 'genomeLength' | 'localGenome'>,
  signal: AbortSignal, isCurrent: () => boolean): Promise<AttachmentSequenceInput> {
  checkInput(signal, isCurrent);
  const contentVersion = repository.getOfflineDataset?.()?.describe().contentVersion ?? null;
  const source = {
    id: phage.id, name: phage.name, accession: phage.accession || null, genomeLength: phage.genomeLength,
    localGenome: phage.localGenome ? structuredClone(phage.localGenome) : null,
  };
  const current = () => {
    checkInput(signal, isCurrent);
    if ((repository.getOfflineDataset?.()?.describe().contentVersion ?? null) !== contentVersion) {
      throw new Error('The catalog content changed while reading the phage. Submit the current inputs again.');
    }
  };
  const length = await repository.getFullGenomeLength(source.id); current();
  if (!Number.isSafeInteger(length) || length < 1 || length > ATTACHMENT_LIMITS.sequenceBases) {
    throw new Error('The selected phage must contain 1–' + ATTACHMENT_LIMITS.sequenceBases.toLocaleString() + ' complete bases.');
  }
  if (source.genomeLength !== null && source.genomeLength !== length) {
    throw new Error('The selected phage length differs from its declared genome. No partial sequence was accepted.');
  }
  const sequence = await repository.getSequenceWindow(source.id, 0, length); current();
  if (sequence.length !== length) throw new Error('The selected phage read is incomplete. No partial sequence was accepted.');
  return {
    name: source.name, accession: source.accession, sequence,
    topology: source.localGenome?.topology ?? 'unknown',
    source: {
      kind: source.localGenome ? 'local' : 'catalog',
      reference: source.localGenome ? 'Private genome accepted in this explorer'
        : source.accession ? 'https://www.ncbi.nlm.nih.gov/nuccore/' + encodeURIComponent(source.accession) : 'Current explorer catalog entry ' + source.id,
      version: source.localGenome?.contentId ?? contentVersion ?? source.accession ?? 'Unversioned catalog entry ' + source.id,
      license: null,
    },
  };
}

export async function readAttachmentFile(file: Pick<File, 'size' | 'arrayBuffer'>, signal: AbortSignal,
  maximumBytes: number = ATTACHMENT_LIMITS.inputBytes): Promise<string> {
  checkInput(signal);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximumBytes) {
    throw new Error('Attachment input exceeds the ' + maximumBytes / (1024 * 1024) + ' MiB file limit.');
  }
  const bytes = await file.arrayBuffer(); checkInput(signal);
  if (bytes.byteLength > maximumBytes) throw new Error('Attachment input exceeds the ' + maximumBytes / (1024 * 1024) + ' MiB file limit.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function fastaRecord(name: string, sequence: string): string {
  const rows: string[] = [];
  for (let start = 0; start < sequence.length; start += 80) rows.push(sequence.slice(start, start + 80));
  return '>' + name.replace(/[\r\n\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n' + rows.join('\n') + '\n';
}

/** Downloads use only accepted evidence, never an edited form or the current catalog label. */
export function attachmentDownload(experiment: AttachmentExperiment,
  format: 'experiment' | 'integrated-fasta' | 'junction-fasta' | 'excised-fasta' | 'restored-fasta'): {
  content: string; filename: string; mime: string;
} {
  if (isProphageExcisionWork(experiment)) {
    const { result, record, input } = experiment;
    if (format === 'experiment') return { content: serializeAnalysisRecord(record), filename: 'prophage-excision.json', mime: 'application/json' };
    if (format === 'excised-fasta' || format === 'restored-fasta') {
      const phage = format === 'excised-fasta', product = phage ? result.excisedPhage : result.restoredHost;
      return { content: fastaRecord((phage ? 'excised-phage' : 'restored-host') + ' result=' + record.resultId
        + ' topology=' + product.topology + ' input-origin=' + (product.sourceOrigin + 1) + ' locus=' + input.locus.name, product.sequence),
        filename: phage ? 'excised-phage.fasta' : 'restored-host.fasta', mime: 'text/plain' };
    }
    if (format !== 'junction-fasta') throw new Error('An excision experiment has separate phage and host products, not an integrated output.');
    return { content: fastaRecord('attP-preview result=' + record.resultId + ' strand=' + result.attP.strand, result.attP.sequence)
      + fastaRecord('attB-preview result=' + record.resultId + ' strand=' + result.attB.strand, result.attB.sequence),
      filename: 'excision-junctions.fasta', mime: 'text/plain' };
  }
  const { result, record, input } = experiment;
  if (format === 'excised-fasta' || format === 'restored-fasta') throw new Error('Reconstruct excision before downloading its phage or host products.');
  if (format === 'experiment') return { content: serializeAnalysisRecord(record), filename: 'attachment-reconstruction.json', mime: 'application/json' };
  if (format === 'integrated-fasta') return {
    content: fastaRecord('integrated-locus result=' + record.resultId + ' host=' + input.host.name + ' phage=' + input.phage.name, result.integratedSequence),
    filename: 'integrated-locus.fasta', mime: 'text/plain',
  };
  return {
    content: fastaRecord('attL-preview result=' + record.resultId + ' strand=' + result.attL.strand, result.attL.sequence)
      + fastaRecord('attR-preview result=' + record.resultId + ' strand=' + result.attR.strand, result.attR.sequence),
    filename: 'attachment-junctions.fasta', mime: 'text/plain',
  };
}

function SequenceSource({ label, source }: { label: string; source: AttachmentSequenceInput }): React.ReactElement {
  return <section aria-label={'Accepted ' + label + ' source'}>
    <h4>{label}: {source.name}</h4>
    <p>{source.sequence.length.toLocaleString()} bases · {source.topology} · {source.accession ?? 'No accession supplied'} · {source.source.kind}</p>
    <p>Source: {source.source.reference}. Version: {source.source.version}. License: {source.source.license ?? 'Not supplied'}.</p>
  </section>;
}

/** Carry accepted integration coordinates into an explicit inverse hypothesis. */
export function excisionInputFromAttachment(experiment: ProphageAttachmentWork): ProphageExcisionInput {
  const { input, result, record } = experiment, length = input.attB.end - input.attB.start;
  const strand = input.attB.strand;
  const evidence = 'Declared integration core carried into attachment result ' + record.resultId;
  const left = { start: result.hostCut, end: result.hostCut + length, strand, evidence };
  const right = { start: result.hostCut + input.phage.sequence.length,
    end: result.hostCut + input.phage.sequence.length + length, strand, evidence };
  return validateProphageExcisionInput({
    format: 'phage-explorer-prophage-excision', version: 1,
    locus: { name: 'Integrated locus from attachment result ' + record.resultId, accession: null,
      sequence: result.integratedSequence, topology: result.integratedTopology,
      source: { kind: 'local', reference: 'Conditional integration reconstruction ' + record.resultId,
        version: record.resultId, license: null } },
    attL: strand === '+' ? left : right, attR: strand === '+' ? right : left,
  });
}

export function ProphageExcisionResults({ experiment }: { experiment: ProphageExcisionWork }): React.ReactElement {
  const { input, result, record } = experiment;
  return <section aria-label="Accepted prophage excision reconstruction" data-testid="excision-result"
    data-result-id={record.resultId} style={{ display: 'grid', gap: '.75rem', minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3>Accepted conditional excision</h3>
    <p>{experiment.verified ? 'Verified replay of the integrated source, declared attL/attR and both reconstructed molecules.'
      : 'Reconstructed from the accepted integrated source and declared attL/attR.'}
      {' '}This sequence operation does not establish biological excision, recombination efficiency or infectivity.</p>
    <SequenceSource label="Integrated locus" source={input.locus} />
    <div style={{ overflowX: 'auto' }}><table aria-label="Accepted excision declarations">
      <thead><tr><th>Site</th><th>Original positions (1-based inclusive)</th><th>Strand</th><th>Evidence or hypothesis</th></tr></thead>
      <tbody>{([['attL', input.attL], ['attR', input.attR]] as const).map(([name, site]) => <tr key={name}>
        <td>{name}</td><td>{site.start + 1}–{site.end}</td><td>{site.strand}</td><td>{site.evidence}</td>
      </tr>)}</tbody>
    </table></div>
    <p>Removed forward input arc: [{result.sourceCuts.start}, {result.sourceCuts.end}) (0-based),
      {' '}{result.sourceCuts.wrapsOrigin ? 'crossing the circular source origin' : 'without crossing the source origin'}.
      Shared oriented crossover core: <code>{result.sharedCore}</code>.</p>
    <p>Conserved bases: {result.conservation.excisedBases.toLocaleString()} excised phage + {' '}
      {result.conservation.restoredBases.toLocaleString()} restored host = {result.conservation.recoveredBases.toLocaleString()} recovered
      {' '}from {result.conservation.inputBases.toLocaleString()} input bases.</p>
    <p>Both product sequences follow the input forward strand. Attachment previews follow the declared site orientation.
      A circular product's stored origin is a coordinate convention, not a biological terminus.</p>
    {([['Excised phage', result.excisedPhage], ['Restored host', result.restoredHost]] as const).map(([name, product]) =>
      <section key={name} aria-label={name + ' product'}>
        <h4>{name}: {product.sequence.length.toLocaleString()} bases · {product.topology}</h4>
        <p>First output base: original input base {product.sourceOrigin + 1} (1-based).</p>
        <div style={{ overflowX: 'auto' }}><table aria-label={name + ' source-coordinate map'}>
          <thead><tr><th>Original input interval (1-based)</th><th>Product interval (1-based)</th><th>Strand</th></tr></thead>
          <tbody>{product.segments.map(segment => <tr key={segment.productStart}>
            <td>{segment.sourceStart + 1}–{segment.sourceEnd}</td><td>{segment.productStart + 1}–{segment.productEnd}</td><td>{segment.strand}</td>
          </tr>)}</tbody>
        </table></div>
        <details><summary>{name} sequence preview</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all' }}><code>{product.sequence.length <= 480
            ? product.sequence : product.sequence.slice(0, 240) + '\n…\n' + product.sequence.slice(-240)}</code></pre>
          {product.sequence.length > 480 && <p>The preview shows the first and last 240 bases. FASTA export retains every product base.</p>}
        </details>
      </section>)}
    {([['attP', result.attP], ['attB', result.attB]] as const).map(([name, junction]) =>
      <section key={name} aria-label={name + ' excision junction'}>
        <h4>{name} · strand {junction.strand}</h4>
        <p>Intervals in the {name === 'attP' ? 'excised phage' : 'restored host'} (1-based inclusive):
          {' '}{junction.productSegments.map(part => (part.start + 1) + '–' + part.end).join(', ')}.</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', maxHeight: '12rem', overflowY: 'auto' }}><code>
          {junction.sequence.slice(0, junction.core.start)}<mark>{junction.sequence.slice(junction.core.start, junction.core.end)}</mark>{junction.sequence.slice(junction.core.end)}
        </code></pre>
      </section>)}
    <details><summary>Excision assumptions and limits</summary><ul>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>
    <AnalysisRecordDetails record={record} />
  </section>;
}

export function AttachmentExperimentResults({ experiment }: { experiment: AttachmentExperiment }): React.ReactElement {
  if (isProphageExcisionWork(experiment)) return <ProphageExcisionResults experiment={experiment} />;
  const { input, result, options, record } = experiment;
  return <section aria-label="Accepted attachment reconstruction" data-testid="attachment-result" data-result-id={record.resultId}
    style={{ display: 'grid', gap: '.75rem', minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3>Accepted conditional reconstruction</h3>
    <p>{experiment.verified ? 'Verified replay of the stored sources, declared attachment cores and complete reconstruction.'
      : 'Reconstructed from the accepted sources and declared attachment cores.'} This is an exact sequence operation under those declarations; it does not establish that integration occurs biologically.</p>
    <SequenceSource label="Host" source={input.host} />
    <SequenceSource label="Phage" source={input.phage} />
    <div style={{ overflowX: 'auto' }}><table aria-label="Accepted attachment declarations">
      <thead><tr><th>Site</th><th>Original positions (1-based inclusive)</th><th>Strand</th><th>Evidence or hypothesis</th></tr></thead>
      <tbody>{([['attB', input.attB], ['attP', input.attP]] as const).map(([name, site]) => <tr key={name}>
        <td>{name}</td><td>{site.start + 1}–{site.end}</td><td>{site.strand}</td><td>{site.evidence}</td>
      </tr>)}</tbody>
    </table></div>
    <p>Phage circularization: {input.circularization === 'already-circular' ? 'Input declared circular' : 'Explicitly assumed circularized'}.
      {' '}Phage insertion strand in the supplied host: {result.insertionStrand}. Shared oriented crossover core: <code>{result.sharedCore}</code>.</p>
    <p>Cut boundaries in the original forward sequences (0-based): host {result.hostCut}, phage {result.phageCut}.
      {' '}Conserved bases: {result.conservation.hostBases.toLocaleString()} host + {result.conservation.phageBases.toLocaleString()} phage
      {' '}= {result.conservation.integratedBases.toLocaleString()} integrated; expected {result.conservation.expectedBases.toLocaleString()}.</p>
    <p>Junction previews use at most {options.flankLength} bases on each side. attL and attR follow the declared attB orientation;
      on a reverse-strand attB, attL is the spatially right-hand junction. Highlighting marks the shared crossover core.</p>
    {([['attL', result.attL], ['attR', result.attR]] as const).map(([name, junction]) => <section key={name} aria-label={name + ' junction'}>
      <h4>{name} · strand {junction.strand}</h4>
      <p>Integrated sequence intervals (1-based inclusive): {junction.integratedSegments.map(segment => (segment.start + 1) + '–' + segment.end).join(', ')}.
        {' '}Flanks in the displayed orientation: {junction.leftFlankBases} left, {junction.rightFlankBases} right.</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', maxHeight: '12rem', overflowY: 'auto' }}><code>
        {junction.sequence.slice(0, junction.core.start)}<mark>{junction.sequence.slice(junction.core.start, junction.core.end)}</mark>{junction.sequence.slice(junction.core.end)}
      </code></pre>
    </section>)}
    <details><summary>Integrated sequence preview · {result.integratedSequence.length.toLocaleString()} bases</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all' }}><code>{result.integratedSequence.length <= 480
        ? result.integratedSequence : result.integratedSequence.slice(0, 240) + '\n…\n' + result.integratedSequence.slice(-240)}</code></pre>
      {result.integratedSequence.length > 480 && <p>Only the first and last 240 bases are shown. The FASTA download contains every integrated base.</p>}
    </details>
    {result.warnings.length > 0 && <details><summary>Interpretation and assumptions</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <AnalysisRecordDetails record={record} />
  </section>;
}

function SiteFields({ name, draft, update }: { name: string; draft: AttachmentSiteDraft; update: (value: AttachmentSiteDraft) => void }): React.ReactElement {
  const edit = (key: keyof AttachmentSiteDraft, value: string) => update({ ...draft, [key]: value });
  return <fieldset style={{ display: 'grid', gap: '.5rem', minWidth: 0 }}>
    <legend>{name} shared crossover core</legend>
    <label>Start base (1-based inclusive)<input inputMode="numeric" maxLength={20} value={draft.start} onChange={event => edit('start', event.target.value)} /></label>
    <label>End base (1-based inclusive)<input inputMode="numeric" maxLength={20} value={draft.end} onChange={event => edit('end', event.target.value)} /></label>
    <label>Site orientation<select value={draft.strand} onChange={event => edit('strand', event.target.value)}><option value="+">Forward (+)</option><option value="-">Reverse (−)</option></select></label>
    <label>Evidence or explicit hypothesis<input value={draft.evidence} maxLength={2000} onChange={event => edit('evidence', event.target.value)} /></label>
  </fieldset>;
}

export function AttachmentExperimentPanel({ repository, currentPhage }: {
  repository: PhageRepository | null; currentPhage: PhageFull | null;
}): React.ReactElement {
  const id = useId();
  const selectedList = usePhageStore(state => state.phages), selectedIndex = usePhageStore(state => state.currentPhageIndex);
  const loadingPhage = usePhageStore(state => state.isLoadingPhage);
  const scope = useMemo(() => crypto.randomUUID(), [repository, currentPhage, selectedList, selectedIndex, loadingPhage]);
  const sourceOwner = useRef({ repository, currentPhage }); sourceOwner.current = { repository, currentPhage };
  const mounted = useRef(false);
  const session = useMemo(() => new ProphageAttachmentSession(() => new Worker(
    new URL('../../workers/prophage-attachment.worker.ts', import.meta.url), { type: 'module' })), []);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [libraryBusy, setLibraryBusy] = useState(false), [formError, setFormError] = useState<string | null>(null);
  const [operation, setOperation] = useState<'integration' | 'excision'>('integration');
  const [hostText, setHostText] = useState(''), [hostFile, setHostFile] = useState<File | null>(null);
  const [hostName, setHostName] = useState(''), [accession, setAccession] = useState('');
  const [hostTopology, setHostTopology] = useState<'linear' | 'circular'>('linear');
  const [reference, setReference] = useState(''), [version, setVersion] = useState(''), [license, setLicense] = useState('');
  const [attB, setAttB] = useState(siteDraft), [attP, setAttP] = useState(siteDraft);
  const [circularization, setCircularization] = useState<AttachmentReconstructionInput['circularization'] | ''>('');
  const [flanks, setFlanks] = useState('50');
  useEffect(() => {
    mounted.current = true; session.activate();
    return () => { mounted.current = false; session.deactivate(); };
  }, [session]);
  useEffect(() => { session.setScope(scope, true); setFormError(null); setCircularization(''); }, [session, scope]);
  const sameScope = state.scope === scope, accepted = state.accepted;
  const busy = !sameScope || state.busy || libraryBusy;
  const selectionReady = !!repository && !!currentPhage && !loadingPhage && selectedList[selectedIndex]?.id === currentPhage.id;
  const showError = (cause: unknown) => setFormError(cause instanceof Error ? cause.message : 'Attachment operation failed.');
  const run = (request: ProphageAttachmentRequest | ((signal: AbortSignal) => Promise<ProphageAttachmentRequest>)) => {
    if (busy) return;
    setFormError(null); void session.run(request, scope).catch(cause => {
      if (mounted.current && session.getSnapshot().scope === scope) showError(cause);
    });
  };
  const exportFile = (format: Parameters<typeof attachmentDownload>[1]) => {
    if (!accepted) return;
    try { const file = attachmentDownload(accepted, format); downloadString(file.content, file.filename, file.mime); setFormError(null); }
    catch (cause) { showError(cause); }
  };
  const field: React.CSSProperties = { display: 'grid', gap: '.25rem', minWidth: 0 };
  return <section aria-label="Supplied attachment reconstruction" style={{ display: 'grid', gap: '.75rem', minWidth: 0 }}>
    <h3>{operation === 'integration' ? 'Reconstruct a supplied integration hypothesis' : 'Reconstruct a supplied prophage excision hypothesis'}</h3>
    <label>Reconstruction operation<select value={operation} disabled={busy} onChange={event => {
      setOperation(event.target.value as 'integration' | 'excision'); setAttB(siteDraft()); setAttP(siteDraft()); setFormError(null);
    }}><option value="integration">Integrate supplied host and phage sites</option><option value="excision">Excise a declared prophage from a supplied locus</option></select></label>
    {operation === 'integration'
      ? <p>Provide a sourced host locus and the matching, oriented crossover cores attB and attP. The selected phage supplies the complete phage sequence.
        Both cores must match exactly. The result contains exact junctions and the integrated sequence under your declarations; site specificity, integrase compatibility and biological integration are not inferred.</p>
      : <p>Provide the complete integrated locus and declared attL/attR cores in the same orientation. This operation reconstructs the excised circular phage and restored host with complete source-coordinate maps.
        Exact shared cores are required; biological excision and its efficiency are not inferred. A selected catalog phage is not needed.</p>}
    <SavedResearchPanel kind="attachment" suggestedName={accepted ? isProphageExcisionWork(accepted) ? accepted.input.locus.name
      : accepted.input.host.name + ' + ' + accepted.input.phage.name : 'Attachment reconstruction'}
      disabled={!sameScope || state.busy} onActivityChange={setLibraryBusy}
      capture={accepted ? () => serializeAnalysisRecord(accepted.record) : null}
      restore={async (content, signal) => {
        setFormError(null);
        await replaySavedResearch(signal, { run: () => session.run({ kind: 'replay', content }, scope),
          cancel: session.cancel, error: () => session.getSnapshot().error });
      }} />
    <label htmlFor={id + '-saved'}>Reopen and verify attachment experiment JSON</label>
    <input id={id + '-saved'} type="file" accept=".json,application/json" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) run(async signal => ({ kind: 'replay', content: await readAttachmentFile(file, signal, 10 * 1024 * 1024) }));
    }} />
    <p role="status" data-testid="attachment-status">{state.busy && sameScope ? state.phase ?? 'Reconstructing attachment products…'
      : sameScope && state.notice ? state.notice : accepted ? 'Accepted reconstruction retained with its own sources. New submissions use the current selection.'
        : 'No reconstruction has been accepted for this workspace.'}</p>
    {(formError || sameScope && state.error) && <p role="alert">{formError ?? state.error}</p>}
    {state.busy && sameScope && <button type="button" onClick={session.cancel}>Cancel attachment operation</button>}
    <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      try {
        if (operation === 'excision') {
          const capturedFile = hostFile, capturedText = hostText;
          const locus: Omit<AttachmentSequenceInput, 'sequence'> = { name: hostName, accession: accession.trim() || null,
            topology: hostTopology, source: { kind: 'local', reference, version, license: license.trim() || null } };
          const attL = attachmentSiteFromDraft(attB, 'attL'), attR = attachmentSiteFromDraft(attP, 'attR');
          const options = { flankLength: attachmentFlankFromDraft(flanks) };
          run(async signal => ({ kind: 'prepare-excision', locus,
            locusContent: capturedFile ? await readAttachmentFile(capturedFile, signal) : capturedText, attL, attR, options }));
          return;
        }
        if (!selectionReady || !repository || !currentPhage) throw new Error('Wait for a complete selected phage before reconstructing attachment products.');
        if (!circularization) throw new Error('Declare whether the supplied phage is circular or is assumed to have circularized.');
        const capturedRepository = repository, capturedPhage = currentPhage, capturedStore = usePhageStore.getState();
        const capturedFile = hostFile, capturedText = hostText;
        const host: Omit<AttachmentSequenceInput, 'sequence'> = { name: hostName, accession: accession.trim() || null,
          topology: hostTopology, source: { kind: 'local', reference, version, license: license.trim() || null } };
        const capturedAttB = attachmentSiteFromDraft(attB, 'attB'), capturedAttP = attachmentSiteFromDraft(attP, 'attP');
        const options = { flankLength: attachmentFlankFromDraft(flanks) }, capturedCircularization = circularization;
        const isCurrent = () => {
          const stateNow = usePhageStore.getState(), owner = sourceOwner.current;
          return owner.repository === capturedRepository && owner.currentPhage === capturedPhage
            && stateNow.currentPhage === capturedPhage && stateNow.phages === capturedStore.phages
            && stateNow.currentPhageIndex === capturedStore.currentPhageIndex && !stateNow.isLoadingPhage;
        };
        run(async signal => {
          const [phage, hostContent] = await Promise.all([
            readAttachmentPhage(capturedRepository, capturedPhage, signal, isCurrent),
            capturedFile ? readAttachmentFile(capturedFile, signal) : Promise.resolve(capturedText),
          ]);
          checkInput(signal, isCurrent);
          return { kind: 'prepare', host, hostContent, phage, attB: capturedAttB, attP: capturedAttP,
            circularization: capturedCircularization, options };
        });
      } catch (cause) { showError(cause); }
    }}><fieldset disabled={busy} style={{ display: 'grid', gap: '.75rem', minWidth: 0 }}>
      <legend>New reconstruction draft</legend>
      {operation === 'integration' && <p data-testid="attachment-selected-phage">Selected phage for this draft: {selectionReady ? currentPhage!.name : 'Unavailable or still loading'}.
        {' '}Declared topology: {currentPhage?.localGenome?.topology ?? 'unknown'}.
        {' '}Each submission captures the complete current sequence. Saved results below keep their own accepted sources.</p>}
      <label style={field}>{operation === 'excision' ? 'Integrated locus name' : 'Host locus name'}<input value={hostName} maxLength={500} onChange={event => setHostName(event.target.value)} /></label>
      <label style={field}>{operation === 'excision' ? 'Integrated locus accession (optional)' : 'Host locus accession (optional)'}<input value={accession} maxLength={500} onChange={event => setAccession(event.target.value)} /></label>
      <label style={field}>{operation === 'excision' ? 'Integrated locus topology' : 'Host locus topology'}<select value={hostTopology} onChange={event => setHostTopology(event.target.value as 'linear' | 'circular')}>
        <option value="linear">Linear locus</option><option value="circular">Complete circular host molecule</option></select></label>
      <label style={field}>{operation === 'excision' ? 'Integrated sequence · one FASTA record or raw A/C/G/T' : 'Host sequence · one FASTA record or raw A/C/G/T'}<textarea value={hostText} disabled={busy || !!hostFile}
        maxLength={ATTACHMENT_LIMITS.inputBytes} rows={4} spellCheck={false} onChange={event => setHostText(event.target.value)} /></label>
      <label style={field}>{operation === 'excision' ? 'Or choose an integrated-locus FASTA file' : 'Or choose a host FASTA file'}<input type="file" accept=".fa,.fasta,.fna,.txt,text/plain"
        onChange={event => { setHostFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ''; }} /></label>
      {hostFile && <p>{hostFile.name}{' '}<button type="button" onClick={() => setHostFile(null)}>Use pasted sequence instead</button></p>}
      <label style={field}>{operation === 'excision' ? 'Locus source reference or provenance' : 'Host source reference or provenance'}<input value={reference} maxLength={2000} onChange={event => setReference(event.target.value)} /></label>
      <label style={field}>{operation === 'excision' ? 'Locus source version' : 'Host source version'}<input value={version} maxLength={500} onChange={event => setVersion(event.target.value)} /></label>
      <label style={field}>{operation === 'excision' ? 'Locus license or permissions (optional)' : 'Host license or permissions (optional)'}<input value={license} maxLength={2000} onChange={event => setLicense(event.target.value)} /></label>
      <p>Enter the shared crossover core, not the full binding site. Positions refer to each original input's forward sequence,
        even when its site orientation is reverse. Each core must be a non-wrapping interval.</p>
      {operation === 'excision' && <p>On the forward strand, excision follows the arc from attL to attR; on the reverse strand, from attR to attL in forward input coordinates.
        Only a circular locus permits that arc to cross the stored origin. Both cores must have the same declared orientation and exact sequence.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '.75rem' }}>
        <SiteFields name={operation === 'excision' ? 'attL · integrated locus' : 'attB · host'} draft={attB} update={setAttB} />
        <SiteFields name={operation === 'excision' ? 'attR · integrated locus' : 'attP · phage'} draft={attP} update={setAttP} />
      </div>
      {operation === 'integration' && <label style={field}>Phage circularization declaration<select value={circularization}
        onChange={event => setCircularization(event.target.value as AttachmentReconstructionInput['circularization'] | '')}>
        <option value="">Choose a declaration</option>
        <option value="already-circular" disabled={currentPhage?.localGenome?.topology !== 'circular'}>Input is annotated as circular</option>
        <option value="assumed-circularized">Assume this supplied phage sequence has circularized</option>
      </select></label>}
      <label style={field}>Junction flank bases (0–1000)<input inputMode="numeric" value={flanks} onChange={event => setFlanks(event.target.value)} /></label>
      <p>{operation === 'excision' ? <>Up to {ATTACHMENT_LIMITS.totalBases.toLocaleString()} integrated bases.</>
        : <>Up to {ATTACHMENT_LIMITS.sequenceBases.toLocaleString()} bases per sequence and {ATTACHMENT_LIMITS.totalBases.toLocaleString()} combined.</>}
        {' '}Source attribution, topology and site declarations are preserved in the exported experiment.</p>
      <button type="submit" disabled={operation === 'integration' && !selectionReady}>
        {operation === 'excision' ? 'Reconstruct declared excision sites' : 'Reconstruct declared attachment sites'}</button>
    </fieldset></form>
    {accepted && <>
      <p>Draft edits do not replace the accepted result. Exports and local snapshots use the accepted sources and declarations shown here.</p>
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={() => exportFile('experiment')}>
          {isProphageExcisionWork(accepted) ? 'Export complete excision experiment' : 'Export complete attachment experiment'}</button>
        {isProphageExcisionWork(accepted) ? <>
          <button type="button" disabled={busy} onClick={() => exportFile('excised-fasta')}>Export excised phage FASTA</button>
          <button type="button" disabled={busy} onClick={() => exportFile('restored-fasta')}>Export restored host FASTA</button>
        </> : <>
          <button type="button" disabled={busy} onClick={() => exportFile('integrated-fasta')}>Export integrated sequence FASTA</button>
          <button type="button" disabled={busy} onClick={() => {
            try { run({ kind: 'excise', input: excisionInputFromAttachment(accepted), options: accepted.options }); }
            catch (cause) { showError(cause); }
          }}>Excise this reconstructed prophage</button>
        </>}
        <button type="button" disabled={busy} onClick={() => exportFile('junction-fasta')}>Export junction previews FASTA</button>
        <button type="button" disabled={busy} onClick={() => run({ kind: 'replay', content: serializeAnalysisRecord(accepted.record) })}>Recompute and verify accepted experiment</button>
      </div>
      <AttachmentExperimentResults experiment={accepted} />
    </>}
  </section>;
}
