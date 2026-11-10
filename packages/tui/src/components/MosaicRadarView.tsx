import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { open } from 'node:fs/promises';
import { usePhageStore } from '@phage-explorer/state';
import { parseAnalysisRecord, serializeAnalysisRecord, serializeMosaicDataset, resolveMosaicRadarConfig,
  mosaicResultFromRecord, exportMosaicTsv, type AnalysisRecord, type MosaicDataset, type MosaicRadarResult } from '@phage-explorer/core';
import { runTerminalResearchWorker } from '../../../../scripts/research-workflow';

interface MosaicRadarViewProps {
  dataset: MosaicDataset | null;
}

export function MosaicRadarView({ dataset }: MosaicRadarViewProps): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const terminalCols = usePhageStore(s => s.terminalCols);

  const [k, setK] = useState(5);
  const [windowSize, setWindowSize] = useState(2000);
  const [minSim, setMinSim] = useState(0.05);
  const [showBreakpoints, setShowBreakpoints] = useState(true);
  const options = useMemo(() => resolveMosaicRadarConfig({ k, window: windowSize,
    step: Math.floor(windowSize / 2), minSimilarity: minSim }), [k, windowSize, minSim]);
  const [snapshot, setSnapshot] = useState<{ dataset: MosaicDataset; options: typeof options;
    record: AnalysisRecord; result: MosaicRadarResult } | null>(null);
  const accepted = snapshot?.dataset === dataset && snapshot.options === options ? snapshot : null;
  const result = accepted?.result ?? null;
  const [failure, setFailure] = useState<{ dataset: MosaicDataset; options: typeof options; message: string } | null>(null);
  const error = failure?.dataset === dataset && failure.options === options ? failure.message : null;
  const [exportMode, setExportMode] = useState<'json' | 'tsv' | null>(null);
  const [exportPath, setExportPath] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setSnapshot(null); setFailure(null); setExportMode(null); setExportPath(''); setExportNotice(''); setExporting(false);
    if (!dataset) return () => { generation.current++; };
    const controller = new AbortController();
    void (async () => {
      try {
        const reply = await runTerminalResearchWorker({ type: 'analyze-mosaic', content: serializeMosaicDataset(dataset), options }, controller.signal);
        if (reply.type !== 'mosaic-analyzed') throw new Error('Unexpected mosaic result.');
        const record = await parseAnalysisRecord(reply.recordJson);
        if (!controller.signal.aborted) setSnapshot({ dataset, options, record, result: mosaicResultFromRecord(record) });
      } catch (cause) {
        if (!controller.signal.aborted) setFailure({ dataset, options, message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
    return () => { generation.current++; controller.abort(); };
  }, [dataset, options]);

  const save = async (path: string) => {
    if (!accepted || !exportMode || exporting) return;
    if (!path.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(path)) { setExportNotice('Enter a new regular file path without control characters.'); return; }
    // Snapshot the accepted record before disk IO. Later navigation cannot relabel this export.
    const text = exportMode === 'json' ? serializeAnalysisRecord(accepted.record) : exportMosaicTsv(accepted.record);
    const owner = generation.current;
    setExporting(true); setExportNotice('');
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
      if (generation.current === owner) { setExportMode(null); setExportPath(''); setExportNotice(`Saved ${exportMode.toUpperCase()} to ${path}.`); }
    } catch (cause) { if (generation.current === owner) setExportNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === owner) setExporting(false); }
  };

  useInput((input, key) => {
    if (exportMode) {
      if (key.escape && !exporting) { setExportMode(null); setExportPath(''); }
      return;
    }
    if (key.escape) {
      closeOverlay('mosaicRadar');
      return;
    }
    if (input === '+' || input === '=') {
      setWindowSize(w => Math.min(10000, Math.round(w * 1.25)));
    } else if (input === '-' || input === '_') {
      setWindowSize(w => Math.max(500, Math.round(w / 1.25)));
    }
    if (input === '[') setK(v => Math.max(3, v - 1));
    if (input === ']') setK(v => Math.min(16, v + 1));
    if (input === 'b' || input === 'B') setShowBreakpoints(v => !v);
    if (input === 'm') setMinSim(s => Math.max(0.01, +(s - 0.02).toFixed(2)));
    if (input === 'M') setMinSim(s => Math.min(0.95, +(s + 0.02).toFixed(2)));
    if (accepted && (input === 'e' || input === 't')) {
      setExportMode(input === 'e' ? 'json' : 'tsv'); setExportNotice('');
    }
  });

  const donors = useMemo(() => {
    const unique = new Set<string>();
    for (const seg of result?.segments ?? []) {
      if (seg.donor) unique.add(seg.donor);
    }
    return Array.from(unique);
  }, [result]);

  const donorColor = useMemo(() => {
    const palette = [colors.accent, colors.info, colors.warning, colors.success, colors.secondary, colors.primary];
    const map = new Map<string, string>();
    donors.forEach((d, i) => map.set(d, palette[i % palette.length]));
    return map;
  }, [donors, colors]);

  const barWidth = Math.max(20, terminalCols - 8);
  const genomeLen = dataset?.query.sequence.length ?? 0;

  const barCells = useMemo(() => {
    const cells: Array<{ char: string; color: string }> = [];
    let segIdx = 0;
    for (let i = 0; i < barWidth; i++) {
      const pos = Math.floor((i / barWidth) * genomeLen);
      while (result && segIdx < result.segments.length - 1 && pos >= result.segments[segIdx].end) segIdx++;
      const seg = result?.segments[segIdx];
      const color = seg?.donor ? (donorColor.get(seg.donor) ?? colors.textDim) : colors.textMuted;
      cells.push({ char: '█', color });
    }
    return cells;
  }, [barWidth, genomeLen, result, donorColor, colors.textDim, colors.textMuted]);

  const breakpointLine = useMemo(() => {
    if (!showBreakpoints) return null;
    const marks = new Array(barWidth).fill(' ');
    for (const bp of result?.breakpoints ?? []) {
      const idx = Math.floor((bp / genomeLen) * barWidth);
      if (idx >= 0 && idx < marks.length) marks[idx] = '|';
    }
    return marks.join('');
  }, [showBreakpoints, result, genomeLen, barWidth]);

  const donorStats = useMemo(() => {
    const stats: Array<{ donor: string; coverage: number; mean: number }> = [];
    for (const d of donors) {
      const segs = result?.segments.filter(s => s.donor === d) ?? [];
      const cov = segs.reduce((a, s) => a + (s.end - s.start), 0);
      const mean = segs.reduce((a, s) => a + s.meanScore * (s.end - s.start), 0) / Math.max(1, cov);
      stats.push({ donor: d, coverage: cov / genomeLen, mean });
    }
    stats.sort((a, b) => b.coverage - a.coverage);
    return stats;
  }, [donors, result, genomeLen]);

  // Keep hook order stable when a changed genome/reference panel is empty.
  if (!result) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} padding={1}>
        <Text color={colors.textDim}>
          {error ?? (!dataset ? 'Waiting for the selected query and reference snapshot.' : 'Computing reference similarity in an isolated worker…')}
        </Text>
        <Text color={colors.textDim}>Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} paddingY={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.primary} bold>🧬 Mosaic / Reference Similarity</Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>

      <Text color={colors.textDim}>
        k={k} · window={result.window}bp · minSim={minSim} · [+/-] window ±25% · [[/]] k · [b] reference switches {showBreakpoints ? 'on' : 'off'} · [m/M] minSim ±0.02
      </Text>
      <Text color={colors.textDim}>[e] Export replayable JSON · [t] Export window TSV · exact source ranges and exclusions retained</Text>
      {exportMode && <Box flexDirection="column">
        <Text>New {exportMode.toUpperCase()} file path (existing files are never replaced; Esc cancels):</Text>
        <TextInput value={exportPath} onChange={setExportPath} onSubmit={path => { void save(path); }} focus={!exporting} />
      </Box>}
      {!!exportNotice && <Text color={colors.info}>{exportNotice}</Text>}
      {result.windows.length === 0 && <Text color={colors.textDim}>No comparable windows: supply usable references and at least k query bases.</Text>}

      <Box marginTop={1} flexDirection="column">
        <Text>
          {barCells.map((c, i) => (
            <Text key={i} color={c.color}>{c.char}</Text>
          ))}
        </Text>
        {breakpointLine && (
          <Text color={colors.textMuted}>{breakpointLine}</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.textDim} bold>Unique closest references:</Text>
        {donorStats.length === 0 && (
          <Text color={colors.textMuted}>No unique reference assignments at current minSim.</Text>
        )}
        {donorStats.map((s, idx) => (
          <Text key={idx} color={donorColor.get(s.donor) ?? colors.text}>
            {s.donor} · {(s.coverage * 100).toFixed(1)}% of display partition · mean J={s.mean.toFixed(2)}
          </Text>
        ))}
        {result.breakpoints.length > 0 && (
          <Box marginTop={1}>
            <Text color={colors.textDim}>
              Reference switches between sampled centers: {result.referenceSwitches.map(change =>
                `${change.from} → ${change.to}: ${change.start.toLocaleString()}–${change.end.toLocaleString()} bp`
              ).join('; ')}
            </Text>
          </Box>
        )}
        <Text color={colors.textMuted}>
          Unresolved: {result.coverage.ambiguous.toLocaleString()} bp tied · {result.coverage['below-threshold'].toLocaleString()} bp below threshold · {result.coverage['no-evidence'].toLocaleString()} bp without comparable k-mers
        </Text>
        <Text color={colors.textDim}>
          {result.referencePanel.usable}/{result.referencePanel.selected} selected references have valid k-mers; {result.referencePanel.omitted} omitted by the panel limit.
        </Text>
        <Text color={colors.textDim}>
          {dataset!.excludedReferences.length} additional references excluded; {dataset!.references.filter(reference => reference.sourceStart !== 0 || reference.sequence.length !== reference.sourceLength).length} supplied references cover only a source interval.
        </Text>
        <Text color={colors.textDim}>
          Canonical k-mer similarity is strand independent. Colors partition sampled windows, not aligned bases. Switches do not establish donors or recombination breakpoints.
        </Text>
        <Text color={colors.textDim}>Small k can tie many long references; [[/]] selects k from 3 to 16.</Text>
      </Box>
    </Box>
  );
}

export default MosaicRadarView;
