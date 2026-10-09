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
