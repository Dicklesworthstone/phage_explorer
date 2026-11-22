import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { basename } from 'node:path';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson } from '../../../core/src/analysis-result';
import { COMMAND_LIMITS } from '../../../core/src/command-session';
import { inspectCodonReferenceInput, type ZeroCountReplacement } from '../../../core/src/analysis/codon-reference';
import { parseSpacerLibrary, SPACER_LIMITS, type SpacerLibrary } from '../../../core/src/analysis/spacer-reference';
import { researchReferenceCodonParameters, researchSpacerParameters,
  type ResearchReferenceCodonParameters, type ResearchSpacerParameters } from '../../../web/src/keyboard/ResearchWorkflow';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import { readInput } from '../../../../scripts/research-workflow';
import { terminalGenomeLabel, terminalGenomePath } from '../local-genome-session';
import type { TerminalResearchDraft, TerminalResearchStep } from '../terminal-research-session';

type ReferenceKind = 'reference-codons' | 'spacers';
interface ReferenceInput { text: string; label: string; summary: string; library?: SpacerLibrary }
function inspectReference(kind: ReferenceKind, text: string, label: string): ReferenceInput {
  if (kind === 'spacers') {
    const library = parseSpacerLibrary(text);
    return { text, label, library, summary: `${library.name} · ${library.hosts.length} hosts · ${library.spacers.length} spacers · ${library.source.kind}` };
  }
  const inspected = inspectCodonReferenceInput(text);
  return { text, label, summary: `Genetic code ${inspected.geneticCode} · ${inspected.sourceBacked
    ? 'source corpus; fresh recount required during computation' : 'user-supplied integer codon counts'}` };
}

/** References are embedded values, never paths to reread during later replay.
 * The editor does no sequence analysis; source-corpus recounting stays in the
 * recording worker. Unmount/replacement retires even a reader that ignores abort.
 */
export function ReferenceStepEditor({ kind, draft, initial, rows, onSave, onCancel, readReference = readInput }: {
  kind: ReferenceKind; draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void; readReference?: typeof readInput;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const prior = initial?.actionId === (kind === 'spacers' ? ActionIds.OverlayCRISPR : ActionIds.OverlayCodonAdaptation)
    ? initial.parameters as unknown as ResearchReferenceCodonParameters & ResearchSpacerParameters : null;
  const owner = useRef(draft);
  const sources = owner.current.sources;
  const activeRead = useRef<AbortController | null>(null);
  const [stage, setStage] = useState<'source' | 'file' | 'genes' | 'policy' | 'host' | 'topology' | 'mismatches'>('source');
  const [sourceIndex, setSourceIndex] = useState(Math.max(0, sources.findIndex(source => source.contentId === prior?.contentId)));
  const [filePath, setFilePath] = useState('');
  const [reference, setReference] = useState<ReferenceInput | null>(() => {
    const text = kind === 'spacers' ? prior?.libraryText : prior?.referenceText;
    if (!text) return null;
    try { return inspectReference(kind, text, 'Embedded reference'); } catch { return null; }
  });
  const [reading, setReading] = useState(false);
  const [geneIds, setGeneIds] = useState<number[] | null>(prior?.geneIds ? [...prior.geneIds] : null);
  const [cursor, setCursor] = useState(0);
  const [zeroCountReplacement, setZeroCountReplacement] = useState<ZeroCountReplacement>(prior?.zeroCountReplacement ?? 0);
  const [hostId, setHostId] = useState<string | null>(prior?.hostId ?? null);
  const [topology, setTopology] = useState<ResearchSpacerParameters['topology']>(prior?.topology ?? sources[sourceIndex].topology);
  const [mismatches, setMismatches] = useState(String(prior?.maxMismatches ?? 0));
  const [error, setError] = useState<string | null>(null);
  const source = sources[sourceIndex];
  const genes = source.genes.filter(gene => gene.type === 'CDS');
  const stopRead = () => { const pending = activeRead.current; activeRead.current = null; pending?.abort(); };
  useEffect(() => () => { const pending = activeRead.current; activeRead.current = null; pending?.abort(); }, []);
  useEffect(() => {
    if (draft !== owner.current) { stopRead(); onCancel(); }
  }, [draft, onCancel]);
  const fail = (cause: unknown) => setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)));
  const acceptReference = (loaded: ReferenceInput) => {
    setReference(loaded);
    if (kind === 'spacers') {
      const index = loaded.library!.hosts.findIndex(host => host.id === hostId);
      if (index < 0) setHostId(null);
      setCursor(index + 1); setStage('host');
    } else { setCursor(0); setStage('genes'); }
  };
  const loadReference = async (value: string) => {
    if (activeRead.current || draft !== owner.current) return;
    setError(null);
    if (!value && reference) { acceptReference(reference); return; }
    if (!value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) { fail(new Error('Provide a local JSON path without control characters.')); return; }
    const controller = new AbortController(); activeRead.current = controller; setReading(true);
    const timer = setTimeout(() => controller.abort(new Error('Reference read timed out. The draft is unchanged.')), 30000);
    try {
      const path = terminalGenomePath(value);
      const text = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason ?? new Error('Reference read cancelled.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        void Promise.resolve().then(() => readReference(path, controller.signal,
          kind === 'spacers' ? SPACER_LIMITS.libraryBytes : COMMAND_LIMITS.bytes))
          .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
        if (controller.signal.aborted) abort();
      });
      if (activeRead.current !== controller || controller.signal.aborted || draft !== owner.current) return;
      acceptReference(inspectReference(kind, text, basename(path)));
    } catch (cause) { if (activeRead.current === controller) fail(cause); }
    finally {
      clearTimeout(timer);
      if (activeRead.current === controller) { activeRead.current = null; setReading(false); }
    }
  };
  const save = () => {
    if (draft !== owner.current || !reference) throw new Error('Choose a reference for the current captured draft.');
    const parameters = kind === 'reference-codons'
      ? researchReferenceCodonParameters(source.contentId, reference.text, geneIds, zeroCountReplacement)
      : researchSpacerParameters(source.contentId, reference.text, topology,
        { hostId, maxMismatches: /^(0|[1-9][0-9]*)$/.test(mismatches) ? Number(mismatches) : Number.NaN });
    onSave({ actionId: kind === 'reference-codons' ? ActionIds.OverlayCodonAdaptation : ActionIds.OverlayCRISPR,
      parameters: analysisJson(parameters) });
  };
  const topologies: ResearchSpacerParameters['topology'][] = source.topology === 'unknown'
    ? ['unknown', 'linear', 'circular'] : [source.topology];
  const choices = stage === 'source' ? sources.map(item => terminalGenomeLabel(`${item.name} · ${item.accession}`) + ` · ${item.bases} bp`)
    : stage === 'genes' ? [`${geneIds === null ? '[x]' : '[ ]'} All captured CDS`, ...genes.map(gene =>
      `${geneIds?.includes(gene.id) ? '[x]' : '[ ]'} ${terminalGenomeLabel(gene.name || gene.locusTag || 'CDS')} · feature ${gene.id}`)]
      : stage === 'policy' ? ['Keep reported zero counts as zero', 'Replace reported zero counts with 0.5']
        : stage === 'host' ? ['All hosts in the reference library', ...reference!.library!.hosts.map(host =>
          terminalGenomeLabel(`${host.name} · ${host.strain} · ${host.accession} · ${host.id}`))]
          : topologies.map(value => value === 'unknown' ? 'Unknown topology; no origin-spanning matches' : `${value} molecule`);
  const position = stage === 'source' ? sourceIndex : stage === 'policy' ? (zeroCountReplacement === 0 ? 0 : 1) : cursor;
  useInput((input, key) => {
    if (key.escape) { stopRead(); onCancel(); return; }
    if (reading || draft !== owner.current || stage === 'file' || stage === 'mismatches') return;
    if (input === ' ' && stage === 'genes') {
      if (!cursor) setGeneIds(null);
      else {
        const id = genes[cursor - 1].id;
        setGeneIds(before => before === null ? [id] : before.includes(id) ? before.filter(value => value !== id) : [...before, id]);
      }
      setError(null); return;
    }
    if (key.return) {
      try {
        setError(null);
        if (stage === 'source') {
          if (kind === 'reference-codons' && !genes.length) throw new Error('Reference CAI requires captured CDS annotations. Select an annotated genome.');
          if (kind === 'spacers' && source.bases > SPACER_LIMITS.genomeBases) throw new Error('Spacer search supports at most 5,000,000 query bases.');
          if (source.contentId !== prior?.contentId) setGeneIds(null);
          setTopology(source.topology === 'unknown' ? prior?.topology ?? 'unknown' : source.topology);
          setStage('file');
        } else if (stage === 'genes') {
          if (geneIds !== null && !geneIds.length) throw new Error('Choose at least one CDS, or explicitly choose all captured CDS.');
          setStage('policy');
        } else if (stage === 'policy') save();
        else if (stage === 'host') {
          setHostId(cursor ? reference!.library!.hosts[cursor - 1].id : null);
          setCursor(Math.max(0, topologies.indexOf(topology))); setStage('topology');
        } else if (stage === 'topology') { setTopology(topologies[cursor]); setStage('mismatches'); }
      } catch (cause) { fail(cause); }
      return;
    }
    const pageSize = Math.max(1, Math.min(8, rows - 16));
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? pageSize : key.leftArrow ? -pageSize : 0;
    if (!delta) return;
    const next = Math.max(0, Math.min(position + delta, choices.length - 1));
    if (stage === 'source') setSourceIndex(next);
    else if (stage === 'policy') setZeroCountReplacement(next ? 0.5 : 0);
    else setCursor(next);
  });
  const pageSize = Math.max(1, Math.min(8, rows - 16)), start = Math.floor(position / pageSize) * pageSize;
  const title = stage === 'source' ? 'Choose a captured reference-analysis query'
    : stage === 'file' ? (kind === 'reference-codons' ? 'Load a codon reference or source corpus' : 'Load a sourced spacer library')
      : stage === 'genes' ? 'Choose CDS for reference-relative CAI'
        : stage === 'policy' ? 'Choose the explicit zero-count policy'
          : stage === 'host' ? 'Choose reference-library hosts' : stage === 'topology' ? 'Choose spacer-search topology' : 'Maximum spacer mismatches (0–5)';
  return <Box flexDirection="column">
    <Text bold>{title}</Text>
    {error && <Text color={colors.accent} wrap="truncate-end">{error}</Text>}
    <Text wrap="truncate-end">Captured query: {terminalGenomeLabel(source.name)} · {source.bases} bp</Text>
    {reference && <>
      <Text wrap="truncate-end">Reference: {terminalGenomeLabel(reference.label)}</Text>
      <Text wrap="truncate-end">{terminalGenomeLabel(reference.summary)}</Text>
    </>}
    {stage === 'file' ? <>
      <Text>{reference ? 'Enter keeps the embedded reference; enter a local JSON path to replace it.' : 'Local JSON path (the exact file contents are embedded in the command):'}</Text>
      {reading ? <Text>Reading reference locally… Esc cancels</Text> : <TextInput value={filePath}
        onChange={value => { if (value.length <= 4096) setFilePath(value); }} onSubmit={value => { void loadReference(value); }} />}
    </> : stage === 'mismatches' ? <TextInput value={mismatches}
      onChange={value => { if (value.length <= 16) setMismatches(value); }}
      onSubmit={() => { try { setError(null); save(); } catch (cause) { fail(cause); } }} />
      : choices.slice(start, start + pageSize).map((label, offset) => <Text key={start + offset}
        wrap="truncate-end" color={start + offset === position ? colors.accent : colors.text}>
        {start + offset === position ? '›' : ' '} {start + offset + 1}. {label}
      </Text>)}
    <Text color={colors.textDim}>{stage === 'genes' ? 'Space toggles CDS · ' : ''}Up/Down select · Enter continues · Esc discards</Text>
    <Text color={colors.textDim}>{kind === 'reference-codons'
      ? 'CAI is reference-relative codon usage, not expression or infectivity. Missing counts stay unavailable.'
      : 'Spacer matches are sequence evidence. No matches do not establish host susceptibility or resistance.'}</Text>
  </Box>;
}
