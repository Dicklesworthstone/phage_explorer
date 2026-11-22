import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { open } from 'node:fs/promises';
import { usePhageStore } from '@phage-explorer/state';
import {
  getGeneMapSegments, prepareSelectedCds, selectedCdsExport, selectedCdsLocation,
  type GeneInfo, type SelectedCdsSource, type SelectedCdsResult, type SelectedCdsExport, type SelectedCdsExportKind,
} from '@phage-explorer/core';
import { terminalGenomeLabel, terminalGenomePath } from '../local-genome-session';
import { genePositionToScroll } from './gene-navigation';
import { readTerminalSize } from './terminal-size';

/** Capture the complete payload before opening a new private file. A cancelled
 * disk write can leave a partial NEW file; an existing path is never replaced.
 */
export async function saveSelectedCdsExport(path: string, payload: SelectedCdsExport,
  signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
  const destination = terminalGenomePath(path);
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new Error('Selected CDS changed or export cancelled. A partial new file may remain.');
  };
  check();
  const file = await open(destination, 'wx', 0o600);
  try {
    check();
    await file.writeFile(payload.content, { encoding: 'utf8', signal });
    await file.sync();
    check();
  } finally { await file.close(); }
}

const tabs = ['Summary', 'CDS DNA', 'Protein', 'Qualifiers', 'Identity'] as const;
/** Conservatively wrap non-ASCII metadata so wide characters cannot hide its
 * remainder. Only display strings are cleaned; the exported record is untouched.
 */
function wrapLines(values: string[], width: number): string[] {
  return values.flatMap(value => {
    const safe = terminalGenomeLabel(value), points = Array.from(safe);
    const count = /[^ -~]/.test(safe) ? Math.max(1, Math.floor(width / 2)) : width;
    if (!points.length) return [''];
    const lines = [];
    for (let start = 0; start < points.length; start += count) lines.push(points.slice(start, start + count).join(''));
    return lines;
  });
}
function resultLines(result: SelectedCdsResult, tab: number, width: number): string[] {
  if (tab === 1 || tab === 2) {
    const sequence = tab === 1 ? result.cds : result.protein;
    if (sequence === null) return wrapLines([
      tab === 1 ? 'CDS DNA unavailable.' : 'Translation unavailable; exact annotated DNA may still be exported.',
      ...(tab === 1 ? result.extractionReasons : result.translationReasons),
    ], width);
    const perLine = Math.max(1, width - 10), lines = [];
    for (let start = 0; start < sequence.length; start += perLine) lines.push(`${String(start + 1).padStart(8)}  ${sequence.slice(start, start + perLine)}`);
    return lines.length ? lines : ['No bases remain after codon_start.'];
  }
  if (tab === 3) return wrapLines(JSON.stringify(result.gene.qualifiers ?? {}, null, 2).split('\n'), width);
  if (tab === 4) return wrapLines([
    `Source: ${result.source.kind} / ${result.source.accession}`,
    `Genome SHA-256: ${result.source.genomeSha256}`,
    `CDS SHA-256: ${result.cdsSha256 ?? 'unavailable'}`,
    `Protein SHA-256: ${result.proteinSha256 ?? 'unavailable'}`,
    `Result SHA-256: ${result.resultId}`,
    `Local input: ${result.source.localContentId ?? 'catalog'}`,
    'JSON includes complete sequences, original feature qualifiers, exact parts and translation limitations.',
    'The complete original genome is required to recheck the coordinates.',
  ], width);
  return wrapLines([
    `Product: ${result.gene.product || 'not annotated'}`,
    `Annotated location: ${String(result.gene.qualifiers?._location ?? `${result.gene.startPos + 1}..${result.gene.endPos}(${result.gene.strand})`)}`,
    `CDS parts, 5' to 3': ${selectedCdsLocation(result) || 'unavailable'}`,
    'Parts use 1-based inclusive genome coordinates after codon_start; joined gaps are excluded.',
    `codon_start: ${result.codonStart || 'unsupported'}; translation table: ${result.geneticCode || 'unsupported'}${result.gene.qualifiers?.transl_table === undefined ? ' (default 1)' : ' (annotation)'}`,
    `CDS DNA: ${result.cds === null ? 'unavailable' : result.cds.length + ' bp'}; protein: ${result.protein === null ? 'unavailable' : result.protein.length + ' symbols'}`,
    ...(result.translationReasons.length ? ['Translation unavailable:', ...result.translationReasons] : [
      'Translation follows the annotation and genetic code; expression and function are not measured.',
      ...(result.protein?.endsWith('*') ? ['Terminal * is the stop codon and is retained in FASTA.'] : []),
    ]),
  ], width);
}

interface PreparedCds { source: SelectedCdsSource; gene: GeneInfo; result: SelectedCdsResult | null; error: string | null }
export function SelectedCdsView({ source, isCurrentSource, onClose, prepare = prepareSelectedCds }: {
  source: SelectedCdsSource | null;
  isCurrentSource: (source: SelectedCdsSource) => boolean;
  onClose: () => void;
  prepare?: typeof prepareSelectedCds;
}): React.ReactElement {
  const { stdout } = useStdout();
  const colors = usePhageStore(state => state.currentTheme.colors);
  const selectedGeneId = usePhageStore(state => state.selectedGeneId);
  const scrollPosition = usePhageStore(state => state.scrollPosition);
  const viewMode = usePhageStore(state => state.viewMode);
  const genes = useMemo(() => source?.phage.genes.filter(gene => gene.type?.toUpperCase() === 'CDS') ?? [], [source]);
  const selected = genes.findIndex(gene => gene.id === selectedGeneId);
  const basePosition = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
  const near = genes.findIndex(gene => getGeneMapSegments(gene).some(part => part.start <= basePosition && basePosition < part.end));
  const index = selected >= 0 ? selected : near >= 0 ? near : 0;
  const gene = genes[index] ?? null;
  const [prepared, setPrepared] = useState<PreparedCds | null>(null);
  const [tab, setTab] = useState(0), [line, setLine] = useState(0), [retry, setRetry] = useState(0);
  const [kind, setKind] = useState<SelectedCdsExportKind | null>(null), [path, setPath] = useState('');
  const [notice, setNotice] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [size, setSize] = useState(() => readTerminalSize(stdout));
  const operation = useRef<AbortController | null>(null);
  const current = useRef({ source, gene, prepared, isCurrentSource });
  current.current = { source, gene, prepared, isCurrentSource };
  const sourceAvailable = source !== null && isCurrentSource(source);
  const owned = sourceAvailable && prepared?.source === source && prepared.gene === gene ? prepared : null;
  const result = owned?.result ?? null;
  const owns = (accepted: SelectedCdsSource, feature: GeneInfo, value?: SelectedCdsResult) => {
    const live = current.current;
    return live.source === accepted && live.gene === feature && live.isCurrentSource(accepted)
      && (value === undefined || live.prepared?.source === accepted && live.prepared.gene === feature && live.prepared.result === value);
  };

  useEffect(() => {
    const resize = () => setSize(readTerminalSize(stdout));
    stdout.on?.('resize', resize);
    return () => { stdout.off?.('resize', resize); };
  }, [stdout]);
  useLayoutEffect(() => {
    let cancelled = false;
    operation.current?.abort(); operation.current = null;
    setKind(null); setPath(''); setNotice(null); setSaving(false); setLine(0);
    setPrepared(null);
    if (source && gene && isCurrentSource(source)) {
      usePhageStore.getState().setSelectedGeneId(gene.id);
      void (async () => {
        try {
          const value = await prepare(source, gene);
          if (!cancelled && owns(source, gene)) setPrepared({ source, gene, result: value, error: null });
        } catch (cause) {
          if (!cancelled && owns(source, gene)) setPrepared({ source, gene, result: null,
            error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
        }
      })();
    }
    return () => { cancelled = true; operation.current?.abort(); operation.current = null; };
  }, [source, gene, prepare, isCurrentSource, retry]);

  const width = Math.max(20, (size.columns ?? 80) - 4), pageSize = Math.max(1, (size.rows ?? 24) - 13);
  const lines = useMemo(() => result ? resultLines(result, tab, width) : [], [result, tab, width]);
  const start = Math.max(0, Math.min(line, Math.max(0, lines.length - pageSize)));
  const payload = result && kind ? selectedCdsExport(result, kind) : null;
  const submit = async () => {
    if (!source || !gene || !result || !payload || operation.current || !owns(source, gene, result)) return;
    const controller = new AbortController(); operation.current = controller;
    setSaving(true); setNotice(null);
    try {
      await saveSelectedCdsExport(path, payload, controller.signal,
        () => operation.current === controller && owns(source, gene, result));
      if (operation.current === controller && owns(source, gene, result)) {
        setNotice(`Saved complete ${kind === 'json' ? 'CDS record' : kind === 'cds' ? 'CDS FASTA' : 'protein FASTA'}: ${terminalGenomeLabel(path)}`);
        setKind(null); setPath('');
      }
    } catch (cause) {
      if (operation.current === controller && owns(source, gene, result)) setNotice(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      if (operation.current === controller) { operation.current = null; setSaving(false); }
    }
  };
  useInput((input, key) => {
    if (operation.current) {
      if (key.escape) {
        operation.current.abort(); operation.current = null; setSaving(false); setKind(null);
        setNotice('Export cancelled. A partial new file may remain; existing files were not overwritten.');
      }
      return;
    }
    if (kind) { if (key.escape) { setKind(null); setPath(''); setNotice(null); } return; }
    if (key.escape || input === 'q') { onClose(); return; }
    if (!source || !gene || !owns(source, gene)) return;
    if (key.leftArrow || key.rightArrow) {
      const next = Math.max(0, Math.min(genes.length - 1, index + (key.rightArrow ? 1 : -1)));
      usePhageStore.getState().setSelectedGeneId(genes[next].id); return;
    }
    if (input === 'g') {
      usePhageStore.getState().setScrollPosition(genePositionToScroll(gene.startPos, viewMode)); onClose(); return;
    }
    if (input === 'r' && owned?.error) { setRetry(value => value + 1); return; }
    if (key.tab) { setTab(value => (value + (key.shift ? tabs.length - 1 : 1)) % tabs.length); setLine(0); return; }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -pageSize : key.pageDown ? pageSize : key.upArrow ? -1 : 1;
      setLine(Math.max(0, Math.min(Math.max(0, lines.length - pageSize), start + delta))); return;
    }
    const nextKind = input === 'd' ? 'cds' : input === 'p' ? 'protein' : input === 'j' ? 'json' : null;
    if (nextKind && result) {
      if (!selectedCdsExport(result, nextKind)) { setNotice(nextKind === 'protein' ? 'Protein export unavailable. See Summary for the annotation limits.' : 'CDS DNA export unavailable. See Summary for the location limits.'); return; }
      setKind(nextKind); setPath(''); setNotice(null);
    }
  });

  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderLight} paddingX={1}>
    <Text bold color={colors.accent}>SELECTED CDS — SEQUENCE AND EXPORT</Text>
    <Text wrap="truncate-end">{sourceAvailable ? `${terminalGenomeLabel(source.phage.name)} · ${terminalGenomeLabel(source.phage.accession)} · ${source.phage.localGenome ? 'private local genome' : 'catalog genome'}` : 'Waiting for the complete accepted genome selection.'}</Text>
    {!sourceAvailable || !gene ? <>
      <Text>{sourceAvailable ? 'No annotated CDS is available. No protein has been inferred.' : 'Inspection and exports are unavailable while the selected genome changes.'}</Text>
      <Text>Use the command palette to import an annotated GenBank file.</Text>
      <Text color={colors.textDim}>Esc returns to the explorer.</Text>
    </> : <>
      <Text wrap="truncate-end" bold>CDS {index + 1}/{genes.length}: {terminalGenomeLabel(gene.locusTag || gene.name || `gene-${gene.id}`)} · strand {gene.strand ?? '?'}</Text>
      {saving ? <>
        <Text>Saving the complete accepted CDS export…</Text>
        <Text>Esc cancels; an interrupted write can leave a partial new file.</Text>
      </> : kind && payload ? <>
        <Text bold>New {kind === 'json' ? 'CDS JSON' : kind === 'cds' ? 'CDS FASTA' : 'protein FASTA'} destination:</Text>
        <TextInput value={path} onChange={value => { if (value.length <= 4096) setPath(value); }} onSubmit={() => void submit()} placeholder={payload.filename} />
        <Text color={colors.textDim}>Literal path; ~/ is supported. Enter saves; Esc cancels this form.</Text>
        <Text color={colors.textDim}>Exports include the complete sequence. Existing files are never overwritten.</Text>
      </> : !result ? <>
        <Text>{owned?.error ?? 'Preparing the exact selected CDS…'}</Text>
        {owned?.error && <Text>[R] Retry inspection</Text>}
        <Text color={colors.textDim}>Left/Right selects another CDS · Esc cancels and returns</Text>
      </> : <>
        <Text color={colors.accent}>{tabs.map((label, position) => position === tab ? `[${label}]` : label).join(' · ')}</Text>
        <Box flexDirection="column" height={pageSize}>
          {lines.slice(start, start + pageSize).map((text, offset) => <Text key={start + offset} wrap="truncate-end">{text || ' '}</Text>)}
        </Box>
        <Text color={colors.textDim}>Lines {lines.length ? start + 1 : 0}–{Math.min(start + pageSize, lines.length)} of {lines.length} · all sequence content is available by scrolling</Text>
        <Text>Left/Right: CDS · Tab: section · Up/Down or PgUp/PgDn: scroll</Text>
        <Text>[D] CDS FASTA · [P] protein FASTA · [J] complete JSON record</Text>
        <Text>[G] Go to this CDS · [Esc] Return · Exports preserve complete sequences.</Text>
      </>}
      {notice && <Text wrap="truncate-end" color={colors.accent}>{notice}</Text>}
    </>}
  </Box>;
}
