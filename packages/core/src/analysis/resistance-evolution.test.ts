import{describe,it}from'bun:test';
import assert from'node:assert/strict';
import{createResistanceExperimentRecord,replayResistanceExperimentRecord,runResistanceExperiment,
  exportResistanceExperimentTsv}from'./resistance-evolution';
import{serializeAnalysisRecord}from'../analysis-result';

describe('reproducible resistance evolution experiment',()=>{
  it('is byte-deterministic for the same seed and changes with a different seed',async()=>{
    const a=await createResistanceExperimentRecord({cocktailSize:2,seed:7});
    const b=await createResistanceExperimentRecord({cocktailSize:2,seed:7});
    const c=await createResistanceExperimentRecord({cocktailSize:2,seed:8});
    assert.equal(serializeAnalysisRecord(a.record),serializeAnalysisRecord(b.record));
    assert.notEqual(a.record.resultId,c.record.resultId);
    assert.deepEqual(a.result,b.result);
  });
  it('replays the exact result identity and preserves explicit simulation provenance',async()=>{
    const first=await createResistanceExperimentRecord({cocktailSize:1,seed:42});
    assert.equal(first.record.inputs[0].source,'demo');
    assert.equal(first.record.fields.trajectory.kind,'simulation');
    const replay=await replayResistanceExperimentRecord(serializeAnalysisRecord(first.record));
    assert.equal(replay.record.resultId,first.record.resultId);
    assert.deepEqual(replay.result,first.result);
  });
  it('validates model parameter ranges rather than silently clipping them',()=>{
    assert.throws(()=>runResistanceExperiment({cocktailSize:0}),/outside|integer/);
    assert.throws(()=>runResistanceExperiment({infectionRate:1}),/outside/);
    assert.throws(()=>runResistanceExperiment({seed:-1}),/uint32/);
  });
  it('exports the complete retained trajectory with its seed and demo caveat',async()=>{
    const first=await createResistanceExperimentRecord({cocktailSize:3,seed:3});
    const tsv=exportResistanceExperimentTsv(first.record);
    assert.match(tsv,/seed=3/);assert.match(tsv,/Illustrative stochastic model only/);
    assert.equal(tsv.trim().split('\n').length,first.result.trajectory.length+3);
  });
});
