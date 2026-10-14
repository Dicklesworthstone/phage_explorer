import { describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import {
  computeDotPlot, computeDotPlotBuffers, getDotPlotWindowRange,
  createDotPlotExperiment, replayDotPlotExperiment, exportDotPlotExperimentTsv,
  computePairwiseDotPlotBuffers, createPairwiseDotPlotExperiment, replayPairwiseDotPlotExperiment,
  exportPairwiseDotPlotExperimentTsv,
  type DotPlotConfig, type DotPlotExperimentInput,
} from './dot-plot';

const resolved = (sequence: string, config: DotPlotConfig = {}) =>
  computeDotPlot(sequence, { ...config, ambiguity: 'exclude' });

describe('Dot plot', () => {
  it('computeDotPlot > empty sequence returns empty grid', () => {
    expect(computeDotPlot('')).toEqual({ grid: [], bins: 0, window: 0 });
  });

  it('computeDotPlot > produces bins x bins grid with expected direct/inverted identities', () => {
    // With explicit window=2, bins=2:
    // bin0 window = "AC", bin1 window = "GT"
    // reverseComplement("AC") = "GT"
    // reverseComplement("GT") = "AC"
    const result = computeDotPlot('ACGT', { bins: 2, window: 2 });
    expect(result.bins).toBe(2);
    expect(result.window).toBe(2);
    expect(result.grid).toHaveLength(2);
    expect(result.grid[0]).toHaveLength(2);
    expect(result.grid[1]).toHaveLength(2);

    expect(result.grid[0]![0]).toEqual({ direct: 1, inverted: 0 });
    expect(result.grid[0]![1]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![0]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![1]).toEqual({ direct: 1, inverted: 0 });
  });

  it('does not invent direct or inverted matches from unresolved bases', () => {
    for (const sequence of ['NNNN', 'RYRY', 'SSWW', '----', 'uuuu', '????']) {
      const result = resolved(sequence, { bins: 3, window: 2 });
      for (const row of result.grid) {
        for (const cell of row) expect(cell).toEqual({ direct: 0, inverted: 0 });
      }
    }
  });

  it('keeps unresolved positions in the denominator and preserves lowercase matches', () => {
    // AN vs NT: the direct diagonal has one observed base out of two;
    // RC(AN) vs NT has one resolved complementary match, not two N matches.
    const result = resolved('anNt', { bins: 2, window: 2 });
    expect(result.grid[0]![0]).toEqual({ direct: 0.5, inverted: 0 });
    expect(result.grid[0]![1]).toEqual({ direct: 0, inverted: 0.5 });
    expect(result.grid[1]![0]).toEqual(result.grid[0]![1]);
    expect(result.grid[1]![1]).toEqual({ direct: 0.5, inverted: 0 });
  });

  it('uses overlapping windows including the terminal base without compressing unknowns', () => {
    // Starts 0,1,2,3: AC, CN, NG, GT. The middle windows are not CG.
    const result = resolved('ACNGT', { bins: 4, window: 2 });
    expect(result.grid[0]![3]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![1].direct).toBe(0.5);
    expect(result.grid[2]![2].direct).toBe(0.5);
    expect(result.grid[1]![2].inverted).toBe(0.5);
  });

  it('preserves coordinates for non-ASCII input rather than expanding uppercase characters', () => {
    // Uppercasing the entire input would expand ß into SS and shift the last window.
    const result = resolved('AßT', { bins: 3, window: 1 });
    expect(result.grid[0]![2].inverted).toBe(1);
    expect(result.grid[1]![1]).toEqual({ direct: 0, inverted: 0 });
  });

  it('supports a single bin and clamps oversized windows to the full sequence', () => {
    expect(computeDotPlot('ACGT', { bins: 1, window: 100 })).toEqual({
      bins: 1, window: 4, grid: [[{ direct: 1, inverted: 1 }]],
    });
    const short = computeDotPlot('a', { bins: 3 });
    expect(short.window).toBe(1);
    for (const row of short.grid) {
      for (const cell of row) expect(cell).toEqual({ direct: 1, inverted: 0 });
    }
  });

  it('rejects invalid or unbounded dimensions before allocating a matrix', () => {
    for (const bins of [0, -1, 1.5, NaN, Infinity, 1025, Number.MAX_SAFE_INTEGER]) {
      expect(() => computeDotPlot('ACGT', { bins })).toThrow(RangeError);
    }
    for (const window of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => computeDotPlot('ACGT', { window })).toThrow(RangeError);
    }
  });

  it('agrees with an independent literal-window oracle for all 625 A/C/G/T/N four-mers', () => {
    const alphabet = 'ACGTN';
    const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
    for (let code = 0; code < 625; code++) {
      let n = code;
      let sequence = '';
      for (let k = 0; k < 4; k++) {
        sequence += alphabet[n % 5];
        n = Math.floor(n / 5);
      }
      // Three length-two windows have independently known starts 0, 1, 2.
      const windows = [sequence.slice(0, 2), sequence.slice(1, 3), sequence.slice(2, 4)];
      const result = resolved(sequence, { bins: 3, window: 2 });
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const a = windows[i];
          const b = windows[j];
          let direct = 0;
          let inverted = 0;
          for (let k = 0; k < 2; k++) {
            if (complement[a[k]] && a[k] === b[k]) direct++;
            if (complement[a[1 - k]] === b[k]) inverted++;
          }
          expect(result.grid[i]![j]).toEqual({ direct: direct / 2, inverted: inverted / 2 });
        }
      }
    }
  });
  it('preserves the existing literal IUPAC matching contract independently of resolved evidence', () => {
    const literal = computeDotPlot('rY', { bins: 2, window: 1 });
    expect(literal.grid).toEqual([
      [{ direct: 1, inverted: 0 }, { direct: 0, inverted: 1 }],
      [{ direct: 0, inverted: 1 }, { direct: 1, inverted: 0 }],
    ]);
    expect(computeDotPlot('NN', { bins: 1, window: 2 }).grid[0]![0])
      .toEqual({ direct: 1, inverted: 1 });
    expect(resolved('NN', { bins: 1, window: 2 }).grid[0]![0])
      .toEqual({ direct: 0, inverted: 0 });
    expect(() => computeDotPlot('ACGT', { ambiguity: 'invalid' as 'literal' })).toThrow(RangeError);
  });

  it('reports exact half-open sampled windows including the final base', () => {
    expect(Array.from({ length: 4 }, (_, i) => getDotPlotWindowRange(101, 4, 20, i)))
      .toEqual([{ start: 0, end: 20 }, { start: 27, end: 47 }, { start: 54, end: 74 }, { start: 81, end: 101 }]);
    expect(getDotPlotWindowRange(5, 4, 2, 1)).toEqual({ start: 1, end: 3 });
    expect(getDotPlotWindowRange(4, 1, 4, 0)).toEqual({ start: 0, end: 4 });
  });

  it('rejects window coordinates outside the actual matrix or sequence', () => {
    for (const args of [[0, 1, 1, 0], [5, 0, 2, 0], [5, 2, 6, 0], [5, 2, 2, -1], [5, 2, 2, 2], [5, 2, 2, NaN]]) {
      expect(() => getDotPlotWindowRange(args[0], args[1], args[2], args[3])).toThrow(RangeError);
    }
  });
});

/** Deliberately scalar oracle: compare literal windows, not packed codes, and
 * compute both matrix triangles independently to catch orientation mistakes.
 */
function windowOracle(sequence: string, bins: number, window: number, ambiguity: 'literal' | 'exclude') {
  const seq = ambiguity === 'literal' ? sequence.toUpperCase() : sequence;
  window = Math.min(window, seq.length);
  const complement: Record<string, string> = {
    A: 'T', C: 'G', G: 'C', T: 'A', R: 'Y', Y: 'R', S: 'S', W: 'W',
    K: 'M', M: 'K', B: 'V', V: 'B', D: 'H', H: 'D', N: 'N',
  };
  const windows = Array.from({ length: bins }, (_, bin) => {
    const start = bins === 1 ? 0 : Math.floor(bin * ((seq.length - window) / (bins - 1)));
    return seq.slice(start, start + window);
  });
  return { bins, window, grid: windows.map(a => windows.map(b => {
    let direct = 0;
    let inverted = 0;
    for (let k = 0; k < window; k++) {
      if (ambiguity === 'literal') {
        if (a[k] === b[k]) direct++;
        const reverseBase = a[window - 1 - k];
        if ((complement[reverseBase] ?? reverseBase) === b[k]) inverted++;
      } else {
        const left = /[ACGTacgt]/.test(a[k]) ? a[k].toUpperCase() : '';
        const right = /[ACGTacgt]/.test(b[k]) ? b[k].toUpperCase() : '';
        const reverseBase = a[window - 1 - k];
        const reverse = /[ACGTacgt]/.test(reverseBase) ? complement[reverseBase.toUpperCase()] : '';
        if (left && left === right) direct++;
        if (reverse && reverse === right) inverted++;
      }
    }
    return { direct: direct / window, inverted: inverted / window };
  })) };
}

describe('Packed dot plot equivalence', () => {
  let state = 0x7f4a7c15;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const dna = (length: number, alphabet: string) =>
    Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');

  it('matches the independent oracle at every bit alignment and tail length', () => {
    for (let window = 31; window <= 65; window++) {
      for (const ambiguity of ['literal', 'exclude'] as const) {
        const sequence = dna(window + 32, ambiguity === 'literal' ? 'ACGT' : 'ACGTacgtNNR?-');
        // Exactly 33 windows, starting at every position from 0 through 32.
        expect(computeDotPlot(sequence, { bins: 33, window, ambiguity }))
          .toEqual(windowOracle(sequence, 33, window, ambiguity));
      }
    }
  });

  it('matches exact scalar results for independently generated multiword windows', () => {
    for (let trial = 0; trial < 40; trial++) {
      const sequence = dna(100 + next() % 1000, trial % 2 ? 'ACGTacgt' : 'ACGTacgtNRY-?ß');
      const bins = 2 + next() % 16;
      const window = 32 + next() % (sequence.length - 31);
      for (const ambiguity of ['literal', 'exclude'] as const) {
        expect(computeDotPlot(sequence, { bins, window, ambiguity }))
          .toEqual(windowOracle(sequence, bins, window, ambiguity));
      }
    }
  });

  it('does not count padding or unresolved bits as matches', () => {
    for (const window of [32, 33, 63, 64, 65, 97]) {
      const sequence = 'N'.repeat(window * 2);
      for (const row of resolved(sequence, { bins: 7, window }).grid) {
        for (const cell of row) expect(cell).toEqual({ direct: 0, inverted: 0 });
      }
      const mixed = `A${sequence.slice(1, -1)}T`;
      expect(resolved(mixed, { bins: 2, window }).grid[0]![1])
        .toEqual({ direct: 0, inverted: 1 / window });
    }
  });

  it('keeps literal IUPAC/Unicode semantics for long fallback windows', () => {
    for (const sequence of ['RYSWKMBDHVN?'.repeat(20), 'AßTŉ'.repeat(40)]) {
      for (const ambiguity of ['literal', 'exclude'] as const) {
        expect(computeDotPlot(sequence, { bins: 11, window: 65, ambiguity }))
          .toEqual(windowOracle(sequence, 11, 65, ambiguity));
      }
    }
  });

  it('returns independently mutable cells, including the symmetric triangle', () => {
    const result = resolved('ACGT'.repeat(40), { bins: 4, window: 64 });
    const opposite = { ...result.grid[1]![0] };
    result.grid[0]![1].direct = -1;
    expect(result.grid[1]![0]).toEqual(opposite);
  });
});

describe('Dot plot output and sampling contracts', () => {
  it('preserves distinct coordinates when encoding sparse sampled windows', () => {
    const sequence = `${'N'.repeat(3000)}aCgT${'RY'.repeat(1800)}GTAC`;
    for (const bins of [1, 2, 7, 31]) {
      for (const window of [1, 16, 32, 65]) {
        for (const ambiguity of ['exclude', 'literal'] as const) {
          expect(computeDotPlot(sequence, { bins, window, ambiguity }))
            .toEqual(windowOracle(sequence, bins, window, ambiguity));
        }
      }
    }
  });

  it('expands duplicate sampled windows without changing values or sharing cell objects', () => {
    for (const sequence of ['ACGT'.repeat(33), 'ANRY'.repeat(33)]) {
      for (const window of [sequence.length - 4, sequence.length, sequence.length + 100]) {
        for (const ambiguity of ['exclude', 'literal'] as const) {
          const result = computeDotPlot(sequence, { bins: 17, window, ambiguity });
          expect(result).toEqual(windowOracle(sequence, 17, window, ambiguity));
          expect(new Set(result.grid.flat()).size).toBe(17 * 17);
        }
      }
    }
  });

  it('writes row-major transfer arrays with exactly the established Float32 rounding', () => {
    for (const sequence of ['ACGT'.repeat(45), 'ANrYacgt?'.repeat(30), 'AßT'.repeat(40)]) {
      for (const window of [7, 33, 65, 1000]) {
        for (const ambiguity of ['literal', 'exclude'] as const) {
          const expected = windowOracle(sequence, 17, window, ambiguity);
          const buffers = computeDotPlotBuffers(sequence, { bins: 17, window, ambiguity });
          expect(buffers.bins).toBe(expected.bins);
          expect(buffers.window).toBe(expected.window);
          expect(buffers.directValues).toEqual(new Float32Array(expected.grid.flat().map(cell => cell.direct)));
          expect(buffers.invertedValues).toEqual(new Float32Array(expected.grid.flat().map(cell => cell.inverted)));
        }
      }
    }
  });

  it('returns independently transferable buffers and tolerates detachment between calls', () => {
    const first = computeDotPlotBuffers('ACGT'.repeat(40), { bins: 9, window: 65 });
    expect(first.directValues.buffer === first.invertedValues.buffer).toBe(false);
    const transferred = structuredClone(first, { transfer: [first.directValues.buffer as ArrayBuffer, first.invertedValues.buffer as ArrayBuffer] });
    expect(first.directValues.byteLength).toBe(0);
    expect(first.invertedValues.byteLength).toBe(0);
    expect(computeDotPlotBuffers('ACGT'.repeat(40), { bins: 9, window: 65 })).toEqual(transferred);
  });

  it('shares validation and empty-output behavior across both public APIs', () => {
    expect(computeDotPlotBuffers('')).toEqual({ bins: 0, window: 0, directValues: new Float32Array(), invertedValues: new Float32Array() });
    for (const config of [{ bins: 0 }, { bins: 1025 }, { window: 0 }, { window: NaN }]) {
      expect(() => computeDotPlotBuffers('ACGT', config)).toThrow(RangeError);
    }
  });
});

const experimentInput = (sequence = 'ACGT'): DotPlotExperimentInput => ({ sequence, accession: 'PRIVATE.1', source: 'local' });
const twoWindows = { bins: 2, window: 2 };
async function resignDotPlot(record: AnalysisRecord, change: (copy: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record);
  change(copy);
  const signed = await createAnalysisRecord({
    method: copy.method, parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(input => ({ id: input.id, accession: input.accession, source: input.source, description: input.description, data: input.data })),
  });
  return serializeAnalysisRecord(signed);
}

describe('portable dot plot experiments', () => {
  it('binds independently known matrices, exact source hash, coordinates and coverage', async () => {
    const result = await createDotPlotExperiment(experimentInput(), twoWindows);
    assert.deepEqual(Array.from(result.directValues), [1, 0, 0, 1]);
    assert.deepEqual(Array.from(result.invertedValues), [0, 1, 1, 0]);
    assert.deepEqual(result.record.fields.windows.value, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    assert.deepEqual(result.record.fields.resolvedPerWindow.value, [2, 2]);
    assert.deepEqual(result.record.fields.direct.coverage, { available: 4, total: 4, unit: 'bases' });
    assert.deepEqual(result.record.parameters, { bins: 2, window: 2, ambiguity: 'exclude' });
    assert.equal(result.record.inputs[0].sha256, createHash('sha256').update(JSON.stringify('ACGT')).digest('hex'));
    assert.equal(result.record.fields.direct.kind, 'sequence-score');
    assert.equal(result.record.fields.direct.units, 'fraction');
  });

  it('retains ambiguity, U, case and overlapping coordinates without inventing evidence', async () => {
    const result = await createDotPlotExperiment(experimentInput('anNt'), twoWindows);
    assert.deepEqual(Array.from(result.directValues), [0.5, 0, 0, 0.5]);
    assert.deepEqual(Array.from(result.invertedValues), [0, 0.5, 0.5, 0]);
    assert.deepEqual(result.record.fields.resolvedPerWindow.value, [1, 1]);
    assert.equal(result.record.inputs[0].data, 'anNt');
    const overlapping = await createDotPlotExperiment(experimentInput('ACUGT'), { bins: 4, window: 2 });
    assert.deepEqual(overlapping.record.fields.windows.value, [
      { start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 3, end: 5 },
    ]);
    assert.deepEqual(overlapping.record.fields.resolvedPerWindow.value, [2, 1, 1, 2]);
  });

  it('normalizes automatic windows to explicit replay settings, including short genomes', async () => {
    const result = await createDotPlotExperiment(experimentInput('ACG'));
    assert.deepEqual(result.record.parameters, { bins: 120, window: 3, ambiguity: 'exclude' });
    const windows = result.record.fields.windows.value;
    assert(Array.isArray(windows));
    assert.equal(windows.length, 120);
    assert.deepEqual(windows[119], { start: 0, end: 3 });
    const fresh = await replayDotPlotExperiment(serializeAnalysisRecord(result.record), experimentInput('ACG'));
    assert.equal(fresh.exactRecord, true);
    assert.deepEqual(fresh.directValues, result.directValues);
  });

  it('captures source metadata and options before the first asynchronous digest', async () => {
    const input = experimentInput();
    const config = { ...twoWindows };
    const task = createDotPlotExperiment(input, config);
    input.sequence = 'AAAA'; input.accession = 'OTHER'; config.bins = 100;
    const result = await task;
    assert.equal(result.record.inputs[0].data, 'ACGT');
    assert.equal(result.record.inputs[0].accession, 'PRIVATE.1');
    assert.equal(result.bins, 2);
  });

  it('replays a saved experiment to fresh arrays and the same complete identity', async () => {
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows);
    const fresh = await replayDotPlotExperiment(serializeAnalysisRecord(saved.record), experimentInput());
    assert.equal(fresh.exactRecord, true);
    assert.deepEqual(fresh.record, saved.record);
    assert.deepEqual(fresh.directValues, saved.directValues);
    assert.notEqual(fresh.directValues, saved.directValues);
  });

  it('reports changed display metadata separately while using the current source identity', async () => {
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows);
    const fresh = await replayDotPlotExperiment(serializeAnalysisRecord(saved.record), { sequence: 'ACGT', accession: null, source: 'catalog' });
    assert.equal(fresh.exactRecord, false);
    assert.equal(fresh.record.inputs[0].source, 'catalog');
    assert.equal(fresh.record.inputs[0].accession, null);
    assert.deepEqual(fresh.record.fields, saved.record.fields);
  });

  it('refuses changed exact bases even when lengths, composition or normalized scores agree', async () => {
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows);
    for (const sequence of ['AGCT', 'acgt', 'ACGN', 'ACGTA']) {
      await assert.rejects(replayDotPlotExperiment(serializeAnalysisRecord(saved.record), experimentInput(sequence)), /exact source/);
    }
  });

  it('snapshots replay selection before parsing asynchronous hashes', async () => {
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows);
    const selected = experimentInput();
    const task = replayDotPlotExperiment(serializeAnalysisRecord(saved.record), selected);
    selected.sequence = 'AAAA'; selected.source = 'catalog';
    const fresh = await task;
    assert.equal(fresh.record.inputs[0].data, 'ACGT');
    assert.equal(fresh.record.inputs[0].source, 'local');
    assert.equal(fresh.exactRecord, true);
  });

  it('rejects both checksum tampering and plausible incorrect outputs with valid new hashes', async () => {
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows);
    const tampered = structuredClone(saved.record);
    (tampered.fields.direct.value as number[])[1] = 0.5;
    await assert.rejects(replayDotPlotExperiment(JSON.stringify(tampered), experimentInput()), /checksum/);
    const rehashed = await resignDotPlot(saved.record, record => { (record.fields.direct.value as number[])[1] = 0.5; });
    await assert.rejects(replayDotPlotExperiment(rehashed, experimentInput()), /Recomputed dot plot/);
  });

  it('recomputes coordinates, counts and evidence, not only matrix values', async () => {
    const { record } = await createDotPlotExperiment(experimentInput(), twoWindows);
    for (const change of [
      (r: AnalysisRecord) => { r.fields.windows.value = [{ start: 0, end: 2 }, { start: 1, end: 3 }]; },
      (r: AnalysisRecord) => { r.fields.resolvedPerWindow.value = [2, 1]; },
      (r: AnalysisRecord) => { r.fields.direct.coverage.available = 3; },
      (r: AnalysisRecord) => { r.fields.direct.limitations = ['Biological confidence is established.']; },
    ]) await assert.rejects(replayDotPlotExperiment(await resignDotPlot(record, change), experimentInput()), /Recomputed dot plot/);
  });

  it('refuses unsupported methods, policies, parameters, references and evidence kinds', async () => {
    const { record } = await createDotPlotExperiment(experimentInput(), twoWindows);
    for (const change of [
      (r: AnalysisRecord) => { r.method.version = '2'; },
      (r: AnalysisRecord) => { r.method.implementation = 'unverified'; },
      (r: AnalysisRecord) => { r.parameters.ambiguity = 'literal'; },
      (r: AnalysisRecord) => { r.parameters.extra = true; },
      (r: AnalysisRecord) => { r.parameters.bins = 201; },
      (r: AnalysisRecord) => { r.seed = 42; },
      (r: AnalysisRecord) => { r.references[0].version = '2'; },
      (r: AnalysisRecord) => { r.inputs[0].source = 'external'; },
      (r: AnalysisRecord) => { r.inputs[0].source = 'demo'; },
      (r: AnalysisRecord) => { r.fields.direct.units = 'percent'; },
      (r: AnalysisRecord) => { r.fields.resolvedPerWindow.value = []; },
    ]) await assert.rejects(replayDotPlotExperiment(await resignDotPlot(record, change), experimentInput()));
  });

  it('rejects unsafe dimensions and unsupported source strings before producing any record', async () => {
    for (const config of [{ bins: 0 }, { bins: 201 }, { bins: 1.5 }, { bins: NaN }, { window: 0 },
      { window: 5 }, { window: Infinity }, { ambiguity: 'literal' as const }, { bins: 2, extra: true }]) {
      await assert.rejects(createDotPlotExperiment(experimentInput(), config));
    }
    for (const sequence of ['', 'NNNN', 'UUUU', 'AC-GT', 'ACßT', 'A'.repeat(5_000_001)]) {
      await assert.rejects(createDotPlotExperiment(experimentInput(sequence), twoWindows));
    }
    await assert.rejects(createDotPlotExperiment({ ...experimentInput(), accession: '' }, twoWindows));
  });

  it('checks every displayed Float32 value and leaves the display buffers owned by their caller', async () => {
    const shown = computeDotPlotBuffers('ACGT', { ...twoWindows, ambiguity: 'exclude' });
    const saved = await createDotPlotExperiment(experimentInput(), twoWindows, shown);
    assert.deepEqual(saved.directValues, shown.directValues);
    assert.equal(shown.directValues.byteLength, 16);
    for (const change of [
      { ...shown, bins: 3 }, { ...shown, window: 1 }, { ...shown, directValues: new Float32Array(1) },
      { ...shown, invertedValues: new Float32Array([0, 0, 1, 0]) },
      { ...shown, directValues: new Float32Array([1, NaN, 0, 1]) },
    ]) await assert.rejects(createDotPlotExperiment(experimentInput(), twoWindows, change), /Displayed dot plot/);
  });

  it('keeps JSON evidence intact after matrix buffers are transferred and detached', async () => {
    const experiment = await createDotPlotExperiment(experimentInput(), twoWindows);
    const moved = structuredClone(experiment, { transfer: [experiment.directValues.buffer as ArrayBuffer, experiment.invertedValues.buffer as ArrayBuffer] });
    assert.equal(experiment.directValues.byteLength, 0);
    const replay = await replayDotPlotExperiment(serializeAnalysisRecord(experiment.record), experimentInput());
    assert.deepEqual(replay.directValues, moved.directValues);
    assert.equal(replay.exactRecord, true);
  });

  it('exports exact tabular coordinates, both score orientations and identities without source bases', async () => {
    const { record } = await createDotPlotExperiment({ ...experimentInput(), accession: '=FORMULA\tprivate' }, twoWindows);
    const tsv = exportDotPlotExperimentTsv(record);
    assert.equal(tsv.includes('ACGT'), false);
    assert.equal(tsv.includes('=FORMULA'), false);
    assert.equal(tsv.includes(record.resultId), true);
    assert.equal(tsv.includes(record.inputs[0].sha256), true);
    assert.deepEqual(tsv.trimEnd().split('\n').slice(3), [
      'row\tcolumn\ty_start\ty_end\tx_start\tx_end\tdirect_score\tinverted_score',
      '0\t0\t0\t2\t0\t2\t1\t0', '0\t1\t0\t2\t2\t4\t0\t1',
      '1\t0\t2\t4\t0\t2\t0\t1', '1\t1\t2\t4\t2\t4\t1\t0',
    ]);
  });

  it('recovers exact resolved counts at the maximum supported source length', async () => {
    const sequence = 'A'.repeat(2_500_001) + 'N'.repeat(2_499_999);
    const result = await createDotPlotExperiment(experimentInput(sequence), { bins: 1, window: sequence.length });
    assert.deepEqual(result.record.fields.resolvedPerWindow.value, [2_500_001]);
    assert.equal(result.record.fields.direct.coverage.available, 2_500_001);
    assert.equal(result.directValues[0], Math.fround(2_500_001 / 5_000_000));
  });

  it('preserves the complete 200x200 viewer resolution in a replayable result', async () => {
    const input = experimentInput('ACGTNN'.repeat(100));
    const saved = await createDotPlotExperiment(input, { bins: 200, window: 21 });
    const replay = await replayDotPlotExperiment(serializeAnalysisRecord(saved.record), input);
    assert.equal(replay.directValues.length, 40_000);
    assert.equal(replay.invertedValues.length, 40_000);
    assert.equal(replay.exactRecord, true);
  });

  it('refuses malformed or oversized serialized experiments', async () => {
    await assert.rejects(replayDotPlotExperiment('{', experimentInput()));
    await assert.rejects(replayDotPlotExperiment(' '.repeat(10 * 1024 * 1024 + 1), experimentInput()), /10 MiB/);
  });
});

/** Independent literal-window oracle: no production encoding, packed counts,
 * symmetry, coordinate helper or coverage implementation is used here. */
function pairwiseOracle(row: string, column: string, bins: number, window: number) {
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  const windows = (sequence: string) => Array.from({ length: bins }, (_, i) => {
    const start = bins === 1 ? 0 : Math.floor(i * ((sequence.length - window) / (bins - 1)));
    return sequence.slice(start, start + window).toUpperCase();
  });
  const rows = windows(row), columns = windows(column), direct: number[] = [], inverted: number[] = [];
  for (const a of rows) for (const b of columns) {
    let d = 0, r = 0;
    for (let k = 0; k < window; k++) {
      if (Object.hasOwn(complement, a[k]) && a[k] === b[k]) d++;
      if (Object.hasOwn(complement, a[window - 1 - k]) && complement[a[window - 1 - k]] === b[k]) r++;
    }
    direct.push(Math.fround(d / window)); inverted.push(Math.fround(r / window));
  }
  const coverage = (samples: string[]) => samples.map(text => Array.from(text).filter(base => Object.hasOwn(complement, base)).length);
  return { direct, inverted, rows: coverage(rows), columns: coverage(columns) };
}
function assertPairwise(row: string, column: string, bins: number, window: number) {
  const result = computePairwiseDotPlotBuffers(row, column, { bins, window });
  const oracle = pairwiseOracle(row, column, bins, Math.min(window, row.length, column.length));
  assert.deepEqual(Array.from(result.directValues), oracle.direct);
  assert.deepEqual(Array.from(result.invertedValues), oracle.inverted);
  assert.deepEqual(result.rowResolvedPerWindow, oracle.rows);
  assert.deepEqual(result.columnResolvedPerWindow, oracle.columns);
  return result;
}

describe('pairwise genome dot plots', () => {
  it('compares unequal axes without mirroring an asymmetric matrix or using its diagonal as coverage', () => {
    const result = assertPairwise('AACC', 'CCAATT', 3, 2);
    assert.deepEqual(Array.from(result.directValues), [0, 1, 0, 0.5, 0.5, 0, 1, 0, 0]);
    assert.deepEqual(Array.from(result.invertedValues), [0, 0, 1, 0, 0, 0.5, 0, 0, 0]);
    assert.deepEqual(result.rowResolvedPerWindow, [2, 2, 2]);
    assert.deepEqual(result.columnResolvedPerWindow, [2, 2, 2]);
  });
  it('agrees with independent oracles across scalar/packed boundaries and offset alignments', () => {
    let seed = 4281;
    const sequence = (length: number) => Array.from({ length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 'aCgTNRYSU'[seed % 9];
    }).join('');
    for (const window of [1, 2, 15, 31, 32, 33, 63, 64, 65, 127, 128, 129]) {
      for (const bins of [1, 2, 9, 33]) assertPairwise(sequence(521), sequence(713), bins, window);
    }
  });
  it('retains every ambiguity position and excludes unresolved symbols from both orientations', () => {
    assertPairwise('anNtcg', 'nNauTcgrYS', 5, 3);
    const result = assertPairwise('NNNN', 'ACGT', 3, 2);
    assert(result.directValues.every(n => n === 0)); assert(result.invertedValues.every(n => n === 0));
    assert.deepEqual(result.rowResolvedPerWindow, [0, 0, 0]);
    assert.deepEqual(result.columnResolvedPerWindow, [2, 2, 2]);
  });
  it('reuses duplicate windows independently on each axis without dropping cells', () => {
    for (const [a, b] of [['ACGT', 'AC'], ['AC', 'ACGT'], ['A', 'TTT']]) assertPairwise(a, b, 80, 2);
    const full = assertPairwise('AN', 'GT', 1024, 2);
    assert.equal(full.directValues.length, 1024 * 1024);
    assert(full.invertedValues.every(n => n === 0.5));
  });
  it('swapping the ordered inputs transposes both matrices', () => {
    const a = 'ACGNACGTTTNN'.repeat(30), b = 'TTNNACCGNTAC'.repeat(21);
    const ab = computePairwiseDotPlotBuffers(a, b, { bins: 25, window: 65 });
    const ba = computePairwiseDotPlotBuffers(b, a, { bins: 25, window: 65 });
    for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) {
      assert.equal(ab.directValues[i * 25 + j], ba.directValues[j * 25 + i]);
      assert.equal(ab.invertedValues[i * 25 + j], ba.invertedValues[j * 25 + i]);
    }
    assert.deepEqual(ab.rowResolvedPerWindow, ba.columnResolvedPerWindow);
  });
  it('preserves all self-plot scores when the two inputs are identical', () => {
    for (const sequence of ['ANCGTU'.repeat(31), 'ACTG'.repeat(113)]) {
      for (const window of [2, 31, 32, 33, 64, 95, sequence.length]) {
        const pair = computePairwiseDotPlotBuffers(sequence, sequence, { bins: 40, window });
        const self = computeDotPlotBuffers(sequence, { bins: 40, window, ambiguity: 'exclude' });
        assert.deepEqual(pair.directValues, self.directValues); assert.deepEqual(pair.invertedValues, self.invertedValues);
      }
    }
  });
  it('chooses an automatic common window from the shorter input and handles empty input', () => {
    const result = computePairwiseDotPlotBuffers('ACGT'.repeat(500), 'ACGT'.repeat(100), { bins: 10 });
    assert.equal(result.window, 40);
    assert.equal(computePairwiseDotPlotBuffers('AC', 'ACGT', { bins: 2, window: 99 }).window, 2);
    assert.equal(computePairwiseDotPlotBuffers('', 'ACGT').bins, 0);
    assert.equal(computePairwiseDotPlotBuffers('ACGT', '').directValues.length, 0);
    for (const config of [{ bins: 0 }, { bins: 1025 }, { bins: 1.5 }, { window: 0 }, { window: NaN }, { ambiguity: 'literal' as const }]) {
      assert.throws(() => computePairwiseDotPlotBuffers('ACGT', 'ACGT', config));
    }
  });
});

describe('portable pairwise dot plot experiments', () => {
  const row = () => experimentInput('AACC'), column = () => ({ ...experimentInput('CCAANT'), accession: 'COLUMN.1' });
  const config = { bins: 3, window: 2 };
  it('binds both ordered exact sequences, distinct coordinates, coverage and stable checksums', async () => {
    const { record } = await createPairwiseDotPlotExperiment(row(), column(), config);
    assert.equal(record.method.id, 'sequence-pairwise-dot-plot');
    assert.deepEqual(record.inputs.map(i => i.id), ['rowSequence', 'columnSequence']);
    assert.equal(record.inputs[1].sha256, createHash('sha256').update(JSON.stringify(column().sequence)).digest('hex'));
    assert.deepEqual(record.fields.rowWindows.value, [{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }]);
    assert.deepEqual(record.fields.columnWindows.value, [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }]);
    assert.deepEqual(record.fields.rowResolvedPerWindow.value, [2, 2, 2]);
    assert.deepEqual(record.fields.columnResolvedPerWindow.value, [2, 2, 1]);
    assert.deepEqual(record.fields.direct.coverage, { available: 9, total: 10, unit: 'bases' });
  });
  it('captures and numerically replays a final matrix with identical record identity', async () => {
    const displayed = computePairwiseDotPlotBuffers(row().sequence, column().sequence, config);
    const original = await createPairwiseDotPlotExperiment(row(), column(), config, displayed);
    const restored = await replayPairwiseDotPlotExperiment(serializeAnalysisRecord(original.record), row(), column());
    assert.deepEqual(restored.record, original.record); assert.equal(restored.exactRecord, true);
    assert.notEqual(restored.directValues.buffer, displayed.directValues.buffer);
  });
  it('rejects stale column inputs, swapped axes and self-record substitutions', async () => {
    const saved = serializeAnalysisRecord((await createPairwiseDotPlotExperiment(row(), column(), config)).record);
    await assert.rejects(replayPairwiseDotPlotExperiment(saved, row(), { ...column(), sequence: 'CCTTNT' }), /both selected genome axes/);
    await assert.rejects(replayPairwiseDotPlotExperiment(saved, column(), row()), /both selected genome axes/);
    const self = serializeAnalysisRecord((await createDotPlotExperiment(row(), config)).record);
    await assert.rejects(replayPairwiseDotPlotExperiment(self, row(), column()), /method/);
    await assert.rejects(replayDotPlotExperiment(saved, row()), /method/);
  });
  it('checks numerical values, both coordinate sets and independent coverage even after rehashing', async () => {
    const { record } = await createPairwiseDotPlotExperiment(row(), column(), config);
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.direct.value as number[])[0] = 1; },
      (r: AnalysisRecord) => { (r.fields.inverted.value as number[])[2] = 0; },
      (r: AnalysisRecord) => { (r.fields.columnWindows.value as { end: number }[])[2].end = 5; },
      (r: AnalysisRecord) => { (r.fields.rowResolvedPerWindow.value as number[])[0] = 0; },
      (r: AnalysisRecord) => { r.fields.direct.coverage.available = 1; },
    ]) await assert.rejects(replayPairwiseDotPlotExperiment(await resignDotPlot(record, change), row(), column()), /Recomputed pairwise/);
  });
  it('rejects wrong references, malformed matrices, unsupported options and excessive total input', async () => {
    const { record } = await createPairwiseDotPlotExperiment(row(), column(), config);
    for (const change of [
      (r: AnalysisRecord) => { r.references[0].version = '999'; },
      (r: AnalysisRecord) => { r.method.version = '999'; },
      (r: AnalysisRecord) => { r.parameters.window = 5; },
      (r: AnalysisRecord) => { r.fields.direct.value = [1]; },
      (r: AnalysisRecord) => { r.parameters.circular = true; },
    ]) await assert.rejects(replayPairwiseDotPlotExperiment(await resignDotPlot(record, change), row(), column()));
    await assert.rejects(createPairwiseDotPlotExperiment(row(), column(), { bins: 201 }), /1–200/);
    await assert.rejects(createPairwiseDotPlotExperiment(row(), experimentInput('NNN')), /No resolved/);
    await assert.rejects(createPairwiseDotPlotExperiment(experimentInput('A'.repeat(2500001)), experimentInput('T'.repeat(2500000))), /total input bases/);
  });
  it('rejects captured previews and matrices computed with a different second genome', async () => {
    const preview = computePairwiseDotPlotBuffers(row().sequence, column().sequence, { bins: 2, window: 2 });
    await assert.rejects(createPairwiseDotPlotExperiment(row(), column(), config, preview), /Displayed pairwise/);
    const wrong = computePairwiseDotPlotBuffers(row().sequence, 'TTTTTT', config);
    await assert.rejects(createPairwiseDotPlotExperiment(row(), column(), config, wrong), /Displayed pairwise/);
  });
  it('snapshots both selections before asynchronous hashing and reports metadata-only changes separately', async () => {
    const a = row(), b = column();
    const pending = createPairwiseDotPlotExperiment(a, b, config); a.sequence = 'TTTT'; b.sequence = 'AAAAAA';
    const original = await pending;
    assert.equal(original.record.inputs[0].data, row().sequence); assert.equal(original.record.inputs[1].data, column().sequence);
    const restored = await replayPairwiseDotPlotExperiment(serializeAnalysisRecord(original.record), row(), { ...column(), accession: 'RENAMED' });
    assert.equal(restored.exactRecord, false); assert.deepEqual(restored.record.fields, original.record.fields);
  });
  it('exports ordered coordinate pairs and true per-axis coverage without source bases or free text', async () => {
    const { record } = await createPairwiseDotPlotExperiment({ ...row(), accession: '=UNTRUSTED\tROW' }, column(), config);
    const tsv = exportPairwiseDotPlotExperimentTsv(record), lines = tsv.trim().split('\n');
    assert.equal(lines.length, 5 + 9);
    assert.equal(lines[5], '0\t0\t0\t2\t0\t2\t2\t2\t0\t0');
    assert.match(lines[7], /^0\t2\t0\t2\t4\t6\t2\t1\t/);
    assert(!tsv.includes('UNTRUSTED')); assert(!tsv.includes('CCAANT'));
    assert.throws(() => exportDotPlotExperimentTsv(record), /Incompatible/);
  });
});
