import React from 'react';
import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseAnalysisRecord } from '../../../../core/src/analysis-result';
import {
  ATTACHMENT_LIMITS, reconstructAttachment, resolveAttachmentOptions, createAttachmentExperimentRecord,
  type AttachmentReconstructionInput,
} from '../../../../core/src/analysis/prophage-excision';
import {
  AttachmentExperimentResults, attachmentSiteFromDraft, attachmentFlankFromDraft,
  readAttachmentPhage, readAttachmentFile, attachmentDownload, excisionInputFromAttachment,
} from './AttachmentExperimentPanel';
import { executeAttachmentRequest, isProphageExcisionWork } from '../../workers/ProphageAttachmentSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const phage = (): Parameters<typeof readAttachmentPhage>[1] => ({
  id: 7, name: 'Selected phage', accession: 'PHAGE.1', genomeLength: 6,
});
function fixture(): AttachmentReconstructionInput {
  return {
    format: 'phage-explorer-attachment-reconstruction', version: 1,
    host: { name: 'Private host locus', accession: 'HOST.1', sequence: 'CCGATTAA', topology: 'linear',
      source: { kind: 'local', reference: 'Hand-constructed exact sequence fixture', version: '1', license: 'CC0' } },
    phage: { name: 'Private phage', accession: 'PHAGE.1', sequence: 'TTGACG', topology: 'circular',
      source: { kind: 'local', reference: 'Hand-constructed exact sequence fixture', version: '1', license: 'CC0' } },
    attB: { start: 2, end: 4, strand: '+', evidence: 'Declared GA crossover core in the host fixture' },
    attP: { start: 2, end: 4, strand: '+', evidence: 'Declared GA crossover core in the phage fixture' },
    circularization: 'already-circular',
  };
}
async function experiment(input = fixture()) {
  const options = resolveAttachmentOptions({ flankLength: 2 });
  const result = reconstructAttachment(input, options);
  const record = await createAttachmentExperimentRecord(input, result);
  return { input, options, result, record, verified: false };
}
const bases = (fasta: string) => fasta.split('\n').filter(line => !line.startsWith('>')).join('');

describe('attachment reconstruction form boundary', () => {
  it('converts displayed inclusive coordinates once and preserves reverse orientation', () => {
    expect(attachmentSiteFromDraft({ start: '3', end: '4', strand: '-', evidence: '  supplied core  ' }, 'attB'))
      .toEqual({ start: 2, end: 4, strand: '-', evidence: 'supplied core' });
    expect(attachmentSiteFromDraft({ start: '1', end: '1', strand: '+', evidence: 'one base' }, 'attP').start).toBe(0);
    for (const [start, end] of [['', '4'], ['0', '4'], ['1e2', '110'], [' 3', '4'], ['3.0', '4'], ['5', '4'],
      ['1', String(ATTACHMENT_LIMITS.coreBases + 1)], ['9007199254740992', '9007199254740992']]) {
      expect(() => attachmentSiteFromDraft({ start, end, strand: '+', evidence: 'test' }, 'attB')).toThrow();
    }
  });

  it('does not coerce empty, fractional, exponential or oversized preview lengths', () => {
    expect(attachmentFlankFromDraft('0')).toBe(0);
    expect(attachmentFlankFromDraft('1000')).toBe(1000);
    for (const value of ['', '-1', '1.5', '1e2', ' 50', '1001', '9007199254740992']) {
      expect(() => attachmentFlankFromDraft(value)).toThrow();
    }
  });
});

describe('captured selected phage ownership and bounds', () => {
  it('captures complete bases, accession and catalog version without inferring circular topology', async () => {
    const calls: unknown[] = [];
    const repository = {
      getOfflineDataset: () => ({ describe: () => ({ contentVersion: 'a'.repeat(64) }) }),
      getFullGenomeLength: async (id: number) => { calls.push(['length', id]); return 6; },
      getSequenceWindow: async (id: number, start: number, end: number) => { calls.push(['sequence', id, start, end]); return 'TTGACG'; },
    };
    const source = await readAttachmentPhage(repository, phage(), new AbortController().signal, () => true);
    expect(calls).toEqual([['length', 7], ['sequence', 7, 0, 6]]);
    expect(source).toMatchObject({ name: 'Selected phage', accession: 'PHAGE.1', sequence: 'TTGACG', topology: 'unknown',
      source: { kind: 'catalog', version: 'a'.repeat(64), reference: 'https://www.ncbi.nlm.nih.gov/nuccore/PHAGE.1' } });
  });

  it('never reads a partial or oversized selected genome', async () => {
    let sequenceReads = 0;
    const repository = { getFullGenomeLength: async () => 0,
      getSequenceWindow: async () => { sequenceReads++; return 'TTGACG'; } };
    for (const length of [0, -1, 1.5, ATTACHMENT_LIMITS.sequenceBases + 1, 7]) {
      repository.getFullGenomeLength = async () => length;
      await expect(readAttachmentPhage(repository, phage(), new AbortController().signal, () => true)).rejects.toThrow();
    }
    expect(sequenceReads).toBe(0);
    repository.getFullGenomeLength = async () => 6;
    repository.getSequenceWindow = async () => 'TTG';
    await expect(readAttachmentPhage(repository, phage(), new AbortController().signal, () => true)).rejects.toThrow('incomplete');
  });

  it('refuses late reads after cancellation, same-ID source replacement or catalog-version replacement', async () => {
    for (const change of ['cancel', 'selection', 'same-id', 'catalog-list', 'version'] as const) {
      const length = deferred<number>(), controller = new AbortController();
      let current = true, version = 'a'.repeat(64), sequenceReads = 0;
      const captured = phage(), capturedList = [captured];
      let selected = captured, selectedList = capturedList;
      const repository = {
        getOfflineDataset: () => ({ describe: () => ({ contentVersion: version }) }),
        getFullGenomeLength: () => length.promise,
        getSequenceWindow: async () => { sequenceReads++; return 'TTGACG'; },
      };
      const pending = readAttachmentPhage(repository, captured, controller.signal,
        () => current && selected === captured && selectedList === capturedList);
      if (change === 'cancel') controller.abort();
      else if (change === 'selection') current = false;
      else if (change === 'same-id') selected = { ...captured };
      else if (change === 'catalog-list') selectedList = [{ ...captured }];
      else version = 'b'.repeat(64);
      length.resolve(6);
      await expect(pending).rejects.toThrow();
      expect(sequenceReads).toBe(0);
    }
  });

  it('checks ownership again after the sequence window and clones source metadata before awaiting', async () => {
    const sequence = deferred<string>(); let current = true;
    const stale = readAttachmentPhage({ getFullGenomeLength: async () => 6, getSequenceWindow: () => sequence.promise },
      phage(), new AbortController().signal, () => current);
    await Promise.resolve(); current = false; sequence.resolve('TTGACG');
    await expect(stale).rejects.toThrow('changed');

    const length = deferred<number>(), source = phage();
    source.localGenome = { contentId: 'a'.repeat(64), sequenceSha256: 'c'.repeat(64), format: 'genbank', topology: 'circular' };
    const reads: number[] = [];
    const pending = readAttachmentPhage({ getFullGenomeLength: () => length.promise,
      getSequenceWindow: async id => { reads.push(id); return 'TTGACG'; } }, source, new AbortController().signal, () => true);
    source.name = 'Edited after capture'; source.id = 99; source.localGenome.contentId = 'b'.repeat(64);
    length.resolve(6);
    expect(await pending).toMatchObject({ name: 'Selected phage', topology: 'circular', source: { kind: 'local', version: 'a'.repeat(64) } });
    expect(reads).toEqual([7]);
  });
});

describe('attachment file import boundary', () => {
  it('uses fatal UTF-8, checks declared and actual bytes, and rejects cancelled reads', async () => {
    const signal = new AbortController().signal;
    expect(await readAttachmentFile(new File(['>one\nCCGATTAA\n'], 'host.fa'), signal)).toBe('>one\nCCGATTAA\n');
    await expect(readAttachmentFile(new File([new Uint8Array([0xff])], 'bad.fa'), signal)).rejects.toThrow();
    let reads = 0;
    await expect(readAttachmentFile({ size: ATTACHMENT_LIMITS.inputBytes + 1,
      arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, signal)).rejects.toThrow('4 MiB');
    expect(reads).toBe(0);
    await expect(readAttachmentFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(ATTACHMENT_LIMITS.inputBytes + 1) }, signal)).rejects.toThrow('4 MiB');
    const bytes = deferred<ArrayBuffer>(), controller = new AbortController();
    const pending = readAttachmentFile({ size: 1, arrayBuffer: () => bytes.promise }, controller.signal);
    controller.abort(); bytes.resolve(new Uint8Array([65]).buffer);
    await expect(pending).rejects.toThrow('cancelled');
  });
});

describe('accepted attachment result and portable downloads', () => {
  it('renders exact declared sources and junctions with escaped user labels', async () => {
    const input = fixture(); input.host.name = '<img src=x onerror=alert(1)>';
    input.phage.name = '<b>private phage</b>';
    const accepted = await experiment(input);
    expect(accepted.result.integratedSequence).toBe('CCGACGTTGATTAA');
    expect(accepted.result.attL.sequence).toBe('CCGACG');
    expect(accepted.result.attR.sequence).toBe('TTGATT');
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={accepted} />);
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;b&gt;private phage&lt;/b&gt;');
    expect(markup).not.toContain('<b>private');
    expect(markup).toContain('data-result-id="' + accepted.record.resultId + '"');
    expect(markup).toContain('>3–4</td>');
    expect(markup).toContain('<mark>GA</mark>');
    expect(markup).toContain('Conserved bases: 8 host + 6 phage');
    expect(markup).toContain('= 14 integrated; expected 14');
    expect(markup).toContain('does not establish that integration occurs biologically');
  });

  it('exports every accepted integrated base, both oriented junctions and the complete replay record', async () => {
    const accepted = await experiment();
    const integrated = attachmentDownload(accepted, 'integrated-fasta');
    expect(integrated.filename).toBe('integrated-locus.fasta');
    expect(bases(integrated.content)).toBe('CCGACGTTGATTAA');
    expect(integrated.content).toContain('result=' + accepted.record.resultId);
    const junctions = attachmentDownload(accepted, 'junction-fasta');
    expect(junctions.content).toContain('>attL-preview result=' + accepted.record.resultId + ' strand=+\nCCGACG\n');
    expect(junctions.content).toContain('>attR-preview result=' + accepted.record.resultId + ' strand=+\nTTGATT\n');
    const serialized = attachmentDownload(accepted, 'experiment');
    const record = await parseAnalysisRecord(serialized.content);
    expect(record.resultId).toBe(accepted.record.resultId);
    expect(record.inputs).toEqual(accepted.record.inputs);
    expect(record.parameters).toEqual(accepted.record.parameters);
    expect(record.fields).toEqual(accepted.record.fields);
  });

  it('labels reversed attachment orientation without swapping source identities', async () => {
    const input = fixture();
    input.host.sequence = 'CCTCAA'; input.attB.strand = '-';
    const accepted = await experiment(input);
    expect(accepted.result.insertionStrand).toBe('-');
    expect(accepted.result.sharedCore).toBe('GA');
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={{ ...accepted, verified: true }} />);
    expect(markup).toContain('Verified replay of the stored sources');
    expect(markup).toContain('attL · strand -');
    expect(markup).toContain('attR · strand -');
    expect(markup).toContain('on a reverse-strand attB, attL is the spatially right-hand junction');
    expect(markup).toContain('Host: Private host locus');
    expect(markup).toContain('Phage: Private phage');
  });
});


describe('accepted prophage excision results and complete downloads', () => {
  it('carries accepted integration coordinates into excision for both site orientations', async () => {
    for (const strand of ['+', '-'] as const) {
      const original = fixture();
      if (strand === '-') { original.host.sequence = 'CCTCAA'; original.attB.strand = '-'; }
      const integrated = await experiment(original), before = structuredClone(integrated);
      const input = excisionInputFromAttachment(integrated);
      expect(input.locus.sequence).toBe(integrated.result.integratedSequence);
      expect(input.locus.source.version).toBe(integrated.record.resultId);
      expect(input.locus.source.reference).toContain(integrated.record.resultId);
      expect(input.attL).toMatchObject({ start: strand === '+' ? 2 : 8, end: strand === '+' ? 4 : 10, strand });
      expect(input.attR).toMatchObject({ start: strand === '+' ? 8 : 2, end: strand === '+' ? 10 : 4, strand });
      const excised = await executeAttachmentRequest({ kind: 'excise', input, options: integrated.options });
      expect(excised.result.restoredHost.sequence).toBe(original.host.sequence);
      expect(excised.result.excisedPhage.sequence).toBe(strand === '+' ? 'GACGTT' : 'TCAACG');
      expect(excised.result.conservation.recoveredBases).toBe(integrated.result.integratedSequence.length);
      expect(integrated).toEqual(before);
    }
  });

  it('renders both source-mapped products, exact declared cores and escaped provenance', async () => {
    const input = excisionInputFromAttachment(await experiment());
    input.locus.name = '<img src=x onerror=alert(1)>';
    input.attL.evidence = '<b>declared left core</b>';
    const accepted = await executeAttachmentRequest({ kind: 'excise', input, options: { flankLength: 2 } });
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={accepted} />);
    expect(markup).toContain('data-testid="excision-result"');
    expect(markup).toContain('data-result-id="' + accepted.record.resultId + '"');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;b&gt;declared left core&lt;/b&gt;');
    expect(markup).toContain('Excised phage: 6 bases');
    expect(markup).toContain('Restored host: 8 bases');
    expect(markup).toContain('>3–4</td>');
    expect(markup).toContain('>9–10</td>');
    expect(markup).toContain('<mark>GA</mark>');
    expect(markup).toContain('6 excised phage + ');
    expect(markup).toContain('8 restored host = 14 recovered');
    expect(markup).toContain('from 14 input bases');
    expect(markup).toContain('does not establish biological excision');
    expect(markup).toContain('Excised phage source-coordinate map');
    expect(markup).toContain('Restored host source-coordinate map');
  });

  it('exports every phage and host base, oriented junctions and a self-contained recomputable experiment', async () => {
    const input = excisionInputFromAttachment(await experiment());
    const accepted = await executeAttachmentRequest({ kind: 'excise', input, options: { flankLength: 2 } });
    const phageFile = attachmentDownload(accepted, 'excised-fasta');
    expect(phageFile.filename).toBe('excised-phage.fasta');
    expect(bases(phageFile.content)).toBe('GACGTT');
    expect(phageFile.content).toContain('topology=circular input-origin=3');
    expect(phageFile.content).toContain('result=' + accepted.record.resultId);
    const hostFile = attachmentDownload(accepted, 'restored-fasta');
    expect(hostFile.filename).toBe('restored-host.fasta');
    expect(bases(hostFile.content)).toBe('CCGATTAA');
    expect(hostFile.content).toContain('topology=linear input-origin=1');
    const junctions = attachmentDownload(accepted, 'junction-fasta');
    expect(junctions.filename).toBe('excision-junctions.fasta');
    expect(junctions.content).toContain('>attP-preview result=' + accepted.record.resultId + ' strand=+\nTTGACG\n');
    expect(junctions.content).toContain('>attB-preview result=' + accepted.record.resultId + ' strand=+\nCCGATT\n');
    const portable = attachmentDownload(accepted, 'experiment');
    expect(portable.filename).toBe('prophage-excision.json');
    expect((await parseAnalysisRecord(portable.content)).inputs).toEqual(accepted.record.inputs);
    const replay = await executeAttachmentRequest({ kind: 'replay', content: portable.content });
    expect(isProphageExcisionWork(replay)).toBe(true);
    expect(replay.result).toEqual(accepted.result);
    expect(replay.record.resultId).toBe(accepted.record.resultId);
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={replay} />);
    expect(markup).toContain('Verified replay of the integrated source');
    expect(() => attachmentDownload(accepted, 'integrated-fasta')).toThrow(/separate phage and host/);
    const integration = await experiment();
    expect(() => attachmentDownload(integration, 'excised-fasta')).toThrow(/Reconstruct excision/);
  });

  it('explains a circular origin change and preserves the complete wrapped phage in FASTA', async () => {
    const input = excisionInputFromAttachment(await experiment());
    input.locus.sequence = 'TTGATTAACCGACG'; input.locus.topology = 'circular';
    input.attL.start = 10; input.attL.end = 12; input.attR.start = 2; input.attR.end = 4;
    const accepted = await executeAttachmentRequest({ kind: 'excise', input, options: { flankLength: 2 } });
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={accepted} />);
    expect(markup).toContain('crossing the circular source origin');
    expect(markup).toContain('>11–14</td>');
    expect(markup).toContain('>1–2</td>');
    expect(markup).toContain('First output base: original input base 3 (1-based)');
    expect(bases(attachmentDownload(accepted, 'excised-fasta').content)).toBe('GACGTT');
    const restored = attachmentDownload(accepted, 'restored-fasta');
    expect(bases(restored.content)).toBe('GATTAACC');
    expect(restored.content).toContain('topology=circular input-origin=3');
  });

  it('keeps long molecule exports complete when the displayed sequence preview is bounded', async () => {
    const input = excisionInputFromAttachment(await experiment());
    input.locus.sequence = 'CCGA' + 'C'.repeat(800) + 'GATTAA';
    input.attR.start = 804; input.attR.end = 806;
    const accepted = await executeAttachmentRequest({ kind: 'excise', input, options: { flankLength: 2 } });
    const markup = renderToStaticMarkup(<AttachmentExperimentResults experiment={accepted} />);
    expect(markup).toContain('first and last 240 bases');
    expect(bases(attachmentDownload(accepted, 'excised-fasta').content)).toBe('GA' + 'C'.repeat(800));
    expect(bases(attachmentDownload(accepted, 'restored-fasta').content)).toBe('CCGATTAA');
  });
});
