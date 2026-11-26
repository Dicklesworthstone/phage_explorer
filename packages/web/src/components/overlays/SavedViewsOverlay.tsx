import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SAVED_VIEW_LIMITS, type SavedView } from '../../../../core/src/saved-views';
import { type BrowserNavigationSession, readSavedViewsFile } from '../../hooks/BrowserNavigationSession';
import { downloadString } from '../../utils/export';
import { Overlay } from './Overlay';
import { SavedResearchPanel } from './SavedResearchPanel';

function describe(view: SavedView): string {
  return view.source.name + ' · ' + view.view.viewMode.toUpperCase() + ' ' + (view.view.scrollPosition + 1).toLocaleString()
    + (view.view.viewMode === 'aa' ? ' aa' : ' bp') + ' · frame ' + view.view.readingFrame
    + (view.view.geneId === null ? '' : ' · gene ' + view.view.geneId);
}

export function SavedViewsOverlay({ session }: { session: BrowserNavigationSession }): React.ReactElement {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [name, setName] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [historyTarget, setHistoryTarget] = useState<SavedView | null>(null);
  const [rename, setRename] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const reading = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const selected = state.saved.find(view => view.name === selectedName);
  const current = state.history[state.historyIndex];
  const targetIndex = historyTarget ? state.history.indexOf(historyTarget) : -1;
  const busy = state.busy || fileBusy || libraryBusy;
  useEffect(() => () => { reading.current?.abort(); reading.current = null; session.cancel(); }, [session]);
  useEffect(() => {
    if (selectedName && !state.saved.some(view => view.name === selectedName)) setSelectedName('');
  }, [selectedName, state.saved]);
  const importFile = async (file: File) => {
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    setFileBusy(true); setFileError(null);
    const timer = setTimeout(() => controller.abort(), SAVED_VIEW_LIMITS.timeoutMs);
    try {
      const content = await readSavedViewsFile(file, controller.signal);
      if (controller.signal.aborted) return;
      session.import(content);
    } catch (cause) {
      if (reading.current === controller) setFileError(controller.signal.aborted
        ? 'File import cancelled or timed out. The named views were not replaced.'
        : cause instanceof Error ? cause.message : 'Could not open the saved views.');
    } finally {
      clearTimeout(timer);
      if (reading.current === controller) { reading.current = null; setFileBusy(false); }
    }
  };
  return <Overlay id="savedViews" title="Saved views and navigation history" size="lg">
    <div style={{ display: 'grid', gap: '1rem', minWidth: 0 }}>
      <p>Return to a genome, position, reading frame and selected gene. Named views verify the complete original
        sequence and annotations before restoring. They do not contain genome bases; keep local input files or workspace bundles.</p>
      <section aria-label="Explorer navigation history">
        <h3>Navigation history</h3>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy || state.historyIndex < 1} onClick={() => void session.moveHistory(-1)}>Back through history</button>
          <button className="btn" disabled={busy || state.historyIndex >= state.history.length - 1} onClick={() => void session.moveHistory(1)}>Forward through history</button>
          {state.busy && <button className="btn" onClick={() => session.cancel()}>Cancel view restoration</button>}
        </div>
        {state.history.length > 1 && <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <label style={{ minWidth: 0, maxWidth: '100%' }}>History position <select style={{ maxWidth: '100%' }} value={targetIndex < 0 ? '' : targetIndex} disabled={busy}
            onChange={event => setHistoryTarget(event.target.value === '' ? null : state.history[Number(event.target.value)] ?? null)}>
            <option value="">Choose a position</option>
            {state.history.map((entry, index) => <option key={index} value={index}>
              {index + 1}. {describe(entry)}{index === state.historyIndex ? ' (current)' : ''}
            </option>)}
          </select></label>
          <button className="btn" disabled={busy || targetIndex < 0 || targetIndex === state.historyIndex}
            onClick={() => { if (historyTarget) void session.restoreHistory(historyTarget); }}>Go to history position</button>
        </div>}
        <p>{current ? describe(current) : 'Load a complete genome to start navigation history.'}</p>
        <p>{state.history.length ? state.historyIndex + 1 : 0} of {state.history.length} positions in this tab. Continuous scrolling is grouped; up to 64 positions are retained.</p>
      </section>
      <section aria-label="Named explorer views">
        <h3>Named views</h3>
        <form onSubmit={event => {
          event.preventDefault();
          if (session.saveCurrent(name.trim())) { setSelectedName(name.trim()); setName(''); }
        }}>
          <label>View name <input value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>{' '}
          <button className="btn" type="submit" disabled={busy || !state.ready || !name.trim()}>Save current view</button>
        </form>
        <p>Names and history are kept in this tab until you export JSON or explicitly save a device snapshot below.</p>
        <label>Named view <select value={selectedName} disabled={busy} onChange={event => {
          setSelectedName(event.target.value); setRename('');
        }}>
          <option value="">Choose a named view</option>
          {state.saved.map(view => <option key={view.name} value={view.name}>{view.name}</option>)}
        </select></label>
        {selected && <p>{describe(selected)} · {selected.source.kind === 'local' ? 'Original local input required' : 'Catalog source verified on restore'}</p>}
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.5rem' }}>
          <button className="btn" disabled={busy || !selected} onClick={() => void session.restoreNamed(selectedName)}>Restore named view</button>
          <button className="btn" disabled={busy || !selected} onClick={() => session.forget(selectedName)}>Forget view from tab</button>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          if (session.rename(selectedName, rename.trim())) { setSelectedName(rename.trim()); setRename(''); }
        }} style={{ marginTop: '.5rem' }}>
          <label>New view name <input value={rename} maxLength={120} disabled={busy || !selected} onChange={event => setRename(event.target.value)} /></label>{' '}
          <button className="btn" type="submit" disabled={busy || !selected || !rename.trim()}>Rename view</button>
        </form>
      </section>
      <section aria-label="Portable saved views">
        <h3>Keep or reopen views</h3>
        <p>Browser and terminal use the same version 1 JSON collection. Import merges distinct names; an existing name with a different view must be renamed first.</p>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy || !state.saved.length} onClick={() => downloadString(session.export(), 'phage-explorer-saved-views.json', 'application/json')}>Export named views JSON</button>
          <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>Import named views JSON</button>
          <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Saved views JSON file" style={{ display: 'none' }} disabled={busy}
            onChange={event => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (file) void importFile(file);
            }} />
          {fileBusy && <button className="btn" onClick={() => reading.current?.abort()}>Cancel views file import</button>}
        </div>
        <p>Up to 64 named views and 1 MiB per collection. Reopening views does not load local genome inputs automatically.</p>
      </section>
      <SavedResearchPanel kind="views" suggestedName="Explorer named views" capture={state.saved.length ? session.export : null}
        disabled={state.busy || fileBusy} onActivityChange={setLibraryBusy}
        restore={async (content, signal) => {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          session.import(content);
        }} />
      {state.notice && <p role="status" aria-live="polite">{state.notice}</p>}
      {(fileError || state.error) && <p role="alert">{fileError || state.error}</p>}
    </div>
  </Overlay>;
}
