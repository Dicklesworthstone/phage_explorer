#!/usr/bin/env bun
/** Database-free categorical evidence, sharing the browser's numerical engine. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import {
  HOST_RANGE_LIMITS, HOST_RANGE_METHOD, parseHostRangeCSV, parseHostRangeExperiment,
  serializeHostRangeExperiment, hostRangeContexts, buildHostRangeMatrix,
  evaluateHostRangeCoverage, selectHostRangeCoverage,
  type HostRangeExperiment, type HostRangeQuery,
} from '../packages/core/src/analysis/host-range-evidence';

export const HOST_RANGE_HELP = `Measured host-range evidence (local files only)

bun scripts/host-range.ts inspect --input observations.csv
bun scripts/host-range.ts analyze --input observations.csv --assay plaque|spot
  --condition TEXT --output NEW.json [--min-replicates 1] [--max-size 3]
  [--phage ID ...] [--host ID ...] [--select ID ... | --greedy]
  [--title TEXT] [--synthetic]
bun scripts/host-range.ts replay --input experiment.json [--output NEW.json]

CSV/TSV header: phage_id,host_id,assay,condition,replicate,outcome,source
Outcome: positive, negative, or indeterminate. Exact strain IDs are not species aliases.
Assay and condition are mandatory when analyzing; different contexts are never pooled.
Repeat --phage/--host to filter candidates/targets and --select for manual coverage.
--greedy chooses observed positive coverage only, not an optimal or compatible mixture.
Without --select or --greedy the selection is empty, not an inferred recommendation.
--synthetic labels examples; user-supplied inputs are not independently verified.
inspect accepts CSV/TSV or saved JSON. replay recomputes the saved inputs and settings;
imported result fields are ignored, not authenticated. No observation validity is inferred.

Limits: 2 MB UTF-8; 5000 observations; 128 phages; 256 strains; 64 assay/condition pairs.
Inputs must be regular files. Outputs are owner-only and never overwrite existing paths.
JSON summaries go to stdout; errors go to stderr. No network, catalog, or terminal UI.
Single-phage results do not establish mixture compatibility, therapeutic efficacy or safety.
Spot clearing does not establish productive infection. Preserve the original assay records.
`;

export type HostRangeCommand = { type: 'help' }
  | { type: 'inspect'; inputPath: string }
  | { type: 'replay'; inputPath: string; outputPath?: string }
  | { type: 'analyze'; inputPath: string; outputPath: string; assay: HostRangeQuery['assay'];
    condition: string; minReplicates: number; phageIds?: string[]; hostIds?: string[];
    selectedPhageIds: string[]; greedy: boolean; maxSize: number; title: string;
    provenance: HostRangeExperiment['provenance'] };

export function parseHostRangeCommand(args: readonly string[]): HostRangeCommand {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (type !== 'inspect' && type !== 'analyze' && type !== 'replay') throw new Error('Choose inspect, analyze, or replay. Use --help for usage.');
  const options = {
    input: { type: 'string' as const },
    ...(type !== 'inspect' ? { output: { type: 'string' as const } } : {}),
    ...(type === 'analyze' ? {
      assay: { type: 'string' as const }, condition: { type: 'string' as const },
      'min-replicates': { type: 'string' as const }, 'max-size': { type: 'string' as const },
      phage: { type: 'string' as const, multiple: true }, host: { type: 'string' as const, multiple: true },
      select: { type: 'string' as const, multiple: true }, greedy: { type: 'boolean' as const },
      title: { type: 'string' as const }, synthetic: { type: 'boolean' as const },
    } : {}),
  };
  const { values, tokens } = parseArgs({ args: rest, options, strict: true, allowPositionals: false, tokens: true });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !['phage', 'host', 'select'].includes(token.name)) throw new Error(`Repeated option --${token.name}.`);
    seen.add(token.name);
  }
  const required = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide nonempty text for --${name}.`);
    return value;
  };
  const inputPath = required(values.input, 'input');
  if (type === 'inspect') return { type, inputPath };
  if (type === 'replay') return { type, inputPath, ...(values.output === undefined ? {} : { outputPath: required(values.output, 'output') }) };
  if (values.assay !== 'plaque' && values.assay !== 'spot') throw new Error('--assay must be plaque or spot.');
  if (values.greedy && values.select !== undefined) throw new Error('Choose --select or --greedy, not both.');
  const integer = (value: unknown, fallback: number, maximum: number, name: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new Error(`--${name} requires an integer from 1 to ${maximum}.`);
    return Number(value);
  };
  const ids = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error(`Repeat --${name} once per ID.`);
    return value.map(id => required(id, name));
  };
  return { type, inputPath, outputPath: required(values.output, 'output'), assay: values.assay,
    condition: required(values.condition, 'condition'),
    minReplicates: integer(values['min-replicates'], 1, 100, 'min-replicates'),
    maxSize: integer(values['max-size'], 3, 10, 'max-size'),
    phageIds: ids(values.phage, 'phage'), hostIds: ids(values.host, 'host'), selectedPhageIds: ids(values.select, 'select') ?? [],
    greedy: values.greedy === true, title: values.title === undefined ? 'Host-range observations' : required(values.title, 'title'),
    provenance: values.synthetic ? 'synthetic' : 'user-supplied' };
}

/** Bound allocation and the read itself, including file growth; reject FIFOs before blocking. */
async function readInput(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Host-range inputs must be regular files.');
    if (stat.size > HOST_RANGE_LIMITS.bytes) throw new Error('Host-range input exceeds the 2 MB UTF-8 limit.');
    const buffer = Buffer.alloc(HOST_RANGE_LIMITS.bytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > HOST_RANGE_LIMITS.bytes) throw new Error('Host-range input exceeds the 2 MB UTF-8 limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}

export async function executeHostRangeCommand(command: Exclude<HostRangeCommand, { type: 'help' }>): Promise<Record<string, unknown>> {
  const content = await readInput(command.inputPath);
  if (command.type === 'inspect') {
    const rows = content.trimStart().startsWith('{') ? parseHostRangeExperiment(content).observations : parseHostRangeCSV(content);
    return { method: HOST_RANGE_METHOD, observations: rows.length, contexts: hostRangeContexts(rows),
      phageIds: [...new Set(rows.map(row => row.phageId))].sort(), hostIds: [...new Set(rows.map(row => row.hostId))].sort() };
  }
  let experiment: HostRangeExperiment;
  if (command.type === 'replay') experiment = parseHostRangeExperiment(content);
  else {
    const observations = parseHostRangeCSV(content);
    const query: HostRangeQuery = { assay: command.assay, condition: command.condition, minReplicates: command.minReplicates,
      phageIds: command.phageIds ?? [...new Set(observations.map(row => row.phageId))],
      hostIds: command.hostIds ?? [...new Set(observations.map(row => row.hostId))] };
    const selectedPhageIds = command.greedy ? selectHostRangeCoverage(observations, query, command.maxSize).selectedPhageIds : command.selectedPhageIds;
    experiment = { schemaVersion: 1, method: HOST_RANGE_METHOD, title: command.title, provenance: command.provenance,
      observations, query, selectedPhageIds, maxSize: command.maxSize };
  }
  // Complete validation, normalization and serialization before opening the output.
  const serialized = serializeHostRangeExperiment(experiment);
  experiment = parseHostRangeExperiment(serialized);
  const matrix = buildHostRangeMatrix(experiment.observations, experiment.query);
  const coverage = evaluateHostRangeCoverage(experiment.observations, experiment.query, experiment.selectedPhageIds);
  if (command.outputPath) {
    const handle = await open(command.outputPath, 'wx', 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }
  return { method: HOST_RANGE_METHOD, recomputed: true, provenance: experiment.provenance, query: experiment.query,
    includedObservations: matrix.includedObservations, excludedObservations: matrix.excludedObservations,
    coverage, warnings: matrix.warnings, ...(command.outputPath ? { outputPath: command.outputPath } : {}) };
}

export async function hostRangeMain(args: readonly string[], output: (text: string) => void, error: (text: string) => void,
  invocation = 'bun scripts/host-range.ts'): Promise<number> {
  try {
    const command = parseHostRangeCommand(args);
    if (command.type === 'help') output(HOST_RANGE_HELP.replaceAll('bun scripts/host-range.ts', invocation));
    else output(JSON.stringify(await executeHostRangeCommand(command), null, 2) + '\n');
    return 0;
  } catch (cause) {
    error(stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n');
    return 1;
  }
}
if (import.meta.main) {
  void hostRangeMain(process.argv.slice(2), text => { process.stdout.write(text); }, text => { process.stderr.write(text); })
    .then(code => { process.exitCode = code; });
}
