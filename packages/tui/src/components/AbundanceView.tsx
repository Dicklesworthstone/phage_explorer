/** Interactive terminal access to the same private abundance experiments as the browser. */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { TerminalSizeGate, useOverlayWidth, MIN_COLUMNS, MIN_ROWS } from './terminal-size';
import { AbundanceWorkspace, abundanceTerminalLabel } from '../commands/abundance';
import type { AbundanceAnalysis, AbundanceAssociation } from '../../../core/src/analysis/abundance';

type Prompt = 'open' | 'metadata' | 'parameters' | 'export dataset' | 'export analysis';
const PROMPT_KEYS = new Map<string, Prompt>([['o', 'open'], ['m', 'metadata'], ['p', 'parameters'], ['e', 'export analysis'], ['d', 'export dataset']]);
const PROMPTS: Record<Prompt, string> = {
  open: 'Dataset or saved-analysis file', metadata: 'Sample metadata file', parameters: 'Parameter JSON (partial object allowed)',
  'export dataset': 'New dataset export file', 'export analysis': 'New analysis export file',
};

export function AbundanceView({ workspace, initialPath }: { workspace: AbundanceWorkspace; initialPath?: string }): React.ReactElement {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const { accepted, options, busy, publishing, phase, error, notice } = snapshot;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [input, setInput] = useState('');
  const [page, setPage] = useState(0);
  const [taxon, setTaxon] = useState(0);
  const [tab, setTab] = useState<'pairs' | 'profiles'>('pairs');
  const { exit } = useApp(), { stdout } = useStdout();
  const width = useOverlayWidth(110);
  const pageSize = Math.max(2, Math.min(12, (stdout.rows ?? 24) - 17));
  const record = accepted?.record;
  const pairs = (record?.fields.associations.value ?? []) as unknown as AbundanceAssociation[];
  const factors = record?.fields.factors.value as unknown as { profiles: AbundanceAnalysis['profiles']; nmf: AbundanceAnalysis['nmfResult'] } | undefined;
  const coverage = record?.fields.coverage.value as unknown as { taxa: string[]; samples: string[]; diagnostics: AbundanceAnalysis['diagnostics'] } | undefined;
  const profile = factors?.profiles[taxon];
  const pageCount = Math.max(1, Math.ceil(pairs.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const safe = abundanceTerminalLabel;

  useEffect(() => {
    workspace.activate();
    if (initialPath && !workspace.getSnapshot().accepted) void workspace.load(initialPath);
    return workspace.deactivate;
  }, [workspace, initialPath]);
  useEffect(() => { setPage(0); setTaxon(0); }, [accepted]);
  useInput((key, info) => {
    if (publishing) return; // Do not truncate an already-authorized export.
    if (info.escape || info.ctrl && key === 'c') {
      if (prompt) { setPrompt(null); setInput(''); }
      else if (busy) workspace.cancel();
      else exit();
      return;
    }
    // Printable shortcut letters belong exclusively to the active text editor.
    if (prompt) return;
    if (key === 'q') { workspace.deactivate(); exit(); return; }
    if (key === 'c') { workspace.cancel(); return; }
    if (busy) return;
    if (info.return || key === 'a') { void workspace.analyze(); return; }
    const nextPrompt = PROMPT_KEYS.get(key);
    if (nextPrompt) { setInput(''); setPrompt(nextPrompt); return; }
    if (key === '1') setTab('pairs');
    if (key === '2') setTab('profiles');
    if (info.rightArrow || key === 'l') setPage(Math.min(currentPage + 1, pageCount - 1));
    if (info.leftArrow || key === 'h') setPage(Math.max(0, currentPage - 1));
    if (info.downArrow || key === 'j') setTaxon(Math.min(taxon + 1, (factors?.profiles.length ?? 1) - 1));
    if (info.upArrow || key === 'k') setTaxon(Math.max(0, taxon - 1));
  });
  const submit = (value: string) => {
    const action = prompt;
    setPrompt(null); setInput('');
    if (!action) return;
    if (action === 'parameters') workspace.setParameters(value);
    else if (action === 'open') void workspace.load(value);
    else if (action === 'metadata') void workspace.attachMetadata(value);
    else void workspace.save(value, action === 'export dataset' ? 'dataset' : 'analysis');
  };
  const changed = record && options && Object.entries(options).some(([key, value]) => record.parameters[key] !== value);
  const title = useMemo(() => accepted ? safe(accepted.dataset.name) : 'No dataset loaded', [accepted]);

  return <Box flexDirection="column" width={width} borderStyle="round" paddingX={1}>
    <Text bold>LOCAL ABUNDANCE WORKSPACE</Text>
    <Text wrap="truncate-end">{title}</Text>
    <Text wrap="truncate-end">{accepted ? `${accepted.dataset.table.taxa.length} taxa × ${accepted.dataset.table.samples.length} samples · ${accepted.dataset.units} · ${accepted.dataset.metadata.length} metadata records · ${accepted.dataset.source.kind === 'demo' ? 'SYNTHETIC EXAMPLE' : 'USER-SUPPLIED DATA'}` : 'Open a CSV/TSV, dataset JSON or saved analysis. No catalog required.'}</Text>
    <Text wrap="truncate-end" color={error ? 'red' : busy ? 'yellow' : undefined}>{safe(error ?? (busy ? phase : notice ?? 'Ready'))}</Text>
    <Text wrap="truncate-end">{record ? `Accepted result: ${record.resultId}` : 'No accepted analysis yet.'}</Text>
    <Text wrap="truncate-end">{options ? `Draft: seed=${options.seed}, pseudocount=${options.pseudocount}, factors=${options.numNiches}, permutations=${options.permutations}` : 'Parameters become available after loading.'}</Text>
    <Text color={changed ? 'yellow' : undefined}>{changed ? 'Unsubmitted parameter edits. Exports still contain the previous accepted result.' : 'Exploratory CLR associations and NMF factors, not ecological interactions.'}</Text>
    {prompt ? <Box flexDirection="column"><Text>{PROMPTS[prompt]} (Enter accepts, Esc cancels)</Text>
      <TextInput value={input} onChange={value => setInput(safe(value).slice(0, 8192))} onSubmit={submit} />
    </Box> : <>
      <Text>[o] Open/verify  [m] Metadata  [p] Parameters  [Enter/a] Analyze</Text>
      <Text>[e] Export result  [d] Export dataset  [c] Cancel  [q] Quit</Text>
    </>}
    <Text>[1] Pair statistics (all tests)  [2] Taxon factors/habitats</Text>
    {tab === 'pairs' ? <>
      <Text>Pairs {pairs.length ? currentPage + 1 : 0}/{pairs.length ? pageCount : 0} · ←/→ or h/l</Text>
      {pairs.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((pair, i) => <Text key={i} wrap="truncate-end">
        {safe(pair.source)} / {safe(pair.target)} · r={pair.correlation.toPrecision(4)} p={pair.pvalue.toPrecision(4)} BH={pair.qvalue.toPrecision(4)}
      </Text>)}
      {!pairs.length && <Text>No tested nonconstant pairs. Load data and run an analysis.</Text>}
    </> : <>
      <Text wrap="truncate-end">Taxon {profile ? taxon + 1 : 0}/{factors?.profiles.length ?? 0} · ↑/↓ or j/k · {profile ? safe(profile.taxon) : 'No analysis'}</Text>
      <Text wrap="truncate-end">{profile ? profile.factorWeights.map((x, i) => `F${i + 1}=${(x * 100).toFixed(2)}%`).join(' ') : 'No factor memberships available.'}</Text>
      <Text wrap="truncate-end">Descriptive memberships, not probabilities. Residual: {factors?.nmf.error.toPrecision(6) ?? '—'}</Text>
      {profile?.habitats.slice(0, pageSize).map(h => <Text key={h.habitat} wrap="truncate-end">{safe(h.habitat)} · n={h.samples} · mean={(100 * h.meanRelativeAbundance).toFixed(4)}%</Text>)}
      {!!profile && profile.habitats.length === 0 && <Text>No matching habitat metadata.</Text>}
      {!!profile && profile.habitats.length > pageSize && <Text>More habitat groups are available in the complete exported record.</Text>}
    </>}
    {coverage && <Text wrap="truncate-end">Retained {coverage.taxa.length} taxa/{coverage.samples.length} samples; {coverage.diagnostics.permutationMode} test; {coverage.diagnostics.constantTaxa.length} constant trajectories excluded.</Text>}
  </Box>;
}

function AbundanceShell(props: { workspace: AbundanceWorkspace; initialPath?: string }): React.ReactElement {
  const { stdout } = useStdout(), { exit } = useApp();
  const small = typeof stdout.columns === 'number' && typeof stdout.rows === 'number' &&
    (stdout.columns < MIN_COLUMNS || stdout.rows < MIN_ROWS);
  useInput((input, key) => { if (small && (input === 'q' || key.ctrl && input === 'c')) exit(); });
  return <TerminalSizeGate><AbundanceView {...props} /></TerminalSizeGate>;
}

export async function launchAbundanceView(args: string[]): Promise<void> {
  if (args.length > 1 || args[0]?.startsWith('-') && args[0] !== '--help') throw new Error('Usage: phage-explorer abundance view [INPUT]');
  if (args[0] === '--help') { process.stdout.write('Usage: phage-explorer abundance view [INPUT]\nOpen data or a saved analysis, edit parameters, run, cancel, inspect and export without a catalog.\n'); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive view requires a terminal. Use abundance inspect/analyze/replay for pipes.');
  const workspace = new AbundanceWorkspace();
  const instance = render(<AbundanceShell workspace={workspace} initialPath={args[0]} />,
    { exitOnCtrlC: false, patchConsole: false });
  const interrupt = () => { if (workspace.getSnapshot().busy) workspace.cancel(); else instance.unmount(); };
  process.on('SIGINT', interrupt);
  try { await instance.waitUntilExit(); }
  finally { process.off('SIGINT', interrupt); workspace.deactivate(); }
}
