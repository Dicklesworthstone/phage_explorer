/** Sourced spacer-to-DNA comparisons. Matches are sequence evidence, not immunity predictions.
 * PAMs and seed intervals are supplied in the guide-equivalent DNA 5'->3' orientation.
 * No CRISPR type, motif, strain susceptibility, or anti-CRISPR activity is inferred.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const SPACER_LIMITS = { libraryBytes: 2 * 1024 * 1024, genomeBases: 5_000_000,
  hosts: 500, records: 10_000, minLength: 20, maxLength: 128, hits: 5_000,
  seedOccurrences: 2_000_000, candidates: 500_000, comparisons: 50_000_000 } as const;
export interface SpacerHost { id: string; name: string; strain: string; accession: string }
export interface ReferenceSpacer {
  id: string; hostId: string; arrayAccession: string; sequence: string; system: string | null;
  target: 'DNA' | 'RNA' | 'unknown'; orientation: 'guide-equivalent' | 'unknown';
  pam: { side: '5prime' | '3prime'; motif: string; reference: string } | null;
  seed: { start: number; end: number; maxMismatches: number; reference: string } | null;
}
export interface SpacerLibrary {
  format: 'phage-explorer-spacer-library'; version: 1; name: string;
  source: { kind: 'local' | 'external' | 'demo'; reference: string; version: string; license: string; scope: string };
  hosts: SpacerHost[]; spacers: ReferenceSpacer[];
}
export interface SpacerGenome { name: string; accession: string | null; sequence: string;
  topology: 'linear' | 'circular' | 'unknown'; source: 'local' | 'catalog' }
export interface SpacerSearchOptions { hostId: string | null; maxMismatches: number }
export interface SpacerInterval { start: number; end: number }
export interface ReferenceSpacerHit {
  spacerId: string; hostId: string; start: number; end: number; wrapsOrigin: boolean;
  strand: '+' | '-'; segments: SpacerInterval[]; protospacer: string; identity: number;
  mismatchPositions: number[];
  pam: { status: 'matched' | 'mismatched' | 'unavailable' | 'not-assessed'; sequence: string | null;
    segments: SpacerInterval[]; reason: string | null };
  seed: { status: 'matched' | 'mismatched' | 'not-assessed'; mismatches: number | null };
}
export interface SpacerSearchResult {
  options: SpacerSearchOptions; hits: ReferenceSpacerHit[];
  excluded: Array<{ spacerId: string; hostId: string; reason: string }>;
  coverage: Array<{ length: number; possibleStarts: number; unambiguousStarts: number }>;
  hosts: Array<{ hostId: string; records: number; searched: number; excluded: number; hitRecords: number; uniqueLoci: number }>;
  selectedRecords: number; searchedRecords: number; distinctSequences: number;
  status: 'no-spacer-data' | 'unsupported-references' | 'no-usable-windows' | 'no-sequence-match' | 'sequence-matches';
  complete: true; warnings: string[];
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const IUPAC: Record<string, string> = { A:'A', C:'C', G:'G', T:'T', R:'AG', Y:'CT', S:'CG', W:'AT', K:'GT', M:'AC', B:'CGT', D:'AGT', H:'ACT', V:'ACG', N:'ACGT' };
const COMPLEMENT: Record<string, string> = { A:'T', C:'G', G:'C', T:'A', R:'Y', Y:'R', S:'S', W:'W', K:'M', M:'K', B:'V', V:'B', D:'H', H:'D', N:'N' };
const reverse = (s: string) => [...s].reverse().map(c => COMPLEMENT[c]).join('');
function keys(v: Record<string, unknown>, allowed: string[], context: string): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error(`Unsupported ${context} field.`);
}
function text(v: unknown, context: string, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error(`${context} requires nonempty text without control characters.`);
  return v.trim();
}
function dna(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[^ACGTRYSWKMBDHVN]/i.test(v)) throw new Error('Expected bounded IUPAC DNA without gaps, whitespace or RNA U.');
  return v.toUpperCase();
}
function bounded(v: unknown, max: number, context: string): void {
  if (new TextEncoder().encode(JSON.stringify(v)).length > max) throw new Error(`${context} exceeds the size limit.`);
}
export function validateSpacerLibrary(input: unknown): SpacerLibrary {
  if (!isObject(input) || input.format !== 'phage-explorer-spacer-library' || input.version !== 1 || !isObject(input.source)) throw new Error('Unsupported spacer library format/version.');
  keys(input, ['format','version','name','source','hosts','spacers'], 'library');
  bounded(input, SPACER_LIMITS.libraryBytes, 'Spacer library');
  const source = input.source;
  keys(source, ['kind','reference','version','license','scope'], 'source');
  if (!['local','external','demo'].includes(String(source.kind))) throw new Error('Spacer source must be local, external or demo.');
  if (!Array.isArray(input.hosts) || !input.hosts.length || input.hosts.length > SPACER_LIMITS.hosts ||
    !Array.isArray(input.spacers) || input.spacers.length > SPACER_LIMITS.records) throw new Error('Spacer library exceeds host/record limits or has no host definitions.');
  const hostIds = new Set<string>(), recordIds = new Set<string>();
  const hosts = input.hosts.map(raw => {
    if (!isObject(raw)) throw new Error('Host must be an object.');
    keys(raw,['id','name','strain','accession'],'host');
    const host = { id:text(raw.id,'Host ID',256), name:text(raw.name,'Host name'), strain:text(raw.strain,'Host strain'), accession:text(raw.accession,'Host accession') };
    if (hostIds.has(host.id)) throw new Error('Duplicate host ID.');
    hostIds.add(host.id); return host;
  });
  const spacers: ReferenceSpacer[] = input.spacers.map(raw => {
    if (!isObject(raw)) throw new Error('Spacer must be an object.');
    keys(raw,['id','hostId','arrayAccession','sequence','system','target','orientation','pam','seed'],'spacer');
    const id=text(raw.id,'Spacer ID',256), hostId=text(raw.hostId,'Spacer host ID',256), sequence=dna(raw.sequence,256);
    if (recordIds.has(id) || !hostIds.has(hostId)) throw new Error('Spacer IDs must be unique and host IDs must reference a defined host.');
    recordIds.add(id);
    if (!['DNA','RNA','unknown'].includes(String(raw.target)) || !['guide-equivalent','unknown'].includes(String(raw.orientation))) throw new Error('Explicit spacer target and orientation are required.');
    let pam: ReferenceSpacer['pam'] = null, seed: ReferenceSpacer['seed'] = null;
    if (raw.pam !== null) {
      if (!isObject(raw.pam)) throw new Error('PAM must be an explicit object or null.');
      keys(raw.pam,['side','motif','reference'],'PAM');
      if (!['5prime','3prime'].includes(String(raw.pam.side))) throw new Error('PAM side must be guide-equivalent 5prime or 3prime.');
      pam={ side:raw.pam.side as '5prime'|'3prime', motif:dna(raw.pam.motif,12), reference:text(raw.pam.reference,'PAM source') };
    }
    if (raw.seed !== null) {
      if (!isObject(raw.seed)) throw new Error('Seed must be an explicit object or null.');
      keys(raw.seed,['start','end','maxMismatches','reference'],'seed');
      const {start,end,maxMismatches}=raw.seed;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start)<0 || Number(end)<=Number(start) || Number(end)>sequence.length ||
        !Number.isSafeInteger(maxMismatches) || Number(maxMismatches)<0 || Number(maxMismatches)>Number(end)-Number(start)) throw new Error('Seed coordinates require a 0-based half-open spacer interval and a valid mismatch limit.');
      seed={start:Number(start),end:Number(end),maxMismatches:Number(maxMismatches),reference:text(raw.seed.reference,'Seed source')};
    }
    if (raw.orientation === 'unknown' && (pam || seed)) throw new Error('PAM/seed constraints cannot be oriented when spacer orientation is unknown.');
    return {id,hostId,sequence,arrayAccession:text(raw.arrayAccession,'Array accession'),system:raw.system === null ? null : text(raw.system,'System designation',256),
      target:raw.target as ReferenceSpacer['target'],orientation:raw.orientation as ReferenceSpacer['orientation'],pam,seed};
  });
  return {format:'phage-explorer-spacer-library',version:1,name:text(input.name,'Library name'),
    source:{kind:source.kind as SpacerLibrary['source']['kind'],reference:text(source.reference,'Reference source'),version:text(source.version,'Reference version'),license:text(source.license,'License or usage permission'),scope:text(source.scope,'Reference scope')},hosts,spacers};
}
export function parseSpacerLibrary(content: string): SpacerLibrary {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > SPACER_LIMITS.libraryBytes) throw new Error('Spacer library exceeds the 2 MiB limit.');
  return validateSpacerLibrary(JSON.parse(content.replace(/^\uFEFF/,'')));
}
export function validateSpacerGenome(raw: unknown): SpacerGenome {
  if (!isObject(raw)) throw new Error('Genome input is required.');
  keys(raw,['name','accession','sequence','topology','source'],'genome');
  if (!['linear','circular','unknown'].includes(String(raw.topology)) || !['local','catalog'].includes(String(raw.source))) throw new Error('Explicit genome topology and source are required.');
  return {name:text(raw.name,'Genome name'),accession:raw.accession === null ? null : text(raw.accession,'Genome accession'),
    sequence:dna(raw.sequence,SPACER_LIMITS.genomeBases),topology:raw.topology as SpacerGenome['topology'],source:raw.source as SpacerGenome['source']};
}
export function resolveSpacerOptions(raw: Partial<SpacerSearchOptions> = {}): SpacerSearchOptions {
  if (!isObject(raw)) throw new Error('Spacer search parameters must be an object.');
  keys(raw,['hostId','maxMismatches'],'spacer parameter');
  const options={hostId:null,maxMismatches:0,...raw};
  if (!Number.isInteger(options.maxMismatches) || options.maxMismatches<0 || options.maxMismatches>5) throw new Error('Spacer mismatches must be an integer from 0 to 5.');
  return {hostId:options.hostId === null ? null : text(options.hostId,'Selected host',256),maxMismatches:options.maxMismatches};
}
function intervals(start: number, length: number, n: number): SpacerInterval[] {
  const s=((start%n)+n)%n;
  return s+length<=n ? [{start:s,end:s+length}] : [{start:s,end:n},{start:0,end:s+length-n}];
}
/** Histogram of contiguous unambiguous runs: exact searchable coverage, without scanning each window. */
function knownRuns(sequence: string, circular: boolean): { histogram: Map<number,number>; allKnown: boolean } {
  const histogram=new Map<number,number>(); let run=0, first=0;
  const add=(length:number,delta=1)=>{if(length)histogram.set(length,(histogram.get(length)??0)+delta);};
  for(let i=0;i<sequence.length;i++) {
    if(/[ACGT]/.test(sequence[i]))run++;
    else {if(i===run)first=run;add(run);run=0;}
  }
  const allKnown=run===sequence.length; add(run);
  if(circular&&!allKnown&&first&&run){add(first,-1);add(run,-1);add(first+run);}
  return {histogram,allKnown};
}
function pamEvidence(genome: SpacerGenome, start: number, length: number, strand: '+'|'-', pam: ReferenceSpacer['pam']): ReferenceSpacerHit['pam'] {
  if(!pam)return {status:'not-assessed',sequence:null,segments:[],reason:'No oriented PAM rule supplied; system type is not guessed.'};
  const n=genome.sequence.length,m=pam.motif.length;
  const left=(strand==='+'&&pam.side==='5prime')||(strand==='-'&&pam.side==='3prime');
  const position=left?start-m:start+length;
  if(n<length+m || (genome.topology!=='circular'&&(position<0||position+m>n))) return {status:'unavailable',sequence:null,segments:[],reason:'Flanking context is unavailable at this boundary/topology.'};
  const segments=intervals(position,m,n), forward=segments.map(s=>genome.sequence.slice(s.start,s.end)).join('');
  const sequence=strand==='+'?forward:reverse(forward);
  if(/[^ACGT]/.test(sequence))return {status:'unavailable',sequence,segments,reason:'PAM context contains ambiguous bases.'};
  return {status:[...sequence].every((base,i)=>IUPAC[pam.motif[i]].includes(base))?'matched':'mismatched',sequence,segments,reason:null};
}
/** Pigeonhole-complete candidate generation: <=k substitutions leave an exact block among k+1 disjoint blocks.
 * Candidates are always verified in full; no heuristic seed filter or top-hit truncation changes a reported zero.
 */
export function searchSpacerReferences(genomeInput: SpacerGenome, libraryInput: SpacerLibrary, settings: Partial<SpacerSearchOptions> = {}): SpacerSearchResult {
  const genome=validateSpacerGenome(genomeInput),library=validateSpacerLibrary(libraryInput),options=resolveSpacerOptions(settings);
  if(options.hostId!==null&&!library.hosts.some(h=>h.id===options.hostId))throw new Error('Selected host is absent from this library.');
  const selected=library.spacers.filter(s=>options.hostId===null||s.hostId===options.hostId),excluded:SpacerSearchResult['excluded']=[];
  const usable=selected.filter(s=>{
    const reason=s.target!=='DNA'?'Only explicitly DNA-targeting references are supported.':s.orientation!=='guide-equivalent'?'Spacer orientation is unknown.':
      s.sequence.length<SPACER_LIMITS.minLength||s.sequence.length>SPACER_LIMITS.maxLength?'Supported spacer lengths are 20–128 bases.':
      /[^ACGT]/.test(s.sequence)?'Spacer contains ambiguous bases; not treated as wildcards.':s.sequence.length>genome.sequence.length?'Spacer is longer than the genome.':null;
    if(reason)excluded.push({spacerId:s.id,hostId:s.hostId,reason});return !reason;
  });
  const n=genome.sequence.length,circular=genome.topology==='circular',runs=knownRuns(genome.sequence,circular);
  const coverage=[...new Set(usable.map(s=>s.sequence.length))].sort((a,b)=>a-b).map(length=>({length,possibleStarts:circular?n:n-length+1,
    unambiguousStarts:circular&&runs.allKnown?n:[...runs.histogram].reduce((sum,[run,count])=>sum+count*Math.max(0,run-length+1),0)}));
  const search=genome.sequence+(circular?genome.sequence.slice(0,SPACER_LIMITS.maxLength-1):'');
  type Match={start:number;strand:'+'|'-';protospacer:string;mismatchPositions:number[]};
  const cached=new Map<string,Match[]>();let occurrences=0,candidates=0,comparisons=0;
  const hits:ReferenceSpacerHit[]=[];
  for(const spacer of usable) {
    let matches=cached.get(spacer.sequence);
    if(!matches){
      matches=[];
      for(const strand of ['+','-'] as const){
        const query=strand==='+'?spacer.sequence:reverse(spacer.sequence),m=query.length,starts=circular?n:n-m+1;
        const seen=new Set<number>();
        for(let b=0;b<=options.maxMismatches;b++){
          const offset=Math.floor(b*m/(options.maxMismatches+1)),end=Math.floor((b+1)*m/(options.maxMismatches+1));
          const block=query.slice(offset,end);
          for(let found=search.indexOf(block);found!==-1;found=search.indexOf(block,found+1)){
            if(++occurrences>SPACER_LIMITS.seedOccurrences)throw new Error('Spacer search seed-occurrence budget exceeded. Select fewer references; no partial result was accepted.');
            const start=found-offset;if(start<0||start>=starts||seen.has(start))continue;seen.add(start);
            if(++candidates>SPACER_LIMITS.candidates)throw new Error('Spacer candidate budget exceeded. Select fewer references; no partial result was accepted.');
            const mismatchPositions:number[]=[];let valid=true;
            for(let j=0;j<m;j++){
              if(++comparisons>SPACER_LIMITS.comparisons)throw new Error('Spacer comparison budget exceeded. Select fewer references; no partial result was accepted.');
              const base=search[start+j];if(!/[ACGT]/.test(base)){valid=false;break;}
              if(base!==query[j])mismatchPositions.push(strand==='+'?j:m-1-j);
              if(mismatchPositions.length>options.maxMismatches){valid=false;break;}
            }
            if(valid){if(matches.length>=SPACER_LIMITS.hits)throw new Error('Spacer hit budget exceeded. Narrow the reference scope; no partial result was accepted.');const raw=search.slice(start,start+m);matches.push({start,strand,protospacer:strand==='+'?raw:reverse(raw),mismatchPositions:mismatchPositions.sort((a,b)=>a-b)});}
          }
        }
      }
      matches.sort((a,b)=>a.start-b.start||(a.strand===b.strand?0:a.strand==='+'?-1:1));cached.set(spacer.sequence,matches);
    }
    for(const match of matches){
      if(hits.length>=SPACER_LIMITS.hits)throw new Error('Spacer hit budget exceeded. Select fewer references or lower the mismatch allowance; no partial result was accepted.');
      const count=spacer.seed?match.mismatchPositions.filter(p=>p>=spacer.seed!.start&&p<spacer.seed!.end).length:null;
      hits.push({...match,spacerId:spacer.id,hostId:spacer.hostId,end:match.start+spacer.sequence.length,wrapsOrigin:match.start+spacer.sequence.length>n,
        segments:intervals(match.start,spacer.sequence.length,n),identity:1-match.mismatchPositions.length/spacer.sequence.length,
        seed:{status:count===null?'not-assessed':count<=spacer.seed!.maxMismatches?'matched':'mismatched',mismatches:count},
        pam:pamEvidence(genome,match.start,spacer.sequence.length,match.strand,spacer.pam)});
    }
  }
  const hosts=library.hosts.filter(h=>options.hostId===null||h.id===options.hostId).map(h=>{
    const hostHits=hits.filter(hit=>hit.hostId===h.id);
    return {hostId:h.id,records:selected.filter(s=>s.hostId===h.id).length,searched:usable.filter(s=>s.hostId===h.id).length,excluded:excluded.filter(s=>s.hostId===h.id).length,
      hitRecords:new Set(hostHits.map(hit=>hit.spacerId)).size,uniqueLoci:new Set(hostHits.map(hit=>`${hit.start}:${hit.end}:${hit.strand}`)).size};
  });
  const warnings=[
    'Sequence similarity and supplied PAM/seed rules do not establish interference, immunity, host range, susceptibility or anti-CRISPR activity.',
    'Only ungapped substitutions in complete unambiguous DNA windows are searched, on both strands. Indels, RNA targeting and unsupported references are excluded.',
    'PAM and seed coordinates refer to the supplied guide-equivalent DNA orientation; no motif, seed, system type or strain is inferred. Rule matches are not calibrated probabilities.',
    'Reference coverage is limited to the supplied library and selected hosts. No hit, no host data and unsupported records are distinct; none implies susceptibility.',
    'Repeated reference sequences are searched once but retain all source IDs. Hit rows are not independent observations; unique loci are reported separately.',
  ];
  if(genome.topology==='unknown')warnings.push('Genome topology is unknown: origin-spanning comparisons and boundary PAMs are not assumed.');
  if(library.source.kind==='demo')warnings.unshift('The reference library is explicitly synthetic demonstration data.');
  return {options,hits,excluded,coverage,hosts,selectedRecords:selected.length,searchedRecords:usable.length,distinctSequences:cached.size,
    status:!selected.length?'no-spacer-data':!usable.length?'unsupported-references':!coverage.some(c=>c.unambiguousStarts)?'no-usable-windows':hits.length?'sequence-matches':'no-sequence-match',complete:true,warnings};
}
const METHOD={id:'sourced-spacer-dna-search',version:'1',implementation:'Pigeonhole-complete ungapped candidate search; full Hamming verification; guide-oriented user-supplied PAM/seed constraints; explicit circular coordinates'};
export async function createSpacerRecord(genomeInput: SpacerGenome, libraryInput: SpacerLibrary, result: SpacerSearchResult): Promise<AnalysisRecord> {
  const genome=validateSpacerGenome(genomeInput),library=validateSpacerLibrary(libraryInput);
  const coverage={available:result.searchedRecords,total:result.selectedRecords,unit:'records' as const};
  const field=(label:string,value:unknown)=>library.source.kind==='demo'?{label,kind:'demo' as const,units:'records' as const,value:analysisJson(value),coverage,limitations:result.warnings,assumptions:['Explicit synthetic reference library; no measured immunity.']}:
    {label,kind:'sequence-score' as const,units:'records' as const,value:analysisJson(value),coverage,limitations:result.warnings};
  return createAnalysisRecord({method:METHOD,inputs:[{id:'genome',accession:genome.accession,source:genome.source,description:'Exact searched DNA, identity and explicitly selected topology.',data:analysisJson(genome)},
    {id:'spacerLibrary',accession:null,source:library.source.kind,description:'Exact host/array reference records, oriented constraints, version, scope and usage permission.',data:analysisJson(library)}],
    parameters:analysisJson(result.options) as AnalysisRecord['parameters'],seed:null,
    references:[{id:'supplied-spacer-library',version:library.source.version,description:library.source.reference},
      {id:'comparison-convention',version:'guide-equivalent-0-based-v1',description:'Guide-equivalent DNA orientation; 0-based half-open intervals; wrapped hits have split forward-genome segments.'}],
    fields:{matches:field('DNA sequence matches and supplied rule checks',result.hits),coverage:field('Search coverage, host scope and excluded references',{status:result.status,hosts:result.hosts,windows:result.coverage,excluded:result.excluded,distinctSequences:result.distinctSequences,complete:result.complete})}});
}
export async function replaySpacerRecord(content:string,selectedGenome:SpacerGenome):Promise<{genome:SpacerGenome;library:SpacerLibrary;result:SpacerSearchResult;record:AnalysisRecord}> {
  const saved=await parseAnalysisRecord(content,{methodId:METHOD.id,methodVersion:METHOD.version});
  if(saved.inputs.length!==2||saved.inputs[0].id!=='genome'||saved.inputs[1].id!=='spacerLibrary')throw new Error('Unsupported spacer evidence input contract.');
  const genome=validateSpacerGenome(selectedGenome);
  if(JSON.stringify(analysisJson(genome))!==JSON.stringify(analysisJson(saved.inputs[0].data)))throw new Error('Selected genome sequence, identity or topology differs from saved spacer evidence.');
  const library=validateSpacerLibrary(saved.inputs[1].data),result=searchSpacerReferences(genome,library,saved.parameters as Partial<SpacerSearchOptions>),record=await createSpacerRecord(genome,library,result);
  if(record.resultId!==saved.resultId||record.cacheKey!==saved.cacheKey)throw new Error('Fresh spacer evidence differs from the saved result or reference contract.');
  return {genome,library,result,record};
}
