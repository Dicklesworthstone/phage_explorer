/** Complete results for a canonical research tape. Records are stored once; each
 * execution's identity comes from the tape, never an independently editable map.
 * Integrity checks are not numerical replay or authentication of the input data.
 */
import { parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from './analysis-result';
import { COMMAND_LIMITS, commandValuesEqual, parseCommandTape, type CommandValue } from './command-session';

export const WORKFLOW_RESULTS_LIMITS = { bytes: 32 * 1024 * 1024, records: COMMAND_LIMITS.commands } as const;
export interface WorkflowResults {
  format: 'phage-explorer-workflow-results'; version: 1;
  /** Exact original tape, including its private source bundle. */
  tapeJson: string;
  repetitions: number;
  /** In first-execution order, without duplicates or unreferenced records. */
  records: AnalysisRecord[];
}
export interface WorkflowResultEntry {
  execution: number; iteration: number; step: number; actionId: string;
  analysis: Pick<AnalysisRecord, 'method' | 'cacheKey' | 'resultId'> | null;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Workflow results cancelled.', 'AbortError');
}
function identity(value: CommandValue): WorkflowResultEntry['analysis'] {
  if (!isObject(value)) throw new Error('Workflow results require canonical research outputs.');
  const keys = Object.keys(value).sort().join('|');
  if (keys === 'sequenceSha256|view' && sha(value.sequenceSha256) && isObject(value.view)) return null;
  if (keys !== 'cacheKey|method|resultId' || !sha(value.cacheKey) || !sha(value.resultId)
    || !isObject(value.method) || Object.keys(value.method).sort().join('|') !== 'id|implementation|version'
    || ![value.method.id, value.method.version, value.method.implementation].every(v => typeof v === 'string' && v.trim())) {
    throw new Error('Workflow results require canonical research analysis or navigation outputs.');
  }
  return value as unknown as NonNullable<WorkflowResultEntry['analysis']>;
}
/** Repetitions preserve execution numbers; navigation is never an analysis. */
export function workflowResultIndex(tapeJson: string, repetitions: number): WorkflowResultEntry[] {
  const tape = parseCommandTape(tapeJson);
  if (!tape.commands.length || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > COMMAND_LIMITS.repetitions
    || tape.commands.length * repetitions > COMMAND_LIMITS.executions) throw new Error('Invalid workflow result execution count.');
  const outputs = tape.commands.map(command => identity(command.expected));
  return Array.from({ length: tape.commands.length * repetitions }, (_, i) => {
    const step = i % tape.commands.length;
    return { execution: i + 1, iteration: Math.floor(i / tape.commands.length) + 1, step: step + 1,
      actionId: tape.commands[step].actionId, analysis: outputs[step] === null ? null : structuredClone(outputs[step]) };
  });
}
function bounded(text: string): string {
  if (typeof text !== 'string' || text.length > WORKFLOW_RESULTS_LIMITS.bytes
    || new TextEncoder().encode(text).length > WORKFLOW_RESULTS_LIMITS.bytes) throw new Error('Complete workflow results exceed the 32 MiB limit; no partial archive was produced.');
  return text;
}
/** Validate every record hash and its ordered tape binding. Does NOT run methods. */
export async function parseWorkflowResults(content: string, signal?: AbortSignal): Promise<WorkflowResults> {
  abort(signal);
  const value: unknown = JSON.parse(bounded(content));
  if (!isObject(value) || Object.keys(value).sort().join('|') !== 'format|records|repetitions|tapeJson|version'
    || value.format !== 'phage-explorer-workflow-results' || value.version !== 1 || typeof value.tapeJson !== 'string'
    || typeof value.repetitions !== 'number' || !Array.isArray(value.records) || value.records.length > WORKFLOW_RESULTS_LIMITS.records) {
    throw new Error('Invalid complete workflow results format.');
  }
  const index = workflowResultIndex(value.tapeJson, value.repetitions);
  const expected = new Map<string, NonNullable<WorkflowResultEntry['analysis']>>();
  for (const entry of index) if (entry.analysis) {
    const before = expected.get(entry.analysis.resultId);
    if (before && !commandValuesEqual(before, entry.analysis)) throw new Error('Conflicting recorded analysis identities.');
    expected.set(entry.analysis.resultId, entry.analysis);
  }
  if (value.records.length !== expected.size) throw new Error('Complete workflow results are missing analyses or contain extra records.');
  const records: AnalysisRecord[] = [];
  const identities = [...expected.values()];
  for (let i = 0; i < value.records.length; i++) {
    abort(signal);
    const record = await parseAnalysisRecord(JSON.stringify(value.records[i]));
    abort(signal);
    if (!commandValuesEqual(identities[i], { method: record.method, cacheKey: record.cacheKey, resultId: record.resultId })) {
      throw new Error(`Workflow result ${i + 1} differs from its recorded analysis or first-execution order.`);
    }
    records.push(record);
  }
  return { format: 'phage-explorer-workflow-results', version: 1, tapeJson: value.tapeJson,
    repetitions: value.repetitions, records };
}
export function serializeWorkflowResults(archive: WorkflowResults): string {
  return bounded(JSON.stringify(archive, null, 2));
}
/** Opt-in bounded capture. It never evicts earlier evidence to admit later work.
 * Exact repeats are deduplicated, but each execution remains in the tape index.
 */
export class WorkflowResultCollector {
  private readonly records = new Map<string, string>();
  private bytes = 0;
  add(record: AnalysisRecord): void {
    const text = serializeAnalysisRecord(record), before = this.records.get(record.resultId);
    if (before !== undefined) {
      if (before !== text) throw new Error('Conflicting evidence uses the same result identity.');
      return;
    }
    const bytes = new TextEncoder().encode(text).length;
    if (this.records.size >= WORKFLOW_RESULTS_LIMITS.records || this.bytes + bytes > WORKFLOW_RESULTS_LIMITS.bytes) {
      throw new Error('Complete workflow results exceed the retention limit; no partial archive was produced.');
    }
    this.records.set(record.resultId, text); this.bytes += bytes;
  }
  async finish(tapeJson: string, repetitions: number, signal?: AbortSignal): Promise<string> {
    abort(signal);
    // Snapshot before awaiting so later caller activity cannot change this export.
    const archive: WorkflowResults = { format: 'phage-explorer-workflow-results', version: 1, tapeJson, repetitions,
      records: [...this.records.values()].map(text => JSON.parse(text) as AnalysisRecord) };
    const text = serializeWorkflowResults(archive);
    await parseWorkflowResults(text, signal);
    return text;
  }
}
/** Return the existing portable record for a 1-based execution, not the last
 * result before a navigation step. Callers must establish archive integrity first.
 */
export function workflowAnalysisAt(archive: WorkflowResults, execution: number): AnalysisRecord {
  const index = workflowResultIndex(archive.tapeJson, archive.repetitions);
  if (!Number.isSafeInteger(execution) || execution < 1 || execution > index.length) throw new Error('Choose an existing 1-based workflow execution.');
  const entry = index[execution - 1];
  if (!entry.analysis) throw new Error(`Execution ${execution} is navigation, not an analysis.`);
  const record = archive.records.find(record => record.resultId === entry.analysis!.resultId);
  if (!record) throw new Error('The selected workflow result is unavailable.');
  return structuredClone(record);
}
