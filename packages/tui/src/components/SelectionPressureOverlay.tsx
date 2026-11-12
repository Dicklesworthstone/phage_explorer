import React, { useEffect, useMemo, useRef, useState } from 'react';
import { writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import { parseAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { CODON_SELECTION_LIMITS, parseCodonAlignmentFasta, resolveCodonSelectionOptions,
  validateCodonAlignment, type CodonAlignmentInput, type CodonEstimate,
  type CodonSelectionOptions, type CodonSelectionResult } from '../../../core/src/analysis/codon-selection';
import { readAbundanceFile } from '../commands/abundance';
import { runCodonSelectionJob, type CodonSelectionJobResult } from '../commands/codon-selection';
import { useOverlayWidth } from './terminal-size';

type Tab = 'pairs' | 'windows' | 'source';
type Prompt = 'load' | 'replay' | 'params' | 'window' | 'range' | 'json' | 'pairs' | 'windows' | 'dataset';
interface Draft { input: CodonAlignmentInput; ids: string[]; options: CodonSelectionOptions }
interface Accepted { input: CodonAlignmentInput; result: CodonSelectionResult; record: AnalysisRecord; output: CodonSelectionJobResult }
const PROMPTS: Record<Prompt, string> = {
  load: 'Codon dataset JSON path', replay: 'Saved codon comparison JSON path', params: 'Codon parameter JSON path',
  window: 'Window size in codons (1–10000)', range: 'Alignment codon range: start,end (zero-based, end exclusive)',
  json: 'New replayable codon JSON path', pairs: 'New complete pair TSV path',
  windows: 'New complete window TSV path', dataset: 'New codon dataset JSON path',
};
const PROMPT_KEYS = new Map<string, Prompt>([['l', 'load'], ['r', 'replay'], ['p', 'params'], ['w', 'window'],
  ['g', 'range'], ['e', 'json'], ['t', 'pairs'], ['u', 'windows'], ['b', 'dataset']]);
const label = (value: string): string => stripVTControlCharacters(value)
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
const number = (value: number | null): string => value === null ? 'Unavailable' : value.toPrecision(6);
function estimateLines(name: string, value: CodonEstimate): string[] {
  return [name + `: codons [${value.startCodon},${value.endCodon})`,
    `dN ${number(value.dN.value)} (${value.dN.status}); dS ${number(value.dS.value)} (${value.dS.status})`,
    `ω ${number(value.omega)}; retained ${value.retained}/${value.endCodon - value.startCodon}`,
    `Sites S ${number(value.synonymousSites)} / N ${number(value.nonsynonymousSites)}; changes S ${number(value.synonymousDifferences)} / N ${number(value.nonsynonymousDifferences)}`,
    ...Object.entries(value.excluded).filter(([, count]) => count > 0).map(([reason, count]) => `Excluded ${count}: ${reason}`),
    ...(value.rejectedPaths ? [`Rejected stop-containing shortest paths: ${value.rejectedPaths}`] : []),
    ...(value.unavailableReason ? [value.unavailableReason] : [])];
}
function initialDraft(input: CodonAlignmentInput): Draft {
  const sequences = parseCodonAlignmentFasta(input.alignment.fasta);
  const maxWindowsPerPair = Math.floor(CODON_SELECTION_LIMITS.windows / (sequences.length - 1));
  const windowCodons = Math.max(50, Math.ceil(sequences[0].sequence.length / 3 / maxWindowsPerPair));
  return { input, ids: sequences.map(sequence => sequence.id), options: resolveCodonSelectionOptions(input, { windowCodons }) };
}

/** Independent local coding alignments; catalog genomes never establish homology or frame. */
export function SelectionPressureOverlay(_props: { repository: PhageRepository }): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const width = useOverlayWidth(100);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [tab, setTab] = useState<Tab>('source');
  const [pairIndex, setPairIndex] = useState(0), [offset, setOffset] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null), [input, setInput] = useState('');
  const [busy, setBusy] = useState(false), [phase, setPhase] = useState('');
  const [notice, setNotice] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const owner = useRef<AbortController | null>(null), mounted = useRef(false), saveGeneration = useRef(0);
  const pageSize = Math.max(1, Math.min(14, terminalRows - 17 - (prompt ? 1 : 0)));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; saveGeneration.current++; owner.current?.abort(); owner.current = null; };
  }, []);

  const cancel = () => {
    const pending = owner.current; owner.current = null; pending?.abort(); setBusy(false); setPhase('');
    if (pending) { setError(null); setNotice('Codon work cancelled; accepted evidence was preserved.'); }
  };
  const run = (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    owner.current?.abort(); const controller = new AbortController(); owner.current = controller;
    const current = () => mounted.current && owner.current === controller && !controller.signal.aborted;
    setBusy(true); setPhase('Reading local coding input'); setError(null); setNotice(null);
    void work(controller.signal, current).catch(cause => {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (current()) { owner.current = null; setBusy(false); setPhase(''); } });
  };
  const accept = async (output: CodonSelectionJobResult, current: () => boolean) => {
    // This is a freshly computed worker response, never an imported cached result.
    if (!current()) return;
    const record = await parseAnalysisRecord(output.content, { methodId: 'aligned-codon-dnds' });
    if (!current()) return;
    const source = record.inputs[0].data as unknown as CodonAlignmentInput;
    const result = record.fields.comparisons.value as unknown as CodonSelectionResult;
    setAccepted({ input: source, result, record, output });
    setDraft({ input: source, ids: result.sequences.map(sequence => sequence.id), options: result.options });
    setTab('pairs'); setPairIndex(0); setOffset(0);
    setNotice(output.verified ? 'Verified codon replay: fresh computation matches saved evidence.' : 'Conditional codon comparison complete.');
  };
  const analyze = () => {
    if (!draft) { setError('Load a sourced codon-alignment dataset first.'); return; }
    const captured = structuredClone(draft);
    run(async (signal, current) => {
      const output = await runCodonSelectionJob({ operation: 'analyze', input: { name: captured.input.name,
        text: JSON.stringify(captured.input) }, params: JSON.stringify(captured.options) }, signal,
      message => { if (current()) setPhase(message); });
      await accept(output, current);
    });
  };
  const change = (options: Partial<CodonSelectionOptions>) => {
    if (!draft) { setError('Load a sourced coding alignment before changing settings.'); return; }
    try {
      const resolved = resolveCodonSelectionOptions(draft.input, { ...draft.options, ...options });
      setDraft({ ...draft, options: resolved }); setError(null); setNotice('Draft settings changed; Enter computes them.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const submit = (value: string) => {
    const action = prompt; setPrompt(null); setInput(''); setError(null); setNotice(null);
    if (!action) return;
    if (action === 'window') {
      if (!/^\d+$/.test(value.trim())) { setError('Window size requires an integer from 1 to 10000.'); return; }
      change({ windowCodons: Number(value.trim()) }); return;
    }
    if (action === 'range') {
      const parts = value.trim().match(/^(\d+)\s*,\s*(\d+)$/);
      if (!parts) { setError('Enter start,end using zero-based alignment codons.'); return; }
      change({ startCodon: Number(parts[1]), endCodon: Number(parts[2]) }); return;
    }
    if (!value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      setError('Enter a nonempty local path without control characters.'); return;
    }
    if (action === 'load' || action === 'replay' || action === 'params') {
      const currentDraft = draft;
      if (action === 'params' && !currentDraft) { setError('Load a coding alignment before its parameters.'); return; }
      run(async (signal, current) => {
        const limit = action === 'replay' ? 10 * 1024 * 1024 : action === 'params' ? 128 * 1024 : CODON_SELECTION_LIMITS.bytes;
        const content = (await readAbundanceFile(value, limit, signal)).replace(/^\uFEFF/, '');
        if (!current()) return;
        if (action === 'replay') {
          const output = await runCodonSelectionJob({ operation: 'replay', input: { name: value, text: content } }, signal,
            message => { if (current()) setPhase(message); });
          await accept(output, current);
        } else if (action === 'load') {
          const next = initialDraft(validateCodonAlignment(JSON.parse(content)));
          setDraft(next); setAccepted(null); setTab('source'); setOffset(0); setPairIndex(0);
          setNotice('Coding alignment loaded. Review source/settings, then Enter analyzes.');
        } else {
          const options = resolveCodonSelectionOptions(currentDraft!.input, JSON.parse(content));
          setDraft({ ...currentDraft!, options }); setNotice('Parameter file loaded; Enter applies the draft settings.');
        }
      });
      return;
    }
    const dataset = accepted?.input ?? draft?.input;
    if (action === 'dataset' ? !dataset : !accepted) { setError('No accepted input or result to export.'); return; }
    const content = action === 'dataset' ? JSON.stringify(dataset, null, 2) + '\n'
      : action === 'json' ? accepted!.output.content : action === 'pairs' ? accepted!.output.pairs : accepted!.output.windows;
    const generation = ++saveGeneration.current;
    setSaving(true);
    // Capture exact accepted content before disk I/O. A new draft cannot rename an export.
    void writeFile(value, content, { flag: 'wx', mode: 0o600 }).then(() => {
      if (mounted.current && generation === saveGeneration.current) setNotice(`Saved ${action} to ${value}.`);
    }).catch(cause => {
      if (mounted.current && generation === saveGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (mounted.current && generation === saveGeneration.current) setSaving(false); });
  };

  const lines = useMemo(() => {
    if (tab === 'source') {
      const source = accepted?.input ?? draft?.input;
      if (!source) return ['No aligned CDS data loaded. Catalog genomes and diff references are unused.',
        'Load the browser\'s exported codon dataset JSON or prepare one with:',
        'phage-explorer codon-selection prepare --help',
        'Require sourced, homologous codon columns in coding 5′→3′ orientation.',
        'Explicit frame zero and genetic code are required; no alignment is guessed.',
        'Files stay local. Export accepted results before closing this panel.'];
      return [`${accepted ? 'Accepted' : 'Loaded'} source: ${source.name}`,
        source.source.kind === 'demo' ? 'SYNTHETIC EXAMPLE' : 'SUPPLIED SOURCE; attribution is not independently verified',
        `Description: ${source.source.description}`, `Reference: ${source.source.reference}`, `License: ${source.source.license}`,
        `Alignment method: ${source.alignment.method}`, `Homology/CDS provenance: ${source.alignment.reference}`,
        `NCBI table ${source.alignment.geneticCode}; coding 5′→3′; frame zero; declared homologous codons.`,
        ...(accepted ? [`Input identity: ${accepted.record.inputs[0].sha256}`, `Result identity: ${accepted.record.resultId}`,
          ...accepted.result.warnings] : []),
        ...((accepted?.result.sequences ?? draft!.ids.map(id => ({ id, description: id }))).map(sequence => `Sequence ${sequence.id}: ${sequence.description}`))];
    }
    if (!accepted) return ['No accepted estimate. Load a codon dataset, review settings and press Enter.'];
    if (tab === 'pairs') return accepted.result.pairs.flatMap((pair, index) => estimateLines(`${index + 1}. ${pair.left} vs ${pair.right}`, pair.overall));
    const pair = accepted.result.pairs[pairIndex];
    return pair ? pair.windows.flatMap((window, index) => estimateLines(`Window ${index + 1}`, window)) : ['No windows available.'];
  }, [tab, draft, accepted, pairIndex]);
  const first = Math.min(offset, Math.max(0, lines.length - pageSize));
  const pair = accepted?.result.pairs[pairIndex];
  const changed = accepted && draft && Object.entries(draft.options)
    .some(([key, value]) => value !== accepted.result.options[key as keyof CodonSelectionOptions]);

  useInput((key, info) => {
    if (saving) return;
    if (info.escape) {
      if (prompt) { setPrompt(null); setInput(''); }
      else if (busy) cancel();
      else { cancel(); closeOverlay('selectionPressure'); }
      return;
    }
    if (prompt) return; // File paths and numeric settings belong exclusively to TextInput.
    if (key === 'c') { cancel(); return; }
    if (busy) return;
    if (info.return) { analyze(); return; }
    const next = PROMPT_KEYS.get(key);
    if (next) { setPrompt(next); setInput(''); return; }
    if (key === 'f' && draft) change({ comparison: 'reference', referenceId: draft.ids[(draft.ids.indexOf(draft.options.referenceId ?? '') + 1) % draft.ids.length] });
    if (key === 'a' && draft) change(draft.options.comparison === 'reference'
      ? { comparison: 'all-pairs', referenceId: null } : { comparison: 'reference', referenceId: draft.ids[0] });
    if (key === 'm' && draft) change({ missing: draft.options.missing === 'pairwise' ? 'complete' : 'pairwise' });
    if (key === '1') { setTab('pairs'); setOffset(0); }
    if (key === '2') { setTab('windows'); setOffset(0); }
    if (key === '3') { setTab('source'); setOffset(0); }
    if (accepted && info.rightArrow) { setPairIndex(index => Math.min(accepted.result.pairs.length - 1, index + 1)); setOffset(0); }
    if (info.leftArrow) { setPairIndex(index => Math.max(0, index - 1)); setOffset(0); }
    if (info.downArrow || info.pageDown) setOffset(value => Math.min(Math.max(0, lines.length - pageSize), value + pageSize));
    if (info.upArrow || info.pageUp) setOffset(value => Math.max(0, value - pageSize));
    if (info.home) setOffset(0);
    if (info.end) setOffset(Math.max(0, lines.length - pageSize));
  });

  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} width={width}>
    <Text bold color={colors.primary}>ALIGNED CDS · CONDITIONAL dN/dS{(accepted?.input ?? draft?.input)?.source.kind === 'demo' ? ' · SYNTHETIC' : ''}</Text>
    {prompt ? <><Text wrap="truncate-end">{PROMPTS[prompt]} (Enter accepts, Esc cancels)</Text>
      <TextInput value={input} onChange={value => {
        if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) setError('Input cannot contain control characters.');
        else setInput(value.slice(0, 8192));
      }} onSubmit={submit} /></>
      : <Text wrap="truncate-end" color={colors.info}>[l] Load [r] Replay [Enter] Analyze [c] Cancel [Esc] Close</Text>}
    <Text wrap="truncate-end" color={colors.info}>[p] Params [f] Reference [a] Pairs [m] Missing [w] Window [g] Range</Text>
    <Text wrap="truncate-end" color={colors.info}>[1] Pairs [2] Windows [3] Source [←/→] Pair</Text>
    <Text wrap="truncate-end" color={colors.info}>[e] JSON [t] Pair TSV [u] Window TSV [b] Dataset</Text>
    <Text wrap="truncate-end">{draft ? `Draft: ${label(draft.input.name)} · code ${draft.input.alignment.geneticCode} · ${draft.ids.length} sequences` : 'No sourced coding alignment. No genome sequence has been read.'}</Text>
    <Text wrap="truncate-end">{draft ? `${label(draft.options.referenceId ?? 'all-pairs')}; ${draft.options.missing}; codons [${draft.options.startCodon},${draft.options.endCodon}); window ${draft.options.windowCodons}` : 'Raw equal-length genomes do not establish homologous coding columns.'}</Text>
    <Text wrap="truncate-end" color={error ? colors.error : colors.textDim}>{label(error ?? (saving ? 'Saving captured evidence…' : busy ? phase : notice ?? 'Load JSON prepared in the browser or with codon-selection prepare.'))}</Text>
    <Text wrap="truncate-end" color={changed ? colors.warning : colors.textDim}>{accepted ? `Accepted: ${accepted.result.pairs.length} pairs; ${accepted.result.options.missing}; window ${accepted.result.options.windowCodons}.${changed ? ' Draft changed; Enter applies.' : accepted.output.verified ? ' Replay verified.' : ''}` : 'No accepted comparison. Exports never use an unapplied parameter draft.'}</Text>
    <Text wrap="truncate-end">{pair ? `Pair ${pairIndex + 1}: ${label(pair.left)} vs ${label(pair.right)}` : 'Complete pair and window tables are available after computation.'}</Text>
    <Text wrap="truncate-end" color={colors.accent}>{tab}: lines {first + 1}–{Math.min(lines.length, first + pageSize)} of {lines.length} · ↑/↓ Home/End</Text>
    {lines.slice(first, first + pageSize).map((line, index) => <Text key={first + index} wrap="truncate-end">{label(line)}</Text>)}
    <Text wrap="truncate-end" color={colors.warning}>Descriptive ratios; no selection test or significance classification.</Text>
    <Text wrap="truncate-end" color={colors.textDim}>Codons are 0-based half-open. Saturation and dS=0 remain unavailable.</Text>
  </Box>;
}
