/** User-selected offline data, bound to the open catalog rather than mutable numeric IDs. */
import type { PhageSummary } from '@phage-explorer/core';
import type { ArtifactAvailability, OfflineDownloadProgress, VerifiedArtifactStore } from './progressive-artifacts';
import type { DataArtifact, ProgressiveManifest } from './progressive-manifest';

export interface OfflineDatasetSelection { genomeIds: number[]; atlasModels: string[] }
export interface OfflineDatasetInfo {
  contentVersion: string;
  catalogBytes: number;
  cacheBudget: number;
  genomes: Array<{ id: number; name: string; accession: string; bytes: number }>;
  atlases: Array<{ model: string; count: number; bytes: number }>;
}
export interface OfflineDatasetPlan {
  contentVersion: string;
  selection: OfflineDatasetSelection;
  totalBytes: number;
  artifactCount: number;
  withinBudget: boolean;
}
export interface SavedOfflineDataset {
  contentVersion: string;
  totalBytes: number;
  /** Null means an older generation or a reservation not expressible as complete current groups. */
  selection: OfflineDatasetSelection | null;
}
export interface OfflineDatasetReport extends OfflineDatasetPlan {
  checkedAt: string;
  catalog: ArtifactAvailability;
  genomes: Array<{ id: number; status: ArtifactAvailability }>;
  atlases: Array<{ model: string; status: ArtifactAvailability }>;
  verifiedBytes: number;
  filesAvailable: boolean;
  startupManifestAvailable: boolean;
  ready: boolean;
}
export interface OfflineDatasetAccess {
  describe(): OfflineDatasetInfo;
  plan(selection: OfflineDatasetSelection): OfflineDatasetPlan;
  saved(signal?: AbortSignal): Promise<SavedOfflineDataset | null>;
  inspect(selection: OfflineDatasetSelection, signal?: AbortSignal): Promise<OfflineDatasetReport>;
  prepare(selection: OfflineDatasetSelection, options?: {
    signal?: AbortSignal; onProgress?: (progress: OfflineDownloadProgress) => void;
  }): Promise<OfflineDatasetReport>;
  /** Releases eviction protection, not cached bytes, private input, or another dataset's selection. */
  release(signal?: AbortSignal): Promise<void>;
}
export type OfflineDatasetStore = Pick<VerifiedArtifactStore,
  'getCacheBudget' | 'getOfflineSelection' | 'inspect' | 'prepareOffline' | 'releaseOfflineSelection'>;
export interface OfflineManifestAccess {
  available(): Promise<boolean>;
  /** Called inside the artifact store's cache lock, after every selected file verifies. */
  publish(): Promise<void>;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Offline operation cancelled.', 'AbortError');
}
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Offline operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
function unique(items: readonly DataArtifact[]): DataArtifact[] {
  return [...new Map(items.map(item => [item.path, item])).values()];
}
const byteCount = (items: readonly DataArtifact[]) => unique(items).reduce((sum, item) => sum + item.bytes, 0);
const sameArtifacts = (a: readonly DataArtifact[], b: readonly DataArtifact[]): boolean => {
  const byPath = new Map(a.map(item => [item.path, item]));
  return byPath.size === b.length && b.every(item => {
    const previous = byPath.get(item.path);
    return previous?.bytes === item.bytes && previous.sha256 === item.sha256;
  });
};

/** Construct only after the repository has verified the manifest and catalog ownership. */
export function createOfflineDatasetAccess(input: {
  manifest: ProgressiveManifest; phages: readonly PhageSummary[]; store: OfflineDatasetStore;
  lifetime: AbortSignal; startupManifest?: OfflineManifestAccess;
}): OfflineDatasetAccess {
  const manifest = structuredClone(input.manifest), store = input.store;
  const genomes = new Map(manifest.genomes.map(genome => [genome.id, genome]));
  const atlases = new Map(manifest.atlas.map(atlas => [atlas.model, atlas]));
  const phages = new Map(input.phages.map(phage => [phage.id, phage]));
  const info: OfflineDatasetInfo = { contentVersion: manifest.contentVersion, catalogBytes: manifest.catalog.bytes,
    cacheBudget: store.getCacheBudget(),
    genomes: manifest.genomes.map(genome => ({ id: genome.id, name: phages.get(genome.id)!.name,
      accession: phages.get(genome.id)!.accession, bytes: genome.artifact.bytes })),
    atlases: manifest.atlas.map(atlas => ({ model: atlas.model, count: atlas.count, bytes: byteCount(atlas.pages) })) };
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([input.lifetime, signal]) : input.lifetime;
  const resolve = (value: OfflineDatasetSelection) => {
    abort(input.lifetime);
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join('|') !== 'atlasModels|genomeIds'
      || !Array.isArray(value.genomeIds) || !Array.isArray(value.atlasModels)
      || value.genomeIds.length > genomes.size || value.atlasModels.length > atlases.size) throw new Error('Invalid offline dataset selection.');
    const ids = Array.from(value.genomeIds), models = Array.from(value.atlasModels);
    if (ids.some(id => !Number.isSafeInteger(id) || !genomes.has(id)) || new Set(ids).size !== ids.length) {
      throw new Error('Choose unique genome IDs from this catalog. Private or unknown genomes cannot be downloaded.');
    }
    if (models.some(model => typeof model !== 'string' || !atlases.has(model)) || new Set(models).size !== models.length) {
      throw new Error('Choose unique global atlas models from this catalog.');
    }
    const selection = { genomeIds: ids.sort((a, b) => a - b), atlasModels: models.sort() };
    const artifacts = unique([manifest.catalog, ...selection.genomeIds.map(id => genomes.get(id)!.artifact),
      ...selection.atlasModels.flatMap(model => atlases.get(model)!.pages)]);
    const totalBytes = byteCount(artifacts);
    return { artifacts, plan: { contentVersion: manifest.contentVersion, selection, totalBytes,
      artifactCount: artifacts.length, withinBudget: totalBytes <= info.cacheBudget } satisfies OfflineDatasetPlan };
  };
  const inspect = async (selection: OfflineDatasetSelection, signal?: AbortSignal): Promise<OfflineDatasetReport> => {
    const combined = signalFor(signal); abort(combined);
    const { plan, artifacts } = resolve(selection);
    if (!plan.withinBudget) throw new Error('Selection exceeds the offline byte budget. Choose fewer genomes or atlas models.');
    const statuses = await wait(store.inspect(artifacts, combined), combined);
    if (statuses.length !== artifacts.length || statuses.some(status => !['available', 'missing', 'corrupt', 'unavailable'].includes(status))) {
      throw new Error('Incomplete offline verification response.');
    }
    const byPath = new Map(artifacts.map((artifact, i) => [artifact.path, statuses[i]]));
    const group = (items: DataArtifact[]): ArtifactAvailability => {
      const states = items.map(item => byPath.get(item.path)!);
      return states.includes('unavailable') ? 'unavailable' : states.includes('corrupt') ? 'corrupt'
        : states.includes('missing') ? 'missing' : 'available';
    };
    const filesAvailable = statuses.every(status => status === 'available');
    const startupManifestAvailable = input.startupManifest ? await wait(input.startupManifest.available(), combined) : false;
    abort(combined);
    return { ...plan, checkedAt: new Date().toISOString(), catalog: byPath.get(manifest.catalog.path)!,
      genomes: plan.selection.genomeIds.map(id => ({ id, status: group([genomes.get(id)!.artifact]) })),
      atlases: plan.selection.atlasModels.map(model => ({ model, status: group(atlases.get(model)!.pages) })),
      verifiedBytes: artifacts.reduce((sum, item, i) => sum + (statuses[i] === 'available' ? item.bytes : 0), 0),
      filesAvailable, startupManifestAvailable, ready: filesAvailable && startupManifestAvailable };
  };
  return {
    describe: () => { abort(input.lifetime); return structuredClone(info); },
    plan: value => resolve(value).plan,
    saved: async signal => {
      const combined = signalFor(signal); abort(combined);
      const saved = await wait(store.getOfflineSelection(), combined);
      if (!saved) return null;
      let selection: OfflineDatasetSelection | null = null;
      if (saved.contentVersion === manifest.contentVersion) {
        const paths = new Set(saved.artifacts.map(item => item.path));
        const candidate = { genomeIds: manifest.genomes.filter(item => paths.has(item.artifact.path)).map(item => item.id),
          atlasModels: manifest.atlas.filter(item => item.pages.every(page => paths.has(page.path))).map(item => item.model) };
        if (sameArtifacts(resolve(candidate).artifacts, saved.artifacts)) selection = candidate;
      }
      abort(combined);
      return { contentVersion: saved.contentVersion, totalBytes: byteCount(saved.artifacts), selection };
    },
    inspect,
    prepare: async (selection, options = {}) => {
      const combined = signalFor(options.signal); abort(combined);
      const { plan, artifacts } = resolve(selection);
      if (!plan.withinBudget) throw new Error('Selection exceeds the offline byte budget. Choose fewer genomes or atlas models.');
      if (!input.startupManifest) throw new Error('Startup manifest persistence is unavailable for this repository.');
      await store.prepareOffline(manifest.contentVersion, artifacts, { signal: combined,
        onProgress: progress => { abort(combined); options.onProgress?.(progress); }, onVerified: input.startupManifest.publish });
      const report = await inspect(plan.selection, combined);
      if (!report.ready) throw new Error('Offline preparation did not retain every file and the startup manifest. Recheck and resume.');
      return report;
    },
    release: async signal => {
      const combined = signalFor(signal); abort(combined);
      await store.releaseOfflineSelection(combined); abort(combined);
    },
  };
}

export interface OfflineDatasetSnapshot {
  plan: OfflineDatasetPlan;
  /** Undefined until inspected; null means no saved reservation exists. */
  saved: SavedOfflineDataset | null | undefined;
  report: OfflineDatasetReport | null;
  busy: 'restoring' | 'checking' | 'preparing' | 'releasing' | null;
  progress: OfflineDownloadProgress | null;
  error: string | null;
  notice: string;
}

/** Settings owns the operation, not the repository: closing it cancels only this job. */
export class OfflineDatasetSession {
  private active = false;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: OfflineDatasetSnapshot;
  constructor(private readonly access: OfflineDatasetAccess) {
    this.snapshot = { plan: access.plan({ genomeIds: [], atlasModels: [] }), saved: undefined,
      report: null, busy: null, progress: null, error: null, notice: 'Choose genomes and check or prepare their offline files.' };
  }
  getSnapshot = (): OfflineDatasetSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<OfflineDatasetSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const previous = this.operation; this.operation = null; previous?.abort();
    if (previous) this.publish({ busy: null, progress: null, report: null,
      notice: 'Offline work cancelled. Saved files and any partial reservation remain; prepare again to resume.' });
  };
  select = (selection: OfflineDatasetSelection): void => {
    if (!this.active) return;
    this.cancel();
    try { this.publish({ plan: this.access.plan(selection), report: null, error: null,
      notice: 'Selection changed. Previous verification does not cover this draft.' }); }
    catch (cause) { this.publish({ report: null, error: cause instanceof Error ? cause.message : 'Invalid offline selection.' }); }
  };
  private async run(kind: NonNullable<OfflineDatasetSnapshot['busy']>,
    operation: (signal: AbortSignal, current: () => boolean) => Promise<Partial<OfflineDatasetSnapshot>>): Promise<void> {
    if (!this.active) return;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    this.publish({ busy: kind, progress: null, report: null, error: null, notice: '' });
    try {
      const update = await wait(operation(owner.signal, current), owner.signal);
      if (current()) this.publish(update);
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Offline operation failed.',
        notice: 'No new offline readiness claim. Saved files may be reusable; recheck or resume explicitly.' });
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: null, progress: null }); }
    }
  }
  restore = (): Promise<void> => this.run('restoring', async signal => {
    const saved = await this.access.saved(signal);
    return { saved, ...(saved?.selection ? { plan: this.access.plan(saved.selection) } : {}),
      notice: !saved ? 'No saved reservation. The current draft is unchanged.' : saved.selection
        ? 'Saved selection restored. Files have not been checked; prepare to resume or verify saved files.'
        : 'Saved reservation belongs to another dataset or incomplete groups. It was not applied to this catalog.' };
  });
  check = (): Promise<void> => {
    const selection = structuredClone(this.snapshot.plan.selection);
    return this.run('checking', async signal => {
      const report = await this.access.inspect(selection, signal);
      return { report, notice: report.ready ? 'Selected dataset files and startup manifest verified in browser storage.'
        : 'Some selected files or the startup manifest are missing, corrupt, or unavailable. Prepare to resume or repair.' };
    });
  };
  prepare = (): Promise<void> => {
    const selection = structuredClone(this.snapshot.plan.selection);
    return this.run('preparing', async (signal, current) => {
      const report = await this.access.prepare(selection, { signal,
        onProgress: progress => { if (current()) this.publish({ progress: { ...progress } }); } });
      if (!report.ready) throw new Error('Preparation did not verify all selected files and the startup manifest.');
      const saved = await this.access.saved(signal);
      return { report, saved, notice: 'Selected dataset files and startup manifest verified in browser storage.' };
    });
  };
  release = (): Promise<void> => this.run('releasing', async signal => {
    await this.access.release(signal);
    return { saved: null, notice: 'Offline reservation released. Cached files were not deleted; they can now be evicted.' };
  });
}
