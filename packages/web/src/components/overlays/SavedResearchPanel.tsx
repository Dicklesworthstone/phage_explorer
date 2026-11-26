import React, { useCallback, useEffect, useRef, useState } from 'react';
import { researchStorage, requestResearchPersistence, RESEARCH_SNAPSHOT_TYPES, RESEARCH_COLLECTION_MAX_BYTES, type ResearchCollectionPreview, type ResearchSnapshotInfo, type ResearchSnapshotKind, type ResearchSnapshotProblem } from '../../db/research-storage';
import { downloadString } from '../../utils/export';
import { readLocalTextFile } from '../../utils/fileSystem';

interface SavedResearchPanelProps {
  kind: ResearchSnapshotKind;
  suggestedName: string;
  capture: (() => string) | null;
  restore: (content: string, signal: AbortSignal) => Promise<void>;
  disabled?: boolean;
  onActivityChange?: (active: boolean) => void;
}

function snapshotKindCounts(entries: readonly ResearchSnapshotInfo[]): Array<{ kind: ResearchSnapshotKind; title: string; count: number }> {
  return (Object.keys(RESEARCH_SNAPSHOT_TYPES) as ResearchSnapshotKind[]).map(kind => ({
    kind, title: RESEARCH_SNAPSHOT_TYPES[kind].title, count: entries.filter(entry => entry.kind === kind).length,
  })).filter(row => row.count > 0);
}

/** Saving is explicit and append-only. Reopening delegates to the existing parser/replay boundary. */
export function SavedResearchPanel({ kind, suggestedName, capture, restore, disabled = false, onActivityChange }: SavedResearchPanelProps): React.ReactElement {
  const [entries, setEntries] = useState<ResearchSnapshotInfo[]>([]);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionEntries, setCollectionEntries] = useState<ResearchSnapshotInfo[]>([]);
  const [collectionFile, setCollectionFile] = useState<File | null>(null);
  const [collectionPreview, setCollectionPreview] = useState<ResearchCollectionPreview | null>(null);
  const [problems, setProblems] = useState<ResearchSnapshotProblem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmProblem, setConfirmProblem] = useState<ResearchSnapshotProblem | null>(null);
  const operation = useRef<AbortController | null>(null);
  const listing = useRef<AbortController | null>(null);
  const activity = useRef(onActivityChange);
  activity.current = onActivityChange;
  const selected = entries.find(entry => entry.id === selectedId);
  const refresh = useCallback(() => {
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
    void researchStorage.inspect(undefined, controller.signal).then(({ entries: rows, problems: damaged }) => {
      if (controller.signal.aborted) return;
      const matching = rows.filter(row => row.kind === kind);
      setEntries(matching); setCollectionEntries(rows);
      setSelectedId(id => matching.some(row => row.id === id) ? id : '');
      setProblems(damaged); setConfirmProblem(null);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not list saved research.'); });
  }, [kind]);
  useEffect(() => {
    refresh(); const unsubscribe = researchStorage.subscribe(refresh);
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe(); window.removeEventListener('focus', refresh); listing.current?.abort();
      operation.current?.abort(); operation.current = null; activity.current?.(false);
    };
  }, [refresh]);
  const perform = (task: (signal: AbortSignal) => Promise<string>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    activity.current?.(true);
    setBusy(true); setError(null); setStatus('Working locally…');
    void task(controller.signal).then(message => {
      if (!controller.signal.aborted) setStatus(message);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        if (cause instanceof Error && cause.name === 'AbortError') { setStatus('Local operation cancelled.'); return; }
        setError(cause instanceof Error ? `${cause.message} Export JSON as a separate backup.` : 'Local operation failed. Export JSON instead.');
        setStatus('The operation did not finish. Existing saved snapshots were not replaced.');
      }
    }).finally(() => {
      if (operation.current === controller) { operation.current = null; activity.current?.(false); setBusy(false); refresh(); }
    });
  };
  const locked = disabled || busy;
  const title = RESEARCH_SNAPSHOT_TYPES[kind].title;
  return <details aria-label={`Saved ${title}`} style={{ border: '1px solid var(--color-border)', padding: '.75rem', minWidth: 0 }}>
    <summary>Saved {title} on this device</summary>
    <p>Save snapshot and Import collection write private inputs to this browser profile. Snapshots survive reloads but are not encrypted or synced.
      Closing a panel does not save it. Browser data clearing or eviction can remove them; export JSON for a separate backup.</p>
    <label>Snapshot name <input value={name} placeholder={suggestedName.slice(0, 120)} maxLength={120} disabled={locked}
      onChange={event => setName(event.target.value)} /></label>{' '}
    <button type="button" className="btn" disabled={locked || !capture || problems.length > 0} onClick={() => perform(async signal => {
      if (!capture) throw new Error('No completed input or result is available to save.');
      const content = capture(); // Capture before any asynchronous storage work.
      const saved = await researchStorage.save(kind, name || suggestedName.slice(0, 120), content, signal);
      if (!signal.aborted) setSelectedId(saved.id);
      return 'Saved an immutable local snapshot. Later edits are not included; saving again creates another snapshot.';
    })}>Save snapshot locally</button>
    <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
      <label>Saved snapshot <select aria-label="Saved snapshot" value={selectedId} disabled={locked} onChange={event => { setSelectedId(event.target.value); setConfirmId(null); }}>
        <option value="">Choose a saved snapshot</option>
        {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {new Date(entry.createdAt).toLocaleString()} · {Math.ceil(entry.bytes / 1024)} KiB</option>)}
      </select></label>
      <button type="button" className="btn" disabled={locked} onClick={() => { setError(null); refresh(); }}>Refresh saved list</button>
      <button type="button" className="btn" disabled={locked || !selected} onClick={() => perform(async signal => {
        const saved = await researchStorage.read(selectedId, kind, signal);
        await restore(saved.content, signal);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        return kind === 'genomes' ? 'Saved genomes parsed. Review and explicitly add them to the explorer.'
          : kind === 'workflow' ? 'Saved workflow loaded for review. No recorded commands were run.'
          : kind === 'views' ? 'Named views loaded. Restore a view to verify its original genome and annotations.'
          : 'Saved experiment recomputed and verified by its analysis pipeline.';
      })}>Open saved snapshot</button>
      <button type="button" className="btn" disabled={locked || !selected} onClick={() => perform(async signal => {
        const saved = await researchStorage.read(selectedId, kind, signal);
        const filename = saved.name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'research-snapshot';
        downloadString(saved.content, `${filename}.json`, 'application/json');
        return 'Exported the exact saved JSON. Storage integrity was checked; export alone does not rerun an analysis.';
      })}>Export saved JSON</button>
      <button type="button" className="btn" disabled={locked || !selected} onClick={() => setConfirmId(selectedId)}>Remove saved snapshot</button>
    </div>
    {confirmId && selected?.id === confirmId && <div role="group" aria-label="Confirm saved snapshot removal">
      <p>Remove “{selected.name}” from this browser? Export first to keep a backup. Current explorer inputs and other snapshots are not removed.</p>
      <button type="button" disabled={locked} onClick={() => perform(async signal => {
        await researchStorage.remove(confirmId, kind, signal); setConfirmId(null);
        return 'Removed the selected local snapshot only. Current inputs and other snapshots are unchanged.';
      })}>Confirm removal</button>{' '}
      <button type="button" disabled={locked} onClick={() => setConfirmId(null)}>Keep snapshot</button>
    </div>}

    <section aria-label="Portable saved research collection" style={{ marginTop: '.75rem' }}>
      <button type="button" className="btn" aria-expanded={collectionOpen} disabled={locked} onClick={() => setCollectionOpen(value => !value)}>Back up or transfer all saved research</button>
      {collectionOpen && <>
      <p>A collection includes every saved panel kind, its names and dates, and the exact original JSON, including any embedded sources and results.
        Import appends immutable snapshots after review. It preserves existing snapshots and never runs analyses or changes the explorer selection.</p>
      <p>Saved in this browser: {collectionEntries.length} snapshots · {Math.ceil(collectionEntries.reduce((sum, entry) => sum + entry.bytes, 0) / 1024)} KiB.</p>
      {collectionEntries.length > 0 && <ul aria-label="Saved collection kinds">
        {snapshotKindCounts(collectionEntries).map(row => <li key={row.kind}>{row.title}: {row.count}</li>)}
      </ul>}
      <button type="button" className="btn" disabled={locked || !collectionEntries.length || problems.length > 0} onClick={() => perform(async signal => {
        const content = await researchStorage.exportCollection(signal);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        downloadString(content, 'phage-explorer-research-collection.json', 'application/json');
        return 'Exported all saved snapshots captured together, including their exact original JSON and metadata. Every stored body checksum was checked.';
      })}>Export all saved research</button>
      <p><label>Choose research collection JSON <input type="file" accept=".json,application/json" disabled={locked} onChange={event => {
        setCollectionFile(event.target.files?.[0] ?? null); setCollectionPreview(null); setError(null);
        setStatus('Choose Review collection file to validate the complete file. Nothing has been imported.');
      }} /></label></p>
      {collectionFile && <p>Selected collection: {collectionFile.name}</p>}
      <button type="button" className="btn" disabled={locked || !collectionFile || problems.length > 0} onClick={() => perform(async signal => {
        if (!collectionFile) throw new Error('Choose a research collection JSON file.');
        setCollectionPreview(null);
        const content = await readLocalTextFile(collectionFile, RESEARCH_COLLECTION_MAX_BYTES, signal);
        const preview = await researchStorage.previewCollection(content, signal);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        setCollectionPreview(preview);
        return 'Collection checked. Review every snapshot below before importing. Hashes verify metadata and saved bytes, not source authenticity or scientific results.';
      })}>Review collection file</button>
      {collectionPreview && <section aria-label="Research collection import review">
        <h4>Review all {collectionPreview.entries.length} snapshots</h4>
        <p>{collectionPreview.additions} new · {collectionPreview.duplicates} exact duplicates already saved.
          {' '}Original contents: {Math.ceil(collectionPreview.totalBytes / 1024)} KiB.
          {' '}After import: {collectionPreview.projectedSnapshots} snapshots · {Math.ceil(collectionPreview.projectedBytes / 1024)} KiB.</p>
        <ul aria-label="Incoming collection kinds">
          {snapshotKindCounts(collectionPreview.entries).map(row => <li key={row.kind}>{row.title}: {row.count}</li>)}
        </ul>
        <div style={{ maxHeight: '24rem', overflow: 'auto' }}>
          <table>
            <caption>Every snapshot in the collection</caption>
            <thead><tr><th scope="col">Snapshot</th><th scope="col">Research kind</th><th scope="col">Saved date</th><th scope="col">Contents</th><th scope="col">Import action</th></tr></thead>
            <tbody>{collectionPreview.entries.map(entry => <tr key={entry.id}>
              <td>{entry.name}<br /><small>Snapshot ID: <code>{entry.id}</code></small></td>
              <td>{RESEARCH_SNAPSHOT_TYPES[entry.kind].title}</td>
              <td>{new Date(entry.createdAt).toLocaleString()}</td>
              <td>{Math.ceil(entry.bytes / 1024)} KiB</td>
              <td>{entry.disposition === 'new' ? 'Add snapshot' : 'Keep identical snapshot'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p style={{ overflowWrap: 'anywhere' }}>Collection checksum: <code>{collectionPreview.manifestSha256}</code></p>
        <p>Integrity checks cover this file’s metadata and exact saved bytes. They do not authenticate source claims or recompute scientific results.
          Open imported snapshots in their original research panels to parse or freshly verify them.</p>
        <button type="button" className="btn" disabled={locked} onClick={() => perform(async signal => {
          const reviewed = collectionPreview;
          try {
            const imported = await researchStorage.importCollection(reviewed, signal);
            setCollectionPreview(null);
            return 'Imported ' + imported.added + ' snapshots; ' + imported.duplicates + ' identical snapshots were already saved. '
              + 'Existing snapshots were preserved. Open snapshots in their research panels for parsing or fresh scientific verification.';
          } catch (cause) {
            if (!signal.aborted) setCollectionPreview(null);
            throw cause;
          }
        })}>Import reviewed collection</button>{' '}
        <button type="button" className="btn" disabled={locked} onClick={() => { setCollectionPreview(null); setStatus('Collection review dismissed. Nothing was imported.'); }}>Dismiss collection review</button>
      </section>}
      <p>Collections are checked in full before any write. A conflicting ID, unsupported kind, damaged entry, changed saved library or exceeded quota aborts the entire import.
        Different snapshot IDs remain separate, including matching content saved under different names. Maximum collection file: 129 MiB.</p>
      </>}
    </section>

    {problems.length > 0 && <section aria-label="Saved library recovery">
      <h4>Saved records needing attention ({problems.length})</h4>
      <p>These records may belong to any research panel. Intact snapshots remain available above.
        New saves are paused while their storage usage cannot be safely accounted for.</p>
      <ul>
        {problems.map((problem, index) => <li key={index}>
          <p>{problem.name ? `“${problem.name}”: ` : ''}{problem.reason}.
            {' '}Storage key: <code style={{ overflowWrap: 'anywhere' }}>{problem.keyLabel}</code></p>
          {problem.removable
            ? <button type="button" className="btn" disabled={locked} onClick={() => { setConfirmProblem(problem); setConfirmId(null); }}>Remove damaged record</button>
            : <p>This record uses a snapshot kind or version this explorer does not support. Reopen it in the explorer version that saved it. The record has been preserved.</p>}
        </li>)}
      </ul>
      {confirmProblem && <div role="group" aria-label="Confirm damaged record removal">
        <p>Permanently remove the record at storage key <code style={{ overflowWrap: 'anywhere' }}>{confirmProblem.keyLabel}</code>?
          This deletes its metadata and any remaining contents. Keep any exported backup before confirming.
          Current explorer inputs and other saved records are unchanged.</p>
        <button type="button" disabled={locked} onClick={() => perform(async signal => {
          await researchStorage.removeDamaged(confirmProblem.key, signal); setConfirmProblem(null);
          return 'Removed the selected damaged record. Other saved snapshots and current inputs are unchanged.';
        })}>Confirm damaged record removal</button>{' '}
        <button type="button" disabled={locked} onClick={() => setConfirmProblem(null)}>Keep damaged record</button>
      </div>}
    </section>}
    {busy && <button type="button" className="btn" onClick={() => {
      operation.current?.abort(); setStatus('Cancellation requested. A save already committed may remain in the saved list.');
    }}>Cancel local operation</button>}
    <p role="status" aria-live="polite">{status}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn" disabled={locked} onClick={() => perform(async () => await requestResearchPersistence()
      ? 'Browser persistence granted for this site. Explicit browser data clearing still removes local snapshots; keep exported backups.'
      : 'Browser persistence was not granted. Ordinary local saving may still work, but keep exported JSON backups.')}>Ask browser to retain local data</button>
    <p>Up to 64 snapshots / 64 MiB total, 10 MiB each. Nothing is automatically deleted to make room.</p>
  </details>;
}
