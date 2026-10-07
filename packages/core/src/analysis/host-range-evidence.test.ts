import { describe, test, expect } from 'bun:test';
import {
  HOST_RANGE_METHOD, HOST_RANGE_LIMITS, parseHostRangeCSV, validateHostRangeObservations,
  hostRangeContexts, buildHostRangeMatrix, evaluateHostRangeCoverage, selectHostRangeCoverage,
  parseHostRangeExperiment, serializeHostRangeExperiment,
  type HostRangeObservation, type HostRangeQuery, type HostRangeExperiment,
} from './host-range-evidence';
const observation = (overrides: Partial<HostRangeObservation> = {}): HostRangeObservation => ({
  phageId: 'P1', hostId: 'H1', assay: 'plaque', condition: 'batch A', replicate: 'r1', outcome: 'positive', source: 'fixture', ...overrides,
});
const rows = [observation(), observation({ hostId: 'H2', outcome: 'negative' }), observation({ phageId: 'P2', hostId: 'H2' }), observation({ phageId: 'P3', hostId: 'H3', outcome: 'indeterminate' })];
const query: HostRangeQuery = { assay: 'plaque', condition: 'batch A', minReplicates: 1, phageIds: ['P1', 'P2', 'P3'], hostIds: ['H1', 'H2', 'H3'] };
const header = 'phage_id,host_id,assay,condition,replicate,outcome,source';
const csv = header + '\nP1,H1,plaque,batch A,r1,positive,fixture';
const experiment: HostRangeExperiment = { schemaVersion: 1, method: HOST_RANGE_METHOD, title: 'Synthetic tests', provenance: 'synthetic', observations: rows, query, selectedPhageIds: ['P1'], maxSize: 3 };
const status = (input: HostRangeObservation[], minReplicates = 1) => buildHostRangeMatrix(input, { ...query, minReplicates, phageIds: ['P1'], hostIds: ['H1'] }).cells[0][0].status;

describe('strict host-range import', () => {
  test('parses CSV and TSV with BOM, CRLF and quoted fields', () => {
    expect(parseHostRangeCSV(csv)).toEqual([observation()]);
    expect(parseHostRangeCSV('\ufeff' + csv.replaceAll(',', '\t').replaceAll('\n', '\r\n'))).toEqual([observation()]);
    expect(parseHostRangeCSV(header + '\n"P,1",H1,plaque,batch A,r1,positive,"a ""quoted"" source"')[0].source).toBe('a "quoted" source');
  });
  for (const bad of [header, header + '\nP1,H1,plaque,A,r1,positive', csv + ',extra', csv.replace('positive', ''), csv.replace('positive', 'true'), csv.replace('plaque,batch', 'eop,batch'), csv.replace('fixture', '"unterminated'), csv.replace('fixture', '"closed"junk'), csv.replace('fixture', 'un"quoted')]) {
    test(`rejects malformed or ambiguous input ${bad.slice(-35)}`, () => expect(() => parseHostRangeCSV(bad)).toThrow());
  }
  test('rejects oversized UTF-8 rather than counting only characters', () => {
    expect(() => parseHostRangeCSV('é'.repeat(HOST_RANGE_LIMITS.bytes / 2 + 1))).toThrow('2 MB');
  });
  test('rejects sparse or missing observations', () => {
    const sparse = [observation()]; sparse.length++;
    expect(() => validateHostRangeObservations(sparse)).toThrow('Observation 2');
    expect(() => validateHostRangeObservations([])).toThrow();
  });
  test('rejects duplicate assay/source/replicate identity even with contradictory outcomes', () => {
    expect(() => validateHostRangeObservations([observation(), observation()])).toThrow('duplicate');
    expect(() => validateHostRangeObservations([observation(), observation({ outcome: 'negative' })])).toThrow('duplicate');
  });
  test('retains same replicate label in independently sourced records', () => {
    expect(validateHostRangeObservations([observation(), observation({ source: 'other laboratory' })])).toHaveLength(2);
  });
  test('does not collapse strain IDs, case, or delimiter-containing IDs', () => {
    const input = [observation({ phageId: 'a|b', hostId: 'c' }), observation({ phageId: 'a', hostId: 'b|c' }), observation({ phageId: 'A', hostId: 'H1' })];
    expect(validateHostRangeObservations(input)).toHaveLength(3);
  });
  test('rejects population and context dimensions above hard bounds', () => {
    expect(() => validateHostRangeObservations(Array.from({ length: 129 }, (_, i) => observation({ phageId: String(i) })))).toThrow('128');
    expect(() => validateHostRangeObservations(Array.from({ length: 257 }, (_, i) => observation({ hostId: String(i) })))).toThrow('256');
    expect(() => validateHostRangeObservations(Array.from({ length: 65 }, (_, i) => observation({ condition: String(i) })))).toThrow('64');
  });
});

describe('evidence matrix and observational coverage', () => {
  test('distinguishes positive, negative, untested, indeterminate, mixed and insufficient', () => {
    const matrix = buildHostRangeMatrix(rows, query);
    expect(matrix.cells[0].map(cell => cell.status)).toEqual(['positive', 'negative', 'untested']);
    expect(matrix.cells[2][2].status).toBe('indeterminate');
    expect(status([observation()], 2)).toBe('insufficient');
    expect(status([observation(), observation({ replicate: 'r2', outcome: 'negative' })])).toBe('mixed');
    expect(status([observation(), observation({ replicate: 'r2', outcome: 'indeterminate' })])).toBe('indeterminate');
    expect(status([observation(), observation({ replicate: 'r2' })], 2)).toBe('positive');
  });
  test('never pools different assays or conditions to meet a replicate threshold', () => {
    const input = [observation(), observation({ assay: 'spot' }), observation({ condition: 'batch B' })];
    expect(status(input, 2)).toBe('insufficient');
    expect(hostRangeContexts(input)).toHaveLength(3);
    expect(buildHostRangeMatrix(input, { ...query, phageIds: ['P1'], hostIds: ['H1'] }).excludedObservations).toBe(2);
  });
  test('preserves row-level evidence links', () => {
    const matrix = buildHostRangeMatrix(rows, query);
    expect(matrix.cells[1][1].observationIndices).toEqual([2]);
    expect(rows[matrix.cells[1][1].observationIndices[0]].source).toBe('fixture');
  });
  test('empty selection is unresolved, never all-negative', () => {
    const coverage = evaluateHostRangeCoverage(rows, query, []);
    expect(coverage.supportedHostIds).toEqual([]);
    expect(coverage.negativeHostIds).toEqual([]);
    expect(coverage.unresolvedHostIds).toEqual(['H1', 'H2', 'H3']);
  });
  test('selected unknown cells remain unresolved while recorded negatives remain negative', () => {
    const coverage = evaluateHostRangeCoverage(rows, query, ['P1']);
    expect(coverage.supportedHostIds).toEqual(['H1']);
    expect(coverage.negativeHostIds).toEqual(['H2']);
    expect(coverage.unresolvedHostIds).toEqual(['H3']);
  });
  test('greedy selection uses positive observations, stops without invented gains, and names uncovered hosts', () => {
    const result = selectHostRangeCoverage(rows, query, 3);
    expect(result.selectedPhageIds).toEqual(['P1', 'P2']);
    expect(result.supportedHostIds).toEqual(['H1', 'H2']);
    expect(result.unresolvedHostIds).toEqual(['H3']);
    expect(result.coverageFraction).toBeCloseTo(2 / 3);
    expect(result.optimalityProven).toBe(false);
  });
  test('tie-breaking and selection do not depend on import order', () => {
    const forward = selectHostRangeCoverage(rows, query, 1);
    const reverse = selectHostRangeCoverage([...rows].reverse(), { ...query, phageIds: [...query.phageIds].reverse() }, 1);
    expect(forward).toEqual(reverse);
    expect(forward.selectedPhageIds).toEqual(['P1']);
  });
  test('does not mutate frozen observations or query arrays', () => {
    const frozen = Object.freeze(rows.map(row => Object.freeze({ ...row })));
    const frozenQuery = { ...query, phageIds: [...query.phageIds], hostIds: [...query.hostIds] };
    Object.freeze(frozenQuery.phageIds); Object.freeze(frozenQuery.hostIds); Object.freeze(frozenQuery);
    expect(selectHostRangeCoverage(frozen, frozenQuery, 2).supportedHostIds).toEqual(['H1', 'H2']);
  });
  test('rejects empty targets, unknown IDs, duplicates, missing context, and noninteger thresholds', () => {
    for (const change of [{ hostIds: [] }, { hostIds: ['missing'] }, { phageIds: ['P1', 'P1'] }, { condition: 'missing' }, { minReplicates: 0 }, { minReplicates: NaN }, { minReplicates: 1.5 }]) {
      expect(() => buildHostRangeMatrix(rows, { ...query, ...change })).toThrow();
    }
    expect(() => evaluateHostRangeCoverage(rows, query, ['P1', 'P1'])).toThrow();
    expect(() => evaluateHostRangeCoverage(rows, query, ['missing'])).toThrow();
    for (const size of [0, 11, 1.5, NaN, Infinity]) expect(() => selectHostRangeCoverage(rows, query, size)).toThrow();
  });
  test('spot clearing carries an explicit productive-infection limitation', () => {
    const input = [observation({ assay: 'spot' })];
    expect(buildHostRangeMatrix(input, { ...query, assay: 'spot', phageIds: ['P1'], hostIds: ['H1'] }).warnings.some(warning => warning.includes('not proof of productive infection'))).toBe(true);
  });
  test('opposing observations are not outvoted by a larger positive count', () => {
    const input = Array.from({ length: 10 }, (_, i) => observation({ replicate: `r${i}`, outcome: i === 9 ? 'negative' : 'positive' }));
    expect(status(input, 3)).toBe('mixed');
  });
  test('magic property names cannot corrupt identity maps', () => {
    const input = [observation({ phageId: '__proto__', hostId: 'constructor' })];
    const result = selectHostRangeCoverage(input, { ...query, phageIds: ['__proto__'], hostIds: ['constructor'] }, 1);
    expect(result.supportedHostIds).toEqual(['constructor']);
  });
  test('selection and manual coverage agree across generated sparse matrices', () => {
    for (let seed = 0; seed < 15; seed++) {
      const input: HostRangeObservation[] = [];
      for (let p = 0; p < 5; p++) for (let h = 0; h < 7; h++) {
        if ((p + h + seed) % 4 === 0) continue;
        input.push(observation({ phageId: `P${p}`, hostId: `H${h}`, outcome: (p * 7 + h + seed) % 3 === 0 ? 'positive' : 'negative' }));
      }
      const q = { ...query, phageIds: [...new Set(input.map(row => row.phageId))], hostIds: [...new Set(input.map(row => row.hostId))] };
      const result = selectHostRangeCoverage(input, q, 3);
      const expectedHosts = q.hostIds.filter(host => input.some(row => row.hostId === host && row.outcome === 'positive' && result.selectedPhageIds.includes(row.phageId))).sort();
      expect(result.supportedHostIds).toEqual(expectedHosts);
      expect(evaluateHostRangeCoverage(input, q, result.selectedPhageIds).supportedHostIds).toEqual(expectedHosts);
    }
  });
});

describe('self-contained experiment replay', () => {
  test('round trip is deterministic and ignores forged result fields', () => {
    const saved = serializeHostRangeExperiment(experiment);
    const forged = JSON.parse(saved); forged.result = { coverageFraction: 1 };
    const parsed = parseHostRangeExperiment(JSON.stringify(forged));
    expect(parsed).toEqual(experiment);
    expect(serializeHostRangeExperiment(parsed)).toBe(saved);
    expect(selectHostRangeCoverage(parsed.observations, parsed.query, 3).coverageFraction).toBeCloseTo(2 / 3);
  });
  test('preserves synthetic provenance and exact source identities', () => {
    const parsed = parseHostRangeExperiment(serializeHostRangeExperiment(experiment));
    expect(parsed.provenance).toBe('synthetic'); expect(parsed.observations).toEqual(rows);
  });
  test('replays manual selection and refuses missing or forged selection settings', () => {
    const saved = JSON.parse(serializeHostRangeExperiment(experiment));
    expect(saved.result.supportedHostIds).toEqual(['H1']);
    for (const change of [{ selectedPhageIds: ['absent'] }, { selectedPhageIds: undefined }, { maxSize: 0 }, { maxSize: 11 }]) {
      expect(() => parseHostRangeExperiment(JSON.stringify({ ...experiment, ...change }))).toThrow();
    }
  });
  test('rejects unknown versions, missing provenance and nonfinite options before JSON conversion', () => {
    for (const change of [{ schemaVersion: 2 }, { method: 'future' }, { provenance: undefined }]) {
      expect(() => parseHostRangeExperiment(JSON.stringify({ ...experiment, ...change }))).toThrow();
    }
    expect(() => serializeHostRangeExperiment({ ...experiment, query: { ...query, minReplicates: Infinity } })).toThrow();
  });
});
