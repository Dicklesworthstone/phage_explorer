/** Network-dependent conformance, separate from the deterministic unit suite. No private inputs. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeHostMetabolism, createHostFluxRecord, parseCobraHostModel, replayHostFluxRecord } from '../packages/core/src/analysis/host-metabolism';
import { ECOLI_CORE_REFERENCE, fetchHostMetabolismReference, importHostMetabolismReference } from '../packages/core/src/analysis/host-metabolism-reference';
import { serializeAnalysisRecord } from '../packages/core/src/analysis-result';

const input = await fetchHostMetabolismReference();
const model = parseCobraHostModel(input.cobra);
assert.equal(model.id, 'e_coli_core');
assert.equal(model.reactions.length, 95);
assert.equal(model.metabolites.length, 72);
const options = {
  changes: [{ reactionId: 'EX_o2_e', lowerBound: 0, upperBound: 1000,
    evidence: { kind: 'assumption' as const, reference: ECOLI_CORE_REFERENCE.publication,
      description: 'Close oxygen uptake while retaining every other published bound; conditional uninfected-host model, not measured growth.', gene: null } }],
  variability: ['BIOMASS_Ecoli_core_w_GAM', 'EX_glc__D_e', 'EX_o2_e'], objectiveLoss: 0,
};
const result = analyzeHostMetabolism(input, options);
assert.equal(result.baseline.status, 'optimal');
assert.ok(Math.abs(result.baseline.objective! - 0.87392150696843) < 1e-6, 'Published E. coli core optimum differs');
assert.equal(result.perturbed?.status, 'optimal');
assert.ok(result.perturbed!.objective! < result.baseline.objective!);
for (const scenario of [result.baseline, result.perturbed!]) {
  assert.ok(scenario.certificate!.maxBalanceResidual < 1e-6);
  assert.ok(scenario.certificate!.maxBoundViolation < 1e-6);
  for (const range of scenario.ranges) {
    assert.equal(range.minimum.status, 'optimal'); assert.equal(range.maximum.status, 'optimal');
    assert.ok(range.minimum.value! <= range.maximum.value! + 1e-6);
  }
}
const record = await createHostFluxRecord(input, result);
const replay = await replayHostFluxRecord(serializeAnalysisRecord(record));
assert.equal(replay.record.resultId, record.resultId);
await assert.rejects(importHostMetabolismReference(JSON.stringify(input.cobra)), /checksum mismatch/);
const output = process.argv[2] ?? '.host-reference-verification';
await mkdir(output, { recursive: true });
await writeFile(join(output, 'dataset.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
await writeFile(join(output, 'analysis.json'), serializeAnalysisRecord(record), { flag: 'wx' });
await writeFile(join(output, 'evidence.json'), JSON.stringify({ reference: ECOLI_CORE_REFERENCE, input, result, resultId: record.resultId }, null, 2), { flag: 'wx' });
process.stdout.write(JSON.stringify({ reference: ECOLI_CORE_REFERENCE.id, sha256: ECOLI_CORE_REFERENCE.sha256,
  baseline: result.baseline.objective, oxygenClosed: result.perturbed!.objective, resultId: record.resultId, output }) + '\n');
