import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ancestralConsensus, createAncestralRecord, reconstructAncestors, parseAncestralFasta, type AncestralDataset, type AncestralOptions } from '../../../core/src/analysis/ancestral-reconstruction';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { AncestralSession, executeAncestralRequest, ancestralAnalysisRequest, type AncestralMessage, type AncestralRequest, type AncestralWorker } from './AncestralSession';

import { createAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, ROOTED_ANCESTRAL_METHOD } from '../../../core/src/analysis/phylogeny-rooting';

const input=():AncestralDataset=>({format:'phage-explorer-ancestral',version:1,name:'Synthetic two-tip input',
  source:{kind:'demo',description:'Hand-derived transition fixture',reference:'At t=3/4 log 3, Pii=1/2, Pij=1/6',license:'Test fixture'},
  tree:{newick:`(a:${.75*Math.log(3)},b:${.75*Math.log(3)});`,units:'substitutions/site',method:'Prespecified',rooting:'Synthetic root'},
  alignment:{homologous:true,fasta:'>a\nAAN\n>b\nACN',method:'Prespecified columns',reference:'Synthetic aligned DNA'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
class TestWorker implements AncestralWorker {
  onmessage:AncestralWorker['onmessage']=null;onerror:AncestralWorker['onerror']=null;onmessageerror:AncestralWorker['onmessageerror']=null;
  stopped=false;request:AncestralRequest|null=null;
  constructor(readonly automatic=true){}
  send(message:AncestralMessage){this.onmessage?.({data:message} as MessageEvent<AncestralMessage>);}
  postMessage(request:AncestralRequest){this.request=request;if(this.automatic)void executeAncestralRequest(request,phase=>this.send({kind:'progress',phase})).then(value=>this.send({kind:'result',value}),cause=>this.send({kind:'error',message:String(cause)}));}
  terminate(){this.stopped=true;}
}

describe('ancestral worker request boundary',()=>{
  it('loads exact inputs without computing or inventing an ancestral result',async()=>{
    const loaded=await executeAncestralRequest({kind:'load',input:input()});
    assert.equal(loaded.result,null);assert.equal(loaded.record,null);assert.equal(loaded.columns,3);assert.equal(loaded.tips,2);
    assert.equal(loaded.input.alignment.fasta,input().alignment.fasta);
  });
  it('runs actual numerical code and restores complete evidence on a fresh request',async()=>{
    const work=await executeAncestralRequest({kind:'analyze',input:input(),options:{minPosterior:.7}});
    assert.ok(work.result&&work.record);assert.equal(ancestralConsensus(work.result,'n0'),'ANN');
    assert.ok(Math.abs(work.result.patterns[0].nodes![0][0]-.75)<1e-12);
    const replay=await executeAncestralRequest({kind:'import',content:'\uFEFF'+serializeAnalysisRecord(work.record)});
    assert.equal(replay.verified,true);assert.equal(replay.record!.resultId,work.record.resultId);
    assert.deepEqual(replay.result,work.result);
  });
  it('rejects rehashed false probability vectors instead of displaying stored output',async()=>{
    const d=input(),record=await createAncestralRecord(d,reconstructAncestors(d));
    const values=record.fields.reconstruction.value as unknown as ReturnType<typeof reconstructAncestors>;
    values.patterns[0].nodes![0]=[1,0,0,0];
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...row})=>row)});
    await assert.rejects(executeAncestralRequest({kind:'import',content:serializeAnalysisRecord(forged)}),/Fresh ancestral evidence differs/);
  });
  it('rejects unknown operations and oversized or malformed saved input',async()=>{
    await assert.rejects(executeAncestralRequest({kind:'other'} as unknown as AncestralRequest),/Unsupported/);
    for(const content of ['{',' '.repeat(10*1024*1024+1)])await assert.rejects(executeAncestralRequest({kind:'import',content}));
  });
});

describe('accepted ancestral evidence lifecycle',()=>{
  it('snapshots submitted inputs and options, ignoring edits while the worker is scheduled',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();
    const data=input(),options={minPosterior:.7};const running=session.run({kind:'analyze',input:data,options});
    data.name='Later edit';options.minPosterior=1;await running;
    assert.equal(session.getSnapshot().accepted!.input.name,'Synthetic two-tip input');
    assert.equal(session.getSnapshot().accepted!.options.minPosterior,.7);
    assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('preserves accepted results after invalid replacement and clears them only after valid new input',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();
    await session.run({kind:'analyze',input:input(),options:{}});const before=session.getSnapshot().accepted;
    await session.run({kind:'import',content:'bad input'});
    assert.strictEqual(session.getSnapshot().accepted,before);assert.ok(session.getSnapshot().error);assert.equal(session.getSnapshot().busy,false);
    const replacement=input();replacement.name='Replacement';await session.run({kind:'load',input:replacement});
    assert.equal(session.getSnapshot().accepted!.input.name,'Replacement');assert.equal(session.getSnapshot().accepted!.record,null);session.deactivate();
  });
  it('cancels a pending file read immediately and never creates its abandoned worker',async()=>{
    let created=0;const session=new AncestralSession(()=>{created++;return new TestWorker();});session.activate();
    await session.run({kind:'load',input:input()});const before=session.getSnapshot().accepted;
    const file=deferred<AncestralRequest>(),running=session.run(file.promise);session.cancel();await running;
    assert.equal(session.getSnapshot().busy,false);assert.strictEqual(session.getSnapshot().accepted,before);assert.equal(created,1);
    file.resolve({kind:'load',input:input()});await flush();assert.equal(created,1);session.deactivate();
  });
  it('terminates running work and ignores its late success, failure and progress',async()=>{
    const workers:TestWorker[]=[];const session=new AncestralSession(()=>{const w=new TestWorker(false);workers.push(w);return w;});session.activate();
    const running=session.run({kind:'analyze',input:input(),options:{}});await flush();session.cancel();await running;
    assert.equal(workers[0].stopped,true);
    workers[0].send({kind:'result',value:await executeAncestralRequest({kind:'load',input:input()})});
    workers[0].send({kind:'error',message:'old failure'});workers[0].send({kind:'progress',phase:'obsolete'});
    assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().error,null);assert.equal(session.getSnapshot().phase,'');session.deactivate();
  });
  it('an old promise cannot clear a newer loading owner or overwrite its evidence',async()=>{
    const workers:TestWorker[]=[];const session=new AncestralSession(()=>{const w=new TestWorker(false);workers.push(w);return w;});session.activate();
    const old=session.run({kind:'load',input:input()});await flush();
    const next=input();next.name='Newer';const fresh=session.run({kind:'load',input:next});await flush();await old;
    workers[0].send({kind:'error',message:'late failure'});assert.equal(session.getSnapshot().busy,true);assert.equal(session.getSnapshot().error,null);
    workers[1].send({kind:'result',value:await executeAncestralRequest({kind:'load',input:next})});await fresh;
    assert.equal(session.getSnapshot().accepted!.input.name,'Newer');assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('settles constructor, postMessage, worker and malformed-response failures',async()=>{
    for(const mode of ['construct','post','error','messageerror','malformed']){
      let worker:TestWorker|undefined;
      const session=new AncestralSession(()=>{
        if(mode==='construct')throw new Error('Creation failed');worker=new TestWorker(false);
        worker.postMessage=()=>{if(mode==='post')throw new Error('Send failed');};return worker;
      });session.activate();const running=session.run({kind:'load',input:input()});await flush();
      if(mode==='error')worker!.onerror?.({} as ErrorEvent);
      if(mode==='messageerror')worker!.onmessageerror?.({} as MessageEvent);
      if(mode==='malformed')worker!.send({kind:'broken'} as unknown as AncestralMessage);
      await running;assert.equal(session.getSnapshot().busy,false);assert.ok(session.getSnapshot().error);
      if(worker)assert.equal(worker.stopped,true);session.deactivate();
    }
  });
  it('deactivation cancels and reactivation cannot adopt the previous owner',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();const file=deferred<AncestralRequest>();
    const previous=session.run(file.promise);session.deactivate();session.activate();
    const d=input();d.name='Current activation';await session.run({kind:'load',input:d});file.resolve({kind:'load',input:input()});await previous;
    assert.equal(session.getSnapshot().accepted!.input.name,'Current activation');session.deactivate();
  });
  it('keeps legitimate zero-likelihood diagnostics without treating them as computed certainty',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();const d=input();d.tree.newick='(a:0,b:0);';
    await session.run({kind:'analyze',input:d,options:{}});const result=session.getSnapshot().accepted!.result!;
    assert.equal(result.impossibleColumns,1);assert.equal(result.logLikelihood,null);assert.equal(result.patterns[1].nodes,null);
    assert.equal(session.getSnapshot().error,null);session.deactivate();
  });
});


const linkedRows = [
  { id: 'A', sequence: 'AAAAAAAAAAAAAAAAR-N?' },
  { id: 'B', sequence: 'AAAAAAAAAAAAAAAAAANN' },
  { id: 'C', sequence: 'CCCCAAAAAAAAAAAAY-??' },
  { id: 'D', sequence: 'CCCCAAAAAAAAAAAACANN' },
];
const linkedFasta = '\uFEFF' + [3, 1, 0, 2].map(index => {
  const row = linkedRows[index];
  return '>' + row.id + ' original header\r\n' + row.sequence.toLowerCase() + '\r\n';
}).join('');
const linkedPermission = 'Synthetic alignment; test reuse permitted.';
async function linkedParent(distance: 'jc69' | 'k80' | 'p-distance' = 'jc69') {
  const unrooted = await createAlignedPhylogenyExperiment({ name: 'Original aligned cohort', kind: 'demo',
    reference: 'Synthetic quartet: four differences in sixteen complete columns.', fasta: linkedFasta },
  { distance, bootstrap: 0, seed: 17 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(unrooted.record), {
    outgroup: ['A', 'B'], fractionFromOutgroup: .25, dateIndependent: true,
    evidence: 'Prespecified synthetic outgroup; quarter-edge placement is an explicit test assumption.',
  });
  return { unrooted, rooted, content: serializeAnalysisRecord(rooted.record) };
}

describe('browser ancestry from verified rooted phylogenies', () => {
  it('prepares JC69 and K80 parents without discarding original columns or inventing a reconstruction', async () => {
    for (const distance of ['jc69', 'k80'] as const) {
      const parent = await linkedParent(distance);
      const prepared = await executeAncestralRequest({ kind: 'prepare-rooted', content: parent.content, license: linkedPermission });
      assert.equal(prepared.result, null); assert.equal(prepared.record, null); assert.equal(prepared.verified, false);
      assert.equal(prepared.columns, 20); assert.equal(prepared.tips, 4); assert.equal(parent.unrooted.result.usedSites, 16);
      assert.deepEqual(parseAncestralFasta(prepared.input.alignment.fasta), linkedRows);
      assert.equal(prepared.input.tree.newick, parent.rooted.result.newick);
      assert.equal(prepared.rootedResultId, parent.rooted.record.resultId);
      assert.equal(prepared.unrootedResultId, parent.unrooted.record.resultId);
      assert.deepEqual(prepared.rootedSource, { content: parent.content, license: linkedPermission });
      assert.equal(parent.rooted.unrooted.source.fasta, linkedFasta);
    }
  });

  it('computes independently derived conditional probabilities and replays the complete parent chain', async () => {
    const parent = await linkedParent();
    const prepared = await executeAncestralRequest({ kind: 'prepare-rooted', content: parent.content, license: linkedPermission });
    const request = ancestralAnalysisRequest(prepared, { endColumn: 2, minPosterior: .7 });
    assert.equal(request.kind, 'analyze-rooted');
    const computed = await executeAncestralRequest(request);
    assert.ok(computed.record && computed.result);
    assert.equal(computed.record.method.id, ROOTED_ANCESTRAL_METHOD.id);
    assert.deepEqual(computed.record.inputs[1].data, JSON.parse(parent.content));
    // Duplicate-tip limbs are zero. The root divides the corrected A/C distance in a 1:3 ratio.
    const length = -.75 * Math.log(1 - 4 * (4 / 16) / 3);
    const transition = (same: boolean, t: number) => .25 + (same ? .75 : -.25) * Math.exp(-4 * t / 3);
    const weights = ['A', 'C', 'G', 'T'].map(base => transition(base === 'A', length / 4) * transition(base === 'C', 3 * length / 4));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const actual = computed.result.patterns[0].nodes![0];
    weights.forEach((value, index) => assert.ok(Math.abs(actual[index] - value / total) < 1e-12));
    const replayed = await executeAncestralRequest({ kind: 'import', content: '\uFEFF' + serializeAnalysisRecord(computed.record) });
    assert.equal(replayed.verified, true);
    assert.deepEqual(replayed.result, computed.result);
    assert.equal(replayed.record!.resultId, computed.record.resultId);
    assert.deepEqual(replayed.rootedSource, prepared.rootedSource);
    assert.equal(replayed.rootedResultId, parent.rooted.record.resultId);
    assert.equal(replayed.unrootedResultId, parent.unrooted.record.resultId);
  });

  it('retains lineage and explicit substitution assumptions when an imported result is rerun', async () => {
    const parent = await linkedParent('k80');
    const prepared = await executeAncestralRequest({ kind: 'prepare-rooted', content: parent.content, license: linkedPermission });
    const first = await executeAncestralRequest(ancestralAnalysisRequest(prepared, { endColumn: 2 }));
    const imported = await executeAncestralRequest({ kind: 'import', content: serializeAnalysisRecord(first.record!) });
    const options: Partial<AncestralOptions> = { startColumn: 2, endColumn: 4, minPosterior: .8,
      substitution: { model: 'HKY85', frequencies: [.3, .2, .2, .3], kappa: 3,
        source: 'Explicit synthetic conditional model, separate from K80 distances', siteRates: [{ rate: 1, weight: 1 }] } };
    const rerun = await executeAncestralRequest(ancestralAnalysisRequest(imported, options));
    assert.equal(rerun.record!.method.id, ROOTED_ANCESTRAL_METHOD.id);
    assert.notEqual(rerun.record!.resultId, first.record!.resultId);
    assert.equal(rerun.rootedResultId, first.rootedResultId); assert.equal(rerun.unrootedResultId, first.unrootedResultId);
    assert.deepEqual(rerun.rootedSource, first.rootedSource);
    assert.deepEqual(rerun.options.substitution, options.substitution);
    assert.deepEqual(rerun.result!.sites.map(site => site.column), [2, 3, 4]);
    const plain = await executeAncestralRequest({ kind: 'load', input: input() });
    assert.equal(ancestralAnalysisRequest(plain, {}).kind, 'analyze');
  });

  it('refuses rehashed posterior and parent forgeries before accepting their evidence', async () => {
    const parent = await linkedParent();
    const computed = await executeAncestralRequest({ kind: 'analyze-rooted',
      rootedSource: { content: parent.content, license: linkedPermission }, options: { endColumn: 1 } });
    const changed = structuredClone(computed.record!);
    (changed.fields.reconstruction.value as { logLikelihood: number }).logLikelihood += 1;
    const forged = await createAnalysisRecord({ ...changed, inputs: changed.inputs.map(({ sha256: _sha, ...row }) => row) });
    await assert.rejects(executeAncestralRequest({ kind: 'import', content: serializeAnalysisRecord(forged) }), /Fresh linked ancestral evidence differs/);
    const changedParent = structuredClone(parent.rooted.record);
    (changedParent.fields.rooting.value as { newick: string }).newick = "(('A':0,'B':0):0.1,('C':0,'D':0):0.2);";
    const forgedParent = await createAnalysisRecord({ ...changedParent, inputs: changedParent.inputs.map(({ sha256: _sha, ...row }) => row) });
    await assert.rejects(executeAncestralRequest({ kind: 'prepare-rooted', content: serializeAnalysisRecord(forgedParent), license: linkedPermission }), /Recomputed rooted phylogeny/);
  });

  it('requires corrected rooted branches and explicit permission instead of accepting a cached tree', async () => {
    const raw = await linkedParent('p-distance');
    await assert.rejects(executeAncestralRequest({ kind: 'prepare-rooted', content: raw.content, license: linkedPermission }), /p-distance is not silently relabeled/);
    const corrected = await linkedParent();
    await assert.rejects(executeAncestralRequest({ kind: 'prepare-rooted', content: corrected.content, license: '' }), /license or usage permission/);
    await assert.rejects(executeAncestralRequest({ kind: 'prepare-rooted', content: serializeAnalysisRecord(corrected.unrooted.record), license: linkedPermission }), /incompatible/);
    await assert.rejects(executeAncestralRequest({ kind: 'analyze-rooted', rootedSource: null, options: {} } as unknown as AncestralRequest), /rooted source/);
  });

  it('snapshots the exact rooted source and nested reconstruction settings before worker scheduling', async () => {
    const parent = await linkedParent();
    const session = new AncestralSession(() => new TestWorker()); session.activate();
    try {
      const options: Partial<AncestralOptions> = { endColumn: 2, substitution: { model: 'HKY85',
        frequencies: [.25, .25, .25, .25], kappa: 2, source: 'Submitted conditional model', siteRates: [{ rate: 1, weight: 1 }] } };
      const expected = structuredClone(options);
      const rootedSource = { content: parent.content, license: linkedPermission };
      const pending = session.run({ kind: 'analyze-rooted', rootedSource, options });
      rootedSource.content = 'Later parent edit'; rootedSource.license = 'Later permission'; options.endColumn = 20;
      if (options.substitution?.model === 'HKY85') { options.substitution.kappa = 9; options.substitution.frequencies[0] = .9; }
      await pending;
      const accepted = session.getSnapshot().accepted;
      assert.ok(accepted?.record, session.getSnapshot().error ?? 'Missing linked result');
      assert.deepEqual(accepted.rootedSource, { content: parent.content, license: linkedPermission });
      assert.equal(accepted.options.endColumn, 2); assert.deepEqual(accepted.options.substitution, expected.substitution);
    } finally { session.deactivate(); }
  });

  it('a superseded rooted preparation cannot restore its lineage over a newer manual input', async () => {
    const parent = await linkedParent();
    const workers: TestWorker[] = [];
    const session = new AncestralSession(() => { const worker = new TestWorker(false); workers.push(worker); return worker; });
    session.activate();
    try {
      const request: AncestralRequest = { kind: 'prepare-rooted', content: parent.content, license: linkedPermission };
      const old = session.run(request); await flush();
      const replacement = input(); replacement.name = 'New manual cohort';
      const fresh = session.run({ kind: 'load', input: replacement }); await flush(); await old;
      assert.equal(workers[0].stopped, true);
      workers[0].send({ kind: 'result', value: await executeAncestralRequest(request) });
      workers[0].send({ kind: 'progress', phase: 'Obsolete rooted work' });
      assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().busy, true);
      workers[1].send({ kind: 'result', value: await executeAncestralRequest({ kind: 'load', input: replacement }) });
      await fresh;
      assert.equal(session.getSnapshot().accepted!.input.name, 'New manual cohort');
      assert.equal(session.getSnapshot().accepted!.rootedSource, undefined);
      assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().busy, false);
    } finally { session.deactivate(); }
  });

  it('cancelled linked reconstruction preserves its accepted parent and ignores late posteriors', async () => {
    const parent = await linkedParent();
    const workers: TestWorker[] = [];
    const session = new AncestralSession(() => { const worker = new TestWorker(false); workers.push(worker); return worker; });
    session.activate();
    try {
      const request: AncestralRequest = { kind: 'prepare-rooted', content: parent.content, license: linkedPermission };
      const preparing = session.run(request); await flush();
      workers[0].send({ kind: 'result', value: await executeAncestralRequest(request) }); await preparing;
      const before = session.getSnapshot().accepted!;
      const analyze = ancestralAnalysisRequest(before, { endColumn: 2 });
      const pending = session.run(analyze); await flush(); session.cancel(); await pending;
      assert.equal(workers[1].stopped, true);
      workers[1].send({ kind: 'result', value: await executeAncestralRequest(analyze) });
      workers[1].send({ kind: 'error', message: 'Obsolete linked failure' });
      assert.strictEqual(session.getSnapshot().accepted, before);
      assert.equal(session.getSnapshot().accepted!.record, null);
      assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().busy, false);
    } finally { session.deactivate(); }
  });
});
