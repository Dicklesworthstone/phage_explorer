import React, { useEffect, useRef, useState } from 'react';
import { exportLocalGenomeBundle, GENOME_IMPORT_LIMITS, type GenomeImportResult, type LocalGenomeView,
  type PhageFull } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { prepareCatalogGenomeSnapshot, useLocalGenomes } from '../../db/local-genomes';
import type { PhageRepository } from '../../db';
import { useFileSystem } from '../../hooks/useFileSystem';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { ResearchWorkflowPanel, runResearchWorker } from './ResearchWorkflowPanel';
import { CodonReferencePanel } from './CodonReferencePanel';
import { SavedResearchPanel } from './SavedResearchPanel';

export function GenomeImportOverlay({ repository = null, onSelectPhage }: {
  repository?: PhageRepository | null;
  onSelectPhage?: (index: number) => Promise<void>;
}): React.ReactElement {
  const { close } = useOverlay();
  const { save } = useFileSystem();
  const genomes = useLocalGenomes(state => state.genomes);
  const add = useLocalGenomes(state => state.add);
  const phages = usePhageStore(state => state.phages);
  const currentPhage = usePhageStore(state => state.currentPhage);
  const loadingPhage = usePhageStore(state => state.isLoadingPhage);
  const [text, setText] = useState('');
  const [filePreview, setFilePreview] = useState(false);
  const [name, setName] = useState('pasted-genomes.txt');
  const [result, setResult] = useState<GenomeImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [importBusy, setBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const busy = importBusy || libraryBusy;
  const [allowCollisions, setAllowCollisions] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const savedImport = useRef<AbortController | null>(null);
  const repositoryRef = useRef(repository);
  repositoryRef.current = repository;
  const captureOwner = useRef<{ repository: PhageRepository; phage: PhageFull; controller: AbortController } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; workerRef.current?.terminate(); savedImport.current?.abort(); }, []);
  useEffect(() => {
    const owner = captureOwner.current;
    if (owner && (owner.repository !== repository || owner.phage !== currentPhage || loadingPhage)) {
      generation.current++;
      captureOwner.current = null;
      owner.controller.abort();
      if (savedImport.current === owner.controller) savedImport.current = null;
      setBusy(false); setResult(null);
      setStatus('The catalog selection changed. Capture was cancelled and no records were added.');
    }
  }, [repository, currentPhage, loadingPhage]);

  const cancel = () => {
    generation.current++;
    savedImport.current?.abort();
    captureOwner.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
    setStatus('Import cancelled. No records were added.');
    setResult(null);
  };
  const captureCatalog = async () => {
    const state = usePhageStore.getState(), selectedPhage = state.currentPhage;
    if (!repository || !selectedPhage || selectedPhage.localGenome || state.isLoadingPhage) {
      setError('Select a loaded catalog genome before capturing it.'); return;
    }
    workerRef.current?.terminate(); workerRef.current = null; savedImport.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    const owner = { repository, phage: selectedPhage, controller };
    captureOwner.current = owner; savedImport.current = controller;
    const selectedView = { viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition };
    setBusy(true); setError(null); setResult(null); setAllowCollisions(false);
    setStatus(`Capturing the complete sequence and displayed annotations for ${selectedPhage.name}…`);
    try {
      const parsed = await prepareCatalogGenomeSnapshot(repository, selectedPhage, {
        signal: controller.signal,
        isCurrent: () => {
          const active = usePhageStore.getState();
          return generation.current === current && repositoryRef.current === repository
            && active.currentPhage === selectedPhage && !active.isLoadingPhage;
        },
        parse: async (input, signal) => {
          const response = await runResearchWorker({ type: 'parse', input }, signal);
          if (response.type !== 'parsed') throw new Error('Expected parsed catalog snapshot.');
          return response.result;
        },
      });
      if (controller.signal.aborted || generation.current !== current) return;
      const genome = parsed.genomes[0];
      setResult({ ...parsed, view: { ...selectedView, contentId: genome.phage.localGenome!.contentId,
        scrollPosition: Math.min(Math.max(0, selectedView.scrollPosition), genome.sequence.length - 1) } });
      setText(genome.original.text); setName(genome.original.name); setFilePreview(genome.original.text.length > 2000);
      setStatus('Catalog snapshot prepared. Review it and allow the matching accession to keep a separate session copy.');
    } catch (cause) {
      if (generation.current === current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not capture the catalog genome.');
        setStatus('No records were added. The catalog and previous local inputs are unchanged.');
      }
    } finally {
      if (captureOwner.current === owner) captureOwner.current = null;
      if (savedImport.current === controller) savedImport.current = null;
      if (generation.current === current) setBusy(false);
    }
  };
  const parse = () => {
    setError(null);
    setResult(null);
    if (!text.trim()) { setError('Paste or choose a genome file first.'); return; }
    if (new TextEncoder().encode(text).length > GENOME_IMPORT_LIMITS.bytes) { setError('Input exceeds the 10 MiB limit.'); return; }
    workerRef.current?.terminate();
    const current = ++generation.current;
    let worker: Worker;
    try { worker = new Worker(new URL('../../workers/genome-import.worker.ts', import.meta.url), { type: 'module' }); }
    catch {
      workerRef.current = null;
      setBusy(false);
      setError('This browser could not start the local parser. No records were added.');
      return;
    }
    workerRef.current = worker;
    setBusy(true);
    setStatus('Parsing local records…');
    worker.onmessage = (event: MessageEvent) => {
      if (generation.current !== current) return;
      const message = event.data;
      if (message.type === 'progress') { setStatus(`Parsed ${message.completed} of ${message.total} records`); return; }
      setBusy(false);
      worker.terminate();
      workerRef.current = null;
      if (message.type === 'error') { setError(message.message); setStatus('No records were added.'); }
      else if (message.type === 'result') { setResult(message.result); setStatus('Review the records before adding them.'); }
    };
    worker.onerror = () => {
      if (generation.current !== current) return;
      worker.terminate();
      workerRef.current = null;
      setBusy(false);
      setError('The import worker failed. Your catalog is unchanged; retry with a smaller input.');
    };
    worker.postMessage({ name, text });
  };
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    cancel();
    setError(null);
    if (file.size > GENOME_IMPORT_LIMITS.bytes) { setError('Input exceeds the 10 MiB limit.'); return; }
    const current = ++generation.current;
    setBusy(true);
    setStatus('Reading local file…');
    try {
      const content = await file.text();
      if (generation.current !== current) return;
      setText(content); setFilePreview(content.length > 2000); setName(file.name); setStatus('File loaded locally. Select Parse records to continue.');
    } catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : 'Could not read the file.'); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const commit = () => {
    if (!result) return;
    try { add(result, allowCollisions, phages); close('genomeImport'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Import failed'); }
  };
  const captureBundle = () => {
    const state = usePhageStore.getState();
    const snapshot = useLocalGenomes.getState().genomes;
    if (!snapshot.length) throw new Error('No imported genomes are available to save.');
    const contentId = state.currentPhage?.localGenome?.contentId;
    const view: LocalGenomeView | undefined = contentId ? {
      contentId, viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition,
    } : undefined;
    return exportLocalGenomeBundle(snapshot, view);
  };
  const restoreBundle = async (content: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    workerRef.current?.terminate(); workerRef.current = null; savedImport.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    savedImport.current = controller;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    setBusy(true); setError(null); setResult(null); setStatus('Parsing saved local workspace…');
    try {
      const response = await runResearchWorker({ type: 'parse', input: { name: 'saved-local-genomes.json', text: content } }, controller.signal);
      if (controller.signal.aborted || generation.current !== current) throw new DOMException('Cancelled', 'AbortError');
      if (response.type !== 'parsed') throw new Error('Expected parsed saved genomes.');
      setText(content); setFilePreview(content.length > 2000); setName('saved-local-genomes.json');
      setAllowCollisions(false); setResult(response.result); setStatus('Saved workspace parsed. Review the records before adding them.');
    } finally {
      signal.removeEventListener('abort', abort);
      if (savedImport.current === controller) savedImport.current = null;
      if (generation.current === current) setBusy(false);
    }
  };
  const exportBundle = async () => {
    try {
      await save(new Blob([captureBundle()], { type: 'application/json' }), { suggestedName: 'phage-local-genomes.json' });
      setStatus('Exported original inputs and the selected local sequence view. Analysis results are exported from their own panels.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export failed'); }
  };

  return (
    <Overlay id="genomeImport" title="Local genomes" size="lg">
      <div style={{ display: 'grid', gap: 'var(--space-3)', minWidth: 0, overflowWrap: 'anywhere' }}>
        <p>Open your own DNA sequences in the sequence viewer, gene map, comparisons and sequence analyses. Input is session-only unless you explicitly save a local snapshot below. Export JSON for a separate backup; a share URL does not contain local sequences.</p>
        <SavedResearchPanel kind="genomes" suggestedName="Local genome workspace" disabled={importBusy}
          capture={genomes.length ? captureBundle : null} restore={restoreBundle} onActivityChange={setLibraryBusy} />
        <section aria-label="Capture a catalog genome for research">
          <h3>Use the catalog in a reproducible workflow</h3>
          <p>Capture the selected catalog genome's complete sequence and loaded annotations as a separate session copy.
            The snapshot travels with saved workflows and can be replayed without the catalog. It contains the catalog's annotation snapshot, not an original GenBank file; deposited structures and external references are not copied.</p>
          <button type="button" className="btn" disabled={busy || !repository || !currentPhage || !!currentPhage.localGenome || loadingPhage}
            onClick={() => void captureCatalog()}>Capture selected catalog genome</button>
          {currentPhage && !currentPhage.localGenome && <p>Selected: {currentPhage.name} · {currentPhage.accession}</p>}
          {currentPhage?.localGenome && <p>This selected record is already available in local research workflows. Select a catalog genome to capture another.</p>}
        </section>
        <p>FASTA, GenBank, a catalog snapshot or a local genome bundle; up to 10 MiB, 100 records and 5,000,000 bases. IUPAC ambiguity codes are retained. FASTA topology is unknown unless the header contains [topology=circular] or [topology=linear].</p>
        <label>Choose genome file <input aria-label="Choose genome file" type="file" accept=".fa,.fasta,.fna,.gb,.gbk,.genbank,.json,.txt" disabled={busy} onChange={event => void chooseFile(event.target.files?.[0])} /></label>
        {filePreview ? <>
          <p>{name}: preview of the first 2,000 characters. Parsing and export use the complete file.</p>
          <pre role="region" aria-label="Genome file preview" style={{ maxHeight: '10rem', overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{text.slice(0, 2000)}</pre>
          <button type="button" className="btn" disabled={busy} onClick={() => { setFilePreview(false); setText(''); setName('pasted-genomes.txt'); setResult(null); setError(null); setStatus('Paste genome data or choose another file.'); }}>Use pasted input instead</button>
        </> : <>
          <label htmlFor="local-genome-input">Paste genome data</label>
          <textarea id="local-genome-input" rows={7} value={text} disabled={busy} spellCheck={false} onChange={event => { setText(event.target.value); setName('pasted-genomes.txt'); setResult(null); setError(null); }} style={{ width: '100%', fontFamily: 'var(--font-mono)' }} />
        </>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={parse}>Parse records</button>
          {importBusy && <button type="button" className="btn" onClick={cancel}>Cancel import</button>}
          {genomes.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void exportBundle()}>Export local genome bundle</button>}
        </div>
        <p role="status">{status}</p>
        {error && <p role="alert">{error}</p>}
        {result && <>
          <h3>{result.genomes.length} local records ready</h3>
          <ul>{result.genomes.map(genome => <li key={genome.phage.id}>
            <strong>{genome.phage.name}</strong> — {genome.sequence.length.toLocaleString()} bases, {genome.phage.genes.length} mapped features, {genome.phage.localGenome?.topology}.
            {genome.phage.localGenome?.format === 'catalog-snapshot' && <p>Catalog snapshot: exact captured bases and loaded annotations. GenBank-only analyses require a separately supplied original GenBank record.</p>}
            {genome.warnings.length > 0 && <ul>{genome.warnings.slice(0, 20).map((warning, index) => <li key={index}>{warning}</li>)}{genome.warnings.length > 20 && <li>{genome.warnings.length - 20} additional annotation warnings; all original annotations remain in the export.</li>}</ul>}
          </li>)}</ul>
          <label><input type="checkbox" checked={allowCollisions} onChange={event => setAllowCollisions(event.target.checked)} /> Keep different records separately when accessions match. Existing records are never replaced.</label>
          <button type="button" className="btn btn-primary" onClick={commit}>Add records to explorer</button>
        </>}
        {genomes.length > 0 && <p>{genomes.length} local records in this session. Deposited structures, protein embeddings and pre-computed host-reference annotations are unavailable for imported records. Supply your own codon-count reference below for reference-relative CDS scoring.</p>}
        <CodonReferencePanel />
        <ResearchWorkflowPanel onSelectPhage={onSelectPhage} />
      </div>
    </Overlay>
  );
}
