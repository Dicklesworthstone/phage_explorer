import React, { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { GeneInfo } from '@phage-explorer/core';
import {
  selectedCdsLocation,
  type SelectedCdsExportKind, type SelectedCdsResult, type SelectedCdsSource,
} from '@phage-explorer/core';
import { SelectedCdsSession } from '../hooks/SelectedCdsSession';
import { copyToClipboard, downloadString } from '../utils/export';

function SequencePreview({ sequence, label, unit }: { sequence: string; label: string; unit: string }): React.ReactElement {
  const limit = 600;
  const shown = sequence.slice(0, limit);
  return <div>
    <p className="text-dim">{label}: {sequence.length.toLocaleString()} {unit}
      {sequence.length > limit ? ` · first ${limit} shown; copy and export include the complete sequence` : ''}</p>
    <pre aria-label={label} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '12rem', overflowY: 'auto', fontSize: '0.8rem' }}>
      {shown.match(/.{1,60}/g)?.join('\n') || 'No bases remain after codon_start.'}
    </pre>
  </div>;
}

export function SelectedCdsDetails({ result, onExport }: {
  result: SelectedCdsResult;
  onExport: (kind: SelectedCdsExportKind, copy: boolean) => void;
}): React.ReactElement {
  const proteinAvailable = result.protein !== null && result.translationReasons.length === 0;
  const partial = result.cds !== null && result.cds.length % 3 !== 0;
  return <div data-testid="selected-cds-result" data-result-id={result.resultId}>
    <p className="text-dim">{result.source.name} · {result.source.accession} · {result.source.kind === 'local' ? 'Private local genome' : 'Catalog genome'}</p>
    <dl className="selected-gene-inspector__facts">
      <div><dt>Translation table</dt><dd>{result.geneticCode || 'Unsupported'}{result.gene.qualifiers?.transl_table === undefined ? ' (default 1)' : ' (annotation)'}</dd></div>
      <div><dt>codon_start</dt><dd>{result.codonStart || 'Unsupported'}</dd></div>
      <div><dt>Coding frame</dt><dd>{result.cds === null ? 'Unavailable' : partial ? `Incomplete: ${result.cds.length % 3} trailing base(s)` : 'Complete codons'}</dd></div>
      <div><dt>Translation</dt><dd>{proteinAvailable ? 'Available from annotation' : 'Unavailable'}</dd></div>
    </dl>
    {result.segments.length > 0 && <p style={{ overflowWrap: 'anywhere' }}>
      <strong>CDS parts, 5′ → 3′:</strong> {selectedCdsLocation(result)}
      <span className="text-dim"> · 1-based inclusive genome coordinates, after codon_start</span>
    </p>}
    {result.translationReasons.length > 0 && <div role="note">
      <p><strong>Translation unavailable</strong>{result.cds !== null ? '; the exact annotated DNA remains available.' : '.'}</p>
      <ul>{result.translationReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    {result.cds !== null && <SequencePreview sequence={result.cds} label="Annotated CDS DNA (5′ to 3′)" unit="bp" />}
    {proteinAvailable && <>
      <SequencePreview sequence={result.protein!} label="Translated protein" unit="symbols" />
      <p className="text-dim">{result.protein!.endsWith('*') ? 'The terminal * marks a stop codon and is retained in the export. ' : ''}
        Translation follows the annotation and selected genetic code; expression and protein function are not measured.</p>
    </>}
    <div className="selected-gene-inspector__action-grid">
      <button type="button" disabled={result.cds === null} onClick={() => onExport('cds', true)}>Copy CDS FASTA</button>
      <button type="button" disabled={result.cds === null} onClick={() => onExport('cds', false)}>Export CDS FASTA</button>
      <button type="button" disabled={!proteinAvailable} onClick={() => onExport('protein', true)}>Copy protein FASTA</button>
      <button type="button" disabled={!proteinAvailable} onClick={() => onExport('protein', false)}>Export protein FASTA</button>
      <button type="button" onClick={() => onExport('json', false)}>Export CDS record (JSON)</button>
    </div>
    <details style={{ marginTop: '0.5rem', overflowWrap: 'anywhere' }}>
      <summary>Source and export identity</summary>
      <p>Genome SHA-256: <code>{result.source.genomeSha256}</code></p>
      <p>Result SHA-256: <code>{result.resultId}</code></p>
      {result.source.localContentId && <p>Local input: <code>{result.source.localContentId}</code></p>}
      <p>The JSON record includes the original feature qualifiers, exact CDS parts, sequences, translation limitations and source fingerprints. The original genome is required to recheck its coordinates.</p>
    </details>
  </div>;
}

export function SelectedCdsInspector({ source, gene }: { source: SelectedCdsSource | null; gene: GeneInfo }): React.ReactElement {
  const [session] = useState(() => new SelectedCdsSession());
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [feedback, setFeedback] = useState<{ resultId: string; message: string } | null>(null);
  useLayoutEffect(() => {
    if (source) void session.select(source, gene);
    else session.clear();
    return () => session.clear();
  }, [gene, session, source]);
  // Render-time ownership prevents an old export being exposed before effects
  // retire work when a genome or same-ID annotation is replaced.
  const owned = snapshot.source === source && snapshot.gene === gene;
  const result = owned ? snapshot.result : null;
  const performExport = async (kind: SelectedCdsExportKind, copy: boolean) => {
    if (!source || !result) return;
    const payload = session.export(kind, source, gene);
    if (!payload) return;
    try {
      if (copy) await copyToClipboard(payload.content);
      else downloadString(payload.content, payload.filename, payload.mimeType);
      if (session.getSnapshot().result === result) setFeedback({ resultId: result.resultId, message: copy ? 'Complete FASTA copied.' : `Exported ${payload.filename}` });
    } catch (cause) {
      if (session.getSnapshot().result === result) setFeedback({ resultId: result.resultId, message: cause instanceof Error ? cause.message : 'Could not export this sequence.' });
    }
  };
  return <section className="selected-gene-inspector__section" aria-label="Selected CDS sequence and protein">
    <h4>CDS sequence and protein</h4>
    {!source ? <p>The complete genome selection is unavailable.</p>
      : result ? <SelectedCdsDetails result={result} onExport={(kind, copy) => void performExport(kind, copy)} />
        : owned && snapshot.error ? <div role="alert">
          <p>{snapshot.error}</p>
          <button type="button" onClick={() => void session.select(source, gene)}>Retry CDS inspection</button>
        </div> : <p role="status">Preparing the exact selected CDS…</p>}
    <p role="status" aria-live="polite">{result && feedback?.resultId === result.resultId ? feedback.message : ''}</p>
  </section>;
}
