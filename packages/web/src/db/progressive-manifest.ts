/** Immutable, bounded deployment contract shared by the publisher and browser. */
export const PROGRESSIVE_LIMITS = {
  manifestBytes: 8 * 1024 * 1024,
  catalogBytes: 8 * 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024,
  cacheBytes: 128 * 1024 * 1024,
  residentBytes: 64 * 1024 * 1024,
  concurrentLoads: 4,
  genomes: 50_000,
} as const;

export interface DataArtifact {
  path: string;
  sha256: string;
  bytes: number;
}
export interface GenomeArtifact {
  id: number;
  genomeLength: number;
  artifact: DataArtifact;
}
export interface AtlasArtifacts {
  model: string;
  count: number;
  pages: DataArtifact[];
}
export interface DatasetByteLedger {
  catalog: number;
  artifacts: number;
  largestArtifact: number;
  artifactCount: number;
}
export interface ProgressiveManifest {
  version: 3;
  layout: 'per-phage-sqlite-v1';
  contentVersion: string;
  generatedAt: string;
  catalog: DataArtifact;
  genomes: GenomeArtifact[];
  atlas: AtlasArtifacts[];
  bytes: DatasetByteLedger;
}

const HASH = /^[a-f0-9]{64}$/;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function artifact(value: unknown, extension: 'sqlite' | 'json', max = PROGRESSIVE_LIMITS.artifactBytes): DataArtifact {
  const item = record(value, 'Artifact');
  if (typeof item.sha256 !== 'string' || !HASH.test(item.sha256) || item.path !== `phage-data/${item.sha256}.${extension}`) {
    throw new Error('Artifacts must have immutable, checksum-addressed relative paths.');
  }
  return { path: item.path as string, sha256: item.sha256, bytes: integer(item.bytes, 'artifact byte count', extension === 'sqlite' ? 512 : 2, max) };
}

export function datasetArtifacts(manifest: Pick<ProgressiveManifest, 'catalog' | 'genomes' | 'atlas'>): DataArtifact[] {
  const unique = new Map<string, DataArtifact>();
  for (const item of [manifest.catalog, ...manifest.genomes.map(genome => genome.artifact), ...manifest.atlas.flatMap(atlas => atlas.pages)]) {
    const previous = unique.get(item.path);
    if (previous && (previous.sha256 !== item.sha256 || previous.bytes !== item.bytes)) throw new Error('Conflicting artifact descriptors.');
    unique.set(item.path, item);
  }
  return [...unique.values()];
}
export function datasetByteLedger(manifest: Pick<ProgressiveManifest, 'catalog' | 'genomes' | 'atlas'>): DatasetByteLedger {
  const items = datasetArtifacts(manifest);
  return {
    catalog: manifest.catalog.bytes,
    artifacts: integer(items.reduce((total, item) => total + item.bytes, 0), 'total dataset bytes'),
    largestArtifact: items.reduce((max, item) => Math.max(max, item.bytes), 0),
    artifactCount: items.length,
  };
}

/** The dataset identity excludes publication time, but includes every asset and its ownership. */
export function progressiveIdentity(manifest: Pick<ProgressiveManifest, 'layout' | 'catalog' | 'genomes' | 'atlas'>): string {
  // Explicit property order must match in Bun, Node, and the browser.
  const descriptor = (item: DataArtifact) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes });
  return JSON.stringify({
    layout: manifest.layout,
    catalog: descriptor(manifest.catalog),
    genomes: manifest.genomes.map(item => ({ id: item.id, genomeLength: item.genomeLength, artifact: descriptor(item.artifact) })),
    atlas: manifest.atlas.map(item => ({ model: item.model, count: item.count, pages: item.pages.map(descriptor) })),
  });
}

export function parseProgressiveManifest(input: unknown): ProgressiveManifest {
  if (typeof input === 'string') {
    if (input.length > PROGRESSIVE_LIMITS.manifestBytes || new TextEncoder().encode(input).byteLength > PROGRESSIVE_LIMITS.manifestBytes) throw new Error('Dataset manifest exceeds its byte budget.');
    input = JSON.parse(input);
  }
  const value = record(input, 'Dataset manifest');
  if (value.version !== 3 || value.layout !== 'per-phage-sqlite-v1') throw new Error('Unsupported progressive dataset layout.');
  if (typeof value.contentVersion !== 'string' || !HASH.test(value.contentVersion)) throw new Error('Invalid dataset identity.');
  if (typeof value.generatedAt !== 'string' || value.generatedAt.length > 64 || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Invalid publication timestamp.');
  if (!Array.isArray(value.genomes) || !value.genomes.length || value.genomes.length > PROGRESSIVE_LIMITS.genomes) throw new Error('Dataset must contain a bounded, nonempty genome catalog.');
  let previousId = 0;
  const genomes = Array.from(value.genomes, item => {
    const genome = record(item, 'Genome');
    const id = integer(genome.id, 'genome ID', 1);
    if (id <= previousId) throw new Error('Genome IDs must be unique and ascending.');
    previousId = id;
    return { id, genomeLength: integer(genome.genomeLength, 'genome length'), artifact: artifact(genome.artifact, 'sqlite') };
  });
  if (!Array.isArray(value.atlas) || value.atlas.length > 256) throw new Error('Invalid atlas index.');
  let previousModel: string | undefined;
  const atlas = Array.from(value.atlas, item => {
    const group = record(item, 'Atlas');
    if (typeof group.model !== 'string' || !group.model.trim() || group.model.length > 512 || (previousModel !== undefined && group.model <= previousModel)) throw new Error('Atlas models must be nonempty, unique, and ascending.');
    previousModel = group.model;
    if (!Array.isArray(group.pages) || !group.pages.length || group.pages.length > 10_000) throw new Error('Invalid atlas pages.');
    return { model: group.model, count: integer(group.count, 'atlas count', 1), pages: Array.from(group.pages, page => artifact(page, 'json')) };
  });
  const manifest: ProgressiveManifest = {
    version: 3, layout: 'per-phage-sqlite-v1', contentVersion: value.contentVersion, generatedAt: value.generatedAt,
    catalog: artifact(value.catalog, 'sqlite', PROGRESSIVE_LIMITS.catalogBytes), genomes, atlas,
    bytes: { catalog: 0, artifacts: 0, largestArtifact: 0, artifactCount: 0 },
  };
  const supplied = record(value.bytes, 'Byte ledger');
  manifest.bytes = datasetByteLedger(manifest);
  for (const key of Object.keys(manifest.bytes) as Array<keyof DatasetByteLedger>) {
    if (supplied[key] !== manifest.bytes[key]) throw new Error(`Dataset byte ledger mismatch: ${key}.`);
  }
  return manifest;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyProgressiveManifest(manifest: ProgressiveManifest): Promise<void> {
  const identity = await sha256Bytes(new TextEncoder().encode(progressiveIdentity(manifest)));
  if (identity !== manifest.contentVersion) throw new Error('Dataset identity does not match its artifact index.');
}
export function dataArtifactUrl(manifestUrl: string, item: DataArtifact): string {
  if (!/^phage-data\/[a-f0-9]{64}\.(sqlite|json)$/.test(item.path)) throw new Error('Invalid artifact path.');
  const base = new URL(manifestUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Dataset URLs must use HTTP(S) without credentials.');
  return new URL(item.path, base).href;
}
