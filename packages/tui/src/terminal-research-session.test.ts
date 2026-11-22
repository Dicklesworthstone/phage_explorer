import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { importLocalGenomes, exportLocalGenomeBundle, type GenomeImportResult } from '../../core/src/genome-import';
import { parseCommandTape, parseCommandPlan, serializeCommandPlan, serializeCommandTape } from '../../core/src/command-session';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowResults, serializeWorkflowResults } from '../../core/src/workflow-results';
import type { GCSkewWindow } from '../../core/src/analysis/gc-skew';
import { replayAlignmentPangenome } from '../../core/src/analysis/alignment-pangenome';
import { replayRNAStructureRecord } from '../../core/src/analysis/rna-structure-experiment';
import { mosaicResultFromRecord } from '../../core/src/analysis/recombination-radar';
import type { PhageRepository } from '../../db-runtime/src/types';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { researchPangenomeParameters, researchRNAParameters, researchMosaicParameters, researchSpacerParameters } from '../../web/src/keyboard/ResearchWorkflow';
import { recordResearchPlan, inspectResearchTape } from './research-replay';
import { runTerminalResearchWorker } from '../../../scripts/research-workflow';
import { TerminalGenomeSession, loadTerminalGenomeBundle, type TerminalGenomeAccepted } from './local-genome-session';
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
async function graphFixture() {
  const reference = (await importLocalGenomes({ name: 'reference.gb',
    text: 'LOCUS       SAME 9 bp DNA linear\nACCESSION   SAME\nFEATURES             Location/Qualifiers\n'
      + '     CDS             1..9\n                     /gene="known"\n     misc_feature    4..6\n'
      + 'ORIGIN\n        1 ATGAAATAA\n//\n' })).genomes[0];
  const queries = (await importLocalGenomes({ name: 'queries.fa', text: '>SAME\nATGAAGTAA\n>STOP\nATGAAATAG\n' })).genomes;
  const genomes = [reference, ...queries], ids = genomes.map(genome => genome.phage.localGenome!.contentId);
  return { reference, genomes, ids, parameters: researchPangenomeParameters(ids,
    { referenceId: `local-${ids[0]}`, alignment: 'affine', terminalGaps: 'alleles', affinePenalties: { mismatch: 3, gapOpen: 5, gapExtend: 1 } },
    { contentId: ids[0], geneIds: [1] }) };
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
  it('validates sourced spacer drafts against their own captured genome and topology before accepting edits or replacements', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    const libraryText = JSON.stringify({ format: 'phage-explorer-spacer-library', version: 1, name: 'No supplied spacer control',
      source: { kind: 'local', reference: 'Explicit empty control', version: '1', license: 'CC0', scope: 'One host without records' },
      hosts: [{ id: 'empty', name: 'Control host', strain: 'fixture', accession: 'EMPTY' }], spacers: [] });
    try {
      assert(await session.load(f.file)); assert(await session.replay());
      assert(await session.createDraft('Keep the accepted source', exportLocalGenomeBundle(f.imported.genomes)));
      const parameters = researchSpacerParameters(f.view.contentId, libraryText, 'linear', { hostId: 'empty', maxMismatches: 0 });
      session.setStep({ actionId: ActionIds.OverlayCRISPR, parameters: analysisJson(parameters) });
      const original = session.getSnapshot().draft, document = session.getSnapshot().document, completed = session.getSnapshot().completedRun;
      for (const changed of [{ ...parameters, topology: 'circular' }, { ...parameters, topology: 'unknown' },
        { ...parameters, contentId: 'f'.repeat(64) }, { ...parameters, hostId: 'absent' }]) {
        assert.throws(() => session.setStep({ actionId: ActionIds.OverlayCRISPR, parameters: analysisJson(changed) }, 0));
        assert.strictEqual(session.getSnapshot().draft, original);
      }
      // A different source with unknown topology may carry an explicit circular
      // assumption. Validation must use this proposal's captured input, not the
      // active draft's known-linear annotation or its same accession label.
      const unknown = (await importLocalGenomes({ name: 'unknown.fa', text: '>joined\n' + f.genome.sequence })).genomes[0];
      const circular = researchSpacerParameters(unknown.phage.localGenome!.contentId, libraryText, 'circular', { hostId: 'empty' });
      const plan = { format: 'phage-explorer-command-plan' as const, version: 1 as const, name: 'Explicit topology assumption',
        context: { bundle: exportLocalGenomeBundle([unknown]) },
        commands: [{ actionId: ActionIds.OverlayCRISPR, parameters: analysisJson(circular) }] };
      const input = join(f.directory, 'unknown-topology-plan.json');
      await writeFile(input, serializeCommandPlan(plan), { flag: 'wx', mode: 0o600 });
      assert(await session.load(input), session.getSnapshot().error ?? '');
      assert.strictEqual(session.getSnapshot().draft, original); assert(session.getSnapshot().pendingDraft);
      session.acceptDraftReplacement();
      const accepted = session.getSnapshot().draft;
      assert.deepEqual(accepted!.plan, plan); assert.equal(accepted!.sources[0].topology, 'unknown');
      for (const [index, changed] of [{ ...parameters, topology: 'circular' }, { ...parameters, topology: 'unknown' },
        { ...parameters, contentId: unknown.phage.localGenome!.contentId }].entries()) {
        const invalid = join(f.directory, `wrong-source-spacer-plan-${index}.json`);
        await writeFile(invalid, serializeCommandPlan({ ...plan, context: { bundle: exportLocalGenomeBundle(f.imported.genomes) },
          commands: [{ actionId: ActionIds.OverlayCRISPR, parameters: analysisJson(changed) }] }), { flag: 'wx', mode: 0o600 });
        assert.equal(await session.load(invalid), false);
        assert.strictEqual(session.getSnapshot().draft, accepted); assert.equal(session.getSnapshot().pendingDraft, null);
        assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, completed);
      }
      assert.equal(session.availableResults()?.provenance, 'verified');
      assert.equal(session.getSnapshot().document!.tapeJson, f.tape);
    } finally { session.cancel(); }
  });

  it('reopens an unrecorded saved plan, edits exact captured inputs, and records and verifies a fresh baseline', async () => {
    const f = await fixture(), author = new TerminalResearchSession(), calls: string[] = [];
    const bundle = exportLocalGenomeBundle(f.imported.genomes), id = f.view.contentId;
    assert(await author.createDraft('Resume this private experiment', bundle, f.view));
    author.setStep({ actionId: ActionIds.OverlayGCSkew, parameters: { contentId: id, windowSize: 4, stepSize: 4 } });
    author.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson(researchRNAParameters(id,
      { geneId: f.view.geneId, start: 0, end: 12, strand: '+' },
      { windowSize: 12, stepSize: 12, minLoopSize: 0, allowWobble: false, includeSynonymousStress: false })) });
    const file = join(f.directory, 'unfinished-plan.json');
    assert(await author.save(file, 'plan'));
    const original = await readFile(file, 'utf8'), proposed = parseCommandPlan(original);
    assert.equal(author.getSnapshot().document, null);
    author.cancel();

    const resumed = new TerminalResearchSession({ run: (...args) => { calls.push(args[0].type); return runTerminalResearchWorker(...args); } });
    assert(await resumed.load(file), resumed.getSnapshot().error ?? '');
    assert.deepEqual(calls, [], 'opening a plan must not record, inspect a recording, or run numerical methods');
    assert.deepEqual(resumed.getSnapshot().draft!.plan, proposed);
    assert.deepEqual(resumed.getSnapshot().draft!.initialView, f.view);
    assert.equal(resumed.getSnapshot().document, null); assert.equal(resumed.availableResults(), null);
    assert.deepEqual(resumed.describeRNA(id, f.view.geneId), { bases: 12, synonymousSupported: true });
    // The reopened draft must use its saved input, even after an unrelated
    // explorer/source object has changed in the current process.
    f.genome.sequence = 'N'.repeat(18); f.genome.phage.genes[0].qualifiers = { transl_table: '999' };
    resumed.setStep({ actionId: ActionIds.OverlayGCSkew, parameters: { contentId: id, windowSize: 6, stepSize: 6 } }, 1);
    assert.equal(await readFile(file, 'utf8'), original, 'editing never overwrites the saved plan');
    assert(await resumed.recordDraft(), resumed.getSnapshot().error ?? '');
    const windows = resumed.analysis(2).fields.windows.value as unknown as GCSkewWindow[];
    // ATGAAA | CCCGGG | TTTCAT has G/C counts 1/0, 3/3, 0/1.
    assert.deepEqual(windows.map(row => [row.g, row.c, row.skew]), [[1, 0, 1], [3, 3, 0], [0, 1, -1]]);
    const rna = await replayRNAStructureRecord(JSON.stringify(resumed.analysis(3)));
    assert.equal(rna.request.sequence, 'ATGAAATTTCAT'); assert.equal(rna.analysis.windows[0].pairCount, 6);
    assert.equal(resumed.availableResults()?.provenance, 'recorded');
    const baseline = resumed.availableResults()!.json;
    assert(await resumed.replay(), resumed.getSnapshot().error ?? '');
    assert.equal(resumed.availableResults()!.json, baseline); assert.equal(resumed.availableResults()?.provenance, 'verified');
    assert.deepEqual(parseCommandTape(resumed.getSnapshot().document!.tapeJson).context, { bundle });
    resumed.cancel();
  });

  it('forks inspected recordings explicitly while retaining their expectations and accepted results', async () => {
    const f = await fixture(), archiveFile = join(f.directory, 'inspected-results.json');
    await writeFile(archiveFile, f.archive, { flag: 'wx', mode: 0o600 });
    for (const file of [f.file, archiveFile]) {
      let computations = 0;
      const session = new TerminalResearchSession({ run: (...args) => { computations++; return runTerminalResearchWorker(...args); } });
      assert(await session.load(file));
      assert.equal(session.getSnapshot().draft, null, 'opening recorded evidence never silently makes a new baseline');
      assert(await session.replay());
      const document = session.getSnapshot().document, verified = session.getSnapshot().completedRun;
      const before = computations, tape = parseCommandTape(document!.tapeJson);
      assert(await session.forkDraft('Alternative window study'), session.getSnapshot().error ?? '');
      assert.equal(computations, before, 'explicit copying still runs no numerical methods');
      const draft = session.getSnapshot().draft!;
      assert.equal(draft.plan.name, 'Alternative window study');
      assert.deepEqual(draft.plan.context, tape.context);
      assert.deepEqual(draft.plan.commands, tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })));
      assert(draft.plan.commands.every(step => !Object.hasOwn(step, 'expected')));
      assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, verified);
      assert.equal(session.availableResults()?.provenance, 'verified');
      session.setStep({ actionId: ActionIds.OverlayGCSkew,
        parameters: { contentId: f.view.contentId, windowSize: 6, stepSize: 6 } }, 0);
      assert.strictEqual(session.getSnapshot().completedRun, verified);
      assert.equal(session.getSnapshot().document!.tapeJson, f.tape, 'editing cannot rewrite the recording being verified');
      assert(await session.recordDraft(), session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().completedRun, null, 'a freshly computed branch is not verification of its parent');
      assert.equal(session.availableResults()?.provenance, 'recorded');
      assert.notDeepEqual(parseCommandTape(session.getSnapshot().document!.tapeJson).commands[0].expected, tape.commands[0].expected);
      assert.equal(await readFile(file, 'utf8'), file === f.file ? f.tape : f.archive);
      session.cancel();
    }
  });

  it('reviews draft replacement against the new sources and preserves accepted work on rejection', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay());
    assert(await session.createDraft('Unfinished original', exportLocalGenomeBundle(f.imported.genomes), f.view));
    const original = session.getSnapshot().draft, document = session.getSnapshot().document, verified = session.getSnapshot().completedRun;
    const newer = await importLocalGenomes({ name: 'different-input.gb', text:
      'LOCUS       joined 9 bp DNA linear\nACCESSION   joined\nFEATURES             Location/Qualifiers\n     CDS             1..9\nORIGIN\n        1 ATGAAATAG\n//\n' });
    const id = newer.genomes[0].phage.localGenome!.contentId;
    const rna = researchRNAParameters(id, { geneId: 1, start: 0, end: 9, strand: '+' },
      { windowSize: 9, stepSize: 9, minLoopSize: 0, allowWobble: false, includeSynonymousStress: false });
    const plan = { format: 'phage-explorer-command-plan' as const, version: 1 as const, name: 'Reviewed replacement',
      context: { bundle: exportLocalGenomeBundle(newer.genomes) },
      commands: [{ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson(rna) }] };
    const file = join(f.directory, 'replacement-plan.json'), content = serializeCommandPlan(plan);
    await writeFile(file, content, { flag: 'wx', mode: 0o600 });
    assert(await session.load(file), session.getSnapshot().error ?? '');
    assert.strictEqual(session.getSnapshot().draft, original);
    assert.deepEqual(session.getSnapshot().pendingDraft, { name: plan.name, sourceCount: 1, stepCount: 1 });
    assert.deepEqual(session.describeRNA(f.view.contentId, f.view.geneId), { bases: 12, synonymousSupported: true });
    assert.throws(() => session.describeRNA(id, 1), /captured input/);
    assert.throws(() => session.removeStep(0), /replacement/);
    await assert.rejects(session.recordDraft(), /replacement/);
    session.discardDraftReplacement();
    assert.strictEqual(session.getSnapshot().draft, original); assert.equal(session.getSnapshot().pendingDraft, null);
    assert(await session.load(file));
    // The user approves an already validated snapshot, not a pathname that may
    // have changed between review and approval.
    await writeFile(file, '{changed by another process');
    session.acceptDraftReplacement();
    assert.deepEqual(session.getSnapshot().draft!.plan, plan);
    assert.deepEqual(session.describeRNA(id, 1), { bases: 9, synonymousSupported: true });
    assert.throws(() => session.describeRNA(f.view.contentId, f.view.geneId), /captured input/);
    assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, verified);
    const accepted = session.getSnapshot().draft;
    for (const [index, changed] of [
      { ...plan, commands: [{ actionId: ActionIds.OverlayRNAStructure, parameters: { ...rna, end: 12 } }] },
      { ...plan, commands: [{ actionId: ActionIds.OverlayRNAStructure, parameters: { ...rna, contentId: 'f'.repeat(64) } }] },
      { ...plan, commands: [{ ...plan.commands[0], expected: null }] },
    ].entries()) {
      const invalid = join(f.directory, `invalid-reopened-plan-${index}.json`);
      await writeFile(invalid, JSON.stringify(changed), { flag: 'wx', mode: 0o600 });
      assert.equal(await session.load(invalid), false);
      assert.strictEqual(session.getSnapshot().draft, accepted); assert.equal(session.getSnapshot().pendingDraft, null);
      assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, verified);
    }
    assert(await session.createDraft('Another empty draft', exportLocalGenomeBundle(f.imported.genomes)));
    assert(session.getSnapshot().pendingDraft);
    session.cancel();
    assert.strictEqual(session.getSnapshot().draft, accepted); assert.equal(session.getSnapshot().pendingDraft, null);
  });

  it('settles cancelled plan reads and cannot publish late source parsing over later edits', async () => {
    const f = await fixture();
    let held = false, entered = false, release!: (value: GenomeImportResult) => void;
    const gate = new Promise<GenomeImportResult>(resolve => { release = resolve; });
    const session = new TerminalResearchSession({ parseBundle: (content, signal) => {
      if (held) { entered = true; return gate; }
      return loadTerminalGenomeBundle(content, signal);
    }, run: async () => { throw new Error('Opening or cancelling a draft must not run analyses.'); } });
    try {
      const bundle = exportLocalGenomeBundle(f.imported.genomes);
      assert(await session.createDraft('Keep these edits', bundle));
      const file = join(f.directory, 'held-plan.json');
      await writeFile(file, serializeCommandPlan({ format: 'phage-explorer-command-plan', version: 1,
        name: 'Delayed draft', context: { bundle }, commands: [] }), { flag: 'wx', mode: 0o600 });
      held = true;
      const opening = session.load(file); await waitFor(() => entered);
      session.cancel();
      assert.equal(await opening, false);
      session.setStep({ actionId: ActionIds.OverlayGCSkew, parameters: { contentId: f.view.contentId, windowSize: 6, stepSize: 6 } });
      const edited = session.getSnapshot().draft;
      release(f.imported); await new Promise(resolve => setTimeout(resolve, 20));
      assert.strictEqual(session.getSnapshot().draft, edited); assert.equal(session.getSnapshot().pendingDraft, null);
      assert.equal(session.getSnapshot().busy, null); assert.equal(session.getSnapshot().document, null);
      held = false;
      assert(await session.load(file)); session.acceptDraftReplacement();
      assert.equal(session.getSnapshot().draft!.plan.commands.length, 0, 'empty saved drafts remain editable');
      assert.equal(await session.recordDraft(), false); assert.match(session.getSnapshot().error!, /at least one command/);
    } finally { session.cancel(); }
  });

  it('authors exact joined-CDS RNA and sourced mosaic steps, exports them, and freshly replays every result', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    const mosaic = (await importLocalGenomes({ name: 'mosaic.fa', text: '>query\nAAAC\n>reference\nAAGT\n' })).genomes;
    const [queryId, referenceId] = mosaic.map(genome => genome.phage.localGenome!.contentId);
    const bundle = exportLocalGenomeBundle([...f.imported.genomes, ...mosaic]);
    assert(await session.createDraft('RNA intervals and reference comparisons', bundle));
    assert.deepEqual(session.describeRNA(f.view.contentId, f.view.geneId), { bases: 12, synonymousSupported: true });
    const rna = researchRNAParameters(f.view.contentId, { geneId: f.view.geneId, start: 0, end: 12, strand: '+' },
      { windowSize: 12, stepSize: 12, minLoopSize: 0, allowWobble: false, includeSynonymousStress: false });
    const comparison = researchMosaicParameters(queryId, [referenceId], { k: 2, window: 200, step: 100, minSimilarity: 0 });
    session.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson(rna) });
    session.setStep({ actionId: ActionIds.OverlayMosaicRadar, parameters: analysisJson(comparison) });
    session.setStep({ actionId: ActionIds.OverlayMosaicRadar, parameters: analysisJson(researchMosaicParameters(queryId, [], comparison.options)) });
    assert.equal(session.getSnapshot().document, null, 'choosing intervals and references must not run methods');
    assert(!JSON.stringify(session.getSnapshot().draft!.sources).includes(f.genome.sequence), 'form summaries do not contain genome bases');
    // The draft owns the parsed source used by its source-aware validator.
    f.genome.sequence = 'N'.repeat(18); f.genome.phage.genes[0].qualifiers = { transl_table: '999' };
    assert.deepEqual(session.describeRNA(f.view.contentId, f.view.geneId), { bases: 12, synonymousSupported: true });
    assert(await session.recordDraft(), session.getSnapshot().error ?? '');
    const pairing = await replayRNAStructureRecord(JSON.stringify(session.analysis(1)));
    assert.equal(pairing.request.sequence, 'ATGAAATTTCAT');
    assert.deepEqual(pairing.request.source, { name: 'joined', accession: 'joined', source: 'local',
      coordinateSystem: 'cds-transcript', sourceLength: 12, start: 0, end: 12, strand: '+', gene: `${f.view.geneId}:reverse_join` });
    // Six noncrossing pairs exist: (0,1),(2,9),(3,8),(4,7),(5,6),(10,11).
    // Twelve bases cannot admit more than six pairs.
    assert.equal(pairing.analysis.windows[0].pairCount, 6);
    assert.equal(pairing.analysis.coverage.analyzedCodons, 0);
    const matches = mosaicResultFromRecord(session.analysis(2));
    // Canonical sets AAAC -> {AA, AC}; AAGT -> {AA, AG, AC}.
    assert.equal(matches.windows[0].score, 2 / 3); assert.equal(matches.windows[0].status, 'matched');
    const empty = mosaicResultFromRecord(session.analysis(3));
    assert.equal(empty.windows.length, 0); assert.equal(empty.coverage['no-evidence'], 4);
    assert.equal(session.availableResults()?.provenance, 'recorded');
    const planPath = join(f.directory, 'rna-mosaic-plan.json'), archivePath = join(f.directory, 'rna-mosaic-archive.json');
    assert(await session.save(planPath, 'plan')); assert(await session.save(archivePath));
    const plan = parseCommandPlan(await readFile(planPath, 'utf8'));
    assert.deepEqual(plan.context, { bundle }); assert.deepEqual(plan.commands[0].parameters, analysisJson(rna));
    assert.deepEqual(plan.commands[1].parameters, analysisJson(comparison));
    const baseline = await readFile(archivePath, 'utf8'), reopened = new TerminalResearchSession();
    assert(await reopened.load(archivePath)); assert.equal(reopened.availableResults()?.replayed, false);
    assert(await reopened.replay(), reopened.getSnapshot().error ?? '');
    assert.equal(reopened.availableResults()!.json, baseline); assert.equal(reopened.availableResults()?.provenance, 'verified');
    assert.equal(reopened.entries().length, 3); assert.deepEqual(reopened.analysis(1), session.analysis(1));
    session.cancel(); reopened.cancel();
  });

  it('validates RNA transcript bounds and genetic codes and mosaic source ownership before accepting draft edits', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    const exceptional = (await importLocalGenomes({ name: 'reassigned.gb', text: genbank.replace('/gene="reverse_join"', '/gene="reverse_join"\n                     /transl_table=4\n                     /codon_start=2') })).genomes[0];
    const alternateId = exceptional.phage.localGenome!.contentId, foreign = 'f'.repeat(64);
    assert(await session.createDraft('Source validation', exportLocalGenomeBundle([...f.imported.genomes, exceptional])));
    const rna = researchRNAParameters(f.view.contentId, { geneId: f.view.geneId, start: 0, end: 12, strand: '+' },
      { windowSize: 12, stepSize: 12, minLoopSize: 0, allowWobble: false, includeSynonymousStress: false });
    session.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson(rna) });
    assert.deepEqual(session.describeRNA(alternateId, 1), { bases: 11, synonymousSupported: false });
    const before = serializeCommandPlan(session.getSnapshot().draft!.plan);
    for (const parameters of [
      { ...rna, contentId: foreign }, { ...rna, geneId: 999 }, { ...rna, end: 13 }, { ...rna, start: 1 },
      { ...rna, strand: '-' }, { ...rna, contentId: alternateId },
      { ...rna, contentId: alternateId, end: 11, options: { ...rna.options, includeSynonymousStress: true } },
      { ...rna, geneId: null, options: { ...rna.options, includeSynonymousStress: true } },
    ]) assert.throws(() => session.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson(parameters) }, 0));
    const mosaic = researchMosaicParameters(f.view.contentId, [alternateId], { k: 2 });
    for (const parameters of [
      { ...mosaic, queryContentId: foreign }, { ...mosaic, referenceContentIds: [foreign] },
      { ...mosaic, referenceContentIds: [f.view.contentId] }, { ...mosaic, referenceContentIds: [alternateId, alternateId] },
      { ...mosaic, options: { ...mosaic.options, window: 199 } }, { ...mosaic, options: { ...mosaic.options, minSimilarity: 2 } },
    ]) assert.throws(() => session.setStep({ actionId: ActionIds.OverlayMosaicRadar, parameters: analysisJson(parameters) }));
    assert.equal(serializeCommandPlan(session.getSnapshot().draft!.plan), before);
    assert.equal(session.getSnapshot().document, null); assert.equal(session.availableResults(), null);
    // Reassigned/partial-frame CDS remain usable for pairing without synonymous assumptions.
    session.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson({ ...rna, contentId: alternateId, end: 11 }) });
    // Genome intervals may deliberately select the reverse strand.
    session.setStep({ actionId: ActionIds.OverlayRNAStructure, parameters: analysisJson({ ...rna, geneId: null, start: 1, end: 14, strand: '-' }) });
    assert(await session.recordDraft(), session.getSnapshot().error ?? '');
    const reassigned = await replayRNAStructureRecord(JSON.stringify(session.analysis(2)));
    assert.equal(reassigned.request.sequence, 'TGAAATTTCAT'); assert.equal(reassigned.request.source.sourceLength, 11);
    const reverse = await replayRNAStructureRecord(JSON.stringify(session.analysis(3)));
    assert.equal(reverse.request.source.coordinateSystem, 'genome-forward'); assert.equal(reverse.request.source.strand, '-');
    assert.equal(reverse.request.source.start, 1); assert.equal(reverse.request.source.end, 14);
    session.cancel();
  });

  it('authors six sequence step types from captured inputs and exports a new baseline before separately verifying it', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay());
    const previous = session.getSnapshot().completedRun, selected = structuredClone(f.view);
    const creating = session.createDraft('Authored private workflow', exportLocalGenomeBundle(f.imported.genomes), selected);
    selected.scrollPosition = 0;
    assert(await creating, session.getSnapshot().error ?? '');
    assert.strictEqual(session.getSnapshot().completedRun, previous);
    assert.deepEqual(session.getSnapshot().draft!.initialView, f.view);
    const contentId = f.view.contentId;
    session.setStep({ actionId: ActionIds.OverlayGCSkew, parameters: { contentId, windowSize: 4, stepSize: 4 } });
    session.setStep({ actionId: ActionIds.OverlayRepeats, parameters: { contentId, method: 'exact-pairs', armLength: 4, maxGap: 12, maxPairs: 100 } });
    session.setStep({ actionId: ActionIds.OverlayCodonAdaptation, parameters: { contentId, geneId: f.view.geneId } });
    session.setStep({ actionId: ActionIds.OverlayGel, parameters: { contentId, enzymes: ['EcoRI'], topology: 'linear' } });
    session.setStep({ actionId: ActionIds.OverlayDotPlot, parameters: { contentId, comparisonContentId: null, bins: 4, window: 4 } });
    session.moveStep(1, -1);
    assert.equal(session.getSnapshot().draft!.plan.commands[0].actionId, ActionIds.OverlayGCSkew);
    const planPath = join(f.directory, 'authored-plan.json'), tapePath = join(f.directory, 'authored-tape.json'), archivePath = join(f.directory, 'authored-results.json');
    assert(await session.save(planPath, 'plan'));
    const plan = parseCommandPlan(await readFile(planPath, 'utf8'));
    assert.equal(plan.commands.length, 6);
    assert(plan.commands.every(step => !Object.hasOwn(step, 'expected')));
    assert.equal(await session.recordDraft(), true, session.getSnapshot().error ?? '');
    assert.equal(session.getSnapshot().completedRun, null, 'new computation is not replay verification');
    assert.equal(session.availableResults()?.provenance, 'recorded');
    assert.equal(session.availableResults()?.replayed, false);
    assert.equal(session.entries().length, 6); assert.equal(session.availableResults()!.archive.records.length, 5);
    const windows = session.analysis(1).fields.windows.value as unknown as GCSkewWindow[];
    assert.deepEqual(windows.map(row => [row.g, row.c, row.skew]), [[1, 0, 1], [0, 2, -1], [3, 1, .5], [0, 1, -1]]);
    assert.equal(session.analysis(3).method.id, 'exact-repeat-pairs');
    assert.deepEqual(session.analysis(4).fields.codingSequences.value,
      [{ geneId: f.view.geneId, codonCount: 4, sequence: 'ATGAAATTTCAT' }]);
    assert.deepEqual(session.analysis(5).parameters, { enzymes: ['EcoRI'], topology: 'linear' });
    assert.equal(session.analysis(6).inputs[0].data, f.genome.sequence);
    assert(await session.save(tapePath, 'tape')); assert(await session.save(archivePath));
    const tape = parseCommandTape(await readFile(tapePath, 'utf8'));
    assert.deepEqual(tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })), plan.commands);
    assert.deepEqual(tape.context, plan.context);
    assert.equal((await parseWorkflowResults(await readFile(archivePath, 'utf8'))).records.length, 5);
    assert.equal(await session.save(planPath, 'plan'), false);
    const baseline = session.availableResults()!.json;
    assert.equal(await session.replay(), true, session.getSnapshot().error ?? '');
    assert.equal(session.availableResults()?.provenance, 'verified');
    assert.equal(session.availableResults()!.json, baseline);
    session.cancel();
  });

  it('authors a three-genome graph with exact GenBank CDS, exports every input and result, then freshly replays the archive', async () => {
    const f = await graphFixture(), session = new TerminalResearchSession();
    const bundle = exportLocalGenomeBundle(f.genomes);
    assert(await session.createDraft('Captured graph and coding consequences', bundle));
    const sourceSummary = JSON.stringify(session.getSnapshot().draft!.sources);
    assert(!sourceSummary.includes('ATGAAATAA') && !sourceSummary.includes('ATGAAGTAA'), 'draft summaries never copy private bases');
    session.setStep({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(f.parameters) });
    assert.equal(session.getSnapshot().document, null, 'choosing sources and settings runs no analysis');
    // Later imports or caller edits cannot rewrite the captured command inputs.
    f.reference.sequence = 'CCCCCCCCC'; f.reference.original.text = '>changed\nCCCCCCCCC\n';
    assert.equal(await session.recordDraft(), true, session.getSnapshot().error ?? '');
    const record = session.analysis(1), graph = await replayAlignmentPangenome(JSON.stringify(record));
    assert.equal(record.method.id, 'alignment-pangenome');
    assert.deepEqual(record.parameters.graph, f.parameters.options);
    assert.deepEqual(graph.graph.variants.map(variant => [variant.referenceStart, variant.reference, variant.alternate]), [[5, 'A', 'G'], [8, 'A', 'G']]);
    assert.deepEqual(graph.graph.diagnostics.affine!.pairs.map(pair => pair.score), [3, 3]);
    assert.equal(graph.cds!.consequences.length, 2);
    for (const consequence of graph.cds!.consequences) {
      assert.deepEqual(consequence.effects, ['synonymous']);
      assert.equal(consequence.queryProtein, 'MK*');
    }
    assert.equal(session.availableResults()?.provenance, 'recorded');
    const directory = await mkdtemp(join(tmpdir(), 'phage-terminal-graph-'));
    const planPath = join(directory, 'plan.json'), tapePath = join(directory, 'tape.json'), archivePath = join(directory, 'archive.json'), analysisPath = join(directory, 'analysis.json');
    assert(await session.save(planPath, 'plan')); assert(await session.save(tapePath, 'tape'));
    assert(await session.save(archivePath)); assert(await session.save(analysisPath, 1));
    const plan = parseCommandPlan(await readFile(planPath, 'utf8')), tape = parseCommandTape(await readFile(tapePath, 'utf8'));
    assert.deepEqual(plan.commands, [{ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(f.parameters) }]);
    assert.deepEqual(plan.context, { bundle }); assert.deepEqual(tape.context, plan.context);
    assert.deepEqual(await parseAnalysisRecord(await readFile(analysisPath, 'utf8')), record);
    const baseline = await readFile(archivePath, 'utf8');
    const fresh = new TerminalResearchSession();
    assert(await fresh.load(archivePath)); assert.equal(fresh.availableResults()?.replayed, false);
    assert(await fresh.replay(), fresh.getSnapshot().error ?? '');
    assert.equal(fresh.availableResults()?.provenance, 'verified'); assert.equal(fresh.availableResults()!.json, baseline);
    assert.deepEqual(fresh.analysis(1), record);
    assert.equal(await fresh.save(archivePath), false, 'an existing complete archive cannot be overwritten');
    assert.equal(await readFile(archivePath, 'utf8'), baseline);
    session.cancel(); fresh.cancel();
  });

  it('rejects foreign graph sources, mismatched annotations and invalid biological or alignment settings without changing accepted work', async () => {
    const f = await graphFixture(), session = new TerminalResearchSession();
    const wrongAnnotation = (await importLocalGenomes({ name: 'wrong.gb', text: f.reference.original.text.replace('ATGAAATAA', 'ATGAAGTAA') })).genomes[0];
    assert(await session.createDraft('Reviewed graph', exportLocalGenomeBundle([...f.genomes, wrongAnnotation])));
    session.setStep({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(f.parameters) });
    assert(await session.recordDraft(), session.getSnapshot().error ?? '');
    const accepted = session.getSnapshot().document, before = serializeCommandPlan(session.getSnapshot().draft!.plan);
    const foreign = 'f'.repeat(64);
    for (const parameters of [
      { ...f.parameters, contentIds: [f.ids[0], foreign] },
      { ...f.parameters, contentIds: [f.ids[0], f.ids[0]] },
      { ...f.parameters, contentIds: [f.ids[0]] },
      { ...f.parameters, options: { ...f.parameters.options, referenceId: `local-${foreign}` } },
      { ...f.parameters, options: { ...f.parameters.options, affinePenalties: { mismatch: 0, gapOpen: 5, gapExtend: 1 } } },
      { ...f.parameters, options: { ...f.parameters.options, normalization: 'circular' } },
      { ...f.parameters, annotation: { contentId: foreign, geneIds: null } },
      { ...f.parameters, annotation: { contentId: f.ids[1], geneIds: null } },
      { ...f.parameters, annotation: { contentId: wrongAnnotation.phage.localGenome!.contentId, geneIds: null } },
      { ...f.parameters, annotation: { contentId: f.ids[0], geneIds: [2] } },
      { ...f.parameters, annotation: { contentId: f.ids[0], geneIds: [999] } },
      { ...f.parameters, annotation: { contentId: f.ids[0], geneIds: [] } },
    ]) {
      assert.throws(() => session.setStep({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(parameters) }, 0));
      assert.equal(serializeCommandPlan(session.getSnapshot().draft!.plan), before);
      assert.strictEqual(session.getSnapshot().document, accepted);
    }
    session.cancel();
  });

  it('bounds captured pangenome input and refuses an unchanged-column comparison with unequal lengths before recording', async () => {
    const f = await graphFixture(), session = new TerminalResearchSession();
    const short = (await importLocalGenomes({ name: 'short.fa', text: '>short\nATGAAA\n' })).genomes[0];
    const oversized = (await importLocalGenomes({ name: 'long.fa', text: '>long\n' + 'A'.repeat(250001) })).genomes[0];
    assert(await session.createDraft('Bounded inputs', exportLocalGenomeBundle([...f.genomes, short, oversized])));
    const columnParameters = researchPangenomeParameters([f.ids[0], short.phage.localGenome!.contentId],
      { referenceId: `local-${f.ids[0]}`, alignment: 'provided', terminalGaps: 'missing' });
    assert.throws(() => session.setStep({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(columnParameters) }), /same length/);
    const largeParameters = researchPangenomeParameters([f.ids[0], oversized.phage.localGenome!.contentId],
      { referenceId: `local-${f.ids[0]}`, alignment: 'wavefront', terminalGaps: 'missing' });
    assert.throws(() => session.setStep({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(largeParameters) }), /250,000/);
    assert.equal(session.getSnapshot().draft!.plan.commands.length, 0); assert.equal(session.getSnapshot().document, null);
    session.cancel();
  });

  it('edits, reorders and removes draft steps without changing accepted records or admitting foreign source parameters', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    assert(await session.load(f.file)); assert(await session.replay());
    const accepted = session.getSnapshot().document, completed = session.getSnapshot().completedRun;
    assert(await session.createDraft('Editable steps', exportLocalGenomeBundle(f.imported.genomes)));
    const contentId = f.view.contentId;
    const step = { actionId: ActionIds.OverlayGCSkew, parameters: { contentId, windowSize: 4, stepSize: 4 } };
    session.setStep(step); step.parameters.windowSize = 5;
    assert.equal((session.getSnapshot().draft!.plan.commands[0].parameters as { windowSize: number }).windowSize, 4);
    session.setStep({ actionId: ActionIds.NavGoto, parameters: { ...f.view } });
    session.moveStep(1, -1); assert.equal(session.getSnapshot().draft!.plan.commands[0].actionId, ActionIds.NavGoto);
    session.setStep({ actionId: ActionIds.OverlayGCSkew, parameters: { contentId, windowSize: 6, stepSize: 3 } }, 1);
    session.removeStep(0); assert.equal(session.getSnapshot().draft!.plan.commands.length, 1);
    const before = serializeCommandPlan(session.getSnapshot().draft!.plan);
    for (const invalid of [
      { actionId: ActionIds.OverlayGCSkew, parameters: { contentId: 'f'.repeat(64), windowSize: 4, stepSize: 4 } },
      { actionId: ActionIds.NavGoto, parameters: { ...f.view, scrollPosition: 99 } },
      { actionId: ActionIds.OverlayCodonAdaptation, parameters: { contentId, geneId: 999 } },
      { actionId: ActionIds.OverlayDotPlot, parameters: { contentId, comparisonContentId: 'f'.repeat(64), bins: 4, window: 4 } },
      { actionId: ActionIds.OverlayDotPlot, parameters: { contentId, comparisonContentId: null, bins: 4, window: 100 } },
      { actionId: ActionIds.OverlayGel, parameters: { contentId, enzymes: ['EcoRI'], topology: 'circular' } },
      { actionId: 'unknown.analysis', parameters: { contentId } },
    ]) assert.throws(() => session.setStep({ actionId: invalid.actionId, parameters: analysisJson(invalid.parameters) }));
    assert.equal(serializeCommandPlan(session.getSnapshot().draft!.plan), before);
    assert.strictEqual(session.getSnapshot().document, accepted); assert.strictEqual(session.getSnapshot().completedRun, completed);
    assert.equal(await session.createDraft('Invalid view', exportLocalGenomeBundle(f.imported.genomes), { ...f.view, geneId: 999 }), false);
    assert.equal(serializeCommandPlan(session.getSnapshot().draft!.plan), before);
    session.cancel();
  });

  it('preserves both the draft and previous verified work after cancelled or foreign recording replies', async () => {
    const f = await fixture(); let block = false;
    let deliver!: (value: Awaited<ReturnType<typeof runTerminalResearchWorker>>) => void;
    let started = false;
    const session = new TerminalResearchSession({ run: (...args) => {
      if (block && args[0].type === 'record') { started = true; return new Promise(resolve => { deliver = resolve; }); }
      return runTerminalResearchWorker(...args);
    } });
    assert(await session.load(f.file)); assert(await session.replay());
    assert(await session.createDraft('New draft', exportLocalGenomeBundle(f.imported.genomes), f.view));
    const document = session.getSnapshot().document, completed = session.getSnapshot().completedRun, draft = session.getSnapshot().draft;
    block = true;
    const pending = session.recordDraft(); await waitFor(() => started);
    assert.throws(() => session.removeStep(0), /active work/);
    session.cancel(); assert.equal(await pending, false);
    const late = await recordResearchPlan(serializeCommandPlan(draft!.plan), { captureResults: true });
    deliver({ type: 'recorded', ...late }); await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, completed);
    assert.strictEqual(session.getSnapshot().draft, draft);
    started = false;
    const foreign = session.recordDraft(); await waitFor(() => started);
    deliver({ type: 'recorded', ...await recordResearchPlan(serializeCommandPlan({ ...draft!.plan, name: 'Different source owner' }), { captureResults: true }) });
    assert.equal(await foreign, false); assert.match(session.getSnapshot().error!, /differ/);
    assert.strictEqual(session.getSnapshot().document, document); assert.strictEqual(session.getSnapshot().completedRun, completed);
    assert.strictEqual(session.getSnapshot().draft, draft); session.cancel();
  });

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
