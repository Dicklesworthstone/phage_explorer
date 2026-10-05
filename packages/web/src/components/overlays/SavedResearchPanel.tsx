import React, { useCallback, useEffect, useRef, useState } from 'react';
import { researchStorage, requestResearchPersistence, type ResearchSnapshotInfo, type ResearchSnapshotKind } from '../../db/research-storage';
import { downloadString } from '../../utils/export';

interface SavedResearchPanelProps {
  kind: ResearchSnapshotKind;
  suggestedName: string;
  capture: (() => string) | null;
  restore: (content: string, signal: AbortSignal) => Promise<void>;
  disabled?: boolean;
  onActivityChange?: (active: boolean) => void;
}
const titles: Record<ResearchSnapshotKind, string> = {
  genomes: 'local genome workspaces', workflow: 'command workflows',
  'codon-reference': 'reference experiments', pangenome: 'pangenome experiments',
};
/** Saving is explicit and append-only. Reopening delegates to the existing parser/replay boundary. */
export function SavedResearchPanel({ kind, suggestedName, capture, restore, disabled = false, onActivityChange }: SavedResearchPanelProps): React.ReactElement {
  const [entries, setEntries] = useState<ResearchSnapshotInfo[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const listing = useRef<AbortController | null>(null);
  const activity = useRef(onActivityChange);
  activity.current = onActivityChange;
  const selected = entries.find(entry => entry.id === selectedId);
  const refresh = useCallback(() => {
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
    void researchStorage.list(kind, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      setEntries(rows); setSelectedId(id => rows.some(row => row.id === id) ? id : '');
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
  return <details aria-label={`Saved ${titles[kind]}`} style={{ border: '1px solid var(--color-border)', padding: '.75rem', minWidth: 0 }}>
    <summary>Saved {titles[kind]} on this device</summary>
    <p>Only Save writes private inputs to this browser profile. Snapshots survive reloads but are not encrypted or synced.
      Closing a panel does not save it. Browser data clearing or eviction can remove them; export JSON for a separate backup.</p>
    <label>Snapshot name <input value={name} placeholder={suggestedName.slice(0, 120)} maxLength={120} disabled={locked}
      onChange={event => setName(event.target.value)} /></label>{' '}
    <button type="button" className="btn" disabled={locked || !capture} onClick={() => perform(async signal => {
      if (!capture) throw new Error('No completed input or result is available to save.');
      const content = capture(); // Capture before any asynchronous storage work.
      const saved = await researchStorage.save(kind, name || suggestedName.slice(0, 120), content, signal);
      if (!signal.aborted) setSelectedId(saved.id);
      return 'Saved an immutable local snapshot. Later edits are not included; saving again creates another snapshot.';
    })}>Save snapshot locally</button>
    <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
      <label>Saved snapshot <select value={selectedId} disabled={locked} onChange={event => { setSelectedId(event.target.value); setConfirmId(null); }}>
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
