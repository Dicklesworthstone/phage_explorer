/** Opt-in private research snapshots. No network, catalog writes, automatic restore or eviction.
 * Metadata and original export text commit together. Consumers still parse/recompute on open.
 * Transaction completion, not request success, is the durability boundary (IndexedDB 3.0).
 */
export type ResearchSnapshotKind = 'genomes' | 'workflow' | 'codon-reference' | 'pangenome';
export interface ResearchSnapshotInfo {
  id: string;
  version: 1;
  kind: ResearchSnapshotKind;
  name: string;
  createdAt: number;
  bytes: number;
  sha256: string;
}
export interface ResearchSnapshot extends ResearchSnapshotInfo { content: string }
export const RESEARCH_STORAGE_LIMITS = { snapshotBytes: 10 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, snapshots: 64 } as const;
export const RESEARCH_STORAGE_NAME = 'phage-explorer-private-research';
const kinds: readonly ResearchSnapshotKind[] = ['genomes', 'workflow', 'codon-reference', 'pangenome'];
const stores = ['metadata', 'contents'];
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function cancelled(): DOMException { return new DOMException('Local research operation cancelled.', 'AbortError'); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }
function validId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid saved research identifier.');
}
export function researchSnapshotName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('Use a snapshot name of 1–120 characters without control characters.');
  }
  return value.trim();
}
/** This is format routing, NOT genomic/method verification. Opening uses the original importer. */
export function validateResearchSnapshotContent(kind: ResearchSnapshotKind, content: string): number {
  if (!kinds.includes(kind) || typeof content !== 'string' || content.length > RESEARCH_STORAGE_LIMITS.snapshotBytes) {
    throw new Error('Unsupported snapshot kind or snapshot larger than 10 MiB.');
  }
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > RESEARCH_STORAGE_LIMITS.snapshotBytes) throw new Error('Snapshot exceeds 10 MiB. Export a smaller experiment.');
  const value: unknown = JSON.parse(content);
  if (!object(value) || value.version !== 1) throw new Error('Unsupported saved research format/version.');
  const matches = kind === 'genomes' ? value.format === 'phage-explorer-local-genomes'
    : kind === 'workflow' ? value.format === 'phage-explorer-commands'
    : value.format === 'phage-explorer-analysis' && object(value.method)
      && value.method.id === (kind === 'pangenome' ? 'alignment-pangenome' : 'reference-codon-adaptation');
  if (!matches) throw new Error('Snapshot content does not match this research panel.');
  return bytes;
}
function metadata(value: unknown): ResearchSnapshotInfo {
  if (!object(value)) throw new Error('Saved research metadata is damaged. Export your other snapshots before clearing browser data.');
  validId(value.id);
  if (value.version !== 1 || !kinds.includes(value.kind as ResearchSnapshotKind) || typeof value.name !== 'string'
      || researchSnapshotName(value.name) !== value.name || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > RESEARCH_STORAGE_LIMITS.snapshotBytes
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Saved research metadata is invalid.');
  return { id: value.id, version: 1, kind: value.kind as ResearchSnapshotKind, name: value.name,
    createdAt: Number(value.createdAt), bytes: Number(value.bytes), sha256: value.sha256 };
}
async function digest(kind: ResearchSnapshotKind, content: string): Promise<string> {
  // Bind the routing kind as well as every byte of the existing export format.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}\n${content}`));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class ResearchStorage {
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  constructor(private readonly name = RESEARCH_STORAGE_NAME) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.channel && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(this.name);
        this.channel.onmessage = event => { if (event.data === 'changed') this.notify(); };
      } catch { /* The Refresh button and focus event remain available. */ }
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.channel?.close(); this.channel = null; } };
  };
  private notify(): void {
    for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot undo a committed save. */ } }
  }
  private changed(): void {
    this.notify();
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      const channel = this.channel ?? new BroadcastChannel(this.name);
      channel.postMessage('changed'); // Invalidation only: no names, checksums or private input.
      if (channel !== this.channel) channel.close();
    } catch { /* Storage succeeded even if cross-tab notifications are unsupported. */ }
  }
  private open(signal?: AbortSignal): Promise<IDBDatabase> {
    check(signal);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('Local research storage is unavailable. Export JSON to preserve your work.')); return; }
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open(this.name, 1); } catch (cause) { reject(cause); return; }
      let settled = false;
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); reject(cause);
      };
      const abort = () => { fail(cancelled()); try { request.transaction?.abort(); } catch { /* Already finished. */ } };
      signal?.addEventListener('abort', abort, { once: true });
      request.onblocked = () => fail(new Error('Local research storage is blocked by another tab. Close older explorer tabs and retry; no snapshots were replaced.'));
      request.onerror = () => fail(request.error ?? new Error('Could not open local research storage. Export JSON instead.'));
      request.onupgradeneeded = () => {
        if (settled || signal?.aborted) { request.transaction?.abort(); return; }
        for (const store of stores) request.result.createObjectStore(store, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (settled || signal?.aborted) { db.close(); fail(cancelled()); return; }
        settled = true; signal?.removeEventListener('abort', abort); resolve(db);
      };
      if (signal?.aborted) abort();
    });
  }
  /** Queue all IDB work synchronously from callbacks; never await hashing in a live transaction. */
  private async transaction<T>(mode: IDBTransactionMode,
    enqueue: (tx: IDBTransaction, result: (value: T) => void, fail: (cause: unknown) => void) => void,
    signal?: AbortSignal): Promise<T> {
    const db = await this.open(signal);
    try {
      check(signal);
      return await new Promise<T>((resolve, reject) => {
        // A strict durability hint is not a backup or protection against browser data clearing.
        const tx = db.transaction(stores, mode, { durability: 'strict' });
        let result: T, hasResult = false, failure: unknown;
        const fail = (cause: unknown) => {
          failure = cause;
          try { tx.abort(); } catch { /* A committed transaction still reports its actual outcome. */ }
        };
        const abort = () => fail(cancelled());
        signal?.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => {
          signal?.removeEventListener('abort', abort);
          if (!hasResult) reject(new Error('Local research transaction completed without a result.'));
          else resolve(result);
        };
        tx.onabort = () => {
          signal?.removeEventListener('abort', abort);
          reject(failure ?? tx.error ?? new Error('Local research transaction aborted; previous snapshots are unchanged.'));
        };
        // Let request failures abort the transaction; never convert quota errors into a saved result.
        tx.onerror = () => { if (!failure) failure = tx.error; };
        try {
          check(signal);
          enqueue(tx, value => { result = value; hasResult = true; }, fail);
        } catch (cause) { fail(cause); }
      });
    } finally { db.close(); }
  }
  async list(kind?: ResearchSnapshotKind, signal?: AbortSignal): Promise<ResearchSnapshotInfo[]> {
    if (kind !== undefined && !kinds.includes(kind)) throw new Error('Unsupported snapshot kind.');
    return this.transaction('readonly', (tx, result, fail) => {
      const request = tx.objectStore('metadata').getAll();
      request.onsuccess = () => {
        try {
          const rows = request.result.map(metadata);
          result(rows.filter(row => kind === undefined || row.kind === kind).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)));
        } catch (cause) { fail(cause); }
      };
    }, signal);
  }
  async save(kind: ResearchSnapshotKind, name: string, content: string, signal?: AbortSignal): Promise<ResearchSnapshotInfo> {
    check(signal);
    const cleanName = researchSnapshotName(name), bytes = validateResearchSnapshotContent(kind, content);
    const sha256 = await digest(kind, content);
    check(signal);
    const entry: ResearchSnapshotInfo = { id: crypto.randomUUID(), version: 1, kind, name: cleanName, createdAt: Date.now(), bytes, sha256 };
    // Every save is immutable and has its own ID. Concurrent tabs cannot overwrite a saved revision.
    const saved = await this.transaction<ResearchSnapshotInfo>('readwrite', (tx, result, fail) => {
      const index = tx.objectStore('metadata'), payloads = tx.objectStore('contents');
      const request = index.getAll();
      request.onsuccess = () => {
        try {
          const rows = request.result.map(metadata);
          if (rows.length >= RESEARCH_STORAGE_LIMITS.snapshots || rows.reduce((sum, row) => sum + row.bytes, 0) + bytes > RESEARCH_STORAGE_LIMITS.totalBytes) {
            throw new Error('Local research library is full (64 snapshots / 64 MiB). Export and explicitly remove old snapshots; nothing was evicted.');
          }
          index.add(entry);
          payloads.add({ id: entry.id, content });
          result(entry);
        } catch (cause) { fail(cause); }
      };
    }, signal);
    this.changed();
    return saved;
  }
  async read(id: string, expectedKind: ResearchSnapshotKind, signal?: AbortSignal): Promise<ResearchSnapshot> {
    validId(id); check(signal);
    const stored = await this.transaction<{ info: unknown; body: unknown }>('readonly', (tx, result) => {
      const info = tx.objectStore('metadata').get(id), body = tx.objectStore('contents').get(id);
      let complete = 0;
      const ready = () => { if (++complete === 2) result({ info: info.result, body: body.result }); };
      info.onsuccess = ready; body.onsuccess = ready;
    }, signal);
    check(signal);
    if (!stored.info || !stored.body) throw new Error('Saved snapshot is missing or incomplete. Refresh the list; no current input was replaced.');
    const info = metadata(stored.info);
    if (info.kind !== expectedKind || !object(stored.body) || stored.body.id !== info.id || typeof stored.body.content !== 'string') {
      throw new Error('Saved snapshot belongs to another panel or its contents are damaged.');
    }
    const content = stored.body.content;
    if (validateResearchSnapshotContent(info.kind, content) !== info.bytes || await digest(info.kind, content) !== info.sha256) {
      throw new Error('Saved snapshot checksum mismatch. It was not opened; recover from an exported JSON file.');
    }
    check(signal);
    return { ...info, content };
  }
  /** Explicit per-snapshot removal only. Callers must confirm the selected immutable ID. */
  async remove(id: string, expectedKind: ResearchSnapshotKind, signal?: AbortSignal): Promise<void> {
    validId(id);
    await this.transaction<void>('readwrite', (tx, result, fail) => {
      const index = tx.objectStore('metadata'), request = index.get(id);
      request.onsuccess = () => {
        try {
          if (request.result !== undefined && metadata(request.result).kind !== expectedKind) throw new Error('Refusing to remove a snapshot from another panel.');
          index.delete(id); tx.objectStore('contents').delete(id); result(undefined);
        } catch (cause) { fail(cause); }
      };
    }, signal);
    this.changed();
  }
}
export const researchStorage = new ResearchStorage();

/** Call only from an explicit user gesture. Refusal does not prevent ordinary saves. */
export async function requestResearchPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
