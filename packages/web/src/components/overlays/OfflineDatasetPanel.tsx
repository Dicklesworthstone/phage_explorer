/** Explicit, version-bound offline files; never persists private imported genomes. */
import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { OfflineDatasetSession, type OfflineDatasetAccess } from '../../db/offline-dataset';
import type { ArtifactAvailability } from '../../db/progressive-artifacts';

export interface OfflineDatasetPanelProps { access: OfflineDatasetAccess; onBusyChange?: (busy: boolean) => void }
const PAGE_SIZE = 25;
const bytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 * 1024
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(2)} MiB`;
const statusLabel = (status?: ArtifactAvailability): string => status === 'available' ? 'Verified cached file'
  : status === 'corrupt' ? 'Corrupt cached file' : status === 'missing' ? 'Not cached'
  : status === 'unavailable' ? 'Storage unavailable' : 'Not checked';

export function OfflineDatasetPanel({ access, onBusyChange }: OfflineDatasetPanelProps): React.ReactElement {
  const id = useId();
  const session = useMemo(() => new OfflineDatasetSession(access), [access]);
  const info = useMemo(() => access.describe(), [access]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [query, setQuery] = useState(''), [page, setPage] = useState(0);
  useEffect(() => { session.activate(); void session.restore(); return session.deactivate; }, [session]);
  useEffect(() => { onBusyChange?.(state.busy !== null); return () => onBusyChange?.(false); }, [onBusyChange, state.busy]);
  const { plan, report, progress, saved } = state;
  const selected = useMemo(() => new Set(plan.selection.genomeIds), [plan]);
  const selectedModels = useMemo(() => new Set(plan.selection.atlasModels), [plan]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return info.genomes.filter(genome => !needle || `${genome.name} ${genome.accession}`.toLowerCase().includes(needle));
  }, [info, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const genomeStates = new Map(report?.genomes.map(item => [item.id, item.status]));
  const atlasStates = new Map(report?.atlases.map(item => [item.model, item.status]));
  const chooseGenome = (genomeId: number, checked: boolean) => session.select({ ...plan.selection,
    genomeIds: checked ? [...plan.selection.genomeIds, genomeId] : plan.selection.genomeIds.filter(value => value !== genomeId) });
  const chooseAtlas = (model: string, checked: boolean) => session.select({ ...plan.selection,
    atlasModels: checked ? [...plan.selection.atlasModels, model] : plan.selection.atlasModels.filter(value => value !== model) });
  const buttons: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '.5rem' };
  const cell: React.CSSProperties = { padding: '.5rem', textAlign: 'left', overflowWrap: 'anywhere', borderBottom: '1px solid var(--color-border)' };

  return <section aria-labelledby={`${id}-title`} style={{ display: 'grid', gap: '.75rem', minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3 id={`${id}-title`}>Offline genome selection</h3>
    <p>Choose curated genomes to take offline. Each selected genome includes its deposited sequences and bundled annotations/models.
      Global atlas projections are separate. Checking or editing a selection does not download data.</p>
    <p>Private imports are not included or uploaded. External structures, reference services, and the application shell are not verified by this data check.
      Install/open the app online and test a disconnected reload before relying on it offline.</p>
    <p>Dataset <code data-testid="offline-dataset-version">{info.contentVersion}</code> · {info.genomes.length} curated genomes.</p>
    <p data-testid="offline-byte-plan">{selected.size} genomes and {selectedModels.size} global atlases selected: {bytes(plan.totalBytes)} across {plan.artifactCount} files,
      including {bytes(info.catalogBytes)} for the catalog. Cache budget: {bytes(info.cacheBudget)}.</p>
    {!plan.withinBudget && <p role="alert">Selection exceeds the cache byte budget. Choose fewer genomes or atlas models; no downloads have started.</p>}
    <label htmlFor={`${id}-filter`}>Filter curated genomes by name or accession</label>
    <input id={`${id}-filter`} className="input" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
    <div style={buttons}>
      <button type="button" className="btn" onClick={() => session.select({ ...plan.selection, genomeIds: info.genomes.map(genome => genome.id) })}>Select all catalog genomes</button>
      <button type="button" className="btn" onClick={() => session.select({ genomeIds: [], atlasModels: [] })}>Clear selection</button>
    </div>
    <div style={{ overflowX: 'auto' }}><table aria-label="Curated genome offline choices" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th scope="col" style={cell}>Genome</th><th scope="col" style={cell}>File bytes</th><th scope="col" style={cell}>Last check of this selection</th></tr></thead>
      <tbody>{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(genome => <tr key={genome.id} data-genome-id={genome.id}>
        <th scope="row" style={cell}><label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minHeight: 44 }}>
          <input type="checkbox" checked={selected.has(genome.id)} onChange={event => chooseGenome(genome.id, event.target.checked)} />
          <span>{genome.name} · {genome.accession}</span>
        </label></th><td style={cell}>{bytes(genome.bytes)}</td><td style={cell}>{statusLabel(genomeStates.get(genome.id))}</td>
      </tr>)}</tbody>
    </table></div>
    {!filtered.length && <p>No curated genomes match this filter. Selected genomes outside the filter are unchanged.</p>}
    <div style={buttons}>
      <button type="button" className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous genomes</button>
      <span>Page {currentPage + 1} of {pages} · {filtered.length} matching genomes</span>
      <button type="button" className="btn" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next genomes</button>
    </div>
    {info.atlases.length > 0 && <details><summary>Optional global atlas projections</summary>
      <p>Whole projection pages are included for each selected model; this does not download every genome's SQLite data.</p>
      {info.atlases.map(atlas => <label key={atlas.model} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minHeight: 44 }}>
        <input type="checkbox" checked={selectedModels.has(atlas.model)} onChange={event => chooseAtlas(atlas.model, event.target.checked)} />
        <span>{atlas.model} · {atlas.count} points · {bytes(atlas.bytes)} · {statusLabel(atlasStates.get(atlas.model))}</span>
      </label>)}
    </details>}
    <div style={buttons}>
      <button type="button" className="btn" disabled={!!state.busy || !plan.withinBudget} onClick={() => { void session.check(); }}>Check saved files</button>
      <button type="button" className="btn" disabled={!!state.busy || !plan.withinBudget} onClick={() => { void session.prepare(); }}>Prepare / resume selection</button>
      <button type="button" className="btn" disabled={!!state.busy} onClick={() => { void session.restore(); }}>Load saved selection</button>
      <button type="button" className="btn" disabled={!state.busy} onClick={session.cancel}>Cancel offline work</button>
      <button type="button" className="btn" disabled={!!state.busy} onClick={() => { void session.release(); }}>Release offline reservation</button>
    </div>
    <p>Preparing replaces this dataset address's previous reservation, reuses verified files, and repairs missing/corrupt files.
      Releasing removes eviction protection, not file bytes. Other saved datasets can consume budget too.</p>
    <p role="status" data-testid="offline-job-status">{state.busy === 'restoring' ? 'Reading saved selection; no download.'
      : state.busy === 'checking' ? 'Checking stored files and startup manifest; no download.'
      : state.busy === 'releasing' ? 'Releasing eviction protection; cached files remain.'
      : state.busy === 'preparing' ? progress?.phase === 'verifying' ? 'Verifying saved bytes and startup manifest…' : 'Preparing selected offline files…'
      : state.notice}</p>
    {progress && <div>
      <progress aria-label="Selected offline files processed" value={progress.completedBytes} max={progress.totalBytes} style={{ width: '100%' }} />
      <p>{bytes(progress.completedBytes)} / {bytes(progress.totalBytes)} processed ({progress.completed}/{progress.total} files).
        This includes cache reuse; it is not a network-transfer counter. Completion requires verification.</p>
    </div>}
    {state.error && <p role="alert">{state.error}</p>}
    {saved !== undefined && <p data-testid="offline-saved-selection">{saved ?
      `Saved reservation: ${bytes(saved.totalBytes)} for dataset ${saved.contentVersion}. ${saved.selection ? 'Compatible with this catalog.' : 'Different generation or incomplete groups; not mapped to current IDs.'}`
      : 'No saved offline reservation.'}</p>}
    {report && <div data-testid="offline-verification" data-ready={String(report.ready)}>
      <p><strong>{report.ready ? 'Selected dataset files verified' : 'Selected dataset incomplete'}</strong> · Checked {report.checkedAt}.</p>
      <p>Catalog: {statusLabel(report.catalog)}. Startup manifest for this version: {report.startupManifestAvailable ? 'verified' : 'not available'}.
        {` ${bytes(report.verifiedBytes)} / ${bytes(report.totalBytes)} verified.`}</p>
    </div>}
    <p>Verification describes storage at the check time. Browsers can evict data, and another tab can replace the reservation.
      Closing this manager, closing Settings, or editing the selection cancels its current job; partial files remain resumable.</p>
  </section>;
}
