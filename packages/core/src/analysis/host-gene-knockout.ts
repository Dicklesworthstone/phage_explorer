/** Explicit model-gene deletion experiments using Boolean GPRs, never annotation-to-capacity guesses.
 * Semantics: COBRApy knock_out_model_genes, AND complexes / OR alternatives; inactive reactions
 * have BOTH signed bounds set to zero. No organismal essentiality or kinetic inference is made.
 * https://cobrapy.readthedocs.io/en/latest/autoapi/cobra/manipulation/delete/index.html
 */
import { analyzeHostMetabolism, parseCobraHostModel, resolveHostFluxOptions, validateHostModelInput,
  type HostModelInput, type HostFluxScenario, type HostNetwork } from './host-metabolism';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const HOST_KNOCKOUT_LIMITS = { genes: 32, tokens: 4096, depth: 64, solves: 256 } as const;
export const HOST_KNOCKOUT_METHOD = { id: 'host-gene-knockout', version: '1',
  implementation: 'Strict Boolean GPR evaluation; zero signed reaction bounds; existing bounded simplex and objective-floor FVA' } as const;
type Expression = { kind: 'gene'; id: string } | { kind: 'and' | 'or'; children: Expression[] };
export interface GeneRule { expression: Expression | null; genes: string[] }
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(v) && !/^(and|or|not|xor|true|false)$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deliberately no eval/Function: reject syntax outside identifiers, parentheses, AND and OR. */
export function parseHostGeneRule(rule: string, declared: ReadonlySet<string>): GeneRule {
  if (typeof rule !== 'string' || rule.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(rule)) throw new Error('Invalid gene-reaction rule.');
  const tokens = rule.match(/\(|\)|[^\s()]+/g) ?? [];
  if (tokens.length > HOST_KNOCKOUT_LIMITS.tokens) throw new Error('Gene rule exceeds the token limit.');
  if (!tokens.length) return { expression: null, genes: [] };
  let cursor = 0;
  const genes = new Set<string>();
  const is = (op: string) => tokens[cursor]?.toLowerCase() === op;
  const atom = (depth: number): Expression => {
    if (depth > HOST_KNOCKOUT_LIMITS.depth) throw new Error('Gene rule exceeds the nesting limit.');
    if (is('(')) {
      cursor++; const node = disjunction(depth + 1);
      if (!is(')')) throw new Error('Unclosed gene-rule parenthesis.');
      cursor++; return node;
    }
    const id = tokens[cursor++];
    if (!identifier(id)) throw new Error('Gene rules support identifiers, parentheses, AND and OR only.');
    if (!declared.has(id)) throw new Error(`Gene rule references undeclared gene: ${id}`);
    genes.add(id); return { kind: 'gene', id };
  };
  const conjunction = (depth: number): Expression => {
    const children = [atom(depth)];
    while (is('and')) { cursor++; children.push(atom(depth)); }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  };
  const disjunction = (depth: number): Expression => {
    const children = [conjunction(depth)];
    while (is('or')) { cursor++; children.push(conjunction(depth)); }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  };
  const expression = disjunction(0);
  if (cursor !== tokens.length) throw new Error('Unexpected token or missing Boolean operator in gene rule.');
  return { expression, genes: [...genes].sort() };
}
export function hostGeneRuleActive(rule: GeneRule, absent: ReadonlySet<string>): boolean {
  const visit = (node: Expression): boolean => node.kind === 'gene' ? !absent.has(node.id)
    : node.kind === 'and' ? node.children.every(visit) : node.children.some(visit);
  // No association is unknown, not evidence that a reaction should be disabled.
  return rule.expression === null || visit(rule.expression);
}
export interface HostGeneOptions { genes: string[]; mode: 'joint' | 'single'; reference: string; variability: string[]; objectiveLoss: number }
export function resolveHostGeneOptions(value: unknown): HostGeneOptions {
  if (!object(value) || Object.keys(value).some(k => !['genes','mode','reference','variability','objectiveLoss'].includes(k))) throw new Error('Unsupported gene-knockout settings.');
  if (!Array.isArray(value.genes) || value.genes.length < 1 || value.genes.length > HOST_KNOCKOUT_LIMITS.genes || !value.genes.every(identifier)) throw new Error('Select 1–32 explicit model gene IDs (letters, digits, dot, underscore, colon or hyphen).');
  if (new Set(value.genes).size !== value.genes.length) throw new Error('Duplicate knockout gene IDs.');
  const mode = value.mode ?? 'joint';
  if (mode !== 'joint' && mode !== 'single') throw new Error('Knockout mode must be joint or single.');
  if (typeof value.reference !== 'string' || !value.reference.trim() || value.reference.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value.reference)) throw new Error('State the knockout experiment source or explicit what-if assumption.');
  const { variability, objectiveLoss } = resolveHostFluxOptions({ variability: value.variability, objectiveLoss: value.objectiveLoss });
  const runs = mode === 'joint' ? 1 : value.genes.length;
  if ((runs + 1) * (1 + 2 * variability.length) > HOST_KNOCKOUT_LIMITS.solves) throw new Error('Knockout screen exceeds 256 LP solves; select fewer genes or flux ranges.');
  return { genes: [...value.genes].sort(), mode, reference: value.reference.trim(), variability, objectiveLoss };
}
export interface HostGeneIndex { genes: Array<{ id: string; reactionIds: string[] }>; unassociatedReactions: string[] }
function index(input: HostModelInput): { network: HostNetwork; rules: Map<string, GeneRule>; report: HostGeneIndex } {
  const network = parseCobraHostModel(input.cobra);
  const raw = input.cobra as Record<string, unknown>;
  if (!Array.isArray(raw.genes) || !raw.genes.length) throw new Error('Gene knockouts require a declared COBRA gene list; no IDs are inferred from labels.');
  const ids = raw.genes.map(g => {
    if (!object(g) || !identifier(g.id)) throw new Error('Model has a gene ID outside the supported Boolean-rule identifier syntax.');
    return g.id;
  });
  const declared = new Set(ids), rules = new Map<string, GeneRule>();
  for (const reaction of network.reactions) {
    try { rules.set(reaction.id, parseHostGeneRule(reaction.geneRule, declared)); }
    catch (cause) { throw new Error(`Reaction ${reaction.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return { network, rules, report: {
    genes: [...ids].sort().map(id => ({ id, reactionIds: network.reactions.filter(r => rules.get(r.id)!.genes.includes(id)).map(r => r.id) })),
    unassociatedReactions: network.reactions.filter(r => !rules.get(r.id)!.expression).map(r => r.id),
  } };
}
export function inspectHostGeneRules(value: HostModelInput): HostGeneIndex { return index(validateHostModelInput(value)).report; }
export interface HostKnockoutRun {
  genes: string[];
  disabled: Array<{ reactionId: string; rule: string; genes: string[]; previousLowerBound: number; previousUpperBound: number }>;
  unassociatedGenes: string[];
  scenario: HostFluxScenario;
  objectiveDelta: number | null;
  relativeObjective: number | null;
}
export interface HostGeneResult {
  options: HostGeneOptions; index: HostGeneIndex; baseline: HostFluxScenario; runs: HostKnockoutRun[]; warnings: string[];
}
export function analyzeHostGeneKnockouts(value: HostModelInput, settings: unknown, progress: (phase: string) => void = () => {}): HostGeneResult {
  const input = validateHostModelInput(value), options = resolveHostGeneOptions(settings), { network, rules, report } = index(input);
  if (options.genes.some(id => !report.genes.some(g => g.id === id))) throw new Error('A selected gene is not declared in this exact host model.');
  // All syntax and work-budget checks happen before the first numerical solve.
  const fluxOptions = { variability: options.variability, objectiveLoss: options.objectiveLoss };
  const baseline = analyzeHostMetabolism(input, fluxOptions, progress).baseline;
  const medium = new Map(input.medium.bounds.map(b => [b.reactionId, b]));
  const groups = options.mode === 'joint' ? [options.genes] : options.genes.map(id => [id]);
  const runs = groups.map((genes, i): HostKnockoutRun => {
    progress(`Gene knockout ${i + 1}/${groups.length}`);
    const absent = new Set(genes);
    const disabled = network.reactions.filter(r => !hostGeneRuleActive(rules.get(r.id)!, absent)).map(r => ({
      reactionId: r.id, rule: r.geneRule, genes: rules.get(r.id)!.genes,
      previousLowerBound: medium.get(r.id)?.lowerBound ?? r.lowerBound,
      previousUpperBound: medium.get(r.id)?.upperBound ?? r.upperBound,
    }));
    const bounds = new Map(medium);
    for (const r of disabled) bounds.set(r.reactionId, { reactionId: r.reactionId, lowerBound: 0, upperBound: 0 });
    const scenario = disabled.length ? analyzeHostMetabolism({ ...input, medium: { ...input.medium, bounds: [...bounds.values()] } }, fluxOptions, progress).baseline : structuredClone(baseline);
    const comparable = baseline.status === 'optimal' && scenario.status === 'optimal' && baseline.objective !== null && scenario.objective !== null;
    return { genes: [...genes], disabled, unassociatedGenes: genes.filter(id => !report.genes.find(g => g.id === id)!.reactionIds.length), scenario,
      objectiveDelta: comparable ? scenario.objective! - baseline.objective! : null,
      // Ratios are not meaningful for zero or negative model baselines.
      relativeObjective: comparable && baseline.objective! > 1e-9 ? scenario.objective! / baseline.objective! : null };
  });
  return { options, index: report, baseline, runs, warnings: [
    'Conditional Boolean gene-deletion model, not measured essentiality, viability, fitness, host range or phage AMG activity.',
    'Declared genes not deleted are assumed functional. AND requires all components; OR permits alternatives. Association rules are supplied model evidence, not independently verified.',
    'An inactive rule sets both signed bounds to zero, overriding that reaction\'s medium bounds and any forced flux. Original bounds are retained in the result.',
    'Empty rules do not disable reactions. A gene with no associated reactions is reported as unassociated, not biologically dispensable.',
    'All deletions in a joint run apply simultaneously. Single mode is a set of separate deletions, not cumulative deletions or a combinatorial search.',
    'A non-optimal solver status is unavailable evidence, not a lethal knockout. Negative or zero baseline objectives have no reported objective ratio.',
    'Flux ranges describe alternative objective-constrained optima, not uncertainty intervals. Regulatory, kinetic, thermodynamic and loopless constraints are absent.',
    ...(input.source.kind === 'demo' ? ['Synthetic numerical example; no organism-specific calibration.'] : []),
  ] };
}
export function createHostGeneRecord(value: HostModelInput, result: HostGeneResult): Promise<AnalysisRecord> {
  const input = validateHostModelInput(value);
  return createAnalysisRecord({ method: HOST_KNOCKOUT_METHOD,
    inputs: [{ id: 'hostModel', accession: input.source.accession, source: input.source.kind === 'reference' ? 'external' : input.source.kind,
      description: input.source.name, data: analysisJson(input) }],
    parameters: analysisJson(resolveHostGeneOptions(result.options)) as AnalysisRecord['parameters'], seed: null,
    references: [{ id: 'host-model', version: input.source.version, description: input.source.reference },
      { id: 'boolean-gpr-deletion', version: '1', description: 'COBRA Boolean gene deletion semantics: AND complexes, OR alternatives, both inactive reaction bounds set to zero.' }],
    fields: { experiment: { label: 'Conditional gene-deletion scenarios and association coverage', kind: input.source.kind === 'demo' ? 'demo' : 'simulation',
      units: 'model-flux', value: analysisJson(result), coverage: { available: result.runs.filter(r => r.scenario.status === 'optimal').length,
        total: result.runs.length, unit: 'records' }, assumptions: ['Exact supplied host model and medium; binary gene availability; maximized model objective.'], limitations: result.warnings } } });
}
export async function replayHostGeneRecord(content: string, progress: (phase: string) => void = () => {}): Promise<{ input: HostModelInput; result: HostGeneResult; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: HOST_KNOCKOUT_METHOD.id, methodVersion: HOST_KNOCKOUT_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'hostModel') throw new Error('Unsupported gene-knockout input contract.');
  const input = validateHostModelInput(saved.inputs[0].data), result = analyzeHostGeneKnockouts(input, saved.parameters, progress);
  const record = await createHostGeneRecord(input, result);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) throw new Error('Fresh gene-knockout results or evidence differ from the saved experiment.');
  return { input, result, record };
}
