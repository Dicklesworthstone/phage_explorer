/** Opt-in private research snapshots. No network, catalog writes, automatic restore or eviction.
 * Metadata and original export text commit together. Consumers still parse/recompute on open.
 * Transaction completion, not request success, is the durability boundary (IndexedDB 3.0).
 */
/** Routing and display names share one registry. A method match only chooses a
 * panel; its existing replay producer must still recompute and verify on open.
 */
export const RESEARCH_SNAPSHOT_TYPES = {
  genomes: { title: 'local genome workspaces', format: 'phage-explorer-local-genomes', methods: [] },
  workflow: { title: 'command workflows', format: 'phage-explorer-commands', methods: [] },
  views: { title: 'named explorer views', format: 'phage-explorer-saved-views', methods: [] },
  'codon-reference': { title: 'reference experiments', format: 'phage-explorer-analysis', methods: ['reference-codon-adaptation'] },
  pangenome: { title: 'pangenome experiments', format: 'phage-explorer-analysis', methods: ['alignment-pangenome'] },
  synteny: { title: 'synteny experiments', format: 'phage-explorer-analysis', methods: ['annotation-order-synteny'] },
  compatibility: { title: 'aligned-site compatibility experiments', format: 'phage-explorer-analysis', methods: ['aligned-dna-site-compatibility'] },
  'region-comparison': { title: 'genomic region comparisons', format: 'phage-explorer-analysis', methods: ['genome-region-comparison'] },
  comparison: { title: 'genome comparison experiments', format: 'phage-explorer-analysis', methods: ['genome-comparison'] },
  phylogeny: { title: 'phylogeny experiments', format: 'phage-explorer-analysis', methods: ['aligned-dna-neighbor-joining', 'explicit-outgroup-rooted-nj'] },
  temporal: { title: 'temporal diagnostic experiments', format: 'phage-explorer-analysis', methods: ['fixed-root-temporal-signal', 'rooted-nj-temporal-signal'] },
  'strict-clock': { title: 'strict-clock experiments', format: 'phage-explorer-analysis', methods: ['fixed-root-strict-clock-dating', 'rooted-nj-strict-clock-dating'] },
  ancestral: { title: 'ancestral experiments', format: 'phage-explorer-analysis', methods: ['ancestral-jc69', 'ancestral-reversible-dna', 'rooted-nj-ancestral'] },
  abundance: { title: 'abundance experiments', format: 'phage-explorer-analysis', methods: ['abundance-clr-nmf'] },
  environmental: { title: 'environmental experiments', format: 'phage-explorer-analysis', methods: ['local-environmental-evidence'] },
  epistasis: { title: 'measured epistasis experiments', format: 'phage-explorer-analysis', methods: ['measured-epistasis-assay'] },
  'plaque-growth': { title: 'plaque-count growth experiments', format: 'phage-explorer-analysis', methods: ['plaque-count-growth'] },
  'pfu-growth': { title: 'corrected PFU growth experiments', format: 'phage-explorer-analysis', methods: ['extracellular-pfu-growth'] },
  inactivation: { title: 'measured inactivation experiments', format: 'phage-explorer-analysis', methods: ['plaque-count-inactivation'] },
  'host-metabolism': { title: 'host-model experiments', format: 'phage-explorer-analysis', methods: ['sourced-host-flux', 'host-gene-knockout'] },
  attachment: { title: 'attachment experiments', format: 'phage-explorer-analysis', methods: ['attachment-reconstruction', 'prophage-excision-reconstruction'] },
} as const;
export type ResearchSnapshotKind = keyof typeof RESEARCH_SNAPSHOT_TYPES;
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
export interface ResearchSnapshotProblem {
  /** The actual IndexedDB primary key, never an ID taken from damaged metadata. */
  key: IDBValidKey;
  keyLabel: string;
  name: string | null;
  removable: boolean;
  reason: 'Invalid snapshot metadata' | 'Saved contents are missing' | 'Saved contents have no metadata' | 'Unsupported snapshot format';
}
export interface ResearchSnapshotInventory {
  entries: ResearchSnapshotInfo[];
  /** Global problems also matter to panels of another kind: quotas are shared. */
  problems: ResearchSnapshotProblem[];
}
export const RESEARCH_STORAGE_LIMITS = { snapshotBytes: 10 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, snapshots: 64 } as const;

export const RESEARCH_COLLECTION_FORMAT = 'phage-explorer-research-collection' as const;
/** JSON escaping can double the 64 MiB of original saved text, plus metadata. */
export const RESEARCH_COLLECTION_MAX_BYTES = 129 * 1024 * 1024;
export interface ResearchCollection {
  format: typeof RESEARCH_COLLECTION_FORMAT;
  version: 1;
  snapshots: ResearchSnapshot[];
  manifestSha256: string;
}
export interface ResearchCollectionPreviewEntry extends ResearchSnapshotInfo {
  disposition: 'new' | 'existing';
}
export interface ResearchCollectionPreview {
  readonly manifestSha256: string;
  readonly entries: readonly Readonly<ResearchCollectionPreviewEntry>[];
  readonly totalBytes: number;
  readonly additions: number;
  readonly duplicates: number;
  readonly currentSnapshots: number;
  readonly projectedSnapshots: number;
  readonly projectedBytes: number;
}
export interface ResearchCollectionImportResult {
  added: number;
  duplicates: number;
  totalSnapshots: number;
  totalBytes: number;
}
interface ResearchCollectionPlan {
  entries: ResearchCollectionPreviewEntry[];
  additions: ResearchSnapshot[];
  duplicates: ResearchSnapshot[];
  inventoryToken: string;
  currentSnapshots: number;
  totalSnapshots: number;
  totalBytes: number;
}

export const RESEARCH_STORAGE_NAME = 'phage-explorer-private-research';
const kinds = Object.keys(RESEARCH_SNAPSHOT_TYPES) as ResearchSnapshotKind[];
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
  const definition = RESEARCH_SNAPSHOT_TYPES[kind];
  const methods: readonly string[] = definition.methods;
  const matches = value.format === definition.format && (!methods.length
    || object(value.method) && typeof value.method.id === 'string' && methods.includes(value.method.id));
  if (!matches) throw new Error('Snapshot content does not match this research panel.');
  return bytes;
}

/** Connect the library's lifetime to an existing owned analysis session. Those
 * sessions report failures as false, so awaiting run alone cannot certify replay.
 * Abort also settles if a provider ignores cancellation; late replies cannot
 * publish a library success or retain a listener that cancels a later operation.
 */
export function replaySavedResearch(signal: AbortSignal, operation: {
  run: () => Promise<boolean>; cancel: () => void; error: () => string | null;
}): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, failed = false) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', stop);
      if (failed) reject(cause); else resolve();
    };
    const stop = () => {
      if (settled) return;
      try { operation.cancel(); } catch { /* Cancellation still settles the library operation. */ }
      finish(cancelled(), true);
    };
    signal.addEventListener('abort', stop, { once: true });
    void Promise.resolve().then(() => { check(signal); return operation.run(); }).then(ok => {
      if (settled) return;
      if (signal.aborted) stop();
      else if (!ok) finish(new Error(operation.error() ?? 'Saved experiment could not be recomputed. The previous result is unchanged.'), true);
      else finish();
    }).catch(cause => finish(cause, true));
    if (signal.aborted) stop();
  });
}
function metadata(value: unknown): ResearchSnapshotInfo {
  if (!object(value)) throw new Error('Saved research metadata is damaged. Use the saved library recovery controls to inspect this record.');
  validId(value.id);
  if (value.version !== 1 || !kinds.includes(value.kind as ResearchSnapshotKind) || typeof value.name !== 'string'
      || researchSnapshotName(value.name) !== value.name || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > RESEARCH_STORAGE_LIMITS.snapshotBytes
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Saved research metadata is invalid.');
  return { id: value.id, version: 1, kind: value.kind as ResearchSnapshotKind, name: value.name,
    createdAt: Number(value.createdAt), bytes: Number(value.bytes), sha256: value.sha256 };
}
/** An older tab must not mistake a newer format for a corrupt record it can discard. */
function unsupportedMetadata(value: unknown): boolean {
  if (!object(value)) return false;
  return (typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 1)
    || (typeof value.kind === 'string' && value.kind.length > 0 && !kinds.includes(value.kind as ResearchSnapshotKind));
}
function metadataAtKey(key: IDBValidKey, value: unknown): ResearchSnapshotInfo | null {
  try {
    const info = metadata(value);
    return info.id === key ? info : null;
  } catch { return null; }
}
function storageKeyLabel(key: IDBValidKey, depth = 0): string {
  if (typeof key === 'string') return JSON.stringify(key.length > 120 ? `${key.slice(0, 120)}…` : key);
  if (typeof key === 'number') return String(key);
  if (key instanceof Date) return `Date(${key.toISOString()})`;
  if (Array.isArray(key)) return depth >= 3 ? '[…]' : `[${key.slice(0, 8).map(part => storageKeyLabel(part, depth + 1)).join(', ')}${key.length > 8 ? ', …' : ''}]`;
  const bytes = ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : new Uint8Array(key);
  return `Binary(${Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}${bytes.length > 16 ? '…' : ''}; ${bytes.length} bytes)`;
}
/** Only metadata and primary keys are read here; opening still verifies the original contents. */
function readInventory(tx: IDBTransaction, result: (inventory: ResearchSnapshotInventory) => void, fail: (cause: unknown) => void): void {
  const index = tx.objectStore('metadata');
  const values = index.getAll(), keys = index.getAllKeys(), payloadKeys = tx.objectStore('contents').getAllKeys();
  let complete = 0;
  const ready = () => {
    if (++complete !== 3) return;
    try {
      const entries: ResearchSnapshotInfo[] = [], problems: ResearchSnapshotProblem[] = [];
      const hasKey = (list: IDBValidKey[], key: IDBValidKey) => list.some(candidate => indexedDB.cmp(candidate, key) === 0);
      for (const [i, key] of keys.result.entries()) {
        const info = metadataAtKey(key, values.result[i]);
        const unsupported = unsupportedMetadata(values.result[i]);
        const present = hasKey(payloadKeys.result, key);
        if (info && present) entries.push(info);
        else problems.push({ key, keyLabel: storageKeyLabel(key), name: info?.name ?? null, removable: !unsupported,
          reason: unsupported ? 'Unsupported snapshot format' : info ? 'Saved contents are missing' : 'Invalid snapshot metadata' });
      }
      for (const key of payloadKeys.result) {
        if (!hasKey(keys.result, key)) problems.push({ key, keyLabel: storageKeyLabel(key), name: null, removable: true, reason: 'Saved contents have no metadata' });
      }
      entries.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      result({ entries, problems });
    } catch (cause) { fail(cause); }
  };
  values.onsuccess = ready; keys.onsuccess = ready; payloadKeys.onsuccess = ready;
}
async function digest(kind: ResearchSnapshotKind, content: string): Promise<string> {
  // Bind the routing kind as well as every byte of the existing export format.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}\n${content}`));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}


function exactKeys(value: Record<string, unknown>, expected: readonly string[], description: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) {
    throw new Error(description + ' has unsupported or missing fields. Nothing was imported.');
  }
}
function collectionManifest(snapshots: readonly ResearchSnapshotInfo[]): string {
  return JSON.stringify({ format: RESEARCH_COLLECTION_FORMAT, version: 1,
    snapshots: snapshots.map(snapshot => metadata(snapshot)) });
}
async function textDigest(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Checks the original export text and routing only; it does not rerun a scientific method. */
async function checkCollectionSnapshots(snapshots: readonly ResearchSnapshot[], signal?: AbortSignal): Promise<void> {
  if (snapshots.length > RESEARCH_STORAGE_LIMITS.snapshots) throw new Error('A research collection exceeds the 64 snapshot limit.');
  const ids = new Set<string>();
  let bytes = 0;
  // Check all declared limits before allocating or hashing any large body.
  for (const snapshot of snapshots) {
    check(signal);
    const info = metadata(snapshot);
    if (ids.has(info.id)) throw new Error('The research collection repeats a saved snapshot identifier.');
    ids.add(info.id);
    bytes += info.bytes;
    if (bytes > RESEARCH_STORAGE_LIMITS.totalBytes) throw new Error('A research collection exceeds the 64 MiB saved-content limit.');
    if (typeof snapshot.content !== 'string' || snapshot.content.length > RESEARCH_STORAGE_LIMITS.snapshotBytes) {
      throw new Error('A research collection snapshot exceeds 10 MiB or has invalid contents.');
    }
  }
  // Sequential hashes bound temporary buffers to one snapshot instead of the whole library.
  for (const snapshot of snapshots) {
    check(signal);
    const actualBytes = validateResearchSnapshotContent(snapshot.kind, snapshot.content);
    if (actualBytes !== snapshot.bytes || await digest(snapshot.kind, snapshot.content) !== snapshot.sha256) {
      throw new Error('Research collection snapshot checksum or byte count mismatch. Nothing was imported.');
    }
    check(signal);
  }
}
/** Verify every entry before exposing an import preview. Hashes establish byte integrity,
 * not source authenticity or the correctness of saved scientific results.
 */
export async function parseResearchCollection(content: string, signal?: AbortSignal): Promise<ResearchCollection> {
  check(signal);
  if (typeof content !== 'string' || content.length > RESEARCH_COLLECTION_MAX_BYTES
      || new TextEncoder().encode(content).length > RESEARCH_COLLECTION_MAX_BYTES) {
    throw new Error('Research collection JSON exceeds the 129 MiB import limit.');
  }
  const value: unknown = JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!object(value)) throw new Error('Invalid saved research collection.');
  exactKeys(value, ['format', 'version', 'snapshots', 'manifestSha256'], 'The research collection');
  if (value.format !== RESEARCH_COLLECTION_FORMAT || value.version !== 1 || !Array.isArray(value.snapshots)
      || typeof value.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) {
    throw new Error('Unsupported research collection format/version or invalid manifest checksum.');
  }
  if (value.snapshots.length > RESEARCH_STORAGE_LIMITS.snapshots) throw new Error('A research collection exceeds the 64 snapshot limit.');
  const snapshots = value.snapshots.map((entry: unknown): ResearchSnapshot => {
    if (!object(entry)) throw new Error('Invalid research collection snapshot.');
    exactKeys(entry, ['id', 'version', 'kind', 'name', 'createdAt', 'bytes', 'sha256', 'content'], 'A collection snapshot');
    const info = metadata(entry);
    if (typeof entry.content !== 'string') throw new Error('A collection snapshot has invalid contents.');
    return { ...info, content: entry.content };
  });
  await checkCollectionSnapshots(snapshots, signal);
  if (await textDigest(collectionManifest(snapshots)) !== value.manifestSha256) {
    throw new Error('Research collection manifest checksum mismatch. Nothing was imported.');
  }
  check(signal);
  return { format: RESEARCH_COLLECTION_FORMAT, version: 1, snapshots, manifestSha256: value.manifestSha256 };
}
function compareSnapshotIds(a: ResearchSnapshotInfo, b: ResearchSnapshotInfo): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function inventoryToken(entries: readonly ResearchSnapshotInfo[]): string {
  return JSON.stringify([...entries].sort(compareSnapshotIds).map(entry => metadata(entry)));
}
function checkedInventory(inventory: ResearchSnapshotInventory): void {
  if (inventory.problems.length) {
    throw new Error('The local library has damaged, incomplete or unsupported records. Review the saved library recovery controls before transferring a collection.');
  }
  if (inventory.entries.length > RESEARCH_STORAGE_LIMITS.snapshots
      || inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0) > RESEARCH_STORAGE_LIMITS.totalBytes) {
    throw new Error('The saved library exceeds the 64 snapshot / 64 MiB collection limits. No records were omitted.');
  }
}
function collectionPlan(inventory: ResearchSnapshotInventory, snapshots: readonly ResearchSnapshot[]): ResearchCollectionPlan {
  checkedInventory(inventory);
  const current = new Map(inventory.entries.map(entry => [entry.id, entry]));
  const additions: ResearchSnapshot[] = [], duplicates: ResearchSnapshot[] = [], entries: ResearchCollectionPreviewEntry[] = [];
  for (const snapshot of snapshots) {
    const info = metadata(snapshot), previous = current.get(info.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(info)) {
      throw new Error('A saved snapshot identifier conflicts with different metadata. The entire collection import was rejected.');
    }
    if (previous) duplicates.push(snapshot); else additions.push(snapshot);
    entries.push({ ...info, disposition: previous ? 'existing' : 'new' });
  }
  const totalSnapshots = inventory.entries.length + additions.length;
  const totalBytes = inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    + additions.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalSnapshots > RESEARCH_STORAGE_LIMITS.snapshots || totalBytes > RESEARCH_STORAGE_LIMITS.totalBytes) {
    throw new Error('This collection would fill the local research library beyond 64 snapshots / 64 MiB. Nothing was imported or evicted.');
  }
  return { entries, additions, duplicates, inventoryToken: inventoryToken(inventory.entries),
    currentSnapshots: inventory.entries.length, totalSnapshots, totalBytes };
}
/** Read only matching IDs during import. Every duplicate must match the exact saved body;
 * other existing bodies are preserved, not represented as freshly verified.
 */
function checkDuplicateBodies(tx: IDBTransaction, snapshots: readonly ResearchSnapshot[], ready: () => void,
  fail: (cause: unknown) => void): void {
  if (!snapshots.length) { ready(); return; }
  let complete = 0;
  for (const snapshot of snapshots) {
    const request = tx.objectStore('contents').get(snapshot.id);
    request.onsuccess = () => {
      try {
        const body: unknown = request.result;
        if (!object(body) || body.id !== snapshot.id || body.content !== snapshot.content) {
          throw new Error('A saved snapshot identifier conflicts with different contents. The entire collection import was rejected.');
        }
        if (++complete === snapshots.length) ready();
      } catch (cause) { fail(cause); }
    };
  }
}

export class ResearchStorage {
  private collectionPreviews = new WeakMap<ResearchCollectionPreview, { snapshots: ResearchSnapshot[]; inventoryToken: string }>();
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
    return (await this.inspect(kind, signal)).entries;
  }
  async inspect(kind?: ResearchSnapshotKind, signal?: AbortSignal): Promise<ResearchSnapshotInventory> {
    if (kind !== undefined && !kinds.includes(kind)) throw new Error('Unsupported snapshot kind.');
    return this.transaction('readonly', (tx, result, fail) => {
      readInventory(tx, inventory => result({ ...inventory,
        entries: inventory.entries.filter(row => kind === undefined || row.kind === kind) }), fail);
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
      readInventory(tx, ({ entries: rows, problems }) => {
        try {
          // Never omit damaged or unaccounted records to manufacture free space.
          if (problems.length) throw new Error('The local library has damaged, incomplete or unsupported records. Review the saved library recovery controls before saving again.');
          if (rows.length >= RESEARCH_STORAGE_LIMITS.snapshots || rows.reduce((sum, row) => sum + row.bytes, 0) + bytes > RESEARCH_STORAGE_LIMITS.totalBytes) {
            throw new Error('Local research library is full (64 snapshots / 64 MiB). Export and explicitly remove old snapshots; nothing was evicted.');
          }
          index.add(entry);
          payloads.add({ id: entry.id, content });
          result(entry);
        } catch (cause) { fail(cause); }
      }, fail);
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

  /** Capture one coherent library revision before hashing outside the IDB transaction. */
  async exportCollection(signal?: AbortSignal): Promise<string> {
    check(signal);
    const snapshots = await this.transaction<ResearchSnapshot[]>('readonly', (tx, result, fail) => {
      readInventory(tx, inventory => {
        try {
          checkedInventory(inventory);
          if (!inventory.entries.length) { result([]); return; }
          const rows = new Array<ResearchSnapshot>(inventory.entries.length);
          let complete = 0;
          for (const [i, info] of inventory.entries.entries()) {
            const request = tx.objectStore('contents').get(info.id);
            request.onsuccess = () => {
              try {
                const body: unknown = request.result;
                if (!object(body) || body.id !== info.id || typeof body.content !== 'string') {
                  throw new Error('Saved collection contents are damaged. No snapshots were omitted or exported.');
                }
                rows[i] = { ...info, content: body.content };
                if (++complete === inventory.entries.length) result(rows);
              } catch (cause) { fail(cause); }
            };
          }
        } catch (cause) { fail(cause); }
      }, fail);
    }, signal);
    await checkCollectionSnapshots(snapshots, signal);
    snapshots.sort(compareSnapshotIds);
    const manifestSha256 = await textDigest(collectionManifest(snapshots));
    check(signal);
    const content = JSON.stringify({ format: RESEARCH_COLLECTION_FORMAT, version: 1, snapshots, manifestSha256 });
    if (new TextEncoder().encode(content).length > RESEARCH_COLLECTION_MAX_BYTES) {
      throw new Error('Research collection JSON exceeds 129 MiB. No snapshots were omitted.');
    }
    return content;
  }
  /** Preview is metadata-only. The verified bodies and expected inventory stay privately owned. */
  async previewCollection(content: string, signal?: AbortSignal): Promise<ResearchCollectionPreview> {
    const collection = await parseResearchCollection(content, signal);
    const plan = await this.transaction<ResearchCollectionPlan>('readonly', (tx, result, fail) => {
      readInventory(tx, inventory => {
        try {
          const plan = collectionPlan(inventory, collection.snapshots);
          checkDuplicateBodies(tx, plan.duplicates, () => result(plan), fail);
        } catch (cause) { fail(cause); }
      }, fail);
    }, signal);
    check(signal);
    const preview: ResearchCollectionPreview = Object.freeze({
      manifestSha256: collection.manifestSha256,
      entries: Object.freeze(plan.entries.map(entry => Object.freeze({ ...entry }))),
      totalBytes: collection.snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
      additions: plan.additions.length, duplicates: plan.duplicates.length,
      currentSnapshots: plan.currentSnapshots, projectedSnapshots: plan.totalSnapshots, projectedBytes: plan.totalBytes,
    });
    this.collectionPreviews.set(preview, { snapshots: collection.snapshots, inventoryToken: plan.inventoryToken });
    return preview;
  }
  /** Append the whole reviewed collection atomically. Never overwrite or evict an existing ID. */
  async importCollection(preview: ResearchCollectionPreview, signal?: AbortSignal): Promise<ResearchCollectionImportResult> {
    check(signal);
    const prepared = this.collectionPreviews.get(preview);
    if (!prepared) throw new Error('Review the collection in this library before importing it.');
    // Recheck our privately captured bodies before starting the write transaction.
    await checkCollectionSnapshots(prepared.snapshots, signal);
    check(signal);
    const imported = await this.transaction<ResearchCollectionImportResult>('readwrite', (tx, result, fail) => {
      readInventory(tx, inventory => {
        try {
          checkedInventory(inventory);
          if (inventoryToken(inventory.entries) !== prepared.inventoryToken) {
            throw new Error('The saved library changed after collection review. Review the file again; nothing was imported.');
          }
          const plan = collectionPlan(inventory, prepared.snapshots);
          checkDuplicateBodies(tx, plan.duplicates, () => {
            try {
              const index = tx.objectStore('metadata'), bodies = tx.objectStore('contents');
              for (const snapshot of plan.additions) {
                index.add(metadata(snapshot));
                bodies.add({ id: snapshot.id, content: snapshot.content });
              }
              result({ added: plan.additions.length, duplicates: plan.duplicates.length,
                totalSnapshots: plan.totalSnapshots, totalBytes: plan.totalBytes });
            } catch (cause) { fail(cause); }
          }, fail);
        } catch (cause) { fail(cause); }
      }, fail);
    }, signal);
    this.collectionPreviews.delete(preview);
    if (imported.added) this.changed();
    return imported;
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
  /** A separate explicit recovery action, rechecked atomically before deleting this primary key only. */
  async removeDamaged(key: IDBValidKey, signal?: AbortSignal): Promise<void> {
    await this.transaction<void>('readwrite', (tx, result, fail) => {
      const index = tx.objectStore('metadata'), payloads = tx.objectStore('contents');
      const info = index.get(key), bodyKey = payloads.getKey(key);
      let complete = 0;
      const ready = () => {
        if (++complete !== 2) return;
        try {
          if (info.result === undefined && bodyKey.result === undefined) throw new Error('This saved record is already absent. Refresh the saved list.');
          if (unsupportedMetadata(info.result)) throw new Error('This record uses an unsupported snapshot format. Open the explorer version that saved it; recovery will not remove it.');
          if (metadataAtKey(key, info.result) && bodyKey.result !== undefined) {
            throw new Error('This record no longer has an index problem. Refresh the saved list and use its own panel to remove it.');
          }
          index.delete(key); payloads.delete(key); result(undefined);
        } catch (cause) { fail(cause); }
      };
      info.onsuccess = ready; bodyKey.onsuccess = ready;
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
