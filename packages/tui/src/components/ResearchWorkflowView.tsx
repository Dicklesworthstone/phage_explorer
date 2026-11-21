import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson } from '../../../core/src/analysis-result';
import { resolveExactRepeatOptions } from '../../../core/src/analysis/exact-repeat-pairs';
import { resolveRestrictionDigestOptions } from '../../../core/src/analysis/restriction-digest';
import { DEFAULT_AFFINE_PENALTIES, type AlignmentGraphOptions } from '../../../core/src/analysis/alignment-pangenome';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import { researchPangenomeParameters, type ResearchView, type ResearchPangenomeParameters } from '../../../web/src/keyboard/ResearchWorkflow';
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
  { kind: 'pangenome', id: ActionIds.OverlayPangenomeGraph, label: 'Multi-genome pangenome + reference CDS consequences' },
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
    case 'pangenome': return []; // The multi-source editor owns these settings.
  }
}
function integer(value: string, label: string, signed = false): number {
  if (!(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(label + ' must be an explicit whole number.');
  }
  return Number(value);
}

const graphAlignments = [
  { value: 'wavefront', label: 'Exact unit-edit wavefront alignment' },
  { value: 'affine', label: 'Exact affine-gap alignment with explicit penalties' },
  { value: 'global', label: 'Global locus alignment (bounded dynamic programming)' },
  { value: 'provided', label: 'Use input columns unchanged (equal lengths required)' },
] as const;

/** Compose the existing multi-genome command without copying sequences into
 * form state. The captured bundle is the only sequence/annotation source.
 */
function PangenomeStepEditor({ draft, initial, rows, onSave, onCancel }: {
  draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const prior = initial?.actionId === ActionIds.OverlayPangenomeGraph
    ? initial.parameters as unknown as ResearchPangenomeParameters : null;
  const [stage, setStage] = useState<'reference' | 'members' | 'annotation' | 'cds' | 'alignment' | 'settings'>('reference');
  const [referenceIndex, setReferenceIndex] = useState(Math.max(0,
    draft.sources.findIndex(source => `local-${source.contentId}` === prior?.options.referenceId)));
  const [members, setMembers] = useState<string[]>(prior ? [...prior.contentIds] : []);
  const [memberIndex, setMemberIndex] = useState(0);
  const [annotationId, setAnnotationId] = useState<string | null>(prior?.annotation?.contentId ?? null);
  const [annotationIndex, setAnnotationIndex] = useState(0);
  const [geneIds, setGeneIds] = useState<number[] | null>(prior?.annotation?.geneIds ? [...prior.annotation.geneIds] : null);
  const [geneIndex, setGeneIndex] = useState(0);
  const [alignmentIndex, setAlignmentIndex] = useState(Math.max(0, graphAlignments.findIndex(mode => mode.value === prior?.options.alignment)));
  const [settings, setSettings] = useState<Setting[]>([]), [values, setValues] = useState<Record<string, string>>({});
  const [settingIndex, setSettingIndex] = useState(0), [error, setError] = useState<string | null>(null);
  const reference = draft.sources[referenceIndex], alignment = graphAlignments[alignmentIndex].value;
  const annotations = draft.sources.filter(source => source.format === 'genbank'
    && source.sequenceSha256 === reference.sequenceSha256 && source.bases === reference.bases);
  const annotation = annotations.find(source => source.contentId === annotationId);
  const genes = annotation?.genes.filter(gene => gene.type === 'CDS') ?? [];
  const label = (source: TerminalResearchDraftSource) => terminalGenomeLabel(`${source.name} · ${source.accession}`)
    + ` · ${source.bases} bp · ${source.topology}`;
  const choices = stage === 'reference' ? draft.sources.map(label)
    : stage === 'members' ? draft.sources.map(source => `${members.includes(source.contentId) ? '[x]' : '[ ]'} ${label(source)}${source === reference ? ' · REFERENCE' : ''}`)
      : stage === 'annotation' ? ['No coding consequences', ...annotations.map(label)]
        : stage === 'cds' ? [`${geneIds === null ? '[x]' : '[ ]'} All captured CDS`, ...genes.map(gene =>
          `${geneIds?.includes(gene.id) ? '[x]' : '[ ]'} ${terminalGenomeLabel(gene.name || gene.locusTag || 'CDS')} · feature ${gene.id} · ${gene.startPos + 1}–${gene.endPos}`)]
          : graphAlignments.map(mode => mode.label);
  const cursor = stage === 'reference' ? referenceIndex : stage === 'members' ? memberIndex
    : stage === 'annotation' ? annotationIndex : stage === 'cds' ? geneIndex : alignmentIndex;
  const pageSize = Math.max(1, Math.min(8, rows - 18)), start = Math.floor(cursor / pageSize) * pageSize;
  const beginSettings = () => {
    const options = prior?.options;
    const next: Setting[] = [{ key: 'terminalGaps', label: 'Terminal gaps (missing or alleles)', initial: options?.terminalGaps ?? 'missing' }];
    if (alignment === 'wavefront' || alignment === 'affine') next.push({ key: 'normalization',
      label: 'Input normalization (none, strand, circular)', initial: options?.normalization ?? 'none' });
    if (alignment === 'affine') {
      const penalties = options?.affinePenalties ?? DEFAULT_AFFINE_PENALTIES;
      next.push({ key: 'mismatch', label: 'Mismatch penalty (1–64)', initial: String(penalties.mismatch) },
        { key: 'gapOpen', label: 'Gap-opening penalty (0–64)', initial: String(penalties.gapOpen) },
        { key: 'gapExtend', label: 'Gap-extension penalty per base (1–64)', initial: String(penalties.gapExtend) });
    }
    setSettings(next); setValues(Object.fromEntries(next.map(field => [field.key, field.initial])));
    setSettingIndex(0); setStage('settings');
  };
  const save = (entered: Record<string, string>) => {
    if (entered.terminalGaps !== 'missing' && entered.terminalGaps !== 'alleles') throw new Error('Choose missing or alleles for terminal gaps.');
    const normalization = entered.normalization ?? 'none';
    if (!['none', 'strand', 'circular'].includes(normalization)) throw new Error('Choose none, strand or circular normalization.');
    const options: AlignmentGraphOptions = { referenceId: `local-${reference.contentId}`, alignment,
      terminalGaps: entered.terminalGaps, ...(normalization === 'none' ? {} : { normalization: normalization as 'strand' | 'circular' }),
      ...(alignment === 'affine' ? { affinePenalties: { mismatch: integer(entered.mismatch, 'Mismatch penalty'),
        gapOpen: integer(entered.gapOpen, 'Gap-opening penalty'), gapExtend: integer(entered.gapExtend, 'Gap-extension penalty') } } : {}) };
    const parameters = researchPangenomeParameters(members, options, annotationId ? { contentId: annotationId, geneIds } : null);
    onSave({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(parameters) });
  };
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (stage === 'settings') {
      if (key.shift && key.tab) { setSettingIndex(index => Math.max(0, index - 1)); setError(null); }
      return;
    }
    if (input === ' ' && stage === 'members') {
      const id = draft.sources[memberIndex].contentId;
      if (id === reference.contentId) { setError('The selected reference stays in the comparison.'); return; }
      setError(null);
      setMembers(before => before.includes(id) ? before.filter(value => value !== id) : [...before, id]);
      return;
    }
    if (input === ' ' && stage === 'cds') {
      setError(null);
      if (!geneIndex) setGeneIds(null);
      else {
        const id = genes[geneIndex - 1].id;
        setGeneIds(before => before === null ? [id] : before.includes(id) ? before.filter(value => value !== id) : [...before, id]);
      }
      return;
    }
    if (key.return) {
      try {
        setError(null);
        if (stage === 'reference') {
          setMembers(before => before.includes(reference.contentId) ? before : [...before, reference.contentId]);
          setMemberIndex(referenceIndex); setStage('members');
        } else if (stage === 'members') {
          if (members.length < 2 || members.length > 24) throw new Error('Select 2–24 distinct captured genomes, including the reference.');
          setAnnotationIndex(Math.max(0, annotations.findIndex(source => source.contentId === annotationId) + 1));
          setStage('annotation');
        } else if (stage === 'annotation') {
          const chosen = annotationIndex ? annotations[annotationIndex - 1] : null;
          setAnnotationId(chosen?.contentId ?? null);
          if (!chosen) { setGeneIds(null); setStage('alignment'); }
          else {
            if (!chosen.genes.some(gene => gene.type === 'CDS')) throw new Error('This reference annotation has no captured CDS. Choose no coding consequences.');
            if (chosen.contentId !== prior?.annotation?.contentId) setGeneIds(null);
            setGeneIndex(0); setStage('cds');
          }
        } else if (stage === 'cds') {
          if (geneIds?.length === 0) throw new Error('Select at least one captured CDS or choose all CDS.');
          setStage('alignment');
        } else beginSettings();
      } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
      return;
    }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? pageSize : key.leftArrow ? -pageSize : 0;
    if (!delta) return;
    const next = Math.max(0, Math.min(cursor + delta, choices.length - 1));
    if (stage === 'reference') setReferenceIndex(next);
    else if (stage === 'members') setMemberIndex(next);
    else if (stage === 'annotation') setAnnotationIndex(next);
    else if (stage === 'cds') setGeneIndex(next);
    else setAlignmentIndex(next);
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
    <Text bold>Multi-genome pangenome and coding consequences</Text>
    <Text wrap="truncate-end">Reference: {terminalGenomeLabel(reference.name)} · {members.length} selected genomes</Text>
    {error && <Text wrap="truncate-end" color={colors.accent}>{error}</Text>}
    {stage === 'settings' && field ? <>
      <Text wrap="truncate-end">{graphAlignments[alignmentIndex].label} · setting {settingIndex + 1}/{settings.length}</Text>
      <Text>{field.label}</Text>
      <TextInput key={field.key} value={values[field.key]} onChange={value => { if (value.length <= 256) setValues(before => ({ ...before, [field.key]: value })); }} onSubmit={submitSetting} />
      {field.key === 'terminalGaps' && <Text color={colors.textDim}>Missing ends are excluded; alleles treats terminal differences as biological variants.</Text>}
      {field.key === 'normalization' && <Text color={colors.textDim}>Circular asserts every selected sequence is a complete circle; linear annotations are refused.</Text>}
      <Text color={colors.textDim}>Enter accepts · Shift+Tab edits the previous value · Esc discards</Text>
    </> : <>
      <Text bold>{stage === 'reference' ? 'Choose the captured reference genome'
        : stage === 'members' ? 'Choose comparison genomes (Space toggles)'
          : stage === 'annotation' ? 'Choose exact-reference GenBank annotations'
            : stage === 'cds' ? 'Choose reference CDS (Space selects a subset)' : 'Choose the alignment method'}</Text>
      {choices.slice(start, start + pageSize).map((text, offset) => <Text key={start + offset} wrap="truncate-end" color={start + offset === cursor ? colors.accent : colors.text}>
        {start + offset === cursor ? '›' : ' '} {start + offset + 1}. {text}
      </Text>)}
      {stage === 'annotation' && <Text color={colors.textDim}>Only captured GenBank records with identical reference bases and origin are offered.</Text>}
      {stage === 'cds' && <Text color={colors.textDim}>Space on a CDS starts/toggles a subset; Space on All restores the full CDS selection.</Text>}
      <Text color={colors.textDim}>Up/Down select · Left/Right page · Enter continues · Esc discards</Text>
    </>}
    <Text color={colors.textDim}>Drafting runs no analyses. Genomes and original annotations remain in the private input bundle.</Text>
  </Box>;
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
    if (action.kind === 'pangenome' && stage !== 'method') return;
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
  if (action.kind === 'pangenome' && stage !== 'method') return <PangenomeStepEditor
    draft={draft} initial={initial} rows={rows} onSave={onSave} onCancel={onCancel} />;
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
          const graph = step.actionId === ActionIds.OverlayPangenomeGraph ? step.parameters as unknown as ResearchPangenomeParameters : null;
          const source = draft.sources.find(item => graph ? `local-${item.contentId}` === graph.options.referenceId
            : item.contentId === (step.parameters as Record<string, unknown>).contentId);
          return <Text key={start + offset} wrap="truncate-end" color={start + offset === selected ? colors.accent : colors.text}>
            {start + offset === selected ? '›' : ' '} {start + offset + 1}. {editorActions.find(action => action.id === step.actionId)?.label ?? step.actionId} · {graph ? `${graph.contentIds.length} genomes; reference ` : ''}{terminalGenomeLabel(source?.name ?? 'missing source')}
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
