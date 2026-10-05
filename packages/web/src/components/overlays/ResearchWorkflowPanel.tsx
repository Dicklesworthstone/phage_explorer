import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson, exportLocalGenomeBundle, serializeAnalysisRecord, type GenomeImportResult } from '@phage-explorer/core';
import { useLocalGenomes } from '../../db/local-genomes';
import { ActionIds, ActionRegistry } from '../../keyboard/actionRegistry';
import { ResearchWorkflow, researchPangenomeParameters, type ResearchView } from '../../keyboard/ResearchWorkflow';
import { EXACT_REPEAT_METHOD, resolveExactRepeatOptions, exportExactRepeatPairsTsv, type ExactRepeatScan } from '../../../../core/src/analysis/exact-repeat-pairs';
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
      signal.removeEventListener('abort', cancel); worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(undefined, new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      if (event.data.type === 'result') finish(event.data.result);
      else if (event.data.type === 'error') finish(undefined, new Error(event.data.message));
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
    pangenome: ActionIds.OverlayPangenomeGraph }, {
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
    codons: async (genome, geneId, signal) => {
      const response = await runResearchWorker({ type: 'codons', genome, geneId }, signal);
      if (response.type !== 'analysis') throw new Error('Expected CDS analysis evidence.');
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
  const genomes = useLocalGenomes(s => s.genomes);
  const [name, setName] = useState('Private genome workflow');
  const [selected, setSelected] = useState('');
  const [gene, setGene] = useState('all');
  const [position, setPosition] = useState('0');
  const [mode, setMode] = useState<ResearchView['viewMode']>('dna');
  const [frame, setFrame] = useState<ResearchView['readingFrame']>(0);
  const [minimum, setMinimum] = useState('8'), [gap, setGap] = useState('5000');
  const [repetitions, setRepetitions] = useState('1');
  const [pairLimit, setPairLimit] = useState('2000');
  const exactRepeatDraft = useMemo(() => {
    try {
      if (![minimum, gap, pairLimit].every(value => value.trim())) throw new Error('Enter an arm length, gap and pair limit.');
      return { options: resolveExactRepeatOptions({ armLength: Number(minimum), maxGap: Number(gap), maxPairs: Number(pairLimit) }), error: null };
    } catch (cause) { return { options: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [minimum, gap, pairLimit]);
  const exactRepeatResult = research.result?.method.id === EXACT_REPEAT_METHOD.id && research.result.method.version === EXACT_REPEAT_METHOD.version
    ? { record: research.result, pairs: research.result.fields.pairs.value as unknown as ExactRepeatScan['pairs'],
      search: research.result.fields.search.value as unknown as ExactRepeatScan['search'] } : null;
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
  useEffect(() => { if (!genomes.some(g => g.phage.localGenome?.contentId === selected)) { setSelected(genomes[0]?.phage.localGenome?.contentId ?? ''); setGene('all'); } }, [genomes, selected]);
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
    <p>Record explicit navigation, repeats, single-genome CDS or multi-genome pangenome commands below, save their private input bundle, and replay with fresh result verification. Actions in other panels are not recorded. Import every required genome before starting; nothing is uploaded.</p>
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
      <label htmlFor="workflow-genome">Workflow genome</label><select id="workflow-genome" value={selected} onChange={event => { setSelected(event.target.value); setGene('all'); setPosition('0'); }}>
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
    <ol aria-label="Recorded workflow commands">{state.tape.commands.map((command, index) => <li key={index}>{ActionRegistry[command.actionId as keyof typeof ActionRegistry]?.title ?? command.actionId} <code>{JSON.stringify(command.parameters)}</code></li>)}</ol>
    {research.view && <p data-testid="workflow-view">Saved view: {research.view.contentId.slice(0, 12)} · {research.view.viewMode} · frame {research.view.readingFrame} · position {research.view.scrollPosition} · CDS {research.view.geneId ?? 'all'}</p>}
    {research.result && <div data-testid="workflow-result" data-result-id={research.result.resultId}>
      <p>Accepted result: {research.result.method.id}. Reproducibility is not biological validation.</p>
      <button type="button" disabled={busy} onClick={() => invoke(() => downloadString(serializeAnalysisRecord(research.result!), 'workflow-analysis.json', 'application/json'))}>Export workflow analysis</button>
      {exactRepeatResult && <section aria-label="Exact repeat-pair results">
        <h4>Exact repeat pairs</h4>
        <p role="status">{exactRepeatResult.pairs.length.toLocaleString()} pairs retained. {exactRepeatResult.search.complete
          ? 'Complete for the submitted fixed-arm, linear gap search.'
          : `Incomplete ordered prefix: the pair limit stopped enumeration at right-arm start ${exactRepeatResult.search.stoppedAtRightStart}.`}</p>
        <p>Submitted arm length: {exactRepeatResult.search.options.armLength} bases; maximum spacer: {exactRepeatResult.search.options.maxGap};
          pair limit: {exactRepeatResult.search.options.maxPairs}. Resolved bases: {exactRepeatResult.search.resolvedBases.toLocaleString()}/{exactRepeatResult.search.sequenceLength.toLocaleString()}.
          This does not search circular-origin crossings or maximal repeat families.</p>
        <button type="button" disabled={busy} onClick={() => invoke(() => downloadString(exportExactRepeatPairsTsv(exactRepeatResult.record), 'exact-repeat-pairs.tsv', 'text/tab-separated-values'))}>Export exact repeat pairs TSV</button>
        <p>Both arm intervals are 0-based and half-open. Showing the first {Math.min(50, exactRepeatResult.pairs.length)} retained pairs; TSV contains the entire retained set and its completeness flag.</p>
        <div style={{ overflowX: 'auto' }}><table aria-label="Exact repeat-pair coordinates">
          <thead><tr><th>Type</th><th>Left arm</th><th>Right arm</th><th>Spacer</th></tr></thead>
          <tbody>{exactRepeatResult.pairs.slice(0, 50).map((pair, index) => <tr key={index}>
            <td>{pair.type}</td><td>[{pair.leftStart}, {pair.leftEnd})</td><td>[{pair.rightStart}, {pair.rightEnd})</td><td>{pair.gap}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
      <details><summary>Computed values (first 12,000 characters)</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(Object.fromEntries(Object.entries(research.result.fields).map(([key, field]) => [key, field.value])), null, 2).slice(0, 12000)}</pre></details>
      <AnalysisRecordDetails record={research.result} />
    </div>}
    <p>Limits: 128 recorded commands, 256 replay executions, 10 repetitions, 10 MiB including private inputs. Reference or execution-backend changes stop verification. Closing this panel cancels active work; stop recording and save a local snapshot or export JSON before closing to keep it.</p>
  </section>;
}
