import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowResults, serializeWorkflowResults } from '../../core/src/workflow-results';
import type { GCSkewWindow } from '../../core/src/analysis/gc-skew';
import type { PhageRepository } from '../../db-runtime/src/types';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { recordResearchPlan, inspectResearchTape } from './research-replay';
import { runTerminalResearchWorker } from '../../../scripts/research-workflow';
import { TerminalGenomeSession, type TerminalGenomeAccepted } from './local-genome-session';
import { TerminalResearchSession } from './terminal-research-session';

const genbank = 'LOCUS       joined                    18 bp    DNA     linear\n'
  + 'ACCESSION   joined\nFEATURES             Location/Qualifiers\n'
  + '     CDS             complement(join(1..6,13..18))\n'
  + '                     /gene="reverse_join"\nORIGIN\n'
  + '        1 atgaaacccgggtttcat\n//\n';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-interactive-research-'));
  const imported = await importLocalGenomes({ name: 'joined.gb', text: genbank });
  const genome = imported.genomes[0], contentId = genome.phage.localGenome!.contentId;
  const view = { contentId, geneId: genome.phage.genes[0].id, viewMode: 'aa' as const, readingFrame: -2 as const, scrollPosition: 3 };
  const gc = { actionId: ActionIds.OverlayGCSkew, parameters: { contentId, windowSize: 4, stepSize: 4 } };
  const navigation = { actionId: ActionIds.NavGoto, parameters: view };
  const authored = await recordResearchPlan(JSON.stringify({
    format: 'phage-explorer-command-plan', version: 1, name: 'Private joined CDS',
    context: { bundle: exportLocalGenomeBundle(imported.genomes) },
    commands: [gc, navigation, gc, navigation],
  }), { captureResults: true });
  const file = join(directory, 'quite-private-workflow.json');
  await writeFile(file, authored.tapeJson, { flag: 'wx', mode: 0o600 });
  return { directory, file, imported, genome, view, tape: authored.tapeJson, archive: authored.allResultsJson! };
}
async function absent(path: string) { await assert.rejects(stat(path), { code: 'ENOENT' }); }
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Research operation did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('interactive terminal research sessions', () => {
  it('inspects without running, then verifies repeated analyses and keeps navigation separate', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert.equal(await session.load(f.file), true, session.getSnapshot().error ?? '');
    assert.equal(session.getSnapshot().completedRun, null);
    assert.equal(session.getSnapshot().document?.inspection.canReplay, true);
    assert.equal(session.availableResults(), null);
    const progress: number[] = [];
    const off = session.subscribe(() => {
      const value = session.getSnapshot().progress;
      if (value) progress.push(value.completed);
    });
    try {
      assert.equal(await session.replay(2), true, session.getSnapshot().error ?? '');
      const run = session.getSnapshot().completedRun!;
      assert.equal(run.report.completed, 8);
      assert.equal(run.report.lastAnalysisExecution, 7);
      assert.deepEqual(run.report.finalView, f.view);
      assert.equal(run.archive.records.length, 1, 'exact repeated results are stored once');
      assert.deepEqual(session.entries().map(entry => [entry.execution, entry.iteration, entry.step, entry.analysis !== null]),
        [[1, 1, 1, true], [2, 1, 2, false], [3, 1, 3, true], [4, 1, 4, false],
          [5, 2, 1, true], [6, 2, 2, false], [7, 2, 3, true], [8, 2, 4, false]]);
      assert(progress.includes(0) && progress.includes(8));
      assert.throws(() => session.analysis(8), /navigation/);
      assert.equal(session.analysis(7).resultId, session.analysis(1).resultId);
      // Independent counts for ATGA | AACC | CGGG | TTTC, not a replay self-comparison.
      const windows = session.analysis(7).fields.windows.value as unknown as GCSkewWindow[];
      assert.deepEqual(windows.map(row => [row.start, row.end, row.g, row.c, row.resolvedBases, row.skew, row.cumulative]),
        [[0, 4, 1, 0, 4, 1, 0], [4, 8, 0, 2, 4, -1, 1], [8, 12, 3, 1, 4, 0.5, -2], [12, 16, 0, 1, 4, -1, 1]]);
    } finally { off(); session.cancel(); }
  });

  it('exports exact executions and complete archives without overwriting any existing file', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay(2));
    const result = join(f.directory, 'selected.json'), all = join(f.directory, 'complete.json'), navigation = join(f.directory, 'navigation.json');
    assert.equal(await session.save(navigation, 8), false);
    await absent(navigation);
    assert.equal(await session.save(result, 7), true);
    assert.deepEqual(await parseAnalysisRecord(await readFile(result, 'utf8')), session.analysis(7));
    assert.equal(await session.save(all), true);
    assert.deepEqual(await parseWorkflowResults(await readFile(all, 'utf8')), session.getSnapshot().completedRun!.archive);
    const before = await readFile(result, 'utf8');
    assert.equal(await session.save(result, 1), false);
    assert.equal(await readFile(result, 'utf8'), before);
    assert.equal(await session.save(f.file), false);
    assert.equal(await readFile(f.file, 'utf8'), f.tape);
    if (process.platform !== 'win32') {
      assert.equal((await stat(result)).mode & 0o777, 0o600);
      const link = join(f.directory, 'output-link.json');
      await symlink(result, link);
      assert.equal(await session.save(link), false);
      assert.equal(await readFile(result, 'utf8'), before);
    }
  });

  it('distinguishes loaded archive integrity from fresh numerical verification and respects its repetition count', async () => {
    const f = await fixture(), producer = new TerminalResearchSession();
    assert(await producer.load(f.file)); assert(await producer.replay(2));
    const saved = join(f.directory, 'saved-results.json'); assert(await producer.save(saved));
    const session = new TerminalResearchSession();
    assert(await session.load(saved));
    assert.equal(session.availableResults()?.replayed, false);
    assert.equal(session.getSnapshot().completedRun, null);
    assert.equal(session.entries().length, 8);
    assert.equal(await session.stageRestore(new TerminalGenomeSession(null)), false);
    assert.match(session.getSnapshot().error!, /Replay successfully/);
    assert.equal(await session.replay(1), true, session.getSnapshot().error ?? '');
    assert.equal(session.getSnapshot().completedRun!.archive.repetitions, 2);
    assert.equal(session.getSnapshot().completedRun!.json, await readFile(saved, 'utf8'));
    assert.equal(session.availableResults()?.replayed, true);
  });

  it('rejects forged numerical values even when all archive hashes and recorded identities are valid', async () => {
    const f = await fixture(), original = await parseWorkflowResults(f.archive);
    const copy = structuredClone(original.records[0]);
    (copy.fields.windows.value as unknown as GCSkewWindow[])[0].g = 99;
    const forged: AnalysisRecord = await createAnalysisRecord({ method: copy.method, parameters: copy.parameters, seed: copy.seed,
      inputs: copy.inputs.map(({ sha256: _hash, ...input }) => input), fields: copy.fields, references: copy.references });
    const tape = parseCommandTape(original.tapeJson);
    for (const command of tape.commands) {
      if (command.actionId === ActionIds.OverlayGCSkew) command.expected = {
        method: { ...forged.method }, cacheKey: forged.cacheKey, resultId: forged.resultId,
      };
    }
    const content = serializeWorkflowResults({ ...original, tapeJson: serializeCommandTape(tape), records: [forged] });
    await parseWorkflowResults(content);
    const file = join(f.directory, 'valid-hashes-wrong-counts.json'); await writeFile(file, content, { flag: 'wx' });
    const session = new TerminalResearchSession();
    assert.equal(await session.load(file), true, session.getSnapshot().error ?? '');
    assert.equal(session.availableResults()?.replayed, false);
    assert.equal(await session.replay(), false);
    assert.match(session.getSnapshot().error!, /Step 1|different|differs|match/i);
    assert.equal(session.getSnapshot().completedRun, null);
    assert.equal(session.availableResults()?.replayed, false);
  });

  it('keeps accepted work after a malformed file, while unsupported tapes remain inspectable and cannot run', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay());
    const accepted = session.getSnapshot().document, completed = session.getSnapshot().completedRun;
    const bad = join(f.directory, 'bad.json'); await writeFile(bad, '{', { flag: 'wx' });
    assert.equal(await session.load(bad), false);
    assert.strictEqual(session.getSnapshot().document, accepted);
    assert.strictEqual(session.getSnapshot().completedRun, completed);
    const unknown = parseCommandTape(f.tape);
    unknown.commands[0].actionId = 'unsupported.action';
    const unsupported = join(f.directory, 'unsupported.json');
    await writeFile(unsupported, serializeCommandTape(unknown), { flag: 'wx' });
    assert.equal(await session.load(unsupported), true);
    assert.equal(session.getSnapshot().document!.inspection.steps[0].supported, false);
    assert.equal(session.getSnapshot().completedRun, null);
    assert.equal(await session.replay(), false);
    assert.match(session.getSnapshot().error!, /unsupported/);
  });

  it('cancels a late inspection promptly and cannot publish it over a newer workflow', async () => {
    const f = await fixture();
    let deliver!: (value: Awaited<ReturnType<typeof runTerminalResearchWorker>>) => void;
    let requests = 0;
    const session = new TerminalResearchSession({ run: (...args) => {
      if (++requests === 1) return new Promise(resolve => { deliver = resolve; });
      return runTerminalResearchWorker(...args);
    } });
    const pending = session.load(f.file);
    await waitFor(() => requests === 1);
    session.cancel();
    assert.equal(await pending, false);
    const tape = parseCommandTape(f.tape); tape.name = 'New accepted workflow';
    const next = join(f.directory, 'new.json'); await writeFile(next, serializeCommandTape(tape), { flag: 'wx' });
    assert(await session.load(next));
    const accepted = session.getSnapshot().document;
    deliver({ type: 'inspection', inspection: await inspectResearchTape(f.tape) });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(session.getSnapshot().document, accepted);
    assert.equal(session.getSnapshot().document!.name, 'New accepted workflow');
    assert.equal(session.getSnapshot().error, null);
  });

  it('terminates the actual owned worker on cancellation without replacing previously verified output', async () => {
    const f = await fixture();
    let block = false;
    let started!: () => void, ended!: (code: number) => void;
    const online = new Promise<void>(resolve => { started = resolve; });
    const exited = new Promise<number>(resolve => { ended = resolve; });
    const session = new TerminalResearchSession({ run: (request, signal, progress) => runTerminalResearchWorker(request, signal, progress,
      block ? () => {
        const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
        worker.once('online', started); worker.once('exit', ended); return worker;
      } : undefined) });
    assert(await session.load(f.file)); assert(await session.replay());
    const accepted = session.getSnapshot().completedRun;
    block = true;
    const pending = session.replay(2);
    await online;
    session.cancel();
    assert.equal(await pending, false);
    await exited;
    assert.strictEqual(session.getSnapshot().completedRun, accepted);
    assert.equal(session.getSnapshot().busy, null);
    assert.equal(session.getSnapshot().error, null);
  });

  it('stages exact joined-CDS inputs and final view for collision review before installation', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay());
    const catalog = { ...f.genome.phage, id: 7, localGenome: undefined };
    const base = { listPhages: async () => [catalog], close: async () => {} } as unknown as PhageRepository;
    const genomes = new TerminalGenomeSession(base);
    assert.equal(await session.stageRestore(genomes), true, session.getSnapshot().error ?? '');
    assert.equal(genomes.getSnapshot().localCount, 0);
    assert.equal(genomes.getSnapshot().reviewGeneId, f.view.geneId);
    assert.equal(genomes.getSnapshot().review?.genomes[0].sequence, 'ATGAAACCCGGGTTTCAT');
    assert.deepEqual(genomes.getSnapshot().review?.genomes[0].phage.genes[0].qualifiers?._segments,
      [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
    assert.equal(await genomes.accept(false, () => assert.fail('colliding import must not install')), false);
    assert.match(genomes.getSnapshot().error!, /Explicitly allow/);
    let installed: TerminalGenomeAccepted | undefined;
    assert.equal(await genomes.accept(true, value => { installed = value; }), true);
    assert.equal(installed!.selected.localGenome!.contentId, f.view.contentId);
    assert.equal(installed!.selectedGeneId, f.view.geneId);
    assert.deepEqual(installed!.view, { contentId: f.view.contentId, viewMode: 'aa', readingFrame: -2, scrollPosition: 3 });
    assert.equal(genomes.getSnapshot().localCount, 1);
    await genomes.close();
  });

  it('rejects invalid final-view features, invalid UTF-8 and nonregular input without installing or creating output', async () => {
    const f = await fixture(), genomes = new TerminalGenomeSession(null);
    assert.equal(await genomes.prepareBundle(exportLocalGenomeBundle(f.imported.genomes), { ...f.view, geneId: 999 }), false);
    assert.equal(genomes.getSnapshot().review, null);
    const session = new TerminalResearchSession();
    const invalid = join(f.directory, 'invalid.json'); await writeFile(invalid, Buffer.from([255, 254]), { flag: 'wx' });
    assert.equal(await session.load(invalid), false);
    assert.equal(await session.load(f.directory), false);
    assert.equal(await session.load('bad\u0000path'), false);
    const destination = join(f.directory, 'no-results.json');
    assert.equal(await session.save(destination), false); await absent(destination);
    assert.equal(genomes.getSnapshot().localCount, 0);
    await genomes.close();
  });
});
