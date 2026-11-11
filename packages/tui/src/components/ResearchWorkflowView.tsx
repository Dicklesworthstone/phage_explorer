import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { terminalGenomeLabel, terminalGenomePath, type TerminalGenomeSession } from '../local-genome-session';
import type { TerminalResearchSession } from '../terminal-research-session';
import { readTerminalSize } from './terminal-size';

/** The explorer is unmounted while this form owns keyboard input. Its worker
 * runs privately; applying replayed inputs requires a separate import review.
 */
export function ResearchWorkflowView({ session, genomes, onReturn, onReviewGenomes }: {
  session: TerminalResearchSession; genomes: TerminalGenomeSession;
  onReturn: () => void; onReviewGenomes: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const { colors } = usePhageStore(state => state.currentTheme);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [mode, setMode] = useState<'browse' | 'open' | 'archive' | 'analysis'>('browse');
  const [pane, setPane] = useState<'steps' | 'results' | 'fields'>('steps');
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
  const count = pane === 'steps' ? steps.length : executions.length;
  const selected = Math.max(0, Math.min(selection, count - 1));
  const entry = executions[selected];
  const analysis = useMemo(() => entry?.analysis && available
    ? available.archive.records.find(record => record.resultId === entry.analysis!.resultId) ?? null : null, [entry, available]);
  // Only result fields are shown, never the original sequence/reference inputs.
  // The complete bounded record can be exported without truncation.
  const detailLines = useMemo(() => analysis ? JSON.stringify(analysis.fields, null, 2).split('\n').map(terminalGenomeLabel) : [], [analysis]);
  const perPage = Math.max(1, Math.min(12, rows - 15));
  const start = Math.floor(selected / perPage) * perPage;
  const detailStart = Math.max(0, Math.min(line, Math.max(0, detailLines.length - perPage)));
  const perform = (task: () => Promise<boolean>, accepted?: () => void) => {
    setFormError(null);
    void task().then(ok => { if (ok && mounted.current) accepted?.(); })
      .catch(cause => { if (mounted.current) setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); });
  };
  const chooseFile = (next: typeof mode) => { setMode(next); setFilename(''); setFormError(null); };
  const submit = () => {
    if (session.getSnapshot().busy || mode === 'browse') return;
    try {
      const path = terminalGenomePath(filename);
      if (mode === 'open') perform(() => session.load(path), () => {
        setMode('browse'); setPane('steps'); setSelection(0); setLine(0); setRepetitions(1);
      });
      else {
        const execution = mode === 'analysis' ? entry?.execution : null;
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
    if (mode !== 'browse') {
      if (key.escape) { setMode('browse'); setFormError(null); }
      return; // TextInput owns every character, including shortcut letters.
    }
    if (key.escape) {
      if (pane === 'fields') { setPane('results'); return; }
      onReturn(); return;
    }
    const action = input.toLowerCase();
    if (action === 'q') { onReturn(); return; }
    if (action === 'o') { chooseFile('open'); return; }
    if (action === 's') { setPane('steps'); setSelection(0); setLine(0); return; }
    if (action === 'v') { setPane('results'); setSelection(0); setLine(0); return; }
    if (action === 'a' && available) { chooseFile('archive'); return; }
    if (action === 'e' && pane !== 'steps' && entry?.analysis) { chooseFile('analysis'); return; }
    if (action === 'g' && state.completedRun) { perform(() => session.stageRestore(genomes), onReviewGenomes); return; }
    if ((input === '+' || input === '=') && !document?.savedResults) { setRepetitions(value => Math.min(10, value + 1)); return; }
    if (input === '-' && !document?.savedResults) { setRepetitions(value => Math.max(1, value - 1)); return; }
    if (action === 'r' && document) {
      perform(() => session.replay(repetitions), () => { setPane('results'); setSelection(0); setLine(0); }); return;
    }
    if (key.return && pane === 'results' && entry?.analysis) { setPane('fields'); setLine(0); return; }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? perPage : key.leftArrow ? -perPage : 0;
    if (delta && pane === 'fields') setLine(Math.max(0, Math.min(detailStart + delta, Math.max(0, detailLines.length - perPage))));
    else if (delta) setSelection(Math.max(0, Math.min(selected + delta, count - 1)));
  });
  const repeats = document?.savedResults?.archive.repetitions ?? repetitions;
  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderLight} paddingX={1}>
    <Text bold color={colors.accent}>RESEARCH WORKFLOWS — LOCAL REPLAY</Text>
    <Text wrap="truncate-end">{document ? terminalGenomeLabel(document.name) + ' · ' + steps.length + ' commands · ' + document.inspection.genomes.length + ' private genomes' : 'Open a command workflow or complete results archive.'}</Text>
    {available && <Text color={colors.textDim}>{available.replayed ? 'Fresh numerical replay verified' : 'Archive integrity checked; numerical replay not run'} · {executions.length} executions · {available.archive.records.length} distinct analyses</Text>}
    {state.notice && <Text wrap="truncate-end" color={colors.textDim}>{state.notice}</Text>}
    {(formError || state.error) && <Text wrap="truncate-end" color={colors.accent}>{formError ?? state.error}</Text>}
    {state.busy ? <>
      <Text>{state.busy === 'saving' ? 'Saving the new output file. Wait for completion.' : 'Working: ' + state.busy + '. Esc cancels.'}</Text>
      {state.progress && <Text wrap="truncate-end">{state.progress.phase}: {state.progress.completed}/{state.progress.total} · {terminalGenomeLabel(state.progress.actionId ?? 'Validating original inputs')}</Text>}
      {state.busy === 'saving' && <Text color={colors.textDim}>Process interruption can leave a partial new file. Existing files are never overwritten.</Text>}
    </> : mode !== 'browse' ? <>
      <Text bold>{mode === 'open' ? 'Workflow or complete archive path:' : mode === 'archive' ? 'New complete archive destination:' : 'New analysis destination (execution ' + entry?.execution + '):'}</Text>
      <TextInput value={filename} onChange={setFilename} onSubmit={submit} />
      <Text color={colors.textDim}>Enter submits · Esc returns · Literal paths; ~/ supported; no shell quotes.</Text>
    </> : <>
      {pane === 'steps' ? <>
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
      {pane !== 'fields' && count > 0 && <Text color={colors.textDim}>Selected {selected + 1}/{count} · Up/Down select · Left/Right page</Text>}
      <Text>[O] Open · [R] Replay ×{repeats}{document?.savedResults ? ' (saved count)' : ' [+/-]'} · [S] Steps · [V] Results</Text>
      <Text dimColor={!available}>[A] Export archive · [E] Export selected analysis</Text>
      <Text dimColor={!state.completedRun}>[G] Restore genomes/view (review first) · Esc back</Text>
      <Text color={colors.textDim}>Replay leaves the explorer unchanged. Exports contain private inputs.</Text>
    </>}
  </Box>;
}
