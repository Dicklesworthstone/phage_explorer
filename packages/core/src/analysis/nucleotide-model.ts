/** Supplied stationary reversible DNA models, with branch lengths in expected substitutions/site.
 * Exchangeability order: AC, AG, AT, CG, CT, GT; state order: A, C, G, T.
 * Rate categories belong to a whole site, NOT independently to each branch.
 * No parameters, base frequencies, category weights or branch lengths are fitted here.
 */
export type DnaFrequencies = [number, number, number, number];
export type DnaExchangeabilities = [number, number, number, number, number, number];
export interface SiteRateCategory { rate: number; weight: number }
interface SuppliedModelContext { source: string; siteRates: SiteRateCategory[] }
export type NucleotideModel = SuppliedModelContext & (
  | { model: 'JC69' }
  | { model: 'HKY85'; frequencies: DnaFrequencies; kappa: number }
  | { model: 'GTR'; frequencies: DnaFrequencies; exchangeabilities: DnaExchangeabilities }
);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unsupported ${label} field.`);
}

/** Preserve submitted numbers. Reject a different scale instead of silently changing branch units. */
export function resolveNucleotideModel(value: unknown): NucleotideModel {
  if (!object(value) || !['JC69', 'HKY85', 'GTR'].includes(String(value.model))) throw new Error('Select JC69, HKY85 or GTR with explicit model parameters.');
  const allowed = ['model', 'source', 'siteRates', ...(value.model === 'JC69' ? [] : ['frequencies']),
    ...(value.model === 'HKY85' ? ['kappa'] : value.model === 'GTR' ? ['exchangeabilities'] : [])];
  keys(value, allowed, 'substitution model');
  if (typeof value.source !== 'string' || !value.source.trim() || value.source.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value.source)) {
    throw new Error('State the source or assumption for the supplied substitution model and site rates.');
  }
  const rawRates = value.siteRates === undefined ? [{ rate: 1, weight: 1 }] : value.siteRates;
  if (!Array.isArray(rawRates) || !rawRates.length || rawRates.length > 8) throw new Error('Supply one to eight site-rate categories.');
  const siteRates = rawRates.map(category => {
    if (!object(category)) throw new Error('Invalid site-rate category.');
    keys(category, ['rate', 'weight'], 'site-rate category');
    if (!finite(category.rate) || category.rate < 0 || category.rate > 1000 || !finite(category.weight) || category.weight <= 0 || category.weight > 1) {
      throw new Error('Site rates must be finite, nonnegative and <= 1000; category weights must be positive and <= 1.');
    }
    return { rate: category.rate, weight: category.weight };
  });
  if (Math.abs(siteRates.reduce((s, c) => s + c.weight, 0) - 1) > 1e-12 ||
    Math.abs(siteRates.reduce((s, c) => s + c.weight * c.rate, 0) - 1) > 1e-12) {
    throw new Error('Category weights and weighted mean rate must each sum to one; branch units are not silently rescaled.');
  }
  const context = { source: value.source.trim(), siteRates };
  if (value.model === 'JC69') return { model: 'JC69', ...context };
  const frequencies = value.frequencies;
  if (!Array.isArray(frequencies) || frequencies.length !== 4 || frequencies.some(p => !finite(p) || p < 1e-6 || p >= 1) ||
    Math.abs(frequencies.reduce((s, p) => s + p, 0) - 1) > 1e-12) throw new Error('Supply A,C,G,T frequencies >= 0.000001 summing to one.');
  if (value.model === 'HKY85') {
    if (!finite(value.kappa) || value.kappa < 1e-6 || value.kappa > 1e6) throw new Error('HKY kappa must be between 0.000001 and 1000000.');
    return { model: 'HKY85', frequencies: [...frequencies] as DnaFrequencies, kappa: value.kappa, ...context };
  }
  const exchangeabilities = value.exchangeabilities;
  if (!Array.isArray(exchangeabilities) || exchangeabilities.length !== 6 || exchangeabilities.some(r => !finite(r) || r < 1e-6 || r > 1e6)) {
    throw new Error('Supply six positive GTR exchangeabilities (AC,AG,AT,CG,CT,GT), each between 0.000001 and 1000000.');
  }
  return { model: 'GTR', frequencies: [...frequencies] as DnaFrequencies, exchangeabilities: [...exchangeabilities] as DnaExchangeabilities, ...context };
}
const identity = (): number[] => Array.from({ length: 16 }, (_, i) => Math.floor(i / 4) === i % 4 ? 1 : 0);
function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4), column = index % 4;
    let value = 0; for (let k = 0; k < 4; k++) value += a[row * 4 + k] * b[k * 4 + column];
    return value;
  });
}
function stochastic(matrix: number[]): number[] {
  for (let i = 0; i < 4; i++) {
    const sum = matrix.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-11) throw new Error('Transition matrix failed its stochastic-row check.');
    for (let j = 0; j < 4; j++) {
      const index = i * 4 + j;
      if (!finite(matrix[index]) || matrix[index] < 0) throw new Error('Transition matrix contains invalid probabilities.');
      // Only floating-point summation drift is removed; no negative values are clipped.
      matrix[index] /= sum;
    }
  }
  return matrix;
}
export interface NucleotideKernel {
  frequencies: DnaFrequencies;
  /** Row-major generator Q, normalized so -sum(pi_i Q_ii)=1. */
  generator: number[];
  /** Row-major conditional transition probabilities P(child | parent). */
  transition: (length: number) => number[];
  /** Log probabilities retain rare transitions below the floating-point probability range. */
  logTransition: (length: number) => number[];
}

/** Poisson uniformization plus scaling/squaring uses nonnegative operations.
 * It avoids cancellation in off-diagonal entries on very short branches and
 * eigenvector instability when reversible model eigenvalues coincide.
 */
export function createNucleotideKernel(specification: NucleotideModel): NucleotideKernel {
  const model = resolveNucleotideModel(specification);
  const supplied = model.model === 'JC69' ? [0.25, 0.25, 0.25, 0.25] : model.frequencies;
  const sum = supplied.reduce((s, p) => s + p, 0);
  const frequencies = supplied.map(p => p / sum) as DnaFrequencies;
  const rates = model.model === 'JC69' ? [1, 1, 1, 1, 1, 1] : model.model === 'HKY85'
    ? [1, model.kappa, 1, 1, model.kappa, 1] : model.exchangeabilities;
  const generator = new Array<number>(16).fill(0);
  let pair = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    generator[i * 4 + j] = rates[pair] * frequencies[j];
    generator[j * 4 + i] = rates[pair++] * frequencies[i];
  }
  for (let i = 0; i < 4; i++) generator[i * 4 + i] = -generator.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b, 0);
  const meanRate = -frequencies.reduce((s, p, i) => s + p * generator[i * 4 + i], 0);
  for (let i = 0; i < 16; i++) generator[i] /= meanRate;
  const lambda = Math.max(...[0, 1, 2, 3].map(i => -generator[i * 4 + i]));
  const jump = generator.map((q, i) => (i % 5 === 0 ? 1 : 0) + q / lambda);
  const logTransition = (length: number): number[] => {
    if (!finite(length) || length < 0 || length > 1e9) throw new Error('Effective branch length must be finite and between zero and 1000000000 substitutions/site.');
    if (length === 0) return identity().map(Math.log);
    // Direct exchange rates are strictly positive. For t < 1e-100, all
    // relative higher-order terms are below double precision throughout the
    // supported parameter range. Keep rare transitions in log space.
    if (length < 1e-100) return generator.map((q, i) => i % 5 === 0 ? q * length : Math.log(q) + Math.log(length));
    if (model.model === 'JC69') {
      const different = -Math.expm1(-4 * length / 3) / 4;
      return Array.from({ length: 16 }, (_, i) => Math.log(i % 5 === 0 ? 1 - 3 * different : different));
    }
    const theta = lambda * length;
    const squarings = Math.max(0, Math.ceil(Math.log2(theta / 0.5)));
    const scaled = theta / 2 ** squarings;
    let power = identity(), weight = Math.exp(-scaled);
    const result = power.map(p => p * weight);
    // At scaled <= 1/2, 24 terms make the omitted Poisson mass < 1e-32.
    // Retain small positive transition entries even below an absolute tail threshold.
    for (let k = 1; k <= 24; k++) {
      power = multiply(power, jump); weight *= scaled / k;
      for (let i = 0; i < 16; i++) result[i] += weight * power[i];
    }
    let probability = stochastic(result);
    for (let i = 0; i < squarings; i++) probability = stochastic(multiply(probability, probability));
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      if (Math.abs(frequencies[i] * probability[i * 4 + j] - frequencies[j] * probability[j * 4 + i]) > 1e-10) {
        throw new Error('Transition matrix failed detailed balance.');
      }
    }
    return probability.map(Math.log);
  };
  return { frequencies, generator, logTransition, transition: length => logTransition(length).map(Math.exp) };
}
