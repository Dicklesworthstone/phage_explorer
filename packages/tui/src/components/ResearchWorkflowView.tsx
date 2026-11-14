import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson } from '../../../core/src/analysis-result';
import { resolveExactRepeatOptions } from '../../../core/src/analysis/exact-repeat-pairs';
import { resolveRestrictionDigestOptions } from '../../../core/src/analysis/restriction-digest';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import type { ResearchView } from '../../../web/src/keyboard/ResearchWorkflow';
import { terminalGenomeLabel, terminalGenomePath, type TerminalGenomeSession } from '../local-genome-session';
import type { TerminalResearchSession, TerminalResearchDraft, TerminalResearchDraftSource, TerminalResearchStep } from '../terminal-research-session';
import { readTerminalSize } from './terminal-size';

const editorActions = [
  { kind: 'view', id: ActionIds.NavGoto, label: 'Saved genome / CDS view' },
  { kind: 'gc-skew', id: ActionIds.OverlayGCSkew, label: 'GC-skew windows and cumulative counts' },
  { kind: 'repeats', id: ActionIds.OverlayRepeats, label: 'Exact repeat pairs' },
  { kind: 'codons', id: ActionIds.OverlayCodonAdaptation, label: 'CDS statistics + illustrative host model' },
  { kind: 'digest', id: ActionIds.OverlayGel, label: 'Restriction digest' },
  { kind: 'dot-plot', id: ActionIds.OverlayDotPlot, label: 'Self or ordered pairwise dot plot' },
] as const;
type EditorKind = (typeof editorActions)[number]['kind'];
interface Setting { key: string; label: string; initial: string }
function stepSettings(kind: EditorKind, source: TerminalResearchDraftSource, initial: Record<string, unknown>, view: ResearchView | null): Setting[] {
  const field = (key: string, label: string, fallback: string | number): Setting => ({ key, label, initial: String(initial[key] ?? fallback) });
  switch (kind) {
    case 'view': return [field('viewMode', 'Sequence mode (dna, aa, dual)', view?.viewMode ?? 'dna'),
      field('readingFrame', 'Reading frame (0, 1, 2, -1, -2, -3)', view?.readingFrame ?? 0),
      field('scrollPosition', 'Position (0-based; amino-acid index in aa mode)', view?.scrollPosition ?? 0)];
    case 'gc-skew': return [field('windowSize', 'Window size (bases)', Math.min(1000, source.bases)),
      field('stepSize', 'Step size (bases)', Math.min(250, source.bases))];
    case 'repeats': return [field('armLength', 'Exact arm length (4–256 bases)', Math.min(20, Math.max(4, source.bases))),
      field('maxGap', 'Maximum gap (0–100000 bases)', 1000), field('maxPairs', 'Maximum reported pairs (1–20000)', 500),
      field('topology', 'Search topology (linear or circular; explicit assumption if unknown)',
        initial.method === 'exact-pairs' ? 'linear' : source.topology === 'circular' ? 'circular' : 'linear')];
    case 'codons': return [];
    case 'digest': return [{ key: 'enzymes', label: 'Enzymes (exact names separated by commas; none for uncut control)',
      initial: Array.isArray(initial.enzymes) ? initial.enzymes.join(',') || 'none' : 'EcoRI,BamHI' },
      field('topology', 'Molecule topology (linear or circular; explicit assumption if unknown)', source.topology === 'circular' ? 'circular' : 'linear')];
    case 'dot-plot': return [field('bins', 'Display bins (1–256)', 64), field('window', 'Comparison window (bases; must fit both inputs)', Math.min(20, source.bases))];
  }
}
function integer(value: string, label: string, signed = false): number {
  if (!(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(label + ' must be an explicit whole number.');
  }
  return Number(value);
}
/** A form over canonical action IDs. It never creates a second executor or runs
 * an analysis while the user selects sources and reviews effective settings.
 */
function ResearchStepEditor({ draft, initial, rows, onSave, onCancel }: {
  draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const parameters = initial?.parameters && typeof initial.parameters === 'object' && !Array.isArray(initial.parameters)
    ? initial.parameters as Record<string, unknown> : {};
  const [stage, setStage] = useState<'method' | 'source' | 'comparison' | 'gene' | 'settings'>('method');
  const [methodIndex, setMethodIndex] = useState(Math.max(0, editorActions.findIndex(item => item.id === initial?.actionId)));
  const [sourceIndex, setSourceIndex] = useState(Math.max(0, draft.sources.findIndex(item => item.contentId === parameters.contentId)));
  const [comparisonIndex, setComparisonIndex] = useState(typeof parameters.comparisonContentId === 'string'
    ? draft.sources.findIndex(item => item.contentId === parameters.comparisonContentId) + 1 : 0);
  const [geneIndex, setGeneIndex] = useState(0);
  const [settings, setSettings] = useState<Setting[]>([]), [values, setValues] = useState<Record<string, string>>({});
  const [settingIndex, setSettingIndex] = useState(0), [error, setError] = useState<string | null>(null);
  const action = editorActions[methodIndex], source = draft.sources[sourceIndex];
  const genes = source.genes.filter(gene => action.kind !== 'codons' || gene.type === 'CDS');
  const geneId = geneIndex ? genes[geneIndex - 1]?.id ?? null : null;
  const save = (entered: Record<string, string>, selectedGene = geneId) => {
    const contentId = source.contentId;
    let value: unknown;
    if (action.kind === 'view') value = { contentId, geneId: selectedGene, viewMode: entered.viewMode,
      readingFrame: integer(entered.readingFrame, 'Reading frame', true), scrollPosition: integer(entered.scrollPosition, 'Position') };
    else if (action.kind === 'gc-skew') value = { contentId, windowSize: integer(entered.windowSize, 'Window size'), stepSize: integer(entered.stepSize, 'Step size') };
    else if (action.kind === 'repeats') {
      if (entered.topology !== 'linear' && entered.topology !== 'circular') throw new Error('Choose linear or circular search topology explicitly.');
      value = { contentId, method: 'exact-pairs', ...resolveExactRepeatOptions({ armLength: integer(entered.armLength, 'Arm length'),
        maxGap: integer(entered.maxGap, 'Maximum gap'), maxPairs: integer(entered.maxPairs, 'Maximum pairs'), topology: entered.topology }) };
    } else if (action.kind === 'codons') value = { contentId, geneId: selectedGene };
    else if (action.kind === 'digest') value = { contentId, ...resolveRestrictionDigestOptions({ topology: entered.topology,
      enzymes: entered.enzymes === 'none' ? [] : entered.enzymes.split(',').map(name => name.trim()) }) };
    else value = { contentId, comparisonContentId: comparisonIndex ? draft.sources[comparisonIndex - 1].contentId : null,
      bins: integer(entered.bins, 'Display bins'), window: integer(entered.window, 'Comparison window') };
    onSave({ actionId: action.id, parameters: analysisJson(value) });
  };
  const beginSettings = (selectedGene = geneId) => {
    if (action.kind === 'codons') { save({}, selectedGene); return; }
    const prior = initial?.actionId === action.id && parameters.contentId === source.contentId ? parameters : {};
    const remembered = draft.initialView?.contentId === source.contentId ? draft.initialView : null;
    const next = stepSettings(action.kind, source, prior, remembered);
    if (action.kind === 'dot-plot' && comparisonIndex && prior.window === undefined) {
      next.find(field => field.key === 'window')!.initial = String(Math.min(20, source.bases, draft.sources[comparisonIndex - 1].bases));
    }
    setSettings(next); setValues(Object.fromEntries(next.map(field => [field.key, field.initial]))); setSettingIndex(0); setStage('settings');
  };
  const choices = stage === 'method' ? editorActions.map(item => item.label)
    : stage === 'source' ? draft.sources.map(item => terminalGenomeLabel(item.name + ' · ' + item.accession) + ' · ' + item.bases + ' bp · ' + item.topology)
      : stage === 'comparison' ? ['Self comparison (one input)', ...draft.sources.map(item => terminalGenomeLabel(item.name + ' · ' + item.accession))]
        : [action.kind === 'codons' ? 'All captured CDS' : 'No selected feature', ...genes.map(gene =>
          terminalGenomeLabel((gene.name || gene.locusTag || gene.type) + ' · feature ' + gene.id) + ' · ' + (gene.startPos + 1) + '–' + gene.endPos)];
  const cursor = stage === 'method' ? methodIndex : stage === 'source' ? sourceIndex : stage === 'comparison' ? comparisonIndex : geneIndex;
  const pageSize = Math.max(1, Math.min(8, rows - 15)), start = Math.floor(cursor / pageSize) * pageSize;
  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (stage === 'settings') {
      if (key.shift && key.tab) { setSettingIndex(index => Math.max(0, index - 1)); setError(null); }
      return; // TextInput owns every printable character.
    }
    if (key.return) {
      try {
        setError(null);
        if (stage === 'method') setStage('source');
        else if (stage === 'source') {
          if (action.kind === 'dot-plot') setStage('comparison');
          else if (action.kind === 'view' || action.kind === 'codons') {
            if (action.kind === 'codons' && !genes.length) throw new Error('This captured genome has no CDS annotations. Choose another source or analysis.');
            const selected = initial?.actionId === action.id && parameters.contentId === source.contentId ? parameters.geneId
              : draft.initialView?.contentId === source.contentId ? draft.initialView.geneId : null;
            setGeneIndex(typeof selected === 'number' ? Math.max(0, genes.findIndex(gene => gene.id === selected) + 1) : 0);
            setStage('gene');
          } else beginSettings();
        } else beginSettings();
      } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
      return;
    }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? pageSize : key.leftArrow ? -pageSize : 0;
    if (!delta) return;
    const next = Math.max(0, Math.min(cursor + delta, choices.length - 1));
    if (stage === 'method') setMethodIndex(next);
    else if (stage === 'source') setSourceIndex(next);
    else if (stage === 'comparison') setComparisonIndex(next);
    else setGeneIndex(next);
  });
  const field = settings[settingIndex];
  const submitSetting = (value: string) => {
    try {
      setError(null); const next = { ...values, [field.key]: value }; setValues(next);
      if (settingIndex + 1 < settings.length) setSettingIndex(settingIndex + 1);
      else save(next);
    } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  return <Box flexDirection="column">
    {error && <Text wrap="truncate-end" color={colors.accent}>{error}</Text>}
    {stage === 'settings' && field ? <>
      <Text bold>{action.label} settings — {settingIndex + 1}/{settings.length}</Text>
      <Text wrap="truncate-end">Captured source: {terminalGenomeLabel(source.name)} · {source.bases} bp</Text>
      <Text>{field.label}</Text>
      <TextInput key={field.key} value={values[field.key]} onChange={value => { if (value.length <= 256) setValues(before => ({ ...before, [field.key]: value })); }} onSubmit={submitSetting} />
      <Text color={colors.textDim}>Enter accepts · Shift+Tab edits the previous value · Esc discards</Text>
    </> : <>
      <Text bold>{stage === 'method' ? 'Choose a workflow action' : stage === 'source' ? 'Choose a captured source genome'
        : stage === 'comparison' ? 'Choose the ordered comparison genome' : 'Choose a captured feature'}</Text>
      {choices.slice(start, start + pageSize).map((label, offset) => <Text key={start + offset} wrap="truncate-end" color={start + offset === cursor ? colors.accent : colors.text}>
        {start + offset === cursor ? '›' : ' '} {start + offset + 1}. {label}
      </Text>)}
      <Text color={colors.textDim}>Up/Down select · Left/Right page · Enter continues · Esc discards</Text>
      {action.kind === 'codons' && <Text color={colors.textDim}>CDS counts use the captured annotation. Host-model scores remain illustrative.</Text>}
    </>}
  </Box>;
}

/** The explorer is unmounted while this form owns keyboard input. Its worker
 * runs privately; applying replayed inputs requires a separate import review.
 */
export function ResearchWorkflowView({ session, genomes, onReturn, onReviewGenomes, captureView }: {
  session: TerminalResearchSession; genomes: TerminalGenomeSession;
  onReturn: () => void; onReviewGenomes: () => void; captureView?: () => ResearchView | null;
}): React.ReactElement {
  const { stdout } = useStdout();
  const { colors } = usePhageStore(state => state.currentTheme);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [mode, setMode] = useState<'browse' | 'open' | 'archive' | 'analysis' | 'new' | 'step' | 'plan' | 'tape'>('browse');
  const [pane, setPane] = useState<'draft' | 'draft-fields' | 'steps' | 'results' | 'fields'>('steps');
  const [editing, setEditing] = useState<number | null>(null);
  const [filename, setFilename] = useState('');
  const [selection, setSelection] = useState(0), [line, setLine] = useState(0);
  const [repetitions, setRepetitions] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);
  const [rows, setRows] = useState(readTerminalSize(stdout).rows || 24);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const resize = () => setRows(readTerminalSize(stdout).rows || 24);
    stdout.on?.('resize', resize);
    return () => { mounted.current = false; stdout.off?.('resize', resize); session.cancel(); };
  }, [session, stdout]);
  const available = useMemo(() => session.availableResults(), [session, state.completedRun, state.document]);
  const executions = useMemo(() => session.entries(), [session, state.completedRun, state.document]);
  const document = state.document;
  const steps = document?.inspection.steps ?? [];
  const draft = state.draft, draftPane = pane === 'draft' || pane === 'draft-fields';
  const count = draftPane ? draft?.plan.commands.length ?? 0 : pane === 'steps' ? steps.length : executions.length;
  const selected = Math.max(0, Math.min(selection, count - 1));
  const entry = executions[selected];
  const analysis = useMemo(() => entry?.analysis && available
    ? available.archive.records.find(record => record.resultId === entry.analysis!.resultId) ?? null : null, [entry, available]);
  // Only result fields are shown, never the original sequence/reference inputs.
  // The complete bounded record can be exported without truncation.
  const detailLines = useMemo(() => pane === 'draft-fields' && draft?.plan.commands[selected]
    ? JSON.stringify(draft.plan.commands[selected], null, 2).split('\n').map(terminalGenomeLabel)
    : analysis ? JSON.stringify(analysis.fields, null, 2).split('\n').map(terminalGenomeLabel) : [], [analysis, draft, selected, pane]);
  const perPage = Math.max(1, Math.min(12, rows - (draftPane ? 17 : 15)));
  const start = Math.floor(selected / perPage) * perPage;
  const detailStart = Math.max(0, Math.min(line, Math.max(0, detailLines.length - perPage)));
  const perform = (task: () => Promise<boolean>, accepted?: () => void) => {
    setFormError(null);
    void task().then(ok => { if (ok && mounted.current) accepted?.(); })
      .catch(cause => { if (mounted.current) setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); });
  };
  const chooseFile = (next: typeof mode) => { setMode(next); setFilename(''); setFormError(null); };
  const submit = () => {
    if (session.getSnapshot().busy || mode === 'browse' || mode === 'step') return;
    try {
      if (mode === 'new') {
        const view = captureView?.() ?? null;
        const bundle = genomes.exportBundle(view ? { contentId: view.contentId, viewMode: view.viewMode,
          readingFrame: view.readingFrame, scrollPosition: view.scrollPosition } : undefined);
        perform(() => session.createDraft(filename, bundle, view), () => { setMode('browse'); setPane('draft'); setSelection(0); setLine(0); });
        return;
      }
      const path = terminalGenomePath(filename);
      if (mode === 'open') perform(() => session.load(path), () => {
        setMode('browse'); setPane('steps'); setSelection(0); setLine(0); setRepetitions(1);
      });
      else {
        const execution = mode === 'plan' || mode === 'tape' ? mode : mode === 'analysis' ? entry?.execution : null;
        if (mode === 'analysis' && (!entry?.analysis || !execution)) throw new Error('Select an analysis execution before exporting.');
        perform(() => session.save(path, execution ?? null), () => { setMode('browse'); setFilename(''); });
      }
    } catch (cause) { setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  useInput((input, key) => {
    const busy = session.getSnapshot().busy;
    // Publication cannot be cancelled from this screen once file creation starts.
    // Process interruption is handled separately and can leave a new partial file.
    if (busy) { if (busy !== 'saving' && key.escape) session.cancel(); return; }
    if (mode === 'step') return; // The owned editor handles all of its input.
    if (mode !== 'browse') {
      if (key.escape) { setMode('browse'); setFormError(null); }
      return; // TextInput owns every character, including shortcut letters.
    }
    if (key.escape) {
      if (pane === 'fields') { setPane('results'); return; }
      if (pane === 'draft-fields') { setPane('draft'); return; }
      onReturn(); return;
    }
    const action = input.toLowerCase();
    if (action === 'q') { onReturn(); return; }
    if (action === 'n') { chooseFile('new'); return; }
    if (action === 'd' && draft) { setPane('draft'); setSelection(0); setLine(0); return; }
    if (action === 'i' && draft) { setEditing(null); setFormError(null); setMode('step'); return; }
    if (action === 'p' && draft) { chooseFile('plan'); return; }
    if (action === 't' && document) { chooseFile('tape'); return; }
    if (action === 'c' && draft?.plan.commands.length) {
      perform(session.recordDraft, () => { setPane('results'); setSelection(0); setLine(0); }); return;
    }
    if (draftPane && draft?.plan.commands.length && (action === 'x' || input === '[' || input === ']' || action === 'e')) {
      try {
        setFormError(null);
        if (action === 'e') { setEditing(selected); setMode('step'); }
        else if (action === 'x') { session.removeStep(selected); setSelection(Math.max(0, selected - 1)); setPane('draft'); }
        else { const direction = input === '[' ? -1 : 1; session.moveStep(selected, direction);
          setSelection(Math.max(0, Math.min(selected + direction, count - 1))); }
      } catch (cause) { setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
      return;
    }
    if (action === 'o') { chooseFile('open'); return; }
    if (action === 's') { setPane('steps'); setSelection(0); setLine(0); return; }
    if (action === 'v') { setPane('results'); setSelection(0); setLine(0); return; }
    if (action === 'a' && available) { chooseFile('archive'); return; }
    if (action === 'e' && (pane === 'results' || pane === 'fields') && entry?.analysis) { chooseFile('analysis'); return; }
    if (action === 'g' && state.completedRun) { perform(() => session.stageRestore(genomes), onReviewGenomes); return; }
    if ((input === '+' || input === '=') && !document?.savedResults) { setRepetitions(value => Math.min(10, value + 1)); return; }
    if (input === '-' && !document?.savedResults) { setRepetitions(value => Math.max(1, value - 1)); return; }
    if (action === 'r' && document) {
      perform(() => session.replay(repetitions), () => { setPane('results'); setSelection(0); setLine(0); }); return;
    }
    if (key.return && pane === 'results' && entry?.analysis) { setPane('fields'); setLine(0); return; }
    if (key.return && pane === 'draft' && draft?.plan.commands[selected]) { setPane('draft-fields'); setLine(0); return; }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? perPage : key.leftArrow ? -perPage : 0;
    if (delta && (pane === 'fields' || pane === 'draft-fields')) setLine(Math.max(0, Math.min(detailStart + delta, Math.max(0, detailLines.length - perPage))));
    else if (delta) setSelection(Math.max(0, Math.min(selected + delta, count - 1)));
  });
  const repeats = document?.savedResults?.archive.repetitions ?? repetitions;
  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderLight} paddingX={1}>
    <Text bold color={colors.accent}>RESEARCH WORKFLOWS — AUTHOR AND REPLAY</Text>
    <Text wrap="truncate-end">{document ? terminalGenomeLabel(document.name) + ' · ' + steps.length + ' commands · ' + document.inspection.genomes.length + ' private genomes' : 'Open a command workflow or complete results archive.'}</Text>
    {available && <Text color={colors.textDim}>{available.replayed ? 'Fresh numerical replay verified'
      : available.provenance === 'recorded' ? 'New computed baseline; independent replay not run' : 'Archive integrity checked; numerical replay not run'} · {executions.length} executions · {available.archive.records.length} distinct analyses</Text>}
    {state.notice && <Text wrap="truncate-end" color={colors.textDim}>{state.notice}</Text>}
    {(formError || state.error) && <Text wrap="truncate-end" color={colors.accent}>{formError ?? state.error}</Text>}
    {state.busy ? <>
      <Text>{state.busy === 'saving' ? 'Saving the new output file. Wait for completion.' : 'Working: ' + state.busy + '. Esc cancels.'}</Text>
      {state.progress && <Text wrap="truncate-end">{state.progress.phase}: {state.progress.completed}/{state.progress.total} · {terminalGenomeLabel(state.progress.actionId ?? 'Validating original inputs')}</Text>}
      {state.busy === 'saving' && <Text color={colors.textDim}>Process interruption can leave a partial new file. Existing files are never overwritten.</Text>}
    </> : mode === 'step' && draft ? <ResearchStepEditor draft={draft} initial={editing === null ? null : draft.plan.commands[editing]} rows={rows}
      onCancel={() => setMode('browse')} onSave={step => { session.setStep(step, editing); setMode('browse'); setPane('draft');
        setSelection(editing ?? draft.plan.commands.length); setLine(0); }} /> : mode !== 'browse' ? <>
      <Text bold>{mode === 'new' ? 'New workflow draft name:' : mode === 'open' ? 'Workflow or complete archive path:'
        : mode === 'plan' ? 'New declarative plan destination:' : mode === 'tape' ? 'New command recording destination:'
          : mode === 'archive' ? 'New complete archive destination:' : 'New analysis destination (execution ' + entry?.execution + '):'}</Text>
      <TextInput value={filename} onChange={setFilename} onSubmit={submit} />
      <Text color={colors.textDim}>{mode === 'new' ? 'Enter captures accepted private inputs and view · Esc returns without changes'
        : 'Enter submits · Esc returns · Literal paths; ~/ supported; no shell quotes.'}</Text>
    </> : <>
      {draftPane && draft ? <>
        <Text bold wrap="truncate-end">Draft: {terminalGenomeLabel(draft.plan.name)} · {draft.sources.length} captured genomes · {draft.plan.commands.length} steps</Text>
        {pane === 'draft-fields' ? <>
          <Text bold>Proposed command parameters — no output expectations</Text>
          {detailLines.slice(detailStart, detailStart + perPage).map((text, index) => <Text key={detailStart + index} wrap="truncate-end">{text}</Text>)}
          <Text color={colors.textDim}>Lines {detailStart + 1}–{Math.min(detailStart + perPage, detailLines.length)} / {detailLines.length} · Esc returns to draft</Text>
        </> : draft.plan.commands.slice(start, start + perPage).map((step, offset) => {
          const source = draft.sources.find(item => item.contentId === (step.parameters as Record<string, unknown>).contentId);
          return <Text key={start + offset} wrap="truncate-end" color={start + offset === selected ? colors.accent : colors.text}>
            {start + offset === selected ? '›' : ' '} {start + offset + 1}. {editorActions.find(action => action.id === step.actionId)?.label ?? step.actionId} · {terminalGenomeLabel(source?.name ?? 'missing source')}
          </Text>;
        })}
        <Text>[I] Add · [E] Edit · [X] Remove step · [ / ] Reorder · Enter reviews parameters</Text>
        <Text>[C] Compute and record a NEW baseline · [P] Export declarative plan</Text>
      </> : pane === 'steps' ? <>
        <Text bold>Recorded steps — {document?.inspection.canReplay ? 'supported for terminal replay' : steps.length ? 'review unsupported actions below' : 'no workflow loaded'}</Text>
        {steps.slice(start, start + perPage).map((step, offset) => <Text key={step.step} wrap="truncate-end" color={start + offset === selected ? colors.accent : colors.text}>
          {start + offset === selected ? '›' : ' '} {step.step}. {terminalGenomeLabel(step.actionId)}{step.supported ? '' : ' — UNSUPPORTED'}
        </Text>)}
        {steps[selected]?.reason && <Text wrap="truncate-end" color={colors.accent}>{terminalGenomeLabel(steps[selected].reason!)}</Text>}
      </> : pane === 'fields' && analysis ? <>
        <Text bold wrap="truncate-end">Execution {entry?.execution} · {terminalGenomeLabel(analysis.method.id)} v{terminalGenomeLabel(analysis.method.version)} · result fields</Text>
        {detailLines.slice(detailStart, detailStart + perPage).map((text, index) => <Text key={detailStart + index} wrap="truncate-end">{text}</Text>)}
        <Text color={colors.textDim}>Lines {detailStart + 1}–{Math.min(detailStart + perPage, detailLines.length)} / {detailLines.length} · Esc returns to results</Text>
      </> : <>
        <Text bold>Ordered results — {executions.length ? 'Enter inspects the selected analysis fields' : 'replay or open a complete archive first'}</Text>
        {executions.slice(start, start + perPage).map((result, offset) => <Text key={result.execution} wrap="truncate-end" color={start + offset === selected ? colors.accent : colors.text}>
          {start + offset === selected ? '›' : ' '} {result.execution}. run {result.iteration}, step {result.step}: {terminalGenomeLabel(result.analysis?.method.id ?? 'navigation (no analysis)')}
        </Text>)}
        {entry?.analysis && <Text wrap="truncate-end" color={colors.textDim}>Result {entry.analysis.resultId} · v{terminalGenomeLabel(entry.analysis.method.version)}</Text>}
      </>}
      {pane !== 'fields' && pane !== 'draft-fields' && count > 0 && <Text color={colors.textDim}>Selected {selected + 1}/{count} · Up/Down select · Left/Right page</Text>}
      <Text>[N] New draft from accepted private genomes · [D] Draft · [T] Export accepted tape</Text>
      <Text>[O] Open · [R] Replay ×{repeats}{document?.savedResults ? ' (saved count)' : ' [+/-]'} · [S] Steps · [V] Results</Text>
      <Text dimColor={!available}>[A] Export archive{draftPane ? '' : ' · [E] Export selected analysis'}</Text>
      <Text dimColor={!state.completedRun}>[G] Restore genomes/view (review first) · Esc back</Text>
      <Text color={colors.textDim}>Replay leaves the explorer unchanged. Exports contain private inputs.</Text>
    </>}
  </Box>;
}
