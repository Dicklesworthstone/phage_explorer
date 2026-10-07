import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CODON_REFERENCE_LIMITS, parseCodonReference, buildCodonReferenceWeights, referenceGenomeFromPhage,
  serializeAnalysisRecord, resolveCodonCorpusOptions, exportCodonCorpusReference, type CodonReferenceCorpus,
  type CodonCorpusOptions, type ReferenceCodonExperiment, type ZeroCountReplacement } from '@phage-explorer/core';
import { useLocalGenomes } from '../../db/local-genomes';
import { runCodonReferenceTask } from '../../workers/codon-reference.worker';
import { downloadString } from '../../utils/export';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { SavedResearchPanel } from './SavedResearchPanel';

/** The existing local-genome workflow supplies query data; references are never uploaded. */
export function CodonReferencePanel(): React.ReactElement {
  const genomes = useLocalGenomes(state => state.genomes);
  const [selected, setSelected] = useState('');
  const [geneId, setGeneId] = useState('all');
  const [referenceText, setReferenceText] = useState('');
  const [zeroPolicy, setZeroPolicy] = useState<ZeroCountReplacement>(0.5);
  const [sourceId, setSourceId] = useState('');
  const [sourceGenes, setSourceGenes] = useState('');
  const [corpusName, setCorpusName] = useState('');
  const [organism, setOrganism] = useState('');
  const [citation, setCitation] = useState('');
  const [sourceVersion, setSourceVersion] = useState('');
  const [sourceCode, setSourceCode] = useState('');
  const [unavailable, setUnavailable] = useState<'reject' | 'exclude'>('reject');
  const [storedCorpus, setStoredCorpus] = useState<{ text: string; corpus: CodonReferenceCorpus } | null>(null);
  const sourceGenome = genomes.find(item => item.phage.localGenome?.contentId === sourceId && item.phage.localGenome.format === 'genbank') ?? null;
  const sourceReference = storedCorpus?.text === referenceText ? storedCorpus.corpus : null;
  const corpusDraft = useMemo(() => {
    if (!sourceGenome) return { options: null, error: 'Choose an imported GenBank reference genome.' };
    try {
      const text = sourceGenes.trim();
      if (text && !/^[1-9]\d*(,[1-9]\d*)*$/.test(text)) throw new Error('Reference CDS IDs must be comma-separated positive integers.');
      const options = resolveCodonCorpusOptions({ name: corpusName, organism, geneticCode: Number(sourceCode) as 1 | 11,
        citation, version: sourceVersion, unavailable,
        record: sourceId, geneIds: text ? text.split(',').map(Number) : null });
      return { options, error: null };
    } catch (cause) { return { options: null, error: cause instanceof Error ? cause.message : 'Invalid reference corpus settings.' }; }
  }, [sourceGenome, sourceId, sourceGenes, corpusName, organism, sourceCode, citation, sourceVersion, unavailable]);
  const [analysisBusy, setBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const busy = analysisBusy || libraryBusy;
  const [status, setStatus] = useState('Choose an imported annotated genome and supply your reference counts.');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const genome = genomes.find(item => item.phage.localGenome?.contentId === selected) ?? null;
  const input = useMemo(() => ({ genome, referenceText, geneId, zeroPolicy }), [genome, referenceText, geneId, zeroPolicy]);
  const [completed, setCompleted] = useState<{ input: typeof input; experiment: ReferenceCodonExperiment; verified: boolean } | null>(null);
  const result = completed?.input === input ? completed : null;
  const reference = useMemo(() => {
    if (!referenceText.trim()) return null;
    try {
      const value = sourceReference?.reference ?? parseCodonReference(referenceText);
      return { value, coverage: buildCodonReferenceWeights(value, zeroPolicy), error: null };
    } catch (cause) {
      return { value: null, coverage: null, error: cause instanceof Error ? cause.message : 'Invalid reference JSON.' };
    }
  }, [referenceText, zeroPolicy, sourceReference]);

  useEffect(() => {
    if (!genomes.some(item => item.phage.localGenome?.contentId === selected)) {
      setSelected(genomes[0]?.phage.localGenome?.contentId ?? ''); setGeneId('all');
    }
  }, [genomes, selected]);
  useEffect(() => {
    operation.current?.abort(); operation.current = null;
    setCompleted(null); setBusy(false); setError(null); setPage(0);
    setStatus('Inputs changed. Run analysis to calculate a new result.');
    return () => { operation.current?.abort(); operation.current = null; };
  }, [input]);

  const begin = () => {
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setCompleted(null); setError(null); setBusy(true); setPage(0);
    return controller;
  };
  const fail = (controller: AbortController, cause: unknown) => {
    if (operation.current !== controller || controller.signal.aborted) return;
    setError(cause instanceof Error ? cause.message : 'Reference analysis failed.');
    setStatus('No result was applied. Correct the input or retry.');
  };
  const end = (controller: AbortController) => {
    if (operation.current === controller) { operation.current = null; setBusy(false); }
  };
  const run = async () => {
    if (!genome) { setError('Import an annotated GenBank genome first.'); return; }
    const controller = begin(); setStatus('Extracting selected CDS and calculating reference-relative scores…');
    try {
      const experiment = await runCodonReferenceTask(
        () => new Worker(new URL('../../workers/codon-reference.worker.ts', import.meta.url), { type: 'module' }),
        { type: 'analyze', genome: referenceGenomeFromPhage(genome.phage), sequence: genome.sequence, referenceText,
          options: { geneIds: geneId === 'all' ? null : [Number(geneId)], zeroCountReplacement: zeroPolicy } }, controller.signal);
      if (operation.current !== controller || controller.signal.aborted) return;
      setCompleted({ input, experiment, verified: false }); setStatus('Reference-relative analysis complete. Export to preserve the exact inputs and scores.');
    } catch (cause) { fail(controller, cause); }
    finally { end(controller); }
  };
  const useCorpus = (corpus: CodonReferenceCorpus, text = serializeAnalysisRecord(corpus.record)) => {
    setStoredCorpus({ corpus, text }); setReferenceText(text);
  };
  const buildCorpus = async () => {
    if (!sourceGenome || !corpusDraft.options) { setError(corpusDraft.error); return; }
    // Capture the source and selection before the first async file/hash operation.
    const original = { ...sourceGenome.original }, options: CodonCorpusOptions = structuredClone(corpusDraft.options);
    const controller = begin(); setStatus('Reparsing reference CDS and counting the declared corpus…');
    try {
      const corpus = await runCodonReferenceTask(
        () => new Worker(new URL('../../workers/codon-reference.worker.ts', import.meta.url), { type: 'module' }),
        { type: 'build-reference', input: original, options }, controller.signal);
      if (operation.current !== controller || controller.signal.aborted) return;
      useCorpus(corpus);
    } catch (cause) { fail(controller, cause); }
    finally { end(controller); }
  };
  const exportCorpus = (countsOnly: boolean) => {
    if (!sourceReference) return;
    try {
      downloadString(countsOnly ? exportCodonCorpusReference(sourceReference) : serializeAnalysisRecord(sourceReference.record),
        countsOnly ? 'codon-reference-counts.json' : 'codon-reference-corpus.json', 'application/json');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reference corpus export failed.'); }
  };
  const load = async (file: File | undefined, kind: 'reference' | 'experiment') => {
    if (!file) return;
    const controller = begin(); setStatus(kind === 'reference' ? 'Reading reference locally…' : 'Recomputing saved experiment from its original inputs…');
    try {
      const maximum = 10 * 1024 * 1024;
      if (file.size > maximum) throw new Error('Reference input or experiment exceeds 10 MiB.');
      const content = await file.text();
      if (operation.current !== controller || controller.signal.aborted) return;
      if (kind === 'reference') {
        // Large references can only be source experiments; leave their parsing off-thread.
        const corpusInput = file.size > CODON_REFERENCE_LIMITS.bytes || content.length > CODON_REFERENCE_LIMITS.bytes
          || JSON.parse(content)?.format === 'phage-explorer-analysis';
        if (corpusInput) {
          const corpus = await runCodonReferenceTask(
            () => new Worker(new URL('../../workers/codon-reference.worker.ts', import.meta.url), { type: 'module' }),
            { type: 'verify-reference', content }, controller.signal);
          if (operation.current !== controller || controller.signal.aborted) return;
          useCorpus(corpus, content);
        } else { parseCodonReference(content); setStoredCorpus(null); setReferenceText(content); }
      }
      else {
        const experiment = await runCodonReferenceTask(
          () => new Worker(new URL('../../workers/codon-reference.worker.ts', import.meta.url), { type: 'module' }),
          { type: 'verify', content }, controller.signal);
        if (operation.current !== controller || controller.signal.aborted) return;
        setCompleted({ input, experiment, verified: true });
        setStatus('Saved experiment recomputed: inputs, parameters and numerical results match. This is not independent validation of the supplied reference.');
      }
    } catch (cause) { fail(controller, cause); }
    finally { end(controller); }
  };
  const cancel = () => {
    operation.current?.abort(); operation.current = null;
    setBusy(false); setCompleted(null); setStatus('Cancelled. No late result will replace the current input.');
  };
  const restoreLocal = async (content: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const controller = begin(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    setStatus('Recomputing the locally saved reference experiment…');
    try {
      const experiment = await runCodonReferenceTask(
        () => new Worker(new URL('../../workers/codon-reference.worker.ts', import.meta.url), { type: 'module' }),
        { type: 'verify', content }, controller.signal);
      if (operation.current !== controller || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      setCompleted({ input, experiment, verified: true });
      setStatus('Local experiment recomputed and verified against its saved inputs and scores.');
    } finally { signal.removeEventListener('abort', abort); end(controller); }
  };
  const exportResult = () => {
    if (!result) return;
    try { downloadString(serializeAnalysisRecord(result.experiment.record), 'codon-reference-experiment.json', 'application/json'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Export failed.'); }
  };
  const analysis = result?.experiment.analysis;
  const resultGenome = result?.experiment.record.inputs.find(item => item.id === 'annotations')?.data as { name?: string; accession?: string } | undefined;
  const rows = analysis?.genes.slice(page * 100, (page + 1) * 100) ?? [];

  return <section aria-label="Reference-backed codon adaptation" style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem', display: 'grid', gap: '.75rem' }}>
    <h3>Reference-backed codon adaptation</h3>
    <p>Analyze annotated CDS against your own codon-count reference, independently of the illustrative host models. Original inputs remain local. CAI measures relative codon usage—not expression, host range or infection probability.</p>
    <SavedResearchPanel kind="codon-reference" suggestedName={`${resultGenome?.name ?? 'Reference'} experiment`} disabled={analysisBusy}
      capture={result ? () => serializeAnalysisRecord(result.experiment.record) : null} restore={restoreLocal} onActivityChange={setLibraryBusy} />
    <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}><legend>Query and reference</legend>
      <label>Reference-analysis genome <select value={selected} onChange={event => { setSelected(event.target.value); setGeneId('all'); }}>
        {!genomes.length && <option value="">Import an annotated GenBank genome above</option>}
        {genomes.map(item => <option key={item.phage.id} value={item.phage.localGenome!.contentId}>{item.phage.name} · {item.phage.accession}</option>)}
      </select></label>
      <label>Reference-analysis CDS <select value={geneId} onChange={event => setGeneId(event.target.value)}>
        <option value="all">All annotated CDS</option>
        {genome?.phage.genes.filter(gene => !gene.type || gene.type === 'CDS').map(gene => <option key={gene.id} value={gene.id}>{gene.locusTag ?? gene.name ?? `CDS ${gene.id}`} · {gene.strand}</option>)}
      </select></label>
      {genome && !genome.phage.genes.some(gene => !gene.type || gene.type === 'CDS') && <p>No CDS annotations are available. FASTA alone cannot define coding frames; import annotated GenBank instead.</p>}
      <label>Codon reference JSON file <input type="file" accept=".json,application/json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void load(file, 'reference'); }} /></label>
      <p>Accepts count-only JSON or a complete source corpus experiment; sources are verified before use.</p>
      <label>Paste codon reference JSON <textarea rows={6} value={sourceReference ? '' : referenceText} readOnly={!!sourceReference} placeholder={sourceReference ? 'Source-backed reference loaded. Clear it below to paste count-only JSON.' : 'Codon-count JSON'} spellCheck={false} onChange={event => {
        if (new TextEncoder().encode(event.target.value).length > CODON_REFERENCE_LIMITS.bytes) { setError('Reference exceeds 128 KiB.'); return; }
        setReferenceText(event.target.value);
      }} style={{ width: '100%', fontFamily: 'var(--font-mono)' }} /></label>
      {sourceReference && <button type="button" onClick={() => { setReferenceText(''); setStoredCorpus(null); }}>Clear source-backed reference</button>}
      <details><summary>Reference format and count requirements</summary>
        <p>Use integer counts from your documented reference corpus, ideally a justified highly expressed gene set. A synonymous family needs every codon reported and at least one observation. Omitted counts mean unavailable, never zero. Counts below illustrate the schema only; they are not a biological reference.</p>
        <pre style={{ overflowX: 'auto' }}>{`{"format":"phage-explorer-codon-reference","version":1,
 "name":"Your reference set","organism":"Your organism","geneticCode":11,
 "source":{"citation":"Describe or cite the count corpus","version":"Your release"},
 "counts":{"AAA":8,"AAG":2}}`}</pre>
        <p>Supported genetic codes: 1 and 11. Joined/reverse-strand CDS and codon_start come from the annotations. Met, Trp and terminal stops are excluded. Unknown triplets, internal stops, unsupported recoding or partial codons leave the full gene score unavailable.</p>
      </details>
      <label>Reported zero counts <select value={zeroPolicy} onChange={event => setZeroPolicy(Number(event.target.value) as ZeroCountReplacement)}>
        <option value={0.5}>Replace reported zeros with 0.5 before normalization</option><option value={0}>Keep true zero weights (CAI may be zero)</option>
      </select></label>
      {reference?.error && <p role="alert">{reference.error}</p>}
      {reference?.value && <p>{reference.value.name} · {reference.value.organism} · {reference.value.source.version}. Covered synonymous families: {reference.coverage!.coveredFamilies.length}/18. Attribution: {reference.value.source.citation}</p>}
      <button type="button" className="btn btn-primary" disabled={!genome || !reference?.value} onClick={() => void run()}>Analyze against reference</button>
    </fieldset>
    <details><summary>Build reference counts from imported GenBank</summary>
      <p>Select a justified reference CDS set and supply its attribution. The program counts sequences; it does not discover highly expressed genes or certify the source organism.</p>
      <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}><legend>Reference corpus sources and policy</legend>
        <label>Corpus source genome <select value={sourceId} onChange={event => { setSourceId(event.target.value); setSourceGenes(''); }}>
          <option value="">Choose imported GenBank</option>
          {genomes.filter(g => g.phage.localGenome?.format === 'genbank').map(g => <option key={g.phage.localGenome!.contentId} value={g.phage.localGenome!.contentId}>{g.phage.name} · {g.phage.accession} · {g.phage.localGenome!.contentId.slice(0, 12)}</option>)}
        </select></label>
        <label>Corpus name <input value={corpusName} onChange={event => setCorpusName(event.target.value)} maxLength={300} /></label>
        <label>Corpus organism (your assertion) <input value={organism} onChange={event => setOrganism(event.target.value)} maxLength={300} /></label>
        <label>Corpus citation and selection rationale <textarea rows={2} value={citation} onChange={event => setCitation(event.target.value)} maxLength={2000} /></label>
        <label>Corpus source version <input value={sourceVersion} onChange={event => setSourceVersion(event.target.value)} maxLength={200} /></label>
        <label>Corpus genetic code <select value={sourceCode} onChange={event => setSourceCode(event.target.value)}>
          <option value="">Choose the declared reference code</option><option value="1">1 — Standard</option><option value="11">11 — Bacterial, archaeal and plastid</option>
        </select></label>
        <label>Corpus CDS IDs (blank selects all mapped CDS) <input value={sourceGenes} onChange={event => setSourceGenes(event.target.value)} placeholder="1,2,7" maxLength={120000} /></label>
        {sourceGenome && <details><summary>Mapped reference CDS identifiers</summary><p>{sourceGenome.phage.genes.filter(g => g.type === 'CDS').map(g => `${g.id}: ${g.locusTag ?? g.name ?? 'CDS'}`).join('; ') || 'No mapped CDS'}</p></details>}
        <label>Unsupported reference CDS <select value={unavailable} onChange={event => setUnavailable(event.target.value as 'reject' | 'exclude')}>
          <option value="reject">Reject the corpus (default)</option><option value="exclude">Explicitly exclude and audit unsupported CDS</option>
        </select></label>
        {sourceGenome && corpusDraft.error && <p>{corpusDraft.error}</p>}
        <button type="button" disabled={!corpusDraft.options} onClick={() => void buildCorpus()}>Build and use source-backed reference</button>
      </fieldset>
    </details>
    {sourceReference && <section aria-label="Accepted reference corpus audit">
      <h4>Loaded source-backed reference for the next analysis: {sourceReference.reference.name}</h4>
      <p>Counted CDS: {sourceReference.summary.countedCds}/{sourceReference.summary.selectedMappedCds} selected mapped CDS; explicitly excluded: {sourceReference.summary.excludedMappedCds}; unmappable CDS in source: {sourceReference.summary.unmappedCds}. Counted triplets: {sourceReference.summary.codons.toLocaleString()}.</p>
      <p>All 64 codons are reported. Zeros mean absent from accepted transcripts, not absent from the organism. Source input and exclusions will be recounted inside the query experiment during replay.</p>
      <details><summary>Source identities and excluded CDS (first 100)</summary>
        {sourceReference.sources.map(source => <p key={source.contentId}>{source.accession} · {source.contentId}. {source.warnings.slice(0, 10).join(' ')}</p>)}
        {sourceReference.genes.filter(g => g.status === 'excluded').slice(0, 100).map(g => <p key={`${g.contentId}:${g.geneId}`}>{sourceReference.sources.find(s => s.contentId === g.contentId)?.accession ?? g.contentId} CDS {g.geneId}: {g.reasons.join(' ')}</p>)}
      </details>
      <button type="button" onClick={() => exportCorpus(false)}>Export source corpus experiment</button>{' '}
      <button type="button" onClick={() => exportCorpus(true)}>Export count-only reference JSON</button>
      <p>Count-only JSON cannot replay its source derivation. The corpus experiment retains private original inputs and the complete CDS audit.</p>
    </section>}
    <label>Reopen and verify reference experiment <input type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void load(file, 'experiment'); }} /></label>
    {analysisBusy && <button type="button" className="btn" onClick={cancel}>Cancel reference analysis</button>}
    <p role="status" aria-live="polite">{status}</p>
    {error && <p role="alert">{error}</p>}
    {analysis && result && <>
      <h4>{result.verified ? 'Verified saved experiment' : 'Reference analysis'}: {resultGenome?.name} · {resultGenome?.accession}</h4>
      <p>Reference: {analysis.reference.name} · {analysis.reference.organism} · {analysis.reference.source.version}. {analysis.reference.source.citation}</p>
      <p>Pooled CAI: <strong>{analysis.summary.cai === null ? 'Unavailable' : analysis.summary.cai.toFixed(6)}</strong>. Fully scored CDS: {analysis.summary.scoredGenes}/{analysis.summary.totalGenes}; eligible codons in those CDS: {analysis.summary.scoredCodons.toLocaleString()}. The pooled value is a codon-weighted geometric mean over fully scorable CDS only.</p>
      <p>Reported-zero replacement: {analysis.zeroCountReplacement}; reference family coverage: {analysis.referenceCoverage.coveredFamilies.length}/18. Missing families: {analysis.referenceCoverage.missingFamilies.join(', ') || 'none'}.</p>
      <div style={{ overflowX: 'auto', maxHeight: '24rem' }}><table style={{ width: '100%', textAlign: 'left', fontSize: '.8rem' }}>
        <caption>Reference-relative scores and reasons for unavailable CDS (100 rows per page)</caption>
        <thead><tr><th scope="col">CDS</th><th scope="col">CAI</th><th scope="col">Covered / eligible codons</th><th scope="col">Status</th></tr></thead>
        <tbody>{rows.map(gene => <tr key={gene.geneId}><td>{gene.label} ({gene.strand})</td><td>{gene.cai === null ? 'Unavailable' : gene.cai.toFixed(6)}</td><td>{gene.scoredCodons}/{gene.eligibleCodons}</td><td>{gene.reasons.join(' ') || 'Scored'}{Object.keys(gene.missingReferenceCodons).length > 0 && ` Missing reference: ${Object.keys(gene.missingReferenceCodons).join(', ')}.`}</td></tr>)}</tbody>
      </table></div>
      <div><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous CDS page</button>{' '}
        <span>Page {page + 1} of {Math.max(1, Math.ceil(analysis.genes.length / 100))}</span>{' '}
        <button type="button" disabled={(page + 1) * 100 >= analysis.genes.length} onClick={() => setPage(value => value + 1)}>Next CDS page</button></div>
      <button type="button" className="btn" onClick={exportResult}>Export reference experiment</button>
      <p>The export contains private genome bases, annotations and your reference JSON. Reopening recomputes results; checksums do not certify the reference's biological validity.</p>
      <AnalysisRecordDetails record={result.experiment.record} />
    </>}
  </section>;
}
