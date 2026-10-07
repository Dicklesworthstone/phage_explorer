import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson, exportLocalGenomeBundle, serializeAnalysisRecord, type GenomeImportResult } from '@phage-explorer/core';
import { useLocalGenomes } from '../../db/local-genomes';
import { ActionIds, ActionRegistry } from '../../keyboard/actionRegistry';
import { ResearchWorkflow, researchPangenomeParameters, researchReferenceCodonParameters,
  type ResearchView } from '../../keyboard/ResearchWorkflow';
import { CODON_REFERENCE_METHOD, CODON_REFERENCE_SOURCE_METHOD,
  type ReferenceCodonAnalysis, type ZeroCountReplacement } from '../../../../core/src/analysis/codon-reference';
import { EXACT_REPEAT_METHOD, CIRCULAR_EXACT_REPEAT_METHOD, resolveExactRepeatOptions, exactRepeatArmSegments, exportExactRepeatPairsTsv, type ExactRepeatScan } from '../../../../core/src/analysis/exact-repeat-pairs';
import { GC_SKEW_METHOD, resolveGCSkewOptions, exportGCSkewTsv, type GCSkewWindow } from '../../../../core/src/analysis/gc-skew';
import { parseCdsGeneIds } from '../../../../core/src/analysis/cds-consequences';
import type { AlignmentGraphOptions } from '../../../../core/src/analysis/alignment-pangenome';
import { runPangenomeWorker } from '../../workers/PangenomeSession';
import { interruptsResearchNavigation, type ResearchNavigationTarget } from '../../keyboard/ResearchNavigation';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { ResearchWorkerRequest, ResearchWorkerResult } from '../../workers/research-workflow.worker';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { SavedResearchPanel } from './SavedResearchPanel';

export function runResearchWorker(request: ResearchWorkerRequest, signal: AbortSignal): Promise<ResearchWorkerResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = new Worker(new URL('../../workers/research-workflow.worker.ts', import.meta.url), { type: 'module' });
    let done = false;
    const finish = (result?: ResearchWorkerResult, error?: Error) => {
      if (done) return; done = true;
      signal.removeEventListener('abort', cancel);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(undefined, new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      if (event.data?.type === 'result') finish(event.data.result);
      else if (event.data?.type === 'error') finish(undefined, new Error(event.data.message));
      else finish(undefined, new Error('Unexpected research worker response.'));
    };
    worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('Research worker failed.')); };
    worker.onmessageerror = () => finish(undefined, new Error('Research worker response could not be read.'));
    try { if (signal.aborted) cancel(); else worker.postMessage(request); } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
  });
}
function currentView(): ResearchView | null {
  const state = usePhageStore.getState(), contentId = state.currentPhage?.localGenome?.contentId;
  return contentId ? { contentId, viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition, geneId: state.selectedGeneId } : null;
}
export function createBrowserResearchWorkflow(selectPhage: (index: number) => Promise<void>): { workflow: ResearchWorkflow; activate: () => void; dispose: () => void } {
  let navigating = false;
  let navigationOwner: ResearchNavigationTarget | null = null;
  let unsubscribe: (() => void) | null = null;
  const workflow = new ResearchWorkflow({ view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats, codons: ActionIds.OverlayCodonAdaptation,
    pangenome: ActionIds.OverlayPangenomeGraph, gcSkew: ActionIds.OverlayGCSkew }, {
    genomes: () => useLocalGenomes.getState().genomes,
    bundle: () => exportLocalGenomeBundle(useLocalGenomes.getState().genomes),
    parseBundle: async (content, signal) => {
      const response = await runResearchWorker({ type: 'parse', input: { name: 'workflow-genomes.json', text: content } }, signal);
      if (response.type !== 'parsed') throw new Error('Expected parsed workflow genomes.');
      return response.result;
    },
    currentView,
    applyView: async (view, signal) => {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (useLocalGenomes.getState().requestedId !== null) throw new Error('Wait for the imported genome selection to finish, then replay.');
      const genome = useLocalGenomes.getState().genomes.find(g => g.phage.localGenome?.contentId === view.contentId);
      const index = usePhageStore.getState().phages.findIndex(p => p.id === genome?.phage.id);
      if (!genome || index < 0) throw new Error('Add the workflow genomes to the explorer before replay.');
      // Keep the target through the asynchronous loader's gene/scroll resets,
      // without suppressing navigation toward a different target or user view.
      const owner: ResearchNavigationTarget = { index, view, signal };
      navigationOwner = owner;
      try {
        let selection: Promise<void>;
        navigating = true;
        try { selection = selectPhage(index); } finally { navigating = false; }
        await selection;
        // Let the loaded genome's queued selection-reset effects run before
        // applying the requested CDS/view. The exact view is checked afterward.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const state = usePhageStore.getState();
        if (state.isLoadingPhage || state.currentPhageIndex !== index || state.currentPhage?.localGenome?.contentId !== view.contentId) {
          throw new Error('Genome selection changed or failed before the saved view could be applied.');
        }
        navigating = true;
        try {
          state.setViewMode(view.viewMode); state.setReadingFrame(view.readingFrame); state.setSelectedGeneId(view.geneId); state.setScrollPosition(view.scrollPosition);
        } finally { navigating = false; }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      } finally {
        if (navigationOwner === owner) navigationOwner = null;
      }
    },
    repeats: async (genome, options, signal) => {
      const result = await getOrchestrator().runAnalysisWithSharedBuffer(genome.phage.id, genome.sequence, 'repeats', options,
        { accession: genome.phage.accession, source: 'local' }, signal);
      if (result.type !== 'repeats' || !result.evidenceRecord) throw new Error('Repeat evidence is unavailable.');
      return result.evidenceRecord;
    },
    exactRepeats: async (genome, options, signal) => {
      const response = await runResearchWorker({ type: 'exact-repeats', genome, options }, signal);
      if (response.type !== 'analysis') throw new Error('Expected exact repeat evidence.');
      return response.record;
    },
    gcSkew: async (genome, options, signal) => {
      const response = await runResearchWorker({ type: 'gc-skew', genome, options }, signal);
      if (response.type !== 'analysis') throw new Error('Expected portable GC-skew evidence.');
      return response.record;
    },
    codons: async (genome, geneId, signal) => {
      const response = await runResearchWorker({ type: 'codons', genome, geneId }, signal);
      if (response.type !== 'analysis') throw new Error('Expected CDS analysis evidence.');
      return response.record;
    },
    referenceCodons: async (genome, referenceText, options, signal) => {
      const response = await runResearchWorker({ type: 'reference-codons', genome, referenceText, options }, signal);
      if (response.type !== 'analysis') throw new Error('Expected reference-backed CDS evidence.');
      return response.record;
    },
    pangenome: async (request, signal) => {
      const result = await runPangenomeWorker(request, signal,
        () => new Worker(new URL('../../workers/pangenome.worker.ts', import.meta.url), { type: 'module' }));
      if (!result.record) throw new Error('The pangenome worker did not produce analysis evidence.');
      return result.record;
    },
  });
  // Subscribe from the React effect, not render. StrictMode may discard a render
  // or run setup/cleanup/setup on the same binding.
  const activate = () => {
    if (unsubscribe) return;
    unsubscribe = usePhageStore.subscribe((next, previous) => {
      if (!navigating && interruptsResearchNavigation(next, previous, navigationOwner) &&
        !['idle', 'recording'].includes(workflow.commands.getSnapshot().mode)) workflow.commands.cancel();
    });
  };
  return { workflow, activate, dispose: () => { unsubscribe?.(); unsubscribe = null; workflow.commands.cancel(); } };
}

/** An explicit research-command surface inside the existing local-genome action, usable by keyboard or touch. */
export function ResearchWorkflowPanel({ onSelectPhage }: { onSelectPhage?: (index: number) => Promise<void> }): React.ReactElement {
  const selectionRef = useRef(onSelectPhage);
  selectionRef.current = onSelectPhage;
  const binding = useMemo(() => createBrowserResearchWorkflow(async index => {
    if (!selectionRef.current) throw new Error('Genome navigation is unavailable in this embedding. Open the workflow in the complete explorer.');
    await selectionRef.current(index);
  }), []), workflow = binding.workflow;
  const state = useSyncExternalStore(workflow.commands.subscribe, workflow.commands.getSnapshot, workflow.commands.getSnapshot);
  const research = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const acceptedAnalysis = research.lastAnalysis;
  const genomes = useLocalGenomes(s => s.genomes);
  const [name, setName] = useState('Private genome workflow');
  const [selected, setSelected] = useState('');
  const [gene, setGene] = useState('all');
  const [position, setPosition] = useState('0');
  const [mode, setMode] = useState<ResearchView['viewMode']>('dna');
  const [frame, setFrame] = useState<ResearchView['readingFrame']>(0);
  const [minimum, setMinimum] = useState('8'), [gap, setGap] = useState('5000');
  const [gcWindow, setGcWindow] = useState('500'), [gcStep, setGcStep] = useState('125');
  const gcDraft = useMemo(() => {
    try {
      if (!gcWindow.trim() || !gcStep.trim()) throw new Error('Enter the GC-skew window and step sizes.');
      return { options: resolveGCSkewOptions({ windowSize: Number(gcWindow), stepSize: Number(gcStep) }), error: null };
    } catch (cause) { return { options: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [gcWindow, gcStep]);
  const gcResult = acceptedAnalysis?.method.id === GC_SKEW_METHOD.id && acceptedAnalysis.method.version === GC_SKEW_METHOD.version
    ? { record: acceptedAnalysis, windows: acceptedAnalysis.fields.windows.value as unknown as GCSkewWindow[] } : null;
  const [repetitions, setRepetitions] = useState('1');
  const [pairLimit, setPairLimit] = useState('2000');
  const [repeatTopology, setRepeatTopology] = useState<'linear' | 'circular'>('linear');
  const exactRepeatDraft = useMemo(() => {
    try {
      if (![minimum, gap, pairLimit].every(value => value.trim())) throw new Error('Enter an arm length, gap and pair limit.');
      return { options: resolveExactRepeatOptions({ armLength: Number(minimum), maxGap: Number(gap), maxPairs: Number(pairLimit), topology: repeatTopology }), error: null };
    } catch (cause) { return { options: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [minimum, gap, pairLimit, repeatTopology]);
  const exactRepeatResult = acceptedAnalysis?.method.id === EXACT_REPEAT_METHOD.id && [EXACT_REPEAT_METHOD.version, CIRCULAR_EXACT_REPEAT_METHOD.version].includes(acceptedAnalysis.method.version)
    ? { record: acceptedAnalysis, pairs: acceptedAnalysis.fields.pairs.value as unknown as ExactRepeatScan['pairs'],
      search: acceptedAnalysis.fields.search.value as unknown as ExactRepeatScan['search'] } : null;
  const circularResult = exactRepeatResult?.search.options.topology === 'circular';
  const armLabel = (start: number, end: number) => exactRepeatArmSegments(exactRepeatResult!.search.sequenceLength, start, end)
    .map(segment => `[${segment.start}, ${segment.end})`).join(' → ');
  const [codonReference, setCodonReference] = useState<{ text: string; name: string; kind: 'counts' | 'corpus' } | null>(null);
  const [referenceZeroPolicy, setReferenceZeroPolicy] = useState<ZeroCountReplacement>(0.5);
  const referenceDraft = useMemo(() => {
    if (!codonReference) return { parameters: null, error: 'Load count-reference JSON or a source-corpus experiment to record this method.' };
    try {
      return { parameters: researchReferenceCodonParameters(selected, codonReference.text,
        gene === 'all' ? null : [Number(gene)], referenceZeroPolicy), error: null };
    } catch (cause) { return { parameters: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [selected, gene, codonReference, referenceZeroPolicy]);
  const referenceResult = useMemo(() => {
    const record = acceptedAnalysis;
    if (!record || record.method.id !== CODON_REFERENCE_METHOD.id
      || ![CODON_REFERENCE_METHOD.version, CODON_REFERENCE_SOURCE_METHOD.version].includes(record.method.version)) return null;
    return { record, sourceBacked: record.method.version === CODON_REFERENCE_SOURCE_METHOD.version,
      summary: record.fields.summary.value as unknown as ReferenceCodonAnalysis['summary'],
      genes: record.fields.geneScores.value as unknown as ReferenceCodonAnalysis['genes'],
      reference: record.references[1], corpus: record.references.find(item => item.id === 'genbank-codon-reference') };
  }, [acceptedAnalysis]);
  const [graphIds, setGraphIds] = useState<string[]>([]);
  const [graphReference, setGraphReference] = useState('');
  const [graphAlignment, setGraphAlignment] = useState<AlignmentGraphOptions['alignment']>('wavefront');
  const [graphNormalization, setGraphNormalization] = useState<'none' | 'strand' | 'circular'>('none');
  const [graphTerminals, setGraphTerminals] = useState<AlignmentGraphOptions['terminalGaps']>('missing');
  const [graphMismatch, setGraphMismatch] = useState('4'), [graphOpening, setGraphOpening] = useState('6'), [graphExtension, setGraphExtension] = useState('1');
  const [graphAnnotate, setGraphAnnotate] = useState(false), [graphGeneIds, setGraphGeneIds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inputBusy, setInputBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [review, setReview] = useState<GenomeImportResult | null>(null);
  const [collisions, setCollisions] = useState(false);
  const inputOperation = useRef<AbortController | null>(null);
  useEffect(() => {
    binding.activate();
    return () => { inputOperation.current?.abort(); binding.dispose(); };
  }, [binding]);
  useEffect(() => { if (!genomes.some(g => g.phage.localGenome?.contentId === selected)) { setSelected(genomes[0]?.phage.localGenome?.contentId ?? ''); setGene('all'); setRepeatTopology('linear'); } }, [genomes, selected]);
  useEffect(() => { setGraphIds(ids => ids.filter(id => genomes.some(g => g.phage.localGenome?.contentId === id))); }, [genomes]);
  const graphGenomes = useMemo(() => genomes.filter(g => graphIds.includes(g.phage.localGenome!.contentId)), [genomes, graphIds]);
  useEffect(() => { if (!graphGenomes.some(g => g.phage.localGenome?.contentId === graphReference)) setGraphReference(graphGenomes[0]?.phage.localGenome?.contentId ?? ''); }, [graphGenomes, graphReference]);
  const annotationGenome = graphGenomes.find(g => g.phage.localGenome?.contentId === graphReference);
  const graphDraft = useMemo(() => {
    try {
      if (graphAnnotate && annotationGenome?.phage.localGenome?.format !== 'genbank') throw new Error('Choose an annotated GenBank reference for coding consequences.');
      const number = (value: string) => value.trim() ? Number(value) : NaN;
      const parameters = researchPangenomeParameters(graphIds, {
        referenceId: `local-${graphReference}`, alignment: graphAlignment, terminalGaps: graphTerminals,
        ...(graphNormalization === 'none' ? {} : { normalization: graphNormalization }),
        ...(graphAlignment === 'affine' ? { affinePenalties: { mismatch: number(graphMismatch), gapOpen: number(graphOpening), gapExtend: number(graphExtension) } } : {}),
      }, graphAnnotate ? { contentId: graphReference, geneIds: parseCdsGeneIds(graphGeneIds) } : null);
      return { parameters, error: null };
    } catch (cause) { return { parameters: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [graphIds, graphReference, graphAlignment, graphTerminals, graphNormalization, graphMismatch, graphOpening, graphExtension, graphAnnotate, graphGeneIds, annotationGenome]);
  const genome = genomes.find(g => g.phage.localGenome?.contentId === selected);
  const commandBusy = inputBusy || !['idle', 'recording'].includes(state.mode);
  const busy = commandBusy || libraryBusy;
  const active = state.mode === 'recording';
  const invoke = (action: () => void | Promise<void>) => {
    setError(null);
    void Promise.resolve().then(action).catch(cause => { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(workflow.commands.getSnapshot().error ?? (cause instanceof Error ? cause.message : String(cause))); });
  };
  const cancel = () => { inputOperation.current?.abort(); inputOperation.current = null; setInputBusy(false); workflow.commands.cancel(); };
  const load = async (file: File | undefined) => {
    if (!file) return;
    inputOperation.current?.abort(); const controller = new AbortController(); inputOperation.current = controller;
    setInputBusy(true); setError(null); setReview(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Workflow exceeds the 10 MiB limit.');
      const content = await file.text(); if (controller.signal.aborted) return;
      const parsed = await workflow.loadAndReview(content, controller.signal); if (controller.signal.aborted) return;
      setName(workflow.commands.getSnapshot().tape.name);
      setReview(parsed);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (inputOperation.current === controller) { inputOperation.current = null; setInputBusy(false); } }
  };
  const loadReference = async (file: File | undefined) => {
    if (!file || busy || !active) return;
    inputOperation.current?.abort();
    const controller = new AbortController(); inputOperation.current = controller;
    setInputBusy(true); setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Reference input exceeds 10 MiB.');
      const text = await file.text();
      if (inputOperation.current !== controller || controller.signal.aborted) return;
      // Reuse the canonical command validator for the draft envelope. Source
      // counts are not trusted here; the numerical worker recounts before use.
      researchReferenceCodonParameters(selected, text, null, referenceZeroPolicy);
      const kind = JSON.parse(text).format === 'phage-explorer-analysis' ? 'corpus' : 'counts';
      setCodonReference({ text, name: file.name, kind });
    } catch (cause) {
      if (inputOperation.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Reference input could not be read.');
    } finally { if (inputOperation.current === controller) { inputOperation.current = null; setInputBusy(false); } }
  };
  const view = (): ResearchView => ({ contentId: selected, geneId: gene === 'all' ? null : Number(gene), scrollPosition: position.trim() ? Number(position) : NaN, viewMode: mode, readingFrame: frame });
  const restoreLocal = async (content: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    inputOperation.current?.abort(); const controller = new AbortController(); inputOperation.current = controller;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    setInputBusy(true); setError(null); setReview(null);
    try {
      const parsed = await workflow.loadAndReview(content, controller.signal);
      if (inputOperation.current !== controller || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      setName(workflow.commands.getSnapshot().tape.name); setCollisions(false); setReview(parsed);
    } finally {
      signal.removeEventListener('abort', abort);
      if (inputOperation.current === controller) { inputOperation.current = null; setInputBusy(false); }
    }
  };
  return <section aria-label="Saved research workflows" style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem', display: 'grid', gap: '.7rem' }}>
    <h3>Saved research workflows</h3>
    <p>Record explicit navigation, GC skew, repeats, reference-backed or illustrative single-genome CDS, and multi-genome pangenome commands below, save their private inputs, and replay with fresh result verification. Actions in other panels are not recorded. Import every required query genome before starting; nothing is uploaded.</p>
    <SavedResearchPanel kind="workflow" suggestedName={state.tape.name} disabled={commandBusy || active}
      capture={state.tape.commands.length && !active ? workflow.commands.export : null} restore={restoreLocal} onActivityChange={setLibraryBusy} />
    <label>Workflow name <input value={name} disabled={busy || active} onChange={event => setName(event.target.value)} /></label>
    <div><button type="button" disabled={busy || active || !genomes.length} onClick={() => invoke(() => workflow.start(name))}>Start workflow recording</button>
      <button type="button" disabled={busy || !active} onClick={() => invoke(workflow.commands.stop)}>Stop workflow recording</button>
      <button type="button" disabled={busy || active || !state.tape.commands.length} onClick={() => invoke(() => downloadString(workflow.commands.export(), 'research-workflow.json', 'application/json'))}>Export research workflow</button></div>
    <label>Load research workflow JSON <input type="file" accept=".json,application/json" disabled={busy || active} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void load(file); }} /></label>
    {review && <div><p>{review.genomes.length} bundled genomes validated. Adding them is separate from running any recorded command.</p>
      <label><input type="checkbox" checked={collisions} onChange={event => setCollisions(event.target.checked)} /> Keep distinct records with matching accessions</label>
      <button type="button" disabled={busy || active} onClick={() => invoke(() => { useLocalGenomes.getState().add(review, collisions, usePhageStore.getState().phages); setReview(null); })}>Add workflow genomes</button></div>}
    <fieldset disabled={busy || !active || !genome} style={{ display: 'grid', gap: '.5rem' }}><legend>Record content-bound commands</legend>
      <label htmlFor="workflow-genome">Workflow genome</label><select id="workflow-genome" value={selected} onChange={event => { setSelected(event.target.value); setGene('all'); setPosition('0'); setRepeatTopology('linear'); }}>
        {genomes.map(g => <option key={g.phage.id} value={g.phage.localGenome!.contentId}>{g.phage.name}</option>)}</select>
      <label htmlFor="workflow-cds">Workflow CDS</label><select id="workflow-cds" value={gene} onChange={event => { setGene(event.target.value); const g = genome?.phage.genes.find(g => g.id === Number(event.target.value)); if (g) setPosition(String(mode === 'aa' ? Math.floor(g.startPos / 3) : g.startPos)); }}>
        <option value="all">All supported CDS</option>{genome?.phage.genes.filter(g => g.type === 'CDS').map(g => <option key={g.id} value={g.id}>{g.locusTag ?? g.name ?? `CDS ${g.id}`} · {g.qualifiers?._location ? String(g.qualifiers._location) : `${g.startPos}–${g.endPos}`}</option>)}</select>
      <label>Workflow position (0-based view coordinate) <input type="number" min={0} max={Math.max(0, (mode === 'aa' ? Math.ceil((genome?.sequence.length ?? 1) / 3) : genome?.sequence.length ?? 1) - 1)} value={position} onChange={event => setPosition(event.target.value)} /></label>
      <p>Positions are base offsets in DNA/dual views and residue offsets in amino-acid view. CDS extraction uses the recorded annotation, independently of the displayed frame.</p>
      <label htmlFor="workflow-mode">Workflow view mode</label><select id="workflow-mode" value={mode} onChange={event => setMode(event.target.value as ResearchView['viewMode'])}><option value="dna">DNA</option><option value="aa">Amino acids</option><option value="dual">Dual</option></select>
      <label htmlFor="workflow-frame">Workflow reading frame</label><select id="workflow-frame" value={frame} onChange={event => setFrame(Number(event.target.value) as ResearchView['readingFrame'])}>{[0, 1, 2, -1, -2, -3].map(value => <option key={value} value={value}>{value}</option>)}</select>
      <button type="button" onClick={() => invoke(() => workflow.commands.dispatch(ActionIds.NavGoto, analysisJson(view())))}>Apply and record view</button>
      <label>Workflow minimum repeat arm <input type="number" min={4} max={256} value={minimum} onChange={event => setMinimum(event.target.value)} /></label>
      <label>Workflow maximum repeat gap <input type="number" min={0} max={100000} value={gap} onChange={event => setGap(event.target.value)} /></label>
      <button type="button" onClick={() => invoke(() => workflow.commands.dispatch(ActionIds.OverlayRepeats, { contentId: selected, minLength: minimum.trim() ? Number(minimum) : NaN, maxGap: gap.trim() ? Number(gap) : NaN }))}>Run and record repeats</button>
      <label>Workflow exact pair limit <input type="number" min={1} max={20000} value={pairLimit} onChange={event => setPairLimit(event.target.value)} /></label>
      <label htmlFor="workflow-repeat-topology">Exact repeat input topology</label>
      <select id="workflow-repeat-topology" value={repeatTopology} onChange={event => setRepeatTopology(event.target.value as typeof repeatTopology)}>
        <option value="linear">Linear or partial sequence (do not join ends)</option>
        <option value="circular">I assert this input is a complete circular molecule</option>
      </select>
      <p>Circular mode joins the sequence ends and searches origin-crossing arms using the shorter spacer arc. Do not use it for a linear molecule or a partial assembly.
        This choice applies only to exact pairs, is recorded explicitly, and resets when the selected genome changes.</p>
      <p>Exact pairs use the chosen arm length as a fixed length and visit every eligible direct/inverted partner. Arms cannot overlap; ambiguous bases can occur only in the spacer. Result limits return an explicitly marked prefix. Legacy repeat overview above remains sampled and browser-bound.</p>
      {exactRepeatDraft.error && <p>{exactRepeatDraft.error}</p>}
      <button type="button" disabled={busy || !active || !genome || !exactRepeatDraft.options} onClick={() => {
        if (busy || !active || !genome || !exactRepeatDraft.options) return;
        const parameters = { contentId: selected, method: 'exact-pairs', ...exactRepeatDraft.options };
        // Claim execution immediately: unmount/cancel cannot race a queued start.
        const task = workflow.commands.dispatch(ActionIds.OverlayRepeats, parameters);
        invoke(() => task);
      }}>Run and record exact repeat pairs</button>
      <button type="button" onClick={() => invoke(() => workflow.commands.dispatch(ActionIds.OverlayCodonAdaptation, { contentId: selected, geneId: gene === 'all' ? null : Number(gene) }))}>Run and record CDS analysis</button>
      <p>The CDS button above uses the existing illustrative host model. It is not the reference-backed command below.</p>
    </fieldset>
    <fieldset disabled={busy || !active || !genome} style={{ display: 'grid', gap: '.5rem' }}><legend>Record portable GC skew</legend>
      <p>Query: {genome?.phage.name ?? 'select a workflow genome above'}. Complete linear windows only; topology is not inferred from a circular annotation.</p>
      <label>Workflow GC-skew window (bp) <input type="number" min={1} max={1000000} value={gcWindow} onChange={event => setGcWindow(event.target.value)} /></label>
      <label>Workflow GC-skew step (bp) <input type="number" min={1} max={5000000} value={gcStep} onChange={event => setGcStep(event.target.value)} /></label>
      {gcDraft.error && <p>{gcDraft.error}</p>}
      <button type="button" disabled={busy || !active || !genome || !gcDraft.options} onClick={() => {
        if (busy || !active || !genome || !gcDraft.options) return;
        const task = workflow.commands.dispatch(ActionIds.OverlayGCSkew, { contentId: selected, ...gcDraft.options });
        invoke(() => task);
      }}>Run and record GC skew</button>
      <p>Portable experiments retain exact nucleotide counts and replay in the browser or CLI. At most 20,000 windows are retained; an excessive request fails before computation.
        Zero-GC windows remain unavailable. Sampled cumulative extrema are sequence-composition candidates, not experimentally identified replication sites.</p>
    </fieldset>
    <fieldset disabled={busy || !active || !genome} style={{ display: 'grid', gap: '.5rem' }}><legend>Record reference-backed codon adaptation</legend>
      <p>Query: {genome?.phage.name ?? 'select a workflow genome above'}; CDS: {gene === 'all' ? 'all supported annotations' : gene}.
        Use the genome/CDS selection above. Coding frames come from annotations, not the displayed reading frame.</p>
      <label>Workflow codon reference JSON <input type="file" accept=".json,application/json" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void loadReference(file);
      }} /></label>
      {codonReference && <p data-testid="workflow-reference-draft">Draft reference: {codonReference.name} · {codonReference.kind === 'corpus' ? 'source-corpus experiment; source replay required at execution' : 'user-supplied integer counts'}.
        Loading only reads the reference; it does not execute or record a command.</p>}
      <p>Use count JSON, or export a source-reference experiment from Reference-backed codon adaptation above.
        A source experiment retains its original GenBank and CDS selection and is freshly recounted on every execution.
        No reference file path is followed during replay. The exact JSON travels with each command; the whole tape must still fit 10 MiB.</p>
      <label>Workflow reference zero-count replacement <select value={referenceZeroPolicy} onChange={event => setReferenceZeroPolicy(Number(event.target.value) as ZeroCountReplacement)}>
        <option value={0.5}>Replace reported zeros with 0.5</option><option value={0}>Keep true zero weights</option>
      </select></label>
      {referenceDraft.error && <p>{referenceDraft.error}</p>}
      <button type="button" disabled={busy || !active || !genome || !referenceDraft.parameters} onClick={() => {
        if (busy || !active || !genome || !referenceDraft.parameters) return;
        const task = workflow.commands.dispatch(ActionIds.OverlayCodonAdaptation, analysisJson(referenceDraft.parameters));
        invoke(() => task);
      }}>Run and record reference-backed CDS</button>
      <p>Missing reference families and unsupported CDS remain unavailable, not zero or fabricated scores.
        CAI is a reference-relative sequence score, not expression, host range or infection probability.</p>
    </fieldset>
    <fieldset disabled={busy || !active} style={{ display: 'grid', gap: '.5rem' }}><legend>Record a real pangenome experiment</legend>
      <p>Select 2–24 imported genomes by content identity. Each run records its exact reference, alignment model and optional GenBank CDS subset; the original inputs are stored once in the workflow bundle.</p>
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>{genomes.map(g => {
        const id = g.phage.localGenome!.contentId;
        return <label key={id} style={{ display: 'block' }}><input type="checkbox" aria-label={`Workflow graph genome ${g.phage.name} ${id.slice(0, 12)}`}
          checked={graphIds.includes(id)} disabled={!graphIds.includes(id) && graphIds.length >= 24}
          onChange={event => setGraphIds(ids => event.target.checked ? [...ids, id] : ids.filter(value => value !== id))} />
          {g.phage.name} · {g.phage.accession} · {id.slice(0, 12)}</label>;
      })}</div>
      <label>Workflow graph reference <select id="workflow-graph-reference" value={graphReference} onChange={event => { setGraphReference(event.target.value); setGraphGeneIds(''); }}>
        {!graphGenomes.length && <option value="">Select genomes above</option>}
        {graphGenomes.map(g => <option key={g.phage.id} value={g.phage.localGenome!.contentId}>{g.phage.name} · {g.phage.localGenome!.contentId.slice(0, 12)}</option>)}
      </select></label>
      <label>Workflow alignment <select id="workflow-graph-alignment" value={graphAlignment} onChange={event => {
        const alignment = event.target.value as AlignmentGraphOptions['alignment']; setGraphAlignment(alignment);
        if (alignment !== 'wavefront' && alignment !== 'affine') setGraphNormalization('none');
      }}><option value="wavefront">Exact unit-edit wavefront</option><option value="affine">Exact affine-gap wavefront</option>
        <option value="global">Bounded global locus alignment</option><option value="provided">Treat equal columns as a supplied alignment</option></select></label>
      {graphAlignment === 'affine' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
        <label>Workflow mismatch cost <input id="workflow-graph-mismatch" type="number" min={1} max={64} value={graphMismatch} onChange={event => setGraphMismatch(event.target.value)} /></label>
        <label>Workflow gap opening <input id="workflow-graph-opening" type="number" min={0} max={64} value={graphOpening} onChange={event => setGraphOpening(event.target.value)} /></label>
        <label>Workflow gap extension <input id="workflow-graph-extension" type="number" min={1} max={64} value={graphExtension} onChange={event => setGraphExtension(event.target.value)} /></label>
      </div>}
      {(graphAlignment === 'wavefront' || graphAlignment === 'affine') && <label>Workflow strand and origin <select id="workflow-graph-normalization" value={graphNormalization} onChange={event => setGraphNormalization(event.target.value as typeof graphNormalization)}>
        <option value="none">Keep submitted representation</option><option value="strand">Normalize whole-sequence strand</option><option value="circular">Normalize complete circular inputs</option></select></label>}
      <label>Workflow terminal gaps <select id="workflow-graph-terminals" value={graphTerminals} onChange={event => setGraphTerminals(event.target.value as typeof graphTerminals)}>
        <option value="missing">Missing sequence coverage</option><option value="alleles">Alleles at complete sequence ends</option></select></label>
      <p>Equal lengths do not establish homology. Circular normalization asserts every input is a complete circle and requires terminal alleles. Non-identical normalization uses heuristic anchors; alignment scores are not biological likelihoods. All existing work limits apply.</p>
      <label><input id="workflow-graph-annotate" type="checkbox" checked={graphAnnotate} onChange={event => setGraphAnnotate(event.target.checked)} /> Include the reference's GenBank coding consequences</label>
      {graphAnnotate && <>
        <label>Workflow graph CDS IDs (blank means all) <input id="workflow-graph-genes" value={graphGeneIds} onChange={event => setGraphGeneIds(event.target.value)} /></label>
        <details><summary>Reference mapped CDS identifiers</summary><p>{annotationGenome?.phage.genes.filter(g => g.type === 'CDS').map(g => `${g.id}: ${g.locusTag ?? g.name ?? 'CDS'}`).join('; ') || 'No mapped CDS in this reference.'}</p></details>
      </>}
      {graphDraft.error && <p>{graphDraft.error}</p>}
      <button type="button" disabled={busy || !active || !graphDraft.parameters} onClick={() => {
        if (busy || !active || !graphDraft.parameters) return;
        const parameters = analysisJson(graphDraft.parameters);
        // Start within the click so an immediate close/unmount cancels this job.
        const task = workflow.commands.dispatch(ActionIds.OverlayPangenomeGraph, parameters);
        invoke(() => task);
      }}>Run and record pangenome</button>
      <p>The result appears below and exports as a complete pangenome experiment for the graph viewer or CLI. This command does not overwrite an open pangenome workspace. The separate single-genome CDS command above retains its illustrative host model.</p>
    </fieldset>
    <div><button type="button" disabled={busy || !research.undoAvailable} onClick={() => invoke(() => workflow.moveHistory(-1))}>Undo workflow view</button>
      <button type="button" disabled={busy || !research.redoAvailable} onClick={() => invoke(() => workflow.moveHistory(1))}>Redo workflow view</button></div>
    <label>Workflow replay repetitions <input type="number" min={1} max={10} disabled={busy || active} value={repetitions} onChange={event => setRepetitions(event.target.value)} /></label>
    <div><button type="button" disabled={busy || active || !state.tape.commands.length} onClick={() => invoke(() => workflow.commands.replay(Number(repetitions)))}>Replay research workflow</button>
      <button type="button" disabled={state.mode !== 'replaying'} onClick={workflow.commands.pause}>Pause workflow</button>
      <button type="button" disabled={state.mode !== 'paused'} onClick={workflow.commands.resume}>Resume workflow</button>
      <button type="button" disabled={!commandBusy} onClick={cancel}>Cancel workflow</button></div>
    <p aria-live="polite" data-testid="workflow-status">{state.mode} · {state.tape.commands.length} recorded commands · {state.completed}/{state.total} replay commands complete. {state.notice}</p>
    {(error || state.error) && <p role="alert">{error ?? state.error}</p>}
    <ol aria-label="Recorded workflow commands">{state.tape.commands.map((command, index) => {
      const parameters = command.parameters;
      // A 10 MiB embedded corpus belongs in the export, not an enormous DOM node.
      const preview = parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
        && parameters.method === 'reference-cai' && typeof parameters.referenceText === 'string'
        ? { ...parameters, referenceText: `[${parameters.referenceText.length} characters embedded; retained exactly in the workflow export]` } : parameters;
      return <li key={index}>{ActionRegistry[command.actionId as keyof typeof ActionRegistry]?.title ?? command.actionId} <code>{JSON.stringify(preview)}</code></li>;
    })}</ol>
    {research.view && <p data-testid="workflow-view">Saved view: {research.view.contentId.slice(0, 12)} · {research.view.viewMode} · frame {research.view.readingFrame} · position {research.view.scrollPosition} · CDS {research.view.geneId ?? 'all'}</p>}
    {acceptedAnalysis && <div data-testid="workflow-result" data-result-id={acceptedAnalysis.resultId}>
      <p>Accepted result: {acceptedAnalysis.method.id}. Reproducibility is not biological validation.</p>
      {!research.result && <p role="status">The latest command changed the view. The last accepted analysis remains available with its original inputs and parameters.</p>}
      <p>Analysis inputs: {acceptedAnalysis.inputs.map(input => input.accession ?? input.id).join(', ')}.</p>
      <button type="button" disabled={busy} onClick={() => invoke(() => downloadString(serializeAnalysisRecord(acceptedAnalysis), 'workflow-analysis.json', 'application/json'))}>Export workflow analysis</button>
      {gcResult && <section aria-label="Recorded GC-skew results">
        <h4>Accepted GC-skew experiment</h4>
        <p>{gcResult.windows.length.toLocaleString()} complete sampled windows; {gcResult.windows.filter(row => row.skew !== null).length.toLocaleString()} with defined skew.
          {' '}Accepted window: {String(gcResult.record.parameters.windowSize)} bp; step: {String(gcResult.record.parameters.stepSize)} bp.</p>
        <p>Cumulative values count G minus C through each window start, inclusive. Undefined skew is shown as unavailable.
          Draft parameters above do not change the accepted result. The preview shows at most 50 rows; JSON and TSV retain every sampled window.</p>
        <button type="button" disabled={busy} onClick={() => invoke(() => downloadString(exportGCSkewTsv(gcResult.record), 'gc-skew-windows.tsv', 'text/tab-separated-values'))}>Export GC-skew windows TSV</button>
        <div style={{ overflowX: 'auto' }}><table aria-label="Recorded GC-skew window counts">
          <thead><tr><th>Interval [start, end)</th><th>G</th><th>C</th><th>Skew</th><th>Cumulative G−C</th></tr></thead>
          <tbody>{gcResult.windows.slice(0, 50).map(row => <tr key={row.start}><td>[{row.start}, {row.end})</td><td>{row.g}</td><td>{row.c}</td>
            <td>{row.skew === null ? 'Unavailable' : row.skew.toFixed(6)}</td><td>{row.cumulative}</td></tr>)}</tbody>
        </table></div>
      </section>}
      {referenceResult && <section aria-label="Recorded reference-codon results">
        <h4>Accepted reference-backed CDS analysis</h4>
        <p>Reference: {referenceResult.reference.id} · {referenceResult.reference.version}. {referenceResult.reference.description}</p>
        <p>{referenceResult.sourceBacked ? 'Original reference corpus was reparsed and recounted before scoring.' : 'Counts were supplied directly; original source extraction is not verified.'}
          {' '}Attribution and reference suitability remain author assertions.</p>
        {referenceResult.corpus && <p>Verified corpus result: <code>{referenceResult.corpus.version}</code></p>}
        <p>Pooled CAI: {referenceResult.summary.cai === null ? 'Unavailable' : referenceResult.summary.cai.toFixed(6)}.
          {' '}Fully scored CDS: {referenceResult.summary.scoredGenes}/{referenceResult.summary.totalGenes}; scored codons: {referenceResult.summary.scoredCodons}.
          {' '}Accepted zero-count replacement: {String(referenceResult.record.parameters.zeroCountReplacement)}.</p>
        <p>The preview shows at most 50 CDS; Export workflow analysis retains all scores, exclusions, query annotations and exact reference input.
          Draft controls above never relabel this accepted result.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Recorded reference-relative CDS scores">
          <thead><tr><th>CDS</th><th>CAI</th><th>Covered / eligible codons</th><th>Status</th></tr></thead>
          <tbody>{referenceResult.genes.slice(0, 50).map(row => <tr key={row.geneId}><td>{row.label} ({row.strand})</td>
            <td>{row.cai === null ? 'Unavailable' : row.cai.toFixed(6)}</td><td>{row.scoredCodons}/{row.eligibleCodons}</td><td>{row.reasons.join(' ') || 'Scored'}</td></tr>)}</tbody>
        </table></div>
      </section>}
      {exactRepeatResult && <section aria-label="Exact repeat-pair results">
        <h4>Exact repeat pairs</h4>
        <p role="status">{exactRepeatResult.pairs.length.toLocaleString()} pairs retained. {exactRepeatResult.search.complete
          ? `Complete for the submitted fixed-arm, ${circularResult ? 'circular shortest-spacer' : 'linear gap'} search.`
          : `Incomplete ordered prefix: the pair limit stopped enumeration at right-arm start ${exactRepeatResult.search.stoppedAtRightStart}.`}</p>
        <p>Submitted arm length: {exactRepeatResult.search.options.armLength} bases; maximum spacer: {exactRepeatResult.search.options.maxGap};
          pair limit: {exactRepeatResult.search.options.maxPairs}. Resolved bases: {exactRepeatResult.search.resolvedBases.toLocaleString()}/{exactRepeatResult.search.sequenceLength.toLocaleString()}.
          {' '}Submitted topology: {circularResult ? 'complete circular molecule (user asserted)' : 'linear'}.
          {' '}{circularResult ? 'Origin-crossing arms are included; each physical pair is counted once per orientation.' : 'Circular-origin crossings are not searched.'}
          {' '}This is not maximal-repeat annotation.</p>
        <button type="button" disabled={busy} onClick={() => invoke(() => downloadString(exportExactRepeatPairsTsv(exactRepeatResult.record), 'exact-repeat-pairs.tsv', 'text/tab-separated-values'))}>Export exact repeat pairs TSV</button>
        <p>Both arm intervals are 0-based and half-open. Showing the first {Math.min(50, exactRepeatResult.pairs.length)} retained pairs; TSV contains the entire retained set and its completeness flag.</p>
        {circularResult && <p>Wrapped arms are split at the sequence origin and listed in traversal order (→). First and second follow the shorter circular spacer,
          not numerical left-to-right order; equal spacer arcs choose the lower first start. TSV retains unrolled ends and explicit original-coordinate segments.</p>}
        <div style={{ overflowX: 'auto' }}><table aria-label="Exact repeat-pair coordinates">
          <thead><tr><th>Type</th><th>First arm</th><th>Second arm</th><th>Spacer</th></tr></thead>
          <tbody>{exactRepeatResult.pairs.slice(0, 50).map((pair, index) => <tr key={index}>
            <td>{pair.type}</td><td>{armLabel(pair.leftStart, pair.leftEnd)}</td><td>{armLabel(pair.rightStart, pair.rightEnd)}</td><td>{pair.gap}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
      <details><summary>Computed values (first 12,000 characters)</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(Object.fromEntries(Object.entries(acceptedAnalysis.fields).map(([key, field]) => [key, field.value])), null, 2).slice(0, 12000)}</pre></details>
      <AnalysisRecordDetails record={acceptedAnalysis} />
    </div>}
    <p>Limits: 128 recorded commands, 256 replay executions, 10 repetitions, 10 MiB including private inputs. Reference or execution-backend changes stop verification. Closing this panel cancels active work; stop recording and save a local snapshot or export JSON before closing to keep it.</p>
  </section>;
}
