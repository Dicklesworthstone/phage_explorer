import{describe,it}from'bun:test';
import assert from'node:assert/strict';
import{createResistanceExperimentRecord,replayResistanceExperimentRecord,runResistanceExperiment,
  exportResistanceExperimentTsv}from'./resistance-evolution';
import{createAnalysisRecord,serializeAnalysisRecord}from'../analysis-result';

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

describe('resistance model version 2 evidence', () => {
  it('exports infected cells and the terminal checkpoint with the new transition identity', async () => {
    const { result, record } = await createResistanceExperimentRecord({ seed: 9 });
    assert.equal(record.method.version, '2');
    assert.equal(record.references[0].version, '2');
    assert.equal(result.trajectory.at(-1)?.t, result.durationHours);
    assert.equal(result.trajectory.at(-1)?.infected, result.final.infectedByPhage.reduce((a, b) => a + b, 0));
    const rows = exportResistanceExperimentTsv(record).trim().split('\n');
    assert.equal(rows[2], 'time_hours\tsensitive\tpartial_resistant\tfully_resistant\tinfected\ttotal_phage');
    assert.equal(Number(rows.at(-1)!.split('\t')[4]), result.trajectory.at(-1)?.infected);
    assert.ok(result.limitations.some(value => value.includes('not an exact Gillespie')));
  });
  it('supports explicit zero-rate controls and stops the no-reaction limit at exactly 48 hours', () => {
    const result = runResistanceExperiment({
      cocktailSize: 1, initialBacteria: 1000, initialPhage: 1000, carryingCap: 10000,
      growthRate: 0, infectionRate: 0, mutationRate: 0, multiResRate: 0, phageDecay: 0, seed: 1,
    });
    assert.equal(result.outcome, 'time-limit');
    assert.equal(result.durationHours, 48);
    assert.equal(result.steps, 4800);
    assert.deepEqual(result.final, {
      sensitive: 1000, partialResistant: [0], fullyResistant: 0, infectedByPhage: [0], phage: [1000],
    });
  });
  it('refuses an earlier transition identity instead of relabeling it as a new-model replay', async () => {
    const { record } = await createResistanceExperimentRecord({ initialBacteria: 0 });
    // A valid content-addressed record with an old method identity tests admission;
    // it is not claimed to be a historical model fixture.
    const earlier = await createAnalysisRecord({ ...record, method: { ...record.method, version: '1' } });
    await assert.rejects(replayResistanceExperimentRecord(serializeAnalysisRecord(earlier)), /incompatible transition model/);
  });
  it('rejects fractional initial particles and progeny at the public experiment boundary', () => {
    for (const options of [{ initialBacteria: 100000.5 }, { initialPhage: 100000.5 }, { burstSize: 10.5 }]) {
      assert.throws(() => runResistanceExperiment(options), /integer/);
    }
  });
});
