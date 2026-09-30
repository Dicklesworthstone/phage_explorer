import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createNucleotideKernel, resolveNucleotideModel, type NucleotideModel } from './nucleotide-model';
const pi = [.1,.2,.3,.4];
const gtr = (): NucleotideModel => resolveNucleotideModel({model:'GTR',frequencies:pi,exchangeabilities:[1,4,2,3,5,6],source:'Independent mathematical fixture'});
const close = (a:number,b:number,tolerance=2e-12) => assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);

describe('supplied reversible nucleotide model',()=>{
  it('matches an independent SciPy expm result for a fully unequal GTR matrix',()=>{
    // SciPy 1.17.0 scipy.linalg.expm, independently assembled symmetric rates * diag(pi).
    // pi=(.1,.2,.3,.4), AC/AG/AT/CG/CT/GT=(1,4,2,3,5,6), t=.7, mean Q rate=1.
    const expected=[.6142307892851753,.05201616221535,.17736209382662144,.15639095467285338,
      .026008081107675007,.5409010198892537,.1565621886862551,.2765287103168162,
      .05912069794220717,.10437479245750343,.5322425924296514,.304261917170638,
      .03909773866821336,.13826435515840813,.22819643787797847,.5944414682954];
    createNucleotideKernel(gtr()).transition(.7).forEach((p,i)=>close(p,expected[i]));
  });
  it('reduces to the independent closed F81 transition formula when rates are equal',()=>{
    const model=gtr(); assert.equal(model.model,'GTR');
    if(model.model!=='GTR')throw new Error('fixture'); model.exchangeabilities=[1,1,1,1,1,1];
    const kernel=createNucleotideKernel(model),scale=1-pi.reduce((s,p)=>s+p*p,0);
    for(const t of [0,1e-12,.3,1,100])kernel.transition(t).forEach((p,i)=>{
      const a=Math.floor(i/4),b=i%4;close(p,pi[b]+((a===b?1:0)-pi[b])*Math.exp(-t/scale));
    });
  });
  it('matches the closed K80 limit of HKY at equal frequencies',()=>{
    const kappa=4,kernel=createNucleotideKernel(resolveNucleotideModel({model:'HKY85',frequencies:[.25,.25,.25,.25],kappa,source:'K80 formula'}));
    const t=.8, beta=1/(kappa+2),alpha=kappa*beta;
    const expectedSame=.25+.25*Math.exp(-4*beta*t)+.5*Math.exp(-2*(alpha+beta)*t);
    const expectedTransition=.25+.25*Math.exp(-4*beta*t)-.5*Math.exp(-2*(alpha+beta)*t);
    const expectedTransversion=.25-.25*Math.exp(-4*beta*t);
    const p=kernel.transition(t);close(p[0],expectedSame);close(p[2],expectedTransition);close(p[1],expectedTransversion);close(p[7],expectedTransition);
  });
  it('normalizes Q to substitutions per site and preserves stationary detailed balance',()=>{
    const kernel=createNucleotideKernel(gtr()),q=kernel.generator;
    close(-pi.reduce((s,p,i)=>s+p*q[i*4+i],0),1);
    for(let i=0;i<4;i++){
      close(q.slice(i*4,i*4+4).reduce((s,v)=>s+v,0),0);
      for(let j=0;j<4;j++)close(pi[i]*q[i*4+j],pi[j]*q[j*4+i]);
    }
    for(const t of [1e-12,.01,1,50,1e6]){
      const p=kernel.transition(t);
      for(let i=0;i<4;i++){
        close(p.slice(i*4,i*4+4).reduce((s,v)=>s+v,0),1);
        for(let j=0;j<4;j++){assert.ok(p[i*4+j]>=0);close(pi[i]*p[i*4+j],pi[j]*p[j*4+i]);}
      }
    }
  });
  it('satisfies the semigroup relation and tends to the supplied stationary distribution',()=>{
    const kernel=createNucleotideKernel(gtr()),a=kernel.transition(.2),b=kernel.transition(.5),c=kernel.transition(.7);
    for(let i=0;i<4;i++)for(let j=0;j<4;j++)close(c[i*4+j],[0,1,2,3].reduce((s,k)=>s+a[i*4+k]*b[k*4+j],0));
    kernel.transition(1e6).forEach((p,i)=>close(p,pi[i%4]));
  });
  it('retains tiny transition log probabilities rather than inventing impossible changes',()=>{
    const kernel=createNucleotideKernel(gtr()),logs=kernel.logTransition(1e-320);
    for(let i=0;i<16;i++)if(i%5!==0){assert.ok(Number.isFinite(logs[i]));close(logs[i],Math.log(kernel.generator[i])+Math.log(1e-320));}
    assert.deepEqual(kernel.transition(0),Array.from({length:16},(_,i)=>i%5===0?1:0));
  });
  it('handles repeated eigenvalues and common rescaling of all exchangeabilities',()=>{
    const base=gtr(),scaled=gtr();if(base.model!=='GTR'||scaled.model!=='GTR')throw new Error('fixture');
    scaled.exchangeabilities=scaled.exchangeabilities.map(r=>r*100) as typeof scaled.exchangeabilities;
    const a=createNucleotideKernel(base).transition(.7),b=createNucleotideKernel(scaled).transition(.7);
    a.forEach((p,i)=>close(p,b[i]));
    const symmetric=resolveNucleotideModel({model:'GTR',frequencies:[.25,.25,.25,.25],exchangeabilities:[1,1,1,1,1,1],source:'JC reduction'});
    const jc=createNucleotideKernel(resolveNucleotideModel({model:'JC69',source:'JC reduction'}));
    createNucleotideKernel(symmetric).transition(.5).forEach((p,i)=>close(p,jc.transition(.5)[i]));
  });
  it('allows an invariant category only with an explicitly unit-mean mixture',()=>{
    const model=resolveNucleotideModel({model:'JC69',source:'Invariant mixture fixture',siteRates:[{rate:0,weight:.2},{rate:.5,weight:.4},{rate:2,weight:.4}]});
    assert.equal(model.siteRates[0].rate,0);
    for(const siteRates of [[],[{rate:0,weight:1}],[{rate:2,weight:1}],[{rate:1,weight:.9}],Array(9).fill({rate:1,weight:1/9}),[{rate:1,weight:0}],[{rate:1,weight:1,unknown:1}]]){
      assert.throws(()=>resolveNucleotideModel({...model,siteRates}));
    }
  });
  it('rejects unknown fields, invalid frequencies and unsourced parameters',()=>{
    const model=gtr();
    for(const changed of [null,{}, {...model,model:'GY94'},{...model,source:''},{...model,source:'bad\u001b'}, {...model,extra:1},
      {...model,frequencies:[.1,.2,.3,.3]},{...model,frequencies:[0,.2,.3,.5]}, {...model,frequencies:[.1,.2,NaN,.7]},
      {...model,exchangeabilities:[1,2]}, {...model,exchangeabilities:[1,2,3,4,5,Infinity]},
      {model:'JC69',source:'invalid extras',kappa:2}, {model:'HKY85',source:'invalid kappa',frequencies:pi,kappa:0}])assert.throws(()=>resolveNucleotideModel(changed));
  });
  it('snapshots model inputs and validates branch lengths',()=>{
    const input=gtr(),before=structuredClone(input),kernel=createNucleotideKernel(input);
    input.siteRates[0].rate=99;
    assert.deepEqual(resolveNucleotideModel(before),before);
    for(const length of [NaN,Infinity,-1,1e9+1])assert.throws(()=>kernel.transition(length));
    assert.ok(kernel.transition(.3).every(Number.isFinite));
  });
});
