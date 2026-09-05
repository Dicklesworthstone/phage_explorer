import React, { useEffect, useRef, useState } from 'react';
import { exportLocalGenomeBundle, GENOME_IMPORT_LIMITS, type GenomeImportResult, type LocalGenomeView } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { useLocalGenomes } from '../../db/local-genomes';
import { useFileSystem } from '../../hooks/useFileSystem';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

export function GenomeImportOverlay(): React.ReactElement {
  const { close } = useOverlay();
  const { save } = useFileSystem();
  const genomes = useLocalGenomes(state => state.genomes);
  const add = useLocalGenomes(state => state.add);
  const phages = usePhageStore(state => state.phages);
  const [text, setText] = useState('');
  const [name, setName] = useState('pasted-genomes.txt');
  const [result, setResult] = useState<GenomeImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowCollisions, setAllowCollisions] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; workerRef.current?.terminate(); }, []);

  const cancel = () => {
    generation.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
    setStatus('Import cancelled. No records were added.');
    setResult(null);
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
      setText(content); setName(file.name); setStatus('File loaded locally. Select Parse records to continue.');
    } catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : 'Could not read the file.'); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const commit = () => {
    if (!result) return;
    try { add(result, allowCollisions, phages); close('genomeImport'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Import failed'); }
  };
  const exportBundle = async () => {
    const state = usePhageStore.getState();
    const contentId = state.currentPhage?.localGenome?.contentId;
    const view: LocalGenomeView | undefined = contentId ? {
      contentId, viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition,
    } : undefined;
    try {
      await save(new Blob([exportLocalGenomeBundle(genomes, view)], { type: 'application/json' }), { suggestedName: 'phage-local-genomes.json' });
      setStatus('Exported original inputs and the selected local sequence view. Analysis results are exported from their own panels.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export failed'); }
  };

  return (
    <Overlay id="genomeImport" title="Local genomes" size="lg">
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p>Open your own DNA sequences in the sequence viewer, gene map, comparisons and sequence analyses. Input stays in this browser session. Export a bundle before reloading; a share URL does not contain local sequences.</p>
        <p>FASTA, GenBank or a local genome bundle; up to 10 MiB, 100 records and 5,000,000 bases. IUPAC ambiguity codes are retained. FASTA topology is unknown unless the header contains [topology=circular] or [topology=linear].</p>
        <label>Choose genome file <input aria-label="Choose genome file" type="file" accept=".fa,.fasta,.fna,.gb,.gbk,.genbank,.json,.txt" disabled={busy} onChange={event => void chooseFile(event.target.files?.[0])} /></label>
        <label htmlFor="local-genome-input">Paste genome data</label>
        <textarea id="local-genome-input" rows={7} value={text} disabled={busy} spellCheck={false} onChange={event => { setText(event.target.value); setName('pasted-genomes.txt'); setResult(null); setError(null); }} style={{ width: '100%', fontFamily: 'var(--font-mono)' }} />
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={parse}>Parse records</button>
          {busy && <button type="button" className="btn" onClick={cancel}>Cancel import</button>}
          {genomes.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void exportBundle()}>Export local genome bundle</button>}
        </div>
        <p role="status">{status}</p>
        {error && <p role="alert">{error}</p>}
        {result && <>
          <h3>{result.genomes.length} local records ready</h3>
          <ul>{result.genomes.map(genome => <li key={genome.phage.id}>
            <strong>{genome.phage.name}</strong> — {genome.sequence.length.toLocaleString()} bases, {genome.phage.genes.length} mapped features, {genome.phage.localGenome?.topology}.
            {genome.warnings.length > 0 && <ul>{genome.warnings.slice(0, 20).map((warning, index) => <li key={index}>{warning}</li>)}{genome.warnings.length > 20 && <li>{genome.warnings.length - 20} additional annotation warnings; all original annotations remain in the export.</li>}</ul>}
          </li>)}</ul>
          <label><input type="checkbox" checked={allowCollisions} onChange={event => setAllowCollisions(event.target.checked)} /> Keep different records separately when accessions match. Existing records are never replaced.</label>
          <button type="button" className="btn btn-primary" onClick={commit}>Add records to explorer</button>
        </>}
        {genomes.length > 0 && <p>{genomes.length} local records in this session. Deposited structures, protein embeddings and host-reference annotations are unavailable for imported records unless supplied by a future reference workflow.</p>}
      </div>
    </Overlay>
  );
}
