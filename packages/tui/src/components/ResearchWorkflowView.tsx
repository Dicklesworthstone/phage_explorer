import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { analysisJson } from '../../../core/src/analysis-result';
import { resolveExactRepeatOptions } from '../../../core/src/analysis/exact-repeat-pairs';
import { resolveRestrictionDigestOptions } from '../../../core/src/analysis/restriction-digest';
import { DEFAULT_AFFINE_PENALTIES, type AlignmentGraphOptions } from '../../../core/src/analysis/alignment-pangenome';
import type { PhylogenyOptions } from '../../../core/src/analysis/aligned-phylogeny';
import { parseRNAInterval } from '../../../core/src/analysis/rna-structure-experiment';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import { researchPangenomeParameters, researchPhylogenyParameters, researchRNAParameters, researchMosaicParameters, researchComparisonParameters, researchSyntenyParameters,
  type ResearchView, type ResearchPangenomeParameters, type ResearchPhylogenyParameters, type ResearchMosaicParameters } from '../../../web/src/keyboard/ResearchWorkflow';
import { terminalGenomeLabel, terminalGenomePath, type TerminalGenomeSession } from '../local-genome-session';
import type { TerminalResearchSession, TerminalResearchDraft, TerminalResearchDraftSource, TerminalResearchStep, TerminalResearchRNASource } from '../terminal-research-session';
import { readTerminalSize } from './terminal-size';
import { ReferenceStepEditor } from './ReferenceStepEditor';
import { DEFAULT_GENOME_COMPARISON_OPTIONS } from '../../../comparison/src/comparison-experiment';

const editorActions = [
  { kind: 'view', id: ActionIds.NavGoto, label: 'Saved genome / CDS view' },
  { kind: 'gc-skew', id: ActionIds.OverlayGCSkew, label: 'GC-skew windows and cumulative counts' },
  { kind: 'repeats', id: ActionIds.OverlayRepeats, label: 'Exact repeat pairs' },
  { kind: 'codons', id: ActionIds.OverlayCodonAdaptation, label: 'CDS statistics + illustrative host model' },
  { kind: 'digest', id: ActionIds.OverlayGel, label: 'Restriction digest' },
  { kind: 'dot-plot', id: ActionIds.OverlayDotPlot, label: 'Self or ordered pairwise dot plot' },
  { kind: 'pangenome', id: ActionIds.OverlayPangenomeGraph, label: 'Multi-genome pangenome + reference CDS consequences' },
  { kind: 'rna', id: ActionIds.OverlayRNAStructure, label: 'RNA pairing in an exact genome or CDS interval' },
  { kind: 'mosaic', id: ActionIds.OverlayMosaicRadar, label: 'Mosaic reference similarity across captured genomes' },
  { kind: 'reference-codons', id: ActionIds.OverlayCodonAdaptation, label: 'CDS statistics + captured reference CAI' },
  { kind: 'spacers', id: ActionIds.OverlayCRISPR, label: 'Sourced CRISPR spacer matches with explicit PAM and seed rules' },
  { kind: 'phylogeny', id: ActionIds.OverlayPhylodynamics, label: 'Pangenome-backed phylogeny with explicit homology provenance' },
  { kind: 'comparison', id: ActionIds.OverlayComparison, label: 'Complete ordered genome comparison with captured annotations' },
  { kind: 'synteny', id: ActionIds.OverlaySynteny, label: 'Annotation-order synteny between captured genomes' },
] as const;
type EditorKind = (typeof editorActions)[number]['kind'];
interface Setting { key: string; label: string; initial: string }
function stepSettings(kind: EditorKind, source: TerminalResearchDraftSource, initial: Record<string, unknown>, view: ResearchView | null,
  rna?: TerminalResearchRNASource & { coding: boolean }): Setting[] {
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
    case 'codons': case 'synteny': return [];
    case 'digest': return [{ key: 'enzymes', label: 'Enzymes (exact names separated by commas; none for uncut control)',
      initial: Array.isArray(initial.enzymes) ? initial.enzymes.join(',') || 'none' : 'EcoRI,BamHI' },
      field('topology', 'Molecule topology (linear or circular; explicit assumption if unknown)', source.topology === 'circular' ? 'circular' : 'linear')];
    case 'dot-plot': return [field('bins', 'Display bins (1–256)', 64), field('window', 'Comparison window (bases; must fit both inputs)', Math.min(20, source.bases))];
    case 'comparison': {
      const options = initial.options as Record<string, unknown> | undefined;
      const defaults = DEFAULT_GENOME_COMPARISON_OPTIONS;
      return [{ key: 'kmerSizes', label: 'Distinct k-mer sizes (comma-separated, 1–31)',
        initial: Array.isArray(options?.kmerSizes) ? options.kmerSizes.join(',') : defaults.kmerSizes.join(',') },
      { key: 'maxEditDistanceLength', label: 'Exact edit-distance limit (0–10000 bases)', initial: String(options?.maxEditDistanceLength ?? defaults.maxEditDistanceLength) },
      { key: 'editDistanceWindowSize', label: 'Sampled edit window (1–2000 bases)', initial: String(options?.editDistanceWindowSize ?? defaults.editDistanceWindowSize) },
      { key: 'editDistanceWindowCount', label: 'Sampled edit window count (1–100)', initial: String(options?.editDistanceWindowCount ?? defaults.editDistanceWindowCount) }];
    }
    case 'pangenome': case 'phylogeny': case 'mosaic': case 'reference-codons': case 'spacers': return []; // Dedicated editors own these settings.
    case 'rna': {
      if (!rna) throw new Error('Choose a supported RNA source first.');
      const options = initial.options as Record<string, unknown> | undefined;
      const length = Math.min(rna.bases, 600);
      return [{ key: 'start', label: 'RNA start (1-based, inclusive)', initial: String(Number(initial.start ?? 0) + 1) },
        field('end', 'RNA end (inclusive; at most 6000 selected bases)', length),
        ...(rna.coding ? [] : [field('strand', 'RNA strand (+ or - within the forward-genome interval)', '+')]),
        { key: 'windowSize', label: 'RNA window (1–240 bases)', initial: String(options?.windowSize ?? Math.min(rna.coding ? 60 : 120, length)) },
        { key: 'stepSize', label: 'RNA step (1–6000 bases)', initial: String(options?.stepSize ?? Math.min(rna.coding ? 15 : 30, length)) },
        { key: 'minLoopSize', label: 'Minimum intervening loop (0–30 bases)', initial: String(options?.minLoopSize ?? 3) },
        { key: 'allowWobble', label: 'Allow GU wobble pairs (yes or no)', initial: options?.allowWobble === false ? 'no' : 'yes' },
        ...(rna.synonymousSupported ? [{ key: 'includeSynonymousStress', label: 'Include descriptive synonymous pairing-score differences (yes or no)',
          initial: options?.includeSynonymousStress === true ? 'yes' : 'no' }] : [])];
    }
  }
}
function integer(value: string, label: string, signed = false): number {
  if (!(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(label + ' must be an explicit whole number.');
  }
  return Number(value);
}
function yesNo(value: string, label: string): boolean {
  if (value !== 'yes' && value !== 'no') throw new Error(label + ' must be yes or no.');
  return value === 'yes';
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
function PangenomeStepEditor({ draft, initial, rows, phylogeny = false, onSave, onCancel }: {
  draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  phylogeny?: boolean;
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const priorTree = initial?.actionId === ActionIds.OverlayPhylodynamics
    ? initial.parameters as unknown as ResearchPhylogenyParameters : null;
  const prior = phylogeny ? priorTree?.pangenome ?? null : initial?.actionId === ActionIds.OverlayPangenomeGraph
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
    if (phylogeny) next.push(
      { key: 'name', label: 'Phylogeny name (required; at most 200 UTF-8 bytes)', initial: priorTree?.name ?? 'Captured reference-backbone phylogeny' },
      { key: 'reference', label: 'Why are these backbone columns homologous? Source or assessment (required)', initial: priorTree?.reference ?? '' },
      { key: 'distance', label: 'Distance model (p-distance, jc69 or k80)', initial: priorTree?.options.distance ?? 'p-distance' },
      { key: 'bootstrap', label: 'Site-bootstrap replicates (0 to disable, or 20–200)', initial: String(priorTree?.options.bootstrap ?? 0) },
      { key: 'seed', label: 'Deterministic bootstrap seed (0–4294967295)', initial: String(priorTree?.options.seed ?? 1) });
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
    if (phylogeny) {
      const tree = researchPhylogenyParameters(parameters, entered.name, entered.reference, {
        distance: entered.distance as PhylogenyOptions['distance'], deletion: 'complete',
        bootstrap: integer(entered.bootstrap, 'Bootstrap count'), seed: integer(entered.seed, 'Seed') });
      onSave({ actionId: ActionIds.OverlayPhylodynamics, parameters: analysisJson(tree) });
    } else onSave({ actionId: ActionIds.OverlayPangenomeGraph, parameters: analysisJson(parameters) });
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
          if (members.length < (phylogeny ? 3 : 2) || members.length > 24) throw new Error(`Select ${phylogeny ? 3 : 2}–24 distinct captured genomes, including the reference.`);
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
    <Text bold>{phylogeny ? 'Pangenome-backed unrooted neighbor-joining phylogeny' : 'Multi-genome pangenome and coding consequences'}</Text>
    <Text wrap="truncate-end">Reference: {terminalGenomeLabel(reference.name)} · {members.length} selected genomes</Text>
    {error && <Text wrap="truncate-end" color={colors.accent}>{error}</Text>}
    {stage === 'settings' && field ? <>
      <Text wrap="truncate-end">{graphAlignments[alignmentIndex].label} · setting {settingIndex + 1}/{settings.length}</Text>
      <Text>{field.label}</Text>
      <TextInput key={field.key} value={values[field.key]} onChange={value => { if (value.length <= (field.key === 'reference' ? 2000 : 256)) setValues(before => ({ ...before, [field.key]: value })); }} onSubmit={submitSetting} />
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
    {phylogeny && <>
      <Text color={colors.textDim}>Reference-gap columns excluded; complete deletion removes columns with any gaps or ambiguity.</Text>
      <Text color={colors.textDim}>Homology is your explicit assessment. The unrooted tree and site support do not infer transfer or ancestry.</Text>
    </>}
    <Text color={colors.textDim}>Drafting runs no analyses. Genomes and original annotations remain in the private input bundle.</Text>
  </Box>;
}
/** A mosaic query owns an explicit reference panel. Empty panels are useful
 * no-reference controls, and a selected query can never be its own reference.
 */
function MosaicStepEditor({ draft, initial, rows, onSave, onCancel }: {
  draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const prior = initial?.actionId === ActionIds.OverlayMosaicRadar ? initial.parameters as unknown as ResearchMosaicParameters : null;
  const [stage, setStage] = useState<'query' | 'references' | 'settings'>('query');
  const [queryIndex, setQueryIndex] = useState(Math.max(0, draft.sources.findIndex(source => source.contentId === prior?.queryContentId)));
  const [references, setReferences] = useState<string[]>(prior ? [...prior.referenceContentIds] : []);
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [settingIndex, setSettingIndex] = useState(0), [error, setError] = useState<string | null>(null);
  const query = draft.sources[queryIndex], candidates = draft.sources.filter(source => source.contentId !== query.contentId);
  const settings: Setting[] = [
    { key: 'k', label: 'Canonical k-mer length (1–16)', initial: String(prior?.options.k ?? 5) },
    { key: 'window', label: 'Mosaic window (200–5000000 bases)', initial: String(prior?.options.window ?? 2000) },
    { key: 'step', label: 'Mosaic step (100 bases through window size)', initial: String(prior?.options.step ?? 1000) },
    { key: 'minSimilarity', label: 'Minimum Jaccard similarity (0–1)', initial: String(prior?.options.minSimilarity ?? 0.05) },
    { key: 'maxReferences', label: 'Maximum references to compare (1–30)', initial: String(prior?.options.maxReferences ?? 30) },
    { key: 'topN', label: 'Retained candidates per window (1–30)', initial: String(prior?.options.topN ?? 3) },
  ];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(settings.map(field => [field.key, field.initial])));
  const label = (source: TerminalResearchDraftSource) => terminalGenomeLabel(`${source.name} · ${source.accession}`)
    + ` · ${source.bases} bp · ${source.contentId.slice(0, 12)}`;
  const choices = stage === 'query' ? draft.sources.map(label)
    : candidates.map(source => `${references.includes(source.contentId) ? '[x]' : '[ ]'} ${label(source)}`);
  const cursor = stage === 'query' ? queryIndex : referenceIndex;
  const pageSize = Math.max(1, Math.min(8, rows - 17)), start = Math.floor(cursor / pageSize) * pageSize;
  const selectedBases = query.bases + candidates.filter(source => references.includes(source.contentId)).reduce((sum, source) => sum + source.bases, 0);
  const save = (entered: Record<string, string>) => {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(entered.minSimilarity)) throw new Error('Minimum similarity must be an explicit decimal from 0 to 1.');
    const options = { k: integer(entered.k, 'K-mer length'), window: integer(entered.window, 'Mosaic window'),
      step: integer(entered.step, 'Mosaic step'), minSimilarity: Number(entered.minSimilarity),
      maxReferences: integer(entered.maxReferences, 'Maximum references'), topN: integer(entered.topN, 'Retained candidates') };
    if (options.window < 200 || options.step < 100) throw new Error('Enter a window of at least 200 bases and step of at least 100; values are not silently enlarged.');
    onSave({ actionId: ActionIds.OverlayMosaicRadar, parameters: analysisJson(researchMosaicParameters(query.contentId, references, options)) });
  };
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (stage === 'settings') {
      if (key.shift && key.tab) { setSettingIndex(index => Math.max(0, index - 1)); setError(null); }
      return;
    }
    if (input === ' ' && stage === 'references') {
      const source = candidates[referenceIndex];
      if (!source) return;
      if (!references.includes(source.contentId) && references.length >= 30) { setError('Select at most 30 captured references.'); return; }
      setError(null);
      setReferences(before => before.includes(source.contentId) ? before.filter(id => id !== source.contentId) : [...before, source.contentId]);
      return;
    }
    if (key.return) {
      setError(null);
      if (stage === 'query') {
        setReferences(before => before.filter(id => id !== query.contentId)); setReferenceIndex(0); setStage('references');
      } else setStage('settings');
      return;
    }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : key.rightArrow ? pageSize : key.leftArrow ? -pageSize : 0;
    if (!delta) return;
    const next = Math.max(0, Math.min(cursor + delta, choices.length - 1));
    if (stage === 'query') setQueryIndex(next); else setReferenceIndex(next);
  });
  const field = settings[settingIndex];
  const submitSetting = (value: string) => {
    try {
      setError(null); const next = { ...values, [field.key]: value }; setValues(next);
      if (settingIndex + 1 < settings.length) setSettingIndex(settingIndex + 1); else save(next);
    } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  return <Box flexDirection="column">
    <Text bold>Mosaic reference similarity</Text>
    <Text wrap="truncate-end">Query: {terminalGenomeLabel(query.name)} · {references.length} references · {selectedBases} supplied bases</Text>
    {error && <Text wrap="truncate-end" color={colors.accent}>{error}</Text>}
    {stage === 'settings' ? <>
      <Text bold>Settings — {settingIndex + 1}/{settings.length}</Text>
      <Text>{field.label}</Text>
      <TextInput key={field.key} value={values[field.key]} onChange={value => { if (value.length <= 256) setValues(before => ({ ...before, [field.key]: value })); }} onSubmit={submitSetting} />
      {field.key === 'maxReferences' && <Text color={colors.textDim}>A smaller cap explicitly omits selected references after stable label ordering.</Text>}
      <Text color={colors.textDim}>Enter accepts · Shift+Tab edits the previous value · Esc discards</Text>
    </> : <>
      <Text bold>{stage === 'query' ? 'Choose the captured mosaic query' : 'Choose captured references (Space toggles; Enter accepts the panel)'}</Text>
      {choices.slice(start, start + pageSize).map((text, offset) => <Text key={start + offset} wrap="truncate-end" color={start + offset === cursor ? colors.accent : colors.text}>
        {start + offset === cursor ? '›' : ' '} {start + offset + 1}. {text}
      </Text>)}
      {stage === 'references' && references.length === 0 && <Text color={colors.textDim}>No references selected: Enter records an explicit no-reference control.</Text>}
      <Text color={colors.textDim}>Up/Down select · Left/Right page · Enter continues · Esc discards</Text>
    </>}
    <Text color={colors.textDim}>Exact supplied reference similarity; no donor, transfer direction or recombination-event inference.</Text>
    <Text color={colors.textDim}>Drafting runs no analyses. No sequences are uploaded or printed.</Text>
  </Box>;
}
/** A form over canonical action IDs. It never creates a second executor or runs
 * an analysis while the user selects sources and reviews effective settings.
 */
function ResearchStepEditor({ draft, initial, rows, describeRNA, onSave, onCancel }: {
  draft: TerminalResearchDraft; initial: TerminalResearchStep | null; rows: number;
  describeRNA: TerminalResearchSession['describeRNA'];
  onSave: (step: TerminalResearchStep) => void; onCancel: () => void;
}): React.ReactElement {
  const { colors } = usePhageStore(state => state.currentTheme);
  const parameters = initial?.parameters && typeof initial.parameters === 'object' && !Array.isArray(initial.parameters)
    ? initial.parameters as Record<string, unknown> : {};
  const [stage, setStage] = useState<'method' | 'source' | 'comparison' | 'gene' | 'settings'>('method');
  const [methodIndex, setMethodIndex] = useState(Math.max(0, editorActions.findIndex(item => item.id === initial?.actionId
    && (item.id !== ActionIds.OverlayCodonAdaptation || (item.kind === 'reference-codons') === (parameters.method === 'reference-cai')))));
  const [sourceIndex, setSourceIndex] = useState(Math.max(0, draft.sources.findIndex(item => item.contentId === parameters.contentId)));
  const [comparisonIndex, setComparisonIndex] = useState(typeof parameters.comparisonContentId === 'string'
    ? draft.sources.findIndex(item => item.contentId === parameters.comparisonContentId) + 1 : 0);
  const [geneIndex, setGeneIndex] = useState(0);
  const [settings, setSettings] = useState<Setting[]>([]), [values, setValues] = useState<Record<string, string>>({});
  const [rnaSource, setRnaSource] = useState<TerminalResearchRNASource | null>(null);
  const [settingIndex, setSettingIndex] = useState(0), [error, setError] = useState<string | null>(null);
  const action = editorActions[methodIndex], source = draft.sources[sourceIndex];
  const genes = source.genes.filter(gene => action.kind !== 'codons' && action.kind !== 'rna' || gene.type === 'CDS');
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
    else if (action.kind === 'rna') {
      const sourceRNA = describeRNA(contentId, selectedGene);
      const interval = parseRNAInterval(entered.start, entered.end, sourceRNA.bases, selectedGene !== null);
      const strand = selectedGene === null ? entered.strand : '+';
      if (strand !== '+' && strand !== '-') throw new Error('RNA strand must be + or -.');
      value = researchRNAParameters(contentId, { geneId: selectedGene, ...interval, strand }, {
        windowSize: integer(entered.windowSize, 'RNA window'), stepSize: integer(entered.stepSize, 'RNA step'),
        minLoopSize: integer(entered.minLoopSize, 'Minimum loop'), allowWobble: yesNo(entered.allowWobble, 'GU wobble'),
        frame: 0, includeSynonymousStress: sourceRNA.synonymousSupported ? yesNo(entered.includeSynonymousStress, 'Synonymous scoring') : false,
      });
    }
    else if (action.kind === 'digest') value = { contentId, ...resolveRestrictionDigestOptions({ topology: entered.topology,
      enzymes: entered.enzymes === 'none' ? [] : entered.enzymes.split(',').map(name => name.trim()) }) };
    else if (action.kind === 'synteny') value = researchSyntenyParameters(contentId,
      comparisonIndex ? draft.sources[comparisonIndex - 1].contentId : contentId);
    else if (action.kind === 'comparison') value = researchComparisonParameters(contentId,
      comparisonIndex ? draft.sources[comparisonIndex - 1].contentId : contentId, {
        kmerSizes: entered.kmerSizes.split(',').map(value => integer(value.trim(), 'K-mer size')),
        maxEditDistanceLength: integer(entered.maxEditDistanceLength, 'Exact edit-distance limit'),
        editDistanceWindowSize: integer(entered.editDistanceWindowSize, 'Sampled edit window'),
        editDistanceWindowCount: integer(entered.editDistanceWindowCount, 'Sampled edit window count'),
      });
    else value = { contentId, comparisonContentId: comparisonIndex ? draft.sources[comparisonIndex - 1].contentId : null,
      bins: integer(entered.bins, 'Display bins'), window: integer(entered.window, 'Comparison window') };
    onSave({ actionId: action.id, parameters: analysisJson(value) });
  };
  const beginSettings = (selectedGene = geneId) => {
    if (action.kind === 'codons' || action.kind === 'synteny') { save({}, selectedGene); return; }
    const prior = initial?.actionId === action.id && parameters.contentId === source.contentId
      && (action.kind !== 'rna' || parameters.geneId === selectedGene) ? parameters : {};
    const remembered = draft.initialView?.contentId === source.contentId ? draft.initialView : null;
    const sourceRNA = action.kind === 'rna' ? describeRNA(source.contentId, selectedGene) : undefined;
    setRnaSource(sourceRNA ?? null);
    const next = stepSettings(action.kind, source, prior, remembered, sourceRNA ? { ...sourceRNA, coding: selectedGene !== null } : undefined);
    if (action.kind === 'dot-plot' && comparisonIndex && prior.window === undefined) {
      next.find(field => field.key === 'window')!.initial = String(Math.min(20, source.bases, draft.sources[comparisonIndex - 1].bases));
    }
    setSettings(next); setValues(Object.fromEntries(next.map(field => [field.key, field.initial]))); setSettingIndex(0); setStage('settings');
  };
  const choices = stage === 'method' ? editorActions.map(item => item.label)
    : stage === 'source' ? draft.sources.map(item => terminalGenomeLabel(item.name + ' · ' + item.accession) + ' · ' + item.bases + ' bp · ' + item.topology)
      : stage === 'comparison' ? [action.kind === 'synteny' ? 'Use query annotations again (explicit two-input control)'
        : action.kind === 'comparison' ? 'Use genome A again (explicit two-input control)' : 'Self comparison (one input)',
        ...draft.sources.map(item => terminalGenomeLabel(item.name + ' · ' + item.accession))]
        : [action.kind === 'codons' ? 'All captured CDS' : action.kind === 'rna' ? 'Forward genome coordinates (choose an interval and strand)' : 'No selected feature', ...genes.map(gene =>
          terminalGenomeLabel((gene.name || gene.locusTag || gene.type) + ' · feature ' + gene.id) + ' · ' + (gene.startPos + 1) + '–' + gene.endPos)];
  const cursor = stage === 'method' ? methodIndex : stage === 'source' ? sourceIndex : stage === 'comparison' ? comparisonIndex : geneIndex;
  const pageSize = Math.max(1, Math.min(8, rows - 15)), start = Math.floor(cursor / pageSize) * pageSize;
  useInput((_input, key) => {
    if ((action.kind === 'pangenome' || action.kind === 'phylogeny' || action.kind === 'mosaic' || action.kind === 'reference-codons' || action.kind === 'spacers') && stage !== 'method') return;
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
          if (action.kind === 'dot-plot' || action.kind === 'comparison' || action.kind === 'synteny') setStage('comparison');
          else if (action.kind === 'view' || action.kind === 'codons' || action.kind === 'rna') {
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
  if ((action.kind === 'pangenome' || action.kind === 'phylogeny') && stage !== 'method') return <PangenomeStepEditor
    draft={draft} initial={initial} rows={rows} phylogeny={action.kind === 'phylogeny'} onSave={onSave} onCancel={onCancel} />;
  if (action.kind === 'mosaic' && stage !== 'method') return <MosaicStepEditor
    draft={draft} initial={initial} rows={rows} onSave={onSave} onCancel={onCancel} />;
  if ((action.kind === 'reference-codons' || action.kind === 'spacers') && stage !== 'method') return <ReferenceStepEditor
    kind={action.kind} draft={draft} initial={initial} rows={rows} onSave={onSave} onCancel={onCancel} />;
  return <Box flexDirection="column">
    {error && <Text wrap="truncate-end" color={colors.accent}>{error}</Text>}
    {stage === 'settings' && field ? <>
      <Text bold>{action.label} settings — {settingIndex + 1}/{settings.length}</Text>
      <Text wrap="truncate-end">Captured source: {terminalGenomeLabel(source.name)} · {source.bases} bp</Text>
      {action.kind === 'comparison' && <>
        <Text wrap="truncate-end">Genome B: {terminalGenomeLabel((comparisonIndex ? draft.sources[comparisonIndex - 1] : source).name)}</Text>
        <Text color={colors.textDim}>Above the exact limit, edit distance is sampled; operation counts are unavailable.</Text>
        <Text color={colors.textDim}>Complete bases, annotations and all comparison metrics travel with the result.</Text>
      </>}
      {action.kind === 'rna' && rnaSource && <>
        <Text>RNA source: {rnaSource.bases} bases · {geneId === null ? 'forward genome coordinates' : 'extracted CDS transcript coordinates'}</Text>
        {geneId !== null && <Text color={colors.textDim}>Joined/complement CDS and codon_start are respected. Start at transcript position 1, 4, 7, ...</Text>}
        {!rnaSource.synonymousSupported && <Text color={colors.textDim}>Pairing only; this source does not support synonymous scoring.</Text>}
      </>}
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
      {action.kind === 'rna' && <Text color={colors.textDim}>Unit-weight pairing scores are descriptive; no folding energy or functional prediction.</Text>}
      {action.kind === 'synteny' && <>
        <Text color={colors.textDim}>Exact supplied annotation order and fixed matching settings are captured.</Text>
        <Text color={colors.textDim}>Requires annotated sources; no sequence homology or validated rearrangement calls.</Text>
      </>}
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
  const [mode, setMode] = useState<'browse' | 'open' | 'archive' | 'analysis' | 'new' | 'fork' | 'step' | 'plan' | 'tape'>('browse');
  // Ink may retire an input listener after the next screen has rendered. A
  // retired filename form must not consume that screen's shortcut or submit.
  const activeMode = useRef(mode); activeMode.current = mode;
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
  const detailLines = useMemo(() => {
    const step = draft?.plan.commands[selected];
    if (pane === 'draft-fields' && step) {
      const parameters = step.parameters;
      // Imported reference commands can embed a private CDS corpus. Keep its
      // exact bytes in the plan/export, never in the terminal's parameter view.
      const display = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? { ...step, parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key,
          (key === 'referenceText' || key === 'libraryText') && typeof value === 'string'
            ? `[Captured reference: ${new TextEncoder().encode(value).length} UTF-8 bytes; included in plan exports]` : value])) }
        : step;
      return JSON.stringify(display, null, 2).split('\n').map(terminalGenomeLabel);
    }
    return analysis ? JSON.stringify(analysis.fields, null, 2).split('\n').map(terminalGenomeLabel) : [];
  }, [analysis, draft, selected, pane]);
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
      if (mode === 'fork') {
        perform(() => session.forkDraft(filename), () => { setMode('browse'); setPane('draft'); setSelection(0); setLine(0); });
        return;
      }
      const path = terminalGenomePath(filename);
      if (mode === 'open') {
        const previousDraft = session.getSnapshot().draft;
        perform(() => session.load(path), () => {
          const opened = session.getSnapshot();
          setMode('browse'); setPane(opened.pendingDraft || opened.draft !== previousDraft ? 'draft' : 'steps');
          setSelection(0); setLine(0); setRepetitions(1);
        });
      }
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
    if (session.getSnapshot().pendingDraft) {
      try {
        if (key.escape || input.toLowerCase() === 'n') session.discardDraftReplacement();
        else if (input.toLowerCase() === 'y') session.acceptDraftReplacement();
        else return;
        setMode('browse'); setPane('draft'); setSelection(0); setLine(0); setFormError(null);
      } catch (cause) { setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
      return;
    }
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
    if (action === 'f' && document) { chooseFile('fork'); return; }
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
    <Text wrap="truncate-end">{document ? terminalGenomeLabel(document.name) + ' · ' + steps.length + ' commands · ' + document.inspection.genomes.length + ' private genomes' : 'Open a saved plan, command workflow or complete results archive.'}</Text>
    {available && <Text color={colors.textDim}>{available.replayed ? 'Fresh numerical replay verified'
      : available.provenance === 'recorded' ? 'New computed baseline; independent replay not run' : 'Archive integrity checked; numerical replay not run'} · {executions.length} executions · {available.archive.records.length} distinct analyses</Text>}
    {state.notice && <Text wrap="truncate-end" color={colors.textDim}>{state.notice}</Text>}
    {(formError || state.error) && <Text wrap="truncate-end" color={colors.accent}>{formError ?? state.error}</Text>}
    {state.busy ? <>
      <Text>{state.busy === 'saving' ? 'Saving the new output file. Wait for completion.' : 'Working: ' + state.busy + '. Esc cancels.'}</Text>
      {state.progress && <Text wrap="truncate-end">{state.progress.phase}: {state.progress.completed}/{state.progress.total} · {terminalGenomeLabel(state.progress.actionId ?? 'Validating original inputs')}</Text>}
      {state.busy === 'saving' && <Text color={colors.textDim}>Process interruption can leave a partial new file. Existing files are never overwritten.</Text>}
    </> : state.pendingDraft ? <>
      <Text bold>Replace the current editable draft?</Text>
      <Text wrap="truncate-end">Current: {terminalGenomeLabel(draft!.plan.name)} · {draft!.plan.commands.length} steps</Text>
      <Text wrap="truncate-end">Reviewed: {terminalGenomeLabel(state.pendingDraft.name)} · {state.pendingDraft.sourceCount} captured genomes · {state.pendingDraft.stepCount} steps</Text>
      <Text>Only the editable draft will change. Accepted recordings and results remain available.</Text>
      <Text>[Y] Replace draft · [N] or Esc keeps the current draft</Text>
    </> : mode === 'step' && draft ? <ResearchStepEditor draft={draft} initial={editing === null ? null : draft.plan.commands[editing]} rows={rows} describeRNA={session.describeRNA}
      onCancel={() => setMode('browse')} onSave={step => { session.setStep(step, editing); setMode('browse'); setPane('draft');
        setSelection(editing ?? draft.plan.commands.length); setLine(0); }} /> : mode !== 'browse' ? <>
      <Text bold>{mode === 'new' ? 'New workflow draft name:' : mode === 'fork' ? 'New draft name for the inspected recording:'
        : mode === 'open' ? 'Saved plan, workflow or complete archive path:'
        : mode === 'plan' ? 'New declarative plan destination:' : mode === 'tape' ? 'New command recording destination:'
          : mode === 'archive' ? 'New complete archive destination:' : 'New analysis destination (execution ' + entry?.execution + '):'}</Text>
      <TextInput key={mode} value={filename}
        onChange={value => {
          const current = session.getSnapshot();
          if (activeMode.current === mode && !current.busy && !current.pendingDraft) setFilename(value);
        }} onSubmit={() => { if (activeMode.current === mode) submit(); }} />
      {mode === 'fork' && <Text>Copies exact inputs and commands without running them. New output expectations require explicit computation; the accepted recording is kept.</Text>}
      <Text color={colors.textDim}>{mode === 'new' ? 'Enter captures accepted private inputs and view · Esc returns without changes'
        : mode === 'fork' ? 'Enter prepares the editable copy · Esc returns without changes'
        : 'Enter submits · Esc returns · Literal paths; ~/ supported; no shell quotes.'}</Text>
    </> : <>
      {draftPane && draft ? <>
        <Text bold wrap="truncate-end">Draft: {terminalGenomeLabel(draft.plan.name)} · {draft.sources.length} captured genomes · {draft.plan.commands.length} steps</Text>
        {pane === 'draft-fields' ? <>
          <Text bold>Proposed command parameters — no output expectations</Text>
          {detailLines.slice(detailStart, detailStart + perPage).map((text, index) => <Text key={detailStart + index} wrap="truncate-end">{text}</Text>)}
          <Text color={colors.textDim}>Lines {detailStart + 1}–{Math.min(detailStart + perPage, detailLines.length)} / {detailLines.length} · Esc returns to draft</Text>
        </> : draft.plan.commands.slice(start, start + perPage).map((step, offset) => {
          const graph = step.actionId === ActionIds.OverlayPhylodynamics ? (step.parameters as unknown as ResearchPhylogenyParameters).pangenome
            : step.actionId === ActionIds.OverlayPangenomeGraph ? step.parameters as unknown as ResearchPangenomeParameters : null;
          const mosaic = step.actionId === ActionIds.OverlayMosaicRadar ? step.parameters as unknown as ResearchMosaicParameters : null;
          const source = draft.sources.find(item => graph ? `local-${item.contentId}` === graph.options.referenceId
            : item.contentId === (mosaic?.queryContentId ?? (step.parameters as Record<string, unknown>).contentId));
          const referenceCodons = step.actionId === ActionIds.OverlayCodonAdaptation
            && (step.parameters as Record<string, unknown>).method === 'reference-cai';
          return <Text key={start + offset} wrap="truncate-end" color={start + offset === selected ? colors.accent : colors.text}>
            {start + offset === selected ? '›' : ' '} {start + offset + 1}. {referenceCodons ? 'CDS statistics + captured reference CAI' : editorActions.find(action => action.id === step.actionId)?.label ?? step.actionId} · {graph ? `${graph.contentIds.length} genomes; reference ` : mosaic ? `${mosaic.referenceContentIds.length} references; query ` : ''}{terminalGenomeLabel(source?.name ?? 'missing source')}
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
      <Text dimColor={!document}>[F] Fork inspected recording into a new editable draft</Text>
      <Text>[O] Open · [R] Replay ×{repeats}{document?.savedResults ? ' (saved count)' : ' [+/-]'} · [S] Steps · [V] Results</Text>
      <Text dimColor={!available}>[A] Export archive{draftPane ? '' : ' · [E] Export selected analysis'}</Text>
      <Text dimColor={!state.completedRun}>[G] Restore genomes/view (review first) · Esc back</Text>
      <Text color={colors.textDim}>Replay leaves the explorer unchanged. Exports contain private inputs.</Text>
    </>}
  </Box>;
}
