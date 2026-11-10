import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayProvenance } from './OverlayProvenance';
import TextInput from 'ink-text-input';
import { open } from 'node:fs/promises';
import { useOverlayWidth } from './terminal-size';
import { loadProteinReferenceInputs, parseAnalysisRecord, serializeAnalysisRecord,
  proteinStructureResultFromRecord, exportProteinStructureTsv,
  type AnalysisRecord, type ProteinReferenceRepository, type ProteinReferenceInputs,
  type ProteinStructureOptions, type ProteinStructureResult } from '@phage-explorer/core';
import referenceSnapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { runTerminalResearchWorker } from '../../../../scripts/research-workflow';
import { usePhageStore } from '@phage-explorer/state';
import type { TropismAnalysis, ReceptorCandidate } from '@phage-explorer/comparison';

function ConfidenceBar({ value, width = 10, color }: { value: number; width?: number; color: string }) {
  const filled = Math.round(value * width);
  const empty = width - filled;
  return (
    <Text color={color}>
      {'█'.repeat(filled)}
      {'░'.repeat(Math.max(0, empty))}
      {` ${(value * 100).toFixed(0)}%`}
    </Text>
  );
}

export function TropismOverlay({ repository = null }: { repository?: ProteinReferenceRepository | null }): React.ReactElement {
  const [showReference, setShowReference] = useState(false);
  const colors = usePhageStore(s => s.currentTheme.colors);
  const overlayData = usePhageStore(s => s.overlayData);
  const phage = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const data = overlayData.tropism as TropismAnalysis | undefined;

  useInput((input, key) => {
    if (showReference) return;
    if (input === 'p' || input === 'P') { setShowReference(true); return; }
    if (key.escape || input === 'e' || input === 'E') {
      closeOverlay('tropism');
    }
  });

  if (showReference) return <TerminalProteinEvidenceView repository={repository} onReturn={() => setShowReference(false)} />;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFocus}
      paddingX={2}
      paddingY={1}
      width={80}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.primary} bold>
          ◉ Tail Fiber Tropism & Receptor Atlas
        </Text>
        <Text color={colors.textMuted}>E / ESC to close</Text>
      </Box>

      <Text color={colors.info}>[p] Real protein alignment and structure evidence</Text>
      <Box marginBottom={1}>
        <OverlayProvenance level="heuristic" source="keyword scan over gene products" />
      </Box>

      {!data || data.hits.length === 0 ? (
        <Text color={colors.textMuted}>
          {phage ? `No tail fiber annotations found for ${phage.name}.` : 'No phage loaded.'}
        </Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text color={colors.accent} bold>
              Breadth:{' '}
            </Text>
            <Text color={colors.text}>
              {data.breadth === 'narrow'
                ? 'NARROW (single primary receptor)'
                : data.breadth === 'multi-receptor'
                  ? 'BROAD (multiple receptor cues)'
                  : 'UNKNOWN'}
            </Text>
          </Box>

          <Box flexDirection="column" gap={1}>
            {data.hits.map((hit, hitIndex) => (
              <Box key={`${hit.gene.id}-${hit.gene.startPos}-${hitIndex}`} flexDirection="column" borderStyle="classic" borderColor={colors.borderLight} padding={1}>
                <Box justifyContent="space-between">
                  <Text color={colors.primary} bold>
                    {hit.gene.name ?? hit.gene.locusTag ?? 'Tail fiber'}
                  </Text>
                  <Text color={colors.textDim}>
                    {hit.gene.startPos}–{hit.gene.endPos} ({hit.gene.strand ?? '?'} strand)
                  </Text>
                </Box>
                <Text color={colors.textMuted}>
                  {hit.gene.product ?? 'Unnamed receptor-binding protein'}
                  {hit.aaLength ? ` · ${hit.aaLength} aa` : ''}
                  {hit.motifs && hit.motifs.length > 0 ? ` · motifs: ${hit.motifs.join('; ')}` : ''}
                </Text>

                {hit.receptorCandidates.length === 0 ? (
                  <Text color={colors.textMuted}>No receptor hints in annotation.</Text>
                ) : (
                  hit.receptorCandidates.map((rc: ReceptorCandidate, rcIndex: number) => (
                    <Box key={`${rc.receptor}-${rcIndex}`} gap={2}>
                      <Text color={colors.success} bold>
                        {rc.receptor}
                      </Text>
                      <ConfidenceBar value={rc.confidence} color={colors.info} />
                      <Text color={colors.textMuted}>
                        Evidence: {rc.evidence.join(', ')}
                      </Text>
                    </Box>
                  ))
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}


/** Current-genome entry point. Standalone reference imports and replay are also available through the workflow CLI. */
export function TerminalProteinEvidenceView({ repository, onReturn }: {
  repository: ProteinReferenceRepository | null;
  onReturn: () => void;
}): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const phage = usePhageStore(s => s.currentPhage);
  const selectedGeneId = usePhageStore(s => s.selectedGeneId);
  const selectGene = usePhageStore(s => s.setSelectedGeneId);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const rows = usePhageStore(s => s.terminalRows);
  const width = useOverlayWidth(80);
  const owner = useMemo(() => ({ repository, phage, selectedGeneId }), [repository, phage, selectedGeneId]);
  const [loaded, setLoaded] = useState<{ owner: typeof owner; inputs: ProteinReferenceInputs } | null>(null);
  const inputs = loaded?.owner === owner ? loaded.inputs : null;
  const [cutoff, setCutoff] = useState(8);
  const [separation, setSeparation] = useState(3);
  const [scope, setScope] = useState<'chain' | 'assembly'>('assembly');
  const [alignmentOnly, setAlignmentOnly] = useState(false);
  const options = useMemo<ProteinStructureOptions>(() => ({
    contactCutoffAngstrom: cutoff, minSequenceSeparation: separation, contactScope: scope,
    ...(alignmentOnly ? { chainLabelAsymId: null } : {}),
  }), [cutoff, separation, scope, alignmentOnly]);
  const operation = useMemo(() => ({ owner, inputs, options }), [owner, inputs, options]);
  const [snapshot, setSnapshot] = useState<{ operation: typeof operation; record: AnalysisRecord; result: ProteinStructureResult } | null>(null);
  const accepted = snapshot?.operation === operation ? snapshot : null;
  const result = accepted?.result ?? null;
  const [failure, setFailure] = useState<{ operation: typeof operation; message: string } | null>(null);
  const error = failure?.operation === operation ? failure.message : null;
  const [table, setTable] = useState<'residues' | 'contacts'>('residues');
  const [offset, setOffset] = useState(0);
  const [exportMode, setExportMode] = useState<'json' | 'residues' | 'contacts' | null>(null);
  const [path, setPath] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const matched = inputs?.status === 'ready' && (selectedGeneId === null || selectedGeneId === inputs.gene.id);
  const pageSize = Math.max(2, Math.min(15, rows - 20 - (exportMode ? 3 : 0)));
  const count = result ? (table === 'residues' ? result.residues.length : result.contacts.length) : 0;
  const first = Math.min(offset, Math.max(0, count - pageSize));

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    if (!repository || !phage) return () => controller.abort();
    void loadProteinReferenceInputs(repository, phage.id, referenceSnapshot)
      .then(value => { if (!controller.signal.aborted) setLoaded({ owner, inputs: value }); })
      .catch(cause => {
        if (!controller.signal.aborted) setLoaded({ owner, inputs: { status: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause) } });
      });
    return () => controller.abort();
  }, [owner, repository, phage]);

  useEffect(() => {
    generation.current++;
    setSnapshot(null); setFailure(null); setOffset(0); setTable('residues');
    setExportMode(null); setPath(''); setNotice(''); setSaving(false);
    if (!matched || inputs?.status !== 'ready') return () => { generation.current++; };
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setFailure({ operation, message: 'Protein analysis exceeded five minutes. Change a setting to retry.' });
      controller.abort();
    }, 300000);
    void (async () => {
      try {
        const response = await runTerminalResearchWorker({ type: 'analyze-protein-structure',
          content: JSON.stringify(inputs.bundle), options }, controller.signal);
        if (response.type !== 'protein-structure-analyzed') throw new Error('Unexpected protein structure response.');
        const record = await parseAnalysisRecord(response.recordJson);
        const produced = proteinStructureResultFromRecord(record);
        if (!controller.signal.aborted) {
          setSnapshot({ operation, record, result: produced });
          setOffset(Math.max(0, produced.residues.findIndex(residue => residue.coordinate !== null)));
        }
      } catch (cause) {
        if (!controller.signal.aborted) setFailure({ operation, message: cause instanceof Error ? cause.message : String(cause) });
      } finally { clearTimeout(timeout); }
    })();
    return () => { generation.current++; clearTimeout(timeout); controller.abort(); };
  }, [operation, matched, inputs, options]);

  const save = async (destination: string) => {
    if (!accepted || !exportMode || saving) return;
    if (!destination.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(destination)) {
      setNotice('Enter a new regular file path without control characters.'); return;
    }
    const content = exportMode === 'json' ? serializeAnalysisRecord(accepted.record)
      : exportProteinStructureTsv(accepted.record, exportMode);
    const version = generation.current;
    const format = exportMode;
    setSaving(true); setNotice('');
    try {
      const file = await open(destination, 'wx', 0o600);
      try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
      if (version === generation.current) {
        setExportMode(null); setPath(''); setNotice('Saved ' + format + ' to ' + destination + '.');
      }
    } catch (cause) {
      if (version === generation.current) setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally { if (version === generation.current) setSaving(false); }
  };

  useInput((input, key) => {
    if (exportMode) {
      if (key.escape && !saving) { setExportMode(null); setPath(''); }
      return;
    }
    if (key.escape || input === 'e' || input === 'E') { closeOverlay('tropism'); return; }
    if (input === 'p' || input === 'P') { onReturn(); return; }
    if ((input === 'g' || input === 'G') && inputs?.status === 'ready') { selectGene(inputs.gene.id); return; }
    if (input === '+' || input === '=') setCutoff(value => Math.min(30, value + 0.5));
    if (input === '-' || input === '_') setCutoff(value => Math.max(0.5, value - 0.5));
    if (input === '[') setSeparation(value => Math.max(1, value - 1));
    if (input === ']') setSeparation(value => Math.min(10000, value + 1));
    if (input === 's' || input === 'S') setScope(value => value === 'assembly' ? 'chain' : 'assembly');
    if (input === 'a' || input === 'A') setAlignmentOnly(value => !value);
    if (!accepted) return;
    if (input === 'v' || input === 'V') { setTable(value => value === 'residues' ? 'contacts' : 'residues'); setOffset(0); }
    if (key.downArrow || key.pageDown) setOffset(value => Math.min(Math.max(0, count - pageSize), value + pageSize));
    if (key.upArrow || key.pageUp) setOffset(value => Math.max(0, value - pageSize));
    if (key.home) setOffset(0);
    if (key.end) setOffset(Math.max(0, count - pageSize));
    if (input === 'm' || input === 'M') {
      setTable('residues'); setOffset(Math.max(0, accepted.result.residues.findIndex(residue => residue.coordinate !== null)));
    }
    if (input === 'j' || input === 't' || input === 'c') {
      setExportMode(input === 'j' ? 'json' : input === 't' ? 'residues' : 'contacts'); setNotice(''); setPath('');
    }
  });

  const number = (value: number | null, digits = 0) => value === null ? 'NA' : value.toFixed(digits);
  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} width={width}>
    <Text color={colors.primary} bold>Protein alignment and observed structure evidence</Text>
    <Text color={colors.textDim}>[p] Back · E/Esc close · [g] Select verified CDS</Text>
    <Text color={colors.info}>[+/-] Cutoff {cutoff} Å · [ / ] Separation {separation} · [s] {scope}</Text>
    <Text color={colors.info}>[a] {alignmentOnly ? 'Alignment only' : 'Mapped structure'} · [v] Residues/contacts · arrows page</Text>
    {!phage || !repository ? <Text>No current genome repository.</Text>
      : !inputs ? <Text>Checking source identities against the actual genomic CDS…</Text>
      : inputs.status === 'unavailable' ? <Text color={colors.warning}>{inputs.reason}</Text>
      : <>
        <Text color={colors.text}>{phage.accession} · verified CDS {inputs.bundle.cds.proteinAccession} · {inputs.protein.accession}, {inputs.protein.sequence.length} aa</Text>
        {!matched ? <Text color={colors.warning}>Selected gene {selectedGeneId} is not the verified reference CDS. Press G to select gene {inputs.gene.id}.</Text>
          : <>
            <Text color={colors.textDim}>{selectedGeneId === null ? 'No gene selected; using the explicitly identified reference CDS.' : 'Selected CDS matches the complete reference protein.'}</Text>
            {error ? <Text color={colors.error}>{error}</Text> : !result ? <Text>Computing alignment diversity and observed distances in an isolated worker…</Text> : <>
              <Text color={colors.text}>Entropy {result.coverage.entropyResidues}/{result.coverage.proteinResidues} residues · observed Cα {result.coverage.coordinateResidues}/{result.coverage.proteinResidues}</Text>
              <Text color={colors.text}>Cα pairs: within chain {result.chain ? result.coverage.intrachainContacts : 'unavailable'} · between supplied chains {result.chain && scope === 'assembly' ? result.coverage.interchainContacts : 'not compared'}</Text>
              {result.chain && <Text color={colors.textDim}>{result.chain.pdbId} v{result.chain.entryVersion}, assembly {result.chain.assemblyId}, label {result.chain.labelAsymId}/author {result.chain.authAsymId}; mapped protein {result.chain.start}–{result.chain.end}</Text>}
              <Text color={colors.accent}>{table} {count ? first + 1 : 0}–{Math.min(count, first + pageSize)} of {count} · Home/End · [m] First observed</Text>
              {table === 'residues' ? <>
                <Text color={colors.textDim}>Protein AA  MSAcol H(bits) Observed  Label Author   Cα within/between</Text>
                {result.residues.slice(first, first + pageSize).map(residue => <Text key={residue.position} color={colors.text}>
                  {String(residue.position).padStart(7)} {residue.aminoAcid} {String(residue.alignment?.column ?? 'NA').padStart(7)} {number(residue.alignment?.entropyBits ?? null, 3).padStart(7)} {((residue.alignment?.observed ?? 0) + '/' + result.alignment.rows).padStart(8)} {String(residue.coordinate?.labelSeqId ?? 'NA').padStart(6)} {(residue.coordinate ? String(residue.coordinate.authSeqId) + residue.coordinate.insertionCode : 'NA').padStart(6)} {number(residue.intrachainNeighbors).padStart(5)}/{number(residue.interchainNeighbors)}
                </Text>)}
              </> : <>
                <Text color={colors.textDim}>Kind       Protein positions       Label/author chain     Cα distance Å</Text>
                {result.contacts.slice(first, first + pageSize).map((contact, index) => <Text key={first + index} color={colors.text}>
                  {contact.kind.padEnd(11)} {String(contact.query.proteinPosition).padStart(5)} → {String(contact.partner.proteinPosition).padEnd(5)} {contact.query.labelAsymId}/{contact.query.authAsymId} → {contact.partner.labelAsymId}/{contact.partner.authAsymId} {contact.distanceAngstrom.toFixed(3)}
                </Text>)}
                {!count && <Text>{result.chain ? 'No Cα pairs meet the requested scope, separation and cutoff.' : 'No mapped chain selected; contact geometry is unavailable.'}</Text>}
              </>}
              <Text color={colors.info}>[j] Replayable JSON · [t] Residue TSV · [c] Contact TSV</Text>
              <Text color={colors.textDim}>NA = missing evidence. Entropy needs at least two observations.</Text>
              <Text color={colors.textDim}>Cα uses supplied chains; zero does not prove no interaction.</Text>
              <Text color={colors.textDim}>No SASA, affinity, population conservation or mutation estimates.</Text>
            </>}
          </>}
      </>}
    {exportMode && <Box flexDirection="column">
      <Text>New {exportMode} destination (existing files are preserved; Esc cancels):</Text>
      <TextInput value={path} onChange={setPath} onSubmit={destination => { void save(destination); }} focus={!saving} />
    </Box>}
    {!!notice && <Text color={colors.info}>{notice}</Text>}
  </Box>;
}
