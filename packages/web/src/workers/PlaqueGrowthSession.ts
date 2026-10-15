/** One accepted growth experiment and one interruptible operation per panel.
 * Observation models share ownership/transport, not statistical assumptions.
 */
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { parsePlaqueGrowthInput, exportPlaqueGrowthTsv, PLAQUE_GROWTH_METHOD, plaqueGrowthMethod, type PlaqueGrowthInput } from '../../../core/src/analysis/plaque-growth';
import { parseGrowthCurveRecordInput, parseGrowthCurveCSV, exportGrowthCurveTsv, GROWTH_CURVE_METHOD,
  GROWTH_CURVE_RECORD_METHOD, type GrowthCurveExperiment } from '../../../core/src/analysis/one-step-growth';
import { validatePlaqueGrowthRequest, type PlaqueGrowthRequest, type PlaqueGrowthResponse } from './plaque-growth.worker';

interface GrowthSource { provenance: { kind: 'user-supplied' | 'synthetic' }; options: object }
interface GrowthModel<Input extends GrowthSource> {
  readonly methodId: string;
  /** Resolve from strictly parsed source inputs, never from the worker's claim. */
  readonly method: (input: Input) => AnalysisRecord['method'];
  readonly parse: (content: string) => Input;
  readonly table: (record: AnalysisRecord) => string;
  readonly operations: Record<'fit' | 'replay', PlaqueGrowthRequest['type']>;
  readonly observationsField: string;
  readonly seed: (input: Input) => AnalysisRecord['seed'];
  readonly fitting: string;
}
export const PLAQUE_GROWTH_MODEL: GrowthModel<PlaqueGrowthInput> = {
  methodId: PLAQUE_GROWTH_METHOD.id, method: input => plaqueGrowthMethod(input.version), parse: parsePlaqueGrowthInput, table: exportPlaqueGrowthTsv,
  operations: { fit: 'fit', replay: 'replay' }, observationsField: 'plates', seed: () => null,
  fitting: 'Fitting counts and profiling likelihood in a worker…',
};
export const CORRECTED_PFU_GROWTH_MODEL: GrowthModel<GrowthCurveExperiment> = {
  methodId: GROWTH_CURVE_RECORD_METHOD.id, method: () => GROWTH_CURVE_RECORD_METHOD, parse: parseGrowthCurveRecordInput, table: exportGrowthCurveTsv,
  operations: { fit: 'pfu-fit', replay: 'pfu-replay' }, observationsField: 'observations', seed: input => input.options.seed,
  fitting: 'Fitting corrected PFU/mL and bootstrapping in a worker…',
};
export interface AcceptedGrowth<Input extends GrowthSource> {
  record: AnalysisRecord;
  input: Input;
  /** The exact original JSON, not a regenerated form of its CSV. */
  inputText: string;
  json: string;
  tsv: string;
  verifiedReplay: boolean;
}
export interface GrowthSnapshot<Input extends GrowthSource> {
  busy: boolean;
  phase: string;
  error: string | null;
  accepted: AcceptedGrowth<Input> | null;
}
export type PlaqueGrowthWorker = Pick<Worker, 'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'>;
const canonical = (value: unknown) => JSON.stringify(analysisJson(value));
const cancelled = () => new DOMException('Growth operation cancelled.', 'AbortError');
function check(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

/** Settles even when a file provider ignores abort. Its late result is discarded. */
function readWithSignal(read: (signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(cancelled());
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(() => { check(signal); return read(signal); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
function compute(request: PlaqueGrowthRequest, signal: AbortSignal, create: () => PlaqueGrowthWorker): Promise<AnalysisRecord> {
  return new Promise((resolve, reject) => {
    check(signal);
    const worker = create();
    let done = false;
    const finish = (record?: AnalysisRecord, error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', stop);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Teardown cannot prevent settlement. */ }
      if (error) reject(error); else resolve(record!);
    };
    const stop = () => finish(undefined, cancelled());
    signal.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<PlaqueGrowthResponse>) => {
      const response = event.data;
      if (response?.type === 'result' && response.record) finish(response.record);
      else finish(undefined, new Error(response?.type === 'error' && typeof response.message === 'string'
        ? response.message : 'Unexpected plaque-count worker response.'));
    };
    worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('Plate-count worker failed.')); };
    worker.onmessageerror = () => finish(undefined, new Error('Plate-count response could not be decoded.'));
    try { check(signal); worker.postMessage(request); } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

export class GrowthExperimentSession<Input extends GrowthSource> {
  private active = false;
  private owner: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: GrowthSnapshot<Input> = { busy: false, phase: 'No growth experiment accepted.', error: null, accepted: null };
  constructor(private readonly createWorker: () => PlaqueGrowthWorker, private readonly model: GrowthModel<Input>) {}
  getSnapshot = (): GrowthSnapshot<Input> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  private publish(change: Partial<GrowthSnapshot<Input>>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  cancel = (): void => {
    const old = this.owner; this.owner = null; old?.abort();
    if (old) this.publish({ busy: false, phase: 'Cancelled. The previously accepted result is unchanged.' });
  };
  /** Explicit new work supersedes older reading, fitting, verification or replay. */
  run = async (type: 'fit' | 'replay', source: string | ((signal: AbortSignal) => Promise<string>)): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = new AbortController(); this.owner = owner;
    const signal = owner.signal;
    this.publish({ busy: true, error: null, phase: typeof source === 'string' ? 'Checking input…' : 'Reading local JSON…' });
    try {
      const content = typeof source === 'string' ? source : await readWithSignal(source, signal);
      check(signal);
      const request: PlaqueGrowthRequest = { type: this.model.operations[type], content };
      validatePlaqueGrowthRequest(request);
      const saved = type === 'replay' ? await parseAnalysisRecord(content, { methodId: this.model.methodId }) : null;
      check(signal);
      const inputText = saved ? saved.inputs[0]?.data : content;
      if (typeof inputText !== 'string' || saved && (saved.inputs.length !== 1 || saved.inputs[0].id !== 'experiment')) {
        throw new Error('Saved evidence must embed one original growth experiment.');
      }
      const input = this.model.parse(inputText);
      const method = this.model.method(input);
      if (saved && canonical(saved.method) !== canonical(method)) {
        throw new Error('Saved method version differs from the embedded observation model.');
      }
      this.publish({ phase: type === 'fit' ? this.model.fitting : 'Recomputing saved observations and uncertainty…' });
      const response = await compute(request, signal, this.createWorker);
      check(signal);
      // Hash/envelope validation is not a second fit on the UI thread. The worker
      // performs numerical replay; this boundary binds its reply to our request.
      const json = serializeAnalysisRecord(response), record = await parseAnalysisRecord(json);
      check(signal);
      if (canonical(record.method) !== canonical(method) || record.inputs.length !== 1
        || record.inputs[0].id !== 'experiment' || record.inputs[0].data !== inputText || record.inputs[0].accession !== null
        || record.inputs[0].source !== (input.provenance.kind === 'synthetic' ? 'demo' : 'local')
        || canonical(record.parameters) !== canonical(input.options) || record.seed !== this.model.seed(input)
        || !record.fields.fit || !record.fields[this.model.observationsField]
        || saved && (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey)) {
        throw new Error('Worker evidence differs from the submitted experiment or saved identity.');
      }
      const accepted: AcceptedGrowth<Input> = { input, inputText, record, json, tsv: this.model.table(record), verifiedReplay: type === 'replay' };
      check(signal);
      if (!this.active || this.owner !== owner) return false;
      this.owner = null;
      this.publish({ busy: false, accepted, error: null, phase: type === 'replay'
        ? 'Saved numerical results verified by fresh replay.' : 'Fresh fit accepted. This is not biological validation.' });
      return true;
    } catch (cause) {
      if (this.active && this.owner === owner) {
        this.owner = null;
        this.publish({ busy: false, error: cause instanceof Error ? cause.message : 'Growth operation failed.',
          phase: 'Operation failed. The previously accepted result is unchanged.' });
      }
      return false;
    }
  };
}

export interface PlaqueGrowthDraft {
  version: 1 | 2;
  title: string; source: string; kind: 'user-supplied' | 'synthetic'; csv: string;
  centers: string; support: string; extracellular: boolean;
}
/** Reject invalid numbers before JSON can turn Infinity/NaN into a valid null. */
export function plaqueGrowthDraftContent(draft: PlaqueGrowthDraft): string {
  if (!draft.extracellular) throw new Error('Confirm extracellular free-phage count observations and any explicit bounds, not total infective centers.');
  const numeric = (text: string, name: string): number => {
    if (!text.trim() || !/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) throw new Error(`Provide a finite positive ${name}.`);
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Provide a finite positive ${name}.`);
    return value;
  };
  const input: PlaqueGrowthInput = {
    format: 'phage-explorer-plaque-growth-input', version: draft.version, measurement: 'extracellular-plaque-counts',
    title: draft.title, provenance: { kind: draft.kind, source: draft.source }, csv: draft.csv,
    options: { infectedCentersPerMl: draft.centers.trim() ? numeric(draft.centers, 'measured infected-center concentration') : null,
      supportDeviance: numeric(draft.support, 'support deviance cutoff') },
  };
  const content = JSON.stringify(input, null, 2);
  parsePlaqueGrowthInput(content);
  return content;
}
export async function readPlaqueGrowthFile(file: Pick<File, 'size' | 'arrayBuffer'>, limit: number, signal: AbortSignal): Promise<string> {
  check(signal);
  if (file.size > limit) throw new Error(`File exceeds the ${limit}-byte limit.`);
  const bytes = await file.arrayBuffer();
  check(signal);
  if (bytes.byteLength > limit) throw new Error(`File exceeds the ${limit}-byte limit.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export interface CorrectedPfuGrowthDraft {
  title: string; source: string; kind: 'user-supplied' | 'synthetic'; csv: string;
  centers: string; bootstrap: string; seed: string; extracellular: boolean;
}
/** Validate numeric draft values before JSON encoding can turn NaN into null. */
export function correctedPfuGrowthDraftContent(draft: CorrectedPfuGrowthDraft): string {
  if (!draft.extracellular) throw new Error('Confirm corrected extracellular free-phage PFU/mL, not total infective-center counts.');
  const numeric = (text: string, label: string): number => {
    if (!text.trim() || !/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) throw new Error(`Provide a finite nonnegative ${label}.`);
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`Provide a finite ${label}.`);
    return value;
  };
  const centers = draft.centers.trim() ? numeric(draft.centers, 'infected-center concentration') : null;
  const experiment: GrowthCurveExperiment = {
    schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml',
    title: draft.title, provenance: { kind: draft.kind, source: draft.source }, observations: parseGrowthCurveCSV(draft.csv),
    options: { infectedCentersPerMl: centers, bootstrapSamples: numeric(draft.bootstrap, 'bootstrap count'), seed: numeric(draft.seed, 'seed') },
  };
  // analysisJson rejects nonfinite values before they can become valid nulls.
  const content = JSON.stringify(analysisJson(experiment), null, 2);
  parseGrowthCurveRecordInput(content);
  return content;
}
