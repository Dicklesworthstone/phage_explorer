import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import snapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import {
  createDepositedHostInteractionRecord, replayDepositedHostInteractionRecord,
  exportDepositedHostInteractionTsv, DEPOSITED_HOST_INTERACTION_METHOD,
} from './host-interaction-evidence';

describe('deposited host interaction evidence', () => {
  it('binds the validated deposited complex without synthesizing affinity or engineering claims', async () => {
    const { evidence, record } = await createDepositedHostInteractionRecord(snapshot);
    assert.deepEqual(record.method, DEPOSITED_HOST_INTERACTION_METHOD);
    assert.equal(record.inputs[0].source, 'external');
    assert.equal(evidence.evidence.method, 'deposited-complex');
    assert.ok(evidence.evidence.experimentalHost.length > 0);
    assert.ok(evidence.interactions.length > 0);
    assert.ok(evidence.chains.every(chain => chain.observedCaResidues > 0));
    assert.equal(record.fields.bindingAffinity.kind, 'unavailable');
    assert.equal(record.fields.bindingFreeEnergy.kind, 'unavailable');
    assert.equal(record.fields.buriedSurfaceArea.kind, 'unavailable');
    assert.equal(record.fields.mutationEffects.kind, 'unavailable');
    assert.ok(!JSON.stringify(record.fields.interaction.value).includes('estimatedDeltaG'));
  });
  it('exports every published domain/loop assignment and explicit experimental host context', async () => {
    const { evidence, record } = await createDepositedHostInteractionRecord(snapshot);
    const tsv = exportDepositedHostInteractionTsv(record);
    assert.match(tsv, /experimental_host=/);
    for (const interaction of evidence.interactions) {
      assert.ok(tsv.includes(interaction.phageDomain));
      assert.ok(tsv.includes(interaction.hostDomain));
      assert.ok(tsv.includes(interaction.sourceSection));
    }
    assert.match(tsv, /No ΔG, Kd, buried surface area, mutation effect or host-range estimate/);
  });
  it('recomputes and verifies the complete saved evidence identity', async () => {
    const created = await createDepositedHostInteractionRecord(snapshot);
    const replay = await replayDepositedHostInteractionRecord(serializeAnalysisRecord(created.record));
    assert.equal(replay.record.resultId, created.record.resultId);
    assert.deepEqual(replay.evidence, created.evidence);
  });
  it('rejects a correctly rehashed forged observation field', async () => {
    const created = await createDepositedHostInteractionRecord(snapshot);
    const forged = structuredClone(created.record), value = forged.fields.interaction.value as any;
    value.interactions[0].phageDomain = 'invented-domain';
    const resigned = await createAnalysisRecord({ ...forged,
      inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    await assert.rejects(replayDepositedHostInteractionRecord(serializeAnalysisRecord(resigned)),
      /Recomputed deposited host-interaction evidence differs/);
  });
});
