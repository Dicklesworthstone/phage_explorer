import { describe, expect, it } from 'bun:test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import {
  createRestrictionDigestRecord, exportRestrictionDigestTsv, findRestrictionCutSites,
  parseRestrictionDigestRecord, replayRestrictionDigestRecord, resolveRestrictionDigestOptions,
} from './restriction-digest';
import { RESTRICTION_ENZYMES } from '../data/restriction-enzymes';

const eco = { enzymes: ['EcoRI'], topology: 'linear' as const };

describe('Portable restriction digest experiments', () => {
  it('exports literal combined cuts and coordinate-bearing fragments from exact source', async () => {
    const record = await createRestrictionDigestRecord('gaattcGATCGATC', {
      enzymes: ['MboI', 'EcoRI'], topology: 'linear',
    }, { accession: 'private', source: 'local' });
    expect(record.inputs[0].data).toBe('gaattcGATCGATC');
    expect(record.parameters).toEqual({ enzymes: ['EcoRI', 'MboI'], topology: 'linear' });
    expect(record.fields.cutSites.value).toEqual([1, 6, 10]);
    expect(record.fields.fragments.value).toEqual([
      { start: 1, end: 6, length: 5, wrapsOrigin: false },
      { start: 6, end: 10, length: 4, wrapsOrigin: false },
      { start: 10, end: 14, length: 4, wrapsOrigin: false },
      { start: 0, end: 1, length: 1, wrapsOrigin: false },
    ]);
    const restored = await replayRestrictionDigestRecord(serializeAnalysisRecord(record));
    expect(restored.resultId).toBe(record.resultId);
    expect(exportRestrictionDigestTsv(restored)).toContain('1\t6\t5\tfalse\n');
    expect(exportRestrictionDigestTsv(restored)).toContain('cuts_0based=1,6,10');
  });

  it('preserves origin-spanning recognition, full-circle cut products and uncut circles', async () => {
    const circular = { ...eco, topology: 'circular' as const };
    const record = await createRestrictionDigestRecord('AATTCAAAAG', circular);
    expect(record.fields.cutSites.value).toEqual([0]);
    expect(record.fields.fragments.value).toEqual([{ start: 0, end: 0, length: 10, wrapsOrigin: true }]);
    expect(exportRestrictionDigestTsv(record)).toContain('0\t0\t10\ttrue');
    const uncut = await createRestrictionDigestRecord('CCCC', circular);
    expect(uncut.fields.summary.value).toEqual({ sequenceLength: 4, resolvedBases: 4, ambiguousBases: 0,
      cutCount: 0, fragmentCount: 1, uncutCircular: true });
    expect(uncut.fields.fragments.value).toEqual([{ start: 0, end: 4, length: 4, wrapsOrigin: false }]);
    expect((await replayRestrictionDigestRecord(serializeAnalysisRecord(record))).resultId).toBe(record.resultId);
  });

  it('retains overlapping sites and never counts an unresolved base as a definite match', async () => {
    const overlapping = await createRestrictionDigestRecord('GCGGCCGCGGCCGC', { enzymes: ['NotI'], topology: 'linear' });
    expect(overlapping.fields.cutSites.value).toEqual([2, 8]);
    const unknown = await createRestrictionDigestRecord('NNNNGAANTC', eco);
    expect(unknown.fields.cutSites.value).toEqual([]);
    expect(unknown.fields.cutSites.coverage).toEqual({ available: 5, total: 10, unit: 'bases' });
    expect(unknown.fields.cutSites.limitations.join(' ')).toContain('does not exclude sites');
    const degenerate = await createRestrictionDigestRecord('GGACCNNNGGTCC', { enzymes: ['AvaII'], topology: 'linear' });
    expect(degenerate.fields.cutSites.value).toEqual([1, 9]);
  });

  it('treats no enzymes as an explicit uncut control without losing the source', async () => {
    const record = await createRestrictionDigestRecord('GAATTC', { enzymes: [], topology: 'linear' });
    expect(record.inputs[1].data).toEqual([]);
    expect(record.fields.cutSites.value).toEqual([]);
    expect(record.fields.fragments.value).toEqual([{ start: 0, end: 6, length: 6, wrapsOrigin: false }]);
    expect((await replayRestrictionDigestRecord(serializeAnalysisRecord(record))).resultId).toBe(record.resultId);
  });

  it('binds exact sequence, topology and enzyme selection while canonicalizing selection order', async () => {
    const original = await createRestrictionDigestRecord('GAATTCGATC', { enzymes: ['EcoRI', 'MboI'], topology: 'linear' });
    const reordered = await createRestrictionDigestRecord('GAATTCGATC', { enzymes: ['MboI', 'EcoRI'], topology: 'linear' });
    expect(original.resultId).toBe(reordered.resultId);
    for (const changed of [
      await createRestrictionDigestRecord('gaattcGATC', { enzymes: ['EcoRI', 'MboI'], topology: 'linear' }),
      await createRestrictionDigestRecord('GAATTCGATC', { enzymes: ['EcoRI', 'MboI'], topology: 'circular' }),
      await createRestrictionDigestRecord('GAATTCGATC', eco),
    ]) expect(changed.cacheKey).not.toBe(original.cacheKey);
  });

  it('snapshots mutable settings before hashing', async () => {
    const settings = { enzymes: ['EcoRI'], topology: 'linear' as const };
    const context = { accession: 'before', source: 'local' as const };
    const pending = createRestrictionDigestRecord('GAATTC', settings, context);
    settings.enzymes[0] = 'MboI'; context.accession = 'after';
    const record = await pending;
    expect(record.parameters.enzymes).toEqual(['EcoRI']);
    expect(record.inputs[0].accession).toBe('before');
    expect(record.fields.cutSites.value).toEqual([1]);
  });

  it('rejects malformed settings and formatted/non-DNA/oversized source', async () => {
    for (const options of [null, {}, { enzymes: ['EcoRI'] }, { ...eco, topology: true },
      { ...eco, enzymes: ['EcoRI', 'EcoRI'] }, { ...eco, enzymes: ['Unknown'] },
      { ...eco, enzymes: [null] }, { ...eco, hidden: true }]) {
      expect(() => resolveRestrictionDigestOptions(options)).toThrow();
    }
    for (const input of ['', 'GAAT TC', 'GAATTC\n', 'AAU', 'ß', 'AC-GT', 'A'.repeat(5000001)]) {
      await expect(createRestrictionDigestRecord(input, eco)).rejects.toThrow();
    }
  });

  it('refuses too many cuts rather than exporting a plausible truncated digest', async () => {
    await expect(createRestrictionDigestRecord('GATC'.repeat(20001), {
      enzymes: ['MboI'], topology: 'linear',
    })).rejects.toThrow('no partial result');
    const mbo = RESTRICTION_ENZYMES.find(enzyme => enzyme.name === 'MboI')!;
    expect(findRestrictionCutSites('GATCGATC', mbo, false, 2)).toEqual([0, 4]);
    expect(() => findRestrictionCutSites('GATCGATC', mbo, false, 1)).toThrow('no partial result');
    expect(() => findRestrictionCutSites('GATC', mbo, false, -1)).toThrow();
  });

  it('rejects stale checksums and also rejects rehashed invented fragment lengths', async () => {
    const record = await createRestrictionDigestRecord('GAATTC', eco);
    const altered = structuredClone(record);
    altered.fields.fragments.value = [{ start: 0, end: 6, length: 999, wrapsOrigin: false }];
    await expect(replayRestrictionDigestRecord(serializeAnalysisRecord(altered))).rejects.toThrow('checksum');
    const rehashed = await createAnalysisRecord(altered);
    await parseAnalysisRecord(serializeAnalysisRecord(rehashed)); // Envelope is valid; numerical claim is not.
    await expect(replayRestrictionDigestRecord(serializeAnalysisRecord(rehashed))).rejects.toThrow('Recomputed restriction');
  });

  it('rejects changed enzyme definitions, method, conventions and implicit parameters even with valid hashes', async () => {
    const record = await createRestrictionDigestRecord('GAATTC', eco);
    const changed = structuredClone(record);
    changed.inputs[1].data = [{ name: 'EcoRI', site: 'GAATTC', cutOffset: 2, overhang: '5' }];
    await expect(replayRestrictionDigestRecord(serializeAnalysisRecord(await createAnalysisRecord(changed)))).rejects.toThrow('enzyme definitions');
    for (const change of [
      { method: { ...record.method, implementation: 'another implementation' } },
      { references: [] }, { seed: 1 }, { parameters: { enzymes: ['EcoRI'] } },
    ]) await expect(replayRestrictionDigestRecord(serializeAnalysisRecord(await createAnalysisRecord({ ...record, ...change })))).rejects.toThrow();
  });

  it('validates imported source identity before producing a replay result', async () => {
    const record = await createRestrictionDigestRecord('GAATTC', eco);
    const changed = structuredClone(record);
    changed.inputs[0].data = 'CCCCCC';
    const rehashed = await createAnalysisRecord(changed);
    await expect(replayRestrictionDigestRecord(serializeAnalysisRecord(rehashed))).rejects.toThrow('Recomputed restriction');
    const parsed = await parseRestrictionDigestRecord(serializeAnalysisRecord(record));
    expect(parsed.sequence).toBe('GAATTC');
    expect(parsed.options).toEqual(eco);
  });

  it('matches a per-base oracle for every catalog enzyme at every circular origin', async () => {
    const allowed: Record<string, string> = { A: 'A', C: 'C', G: 'G', T: 'T', W: 'AT', R: 'AG', Y: 'CT',
      S: 'CG', M: 'AC', K: 'GT', B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT' };
    for (const enzyme of RESTRICTION_ENZYMES) {
      const motif = [...enzyme.site].map(base => allowed[base][0]).join('');
      const sequence = motif + 'AT' + motif;
      for (let shift = 0; shift < sequence.length; shift++) {
        const rotated = sequence.slice(shift) + sequence.slice(0, shift);
        const cuts: number[] = [];
        for (let start = 0; start < sequence.length; start++) {
          if ([...enzyme.site].every((base, offset) => allowed[base].includes(rotated[(start + offset) % rotated.length]))) {
            cuts.push((start + enzyme.cutOffset) % rotated.length);
          }
        }
        const expected = [...new Set(cuts)].sort((a, b) => a - b);
        const record = await createRestrictionDigestRecord(rotated.toLowerCase(), { enzymes: [enzyme.name], topology: 'circular' });
        expect(record.fields.cutSites.value).toEqual(expected);
        expect(record.fields.fragments.value).toEqual(expected.map((start, i) => {
          const end = expected[(i + 1) % expected.length];
          return { start, end, length: (end - start + rotated.length) % rotated.length || rotated.length, wrapsOrigin: end <= start };
        }).sort((a, b) => b.length - a.length));
      }
    }
  });
});
