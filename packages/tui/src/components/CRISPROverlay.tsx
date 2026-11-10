import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { SPACER_LIMITS, type SpacerGenome, type SpacerSearchResult } from '../../../core/src/analysis/spacer-reference';
import { SpacerReferenceSession, readSpacerGenome, type SpacerRepository, type SpacerRequest, type SpacerWorkResult } from '../../../web/src/workers/SpacerReferenceSession';
import { createTerminalSpacerWorker, readTerminalSpacerFile, writeTerminalSpacerFile,
  spacerTerminalLabel, terminalSpacerHitsTsv, runTerminalAcrHeuristic } from '../commands/spacer-reference';
import type { TerminalAcrResult } from '../commands/acr-heuristic';
import { useOverlayWidth } from './terminal-size';

type Tab = 'hits' | 'coverage' | 'excluded' | 'source' | 'acr';
type Prompt = 'library' | 'replay' | 'json' | 'tsv' | 'library-export' | 'host';
const PROMPTS: Record<Prompt, string> = {
  library: 'Spacer library JSON path', replay: 'Saved spacer analysis path (verify against current DNA/topology)',
  json: 'New replayable evidence JSON path', tsv: 'New complete hit TSV path',
  'library-export': 'New spacer library JSON path', host: 'Host ID from this library (blank selects all hosts)',
};
const PROMPT_KEYS = new Map<string, Prompt>([
  ['l', 'library'], ['r', 'replay'], ['e', 'json'], ['t', 'tsv'], ['b', 'library-export'], ['H', 'host'],
]);
const STATUSES: Record<SpacerSearchResult['status'], string> = {
  'no-spacer-data': 'No records for the selected host scope; nothing was searched.',
  'unsupported-references': 'All selected references were excluded; inspect exclusions.',
  'no-usable-windows': 'No complete unambiguous DNA windows for the supported spacers.',
  'no-sequence-match': 'No matches within the submitted mismatch allowance and coverage.',
  'sequence-matches': 'Sequence matches found; supplied PAM and seed rules were checked.',
};

/** Real, locally supplied references against an explicitly selected repository snapshot. */
export function CRISPROverlay({ repository }: { repository: SpacerRepository | null }): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const phage = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const width = useOverlayWidth(94);
  const scope = useMemo(() => ({ repository, phage }), [repository, phage]);
  const session = useMemo(() => new SpacerReferenceSession(createTerminalSpacerWorker), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { library, busy: spacerBusy, phase, error, notice } = snapshot;
  const accepted = snapshot.acceptedScope === scope ? snapshot.accepted : null;
  const result = accepted?.result;
  const [hostId, setHostId] = useState<string | null>(null);
  const [mismatches, setMismatches] = useState(0);
  const [topology, setTopology] = useState<SpacerGenome['topology']>(phage?.localGenome?.topology ?? 'unknown');
  const [tab, setTab] = useState<Tab>('hits');
  const [offset, setOffset] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [input, setInput] = useState('');
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const acrController = useRef<AbortController | null>(null);
  const [acrPhase, setAcrPhase] = useState<string | null>(null);
  const [acrState, setAcrState] = useState<{ scope: object; anchor: SpacerWorkResult | null; value: TerminalAcrResult } | null>(null);
  const acr = acrState?.scope === scope && acrState.anchor === accepted ? acrState.value : null;
  const busy = spacerBusy || acrPhase !== null;
  const pageSize = Math.max(2, Math.min(18, terminalRows - 15 - (prompt ? 1 : 0)));

  useLayoutEffect(() => {
    generation.current++;
    session.setScope(scope); setTopology(phage?.localGenome?.topology ?? 'unknown');
    setPrompt(null); setInput(''); setOffset(0); setFileNotice(null); setSaving(false);
  }, [scope, session, phage]);
  useLayoutEffect(() => {
    acrController.current?.abort(); acrController.current = null;
    setAcrState(null); setAcrPhase(null);
  }, [scope, accepted]);
  useEffect(() => { session.activate(); return () => {
    generation.current++; session.deactivate();
    acrController.current?.abort(); acrController.current = null;
  }; }, [session]);
  useEffect(() => { setHostId(null); setMismatches(0); setOffset(0); }, [library]);
  useEffect(() => {
    if (!accepted?.result || !accepted.genome) return;
    setHostId(accepted.result.options.hostId); setMismatches(accepted.result.options.maxMismatches);
    setTopology(accepted.genome.topology); setOffset(0);
  }, [accepted]);
  useEffect(() => { setOffset(0); }, [tab]);

  const run = (request: SpacerRequest | ((signal: AbortSignal) => Promise<SpacerRequest>)) => {
    setFileNotice(null); void session.run(scope, request);
  };
  const currentGenome = (signal: AbortSignal, selectedTopology = topology) => {
    if (!repository || !phage) return Promise.reject(new Error('Select a genome with an available repository first.'));
    return readSpacerGenome(repository, phage, selectedTopology, signal);
  };
  const analyze = () => {
    if (!library) { setFileNotice('Load an explicitly sourced spacer library first. No sequence has been searched.'); return; }
    const submitted = structuredClone(library), options = { hostId, maxMismatches: mismatches }, selectedTopology = topology;
    run(async signal => ({ kind: 'analyze', library: submitted, options, genome: await currentGenome(signal, selectedTopology) }));
  };
  const runAcr = async () => {
    setTab('acr'); setOffset(0); setFileNotice(null);
    if (!phage || !repository) { setFileNotice('Select an annotated genome with an available repository first.'); return; }
    const controller = new AbortController(), anchor = accepted, genes = structuredClone(phage.genes);
    acrController.current?.abort(); acrController.current = controller;
    const current = () => acrController.current === controller && !controller.signal.aborted;
    setAcrPhase('Reading the current genome and its captured annotations');
    try {
      // Reuse an accepted DNA snapshot when present; never mix a replay's query with other genes.
      const genome = anchor?.genome ?? await currentGenome(controller.signal);
      const value = await runTerminalAcrHeuristic({ kind: 'acr', genome, genes }, controller.signal,
        message => { if (current()) setAcrPhase(message); });
      if (current()) { setAcrState({ scope, anchor, value }); setFileNotice('Optional Acr size/charge shortlist complete; heuristic only.'); }
    } catch (cause) {
      if (current()) setFileNotice(cause instanceof Error ? cause.message : String(cause));
    } finally { if (current()) { acrController.current = null; setAcrPhase(null); } }
  };
  const cancel = () => {
    const pending = acrController.current;
    acrController.current = null; pending?.abort(); setAcrPhase(null);
    if (pending) setFileNotice('Acr heuristic cancelled; the previous shortlist was preserved.');
    session.cancel();
  };
  const submit = (value: string) => {
    const action = prompt;
    setPrompt(null); setInput(''); setFileNotice(null);
    if (!action) return;
    if (action === 'host') {
      const id = value.trim() || null;
      if (id !== null && !library?.hosts.some(host => host.id === id)) setFileNotice('Host ID is absent from the loaded library.');
      else setHostId(id);
      return;
    }
    if (action === 'library') {
      run(async signal => ({ kind: 'library', content: await readTerminalSpacerFile(value, SPACER_LIMITS.libraryBytes, signal) }));
      return;
    }
    if (action === 'replay') {
      const selectedTopology = topology;
      run(async signal => {
        const content = await readTerminalSpacerFile(value, 10 * 1024 * 1024, signal);
        return { kind: 'replay', content, genome: await currentGenome(signal, selectedTopology) };
      });
      return;
    }
    if (action === 'library-export' ? !library : !accepted?.record) { setFileNotice('No accepted input or result to export.'); return; }
    // Capture the accepted source and result before disk I/O; later navigation cannot relabel it.
    let content: string;
    try {
      content = action === 'library-export' ? JSON.stringify(library, null, 2)
        : action === 'json' ? serializeAnalysisRecord(accepted!.record!) : terminalSpacerHitsTsv(accepted!);
    } catch (cause) { setFileNotice(cause instanceof Error ? cause.message : String(cause)); return; }
    const owner = generation.current;
    setSaving(true);
    void writeTerminalSpacerFile(value, content).then(() => {
      if (owner === generation.current) setFileNotice(`Saved ${action} to ${value}.`);
    }).catch(cause => {
      if (owner === generation.current) setFileNotice(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (owner === generation.current) setSaving(false); });
  };

  const lines = useMemo(() => {
    const rows: string[] = [];
    if (tab === 'acr') {
      rows.push('HEURISTIC ONLY: small acidic proteins are candidates for follow-up, not verified Acrs.',
        'Legacy rules: 50–200 translated codons; D/E minus K/R >5; +20 below 100 codons.',
        'Only complete contiguous, unambiguous CDS spans with default frame and code (1/11).',
        'No family assignment, calibrated confidence, inhibition or host-range inference.',
        'Spacer exports contain reference evidence only; this optional shortlist is separate.');
      if (!acr) { rows.push('Press A to score the current genome and its annotations. No spacer library is required.'); return rows; }
      rows.push(`${acr.eligibleGenes}/${acr.submittedGenes} annotations eligible; ${acr.candidates.length} size/charge candidates.`);
      for (const [reason, count] of Object.entries(acr.skipped)) rows.push(`Excluded ${count}: ${reason}.`);
      for (const [index, candidate] of acr.candidates.entries()) rows.push(
        `${index + 1}. ${candidate.geneName ?? 'unnamed'} (gene ${candidate.geneId}); heuristic score ${candidate.score}.`,
        `${candidate.strand} [${candidate.start},${candidate.end}); ${candidate.translatedCodons} translated codons; acidic excess >5.`);
      if (!acr.eligibleGenes) rows.push('No supported annotated spans were scored; this is not evidence that Acrs are absent.');
      else if (!acr.candidates.length) rows.push('No eligible spans met this size/charge rule; other Acr mechanisms remain unassessed.');
      return rows;
    }
    if (tab === 'source') {
      if (!library) return ['No reference library loaded. Import JSON with declared hosts, arrays, orientation and source.',
        'Schema: phage-explorer-spacer-library version 1, matching the web CRISPR panel.',
        'Libraries and results stay local. No host, PAM, seed or system type is guessed.'];
      rows.push(`Source kind: ${library.source.kind}${library.source.kind === 'demo' ? ' — SYNTHETIC DEMONSTRATION' : ' — supplied attribution, not independently verified'}`,
        `Reference: ${library.source.reference}`, `Version: ${library.source.version}`, `License/permission: ${library.source.license}`, `Scope: ${library.source.scope}`);
      for (const host of library.hosts) rows.push(`Host ${host.id}: ${host.name}; strain ${host.strain}; ${host.accession}`);
      if (accepted?.record) rows.push(`Input/result: ${accepted.record.cacheKey}`, `Result ID: ${accepted.record.resultId}`, ...result!.warnings);
      return rows;
    }
    if (!result) return ['No accepted comparison. Load references, choose scope/topology, then press Enter.',
      'No hit, no supplied data and unsupported references are different outcomes.'];
    if (tab === 'coverage') {
      rows.push(`${result.searchedRecords}/${result.selectedRecords} reference records searched; ${result.distinctSequences} distinct sequences.`);
      for (const host of result.hosts) rows.push(`${host.hostId}: ${host.searched}/${host.records} searched, ${host.excluded} excluded, ${host.hitRecords} hit records, ${host.uniqueLoci} oriented loci`);
      for (const window of result.coverage) rows.push(`${window.length} bp windows: ${window.unambiguousStarts}/${window.possibleStarts} complete unambiguous starts.`);
    } else if (tab === 'excluded') {
      for (const item of result.excluded) rows.push(`${item.hostId} / ${item.spacerId}: ${item.reason}`);
      if (!rows.length) rows.push('No selected reference records were excluded.');
    } else {
      const references = new Map(library?.spacers.map(spacer => [spacer.id, spacer]));
      for (const [index, hit] of result.hits.entries()) {
        const reference = references.get(hit.spacerId);
        rows.push(`${index + 1}. ${hit.spacerId} / ${hit.hostId}: ${hit.strand} [${hit.start},${hit.end})${hit.wrapsOrigin ? ' wraps origin' : ''}; ${(100 * hit.identity).toFixed(1)}% identity`,
          `Segments: ${hit.segments.map(segment => `[${segment.start},${segment.end})`).join(' → ')}; guide mismatch offsets: ${hit.mismatchPositions.join(',') || 'none'}`,
          `PAM ${hit.pam.status}${hit.pam.sequence ? ` (${hit.pam.sequence})` : ''}; seed ${hit.seed.status}${hit.seed.mismatches === null ? '' : ` (${hit.seed.mismatches} substitutions)`}`,
          `Guide-oriented protospacer: ${hit.protospacer}`, `Source array: ${reference?.arrayAccession}; system: ${reference?.system ?? 'unspecified'}`);
        if (reference?.pam) rows.push(`PAM rule: ${reference.pam.side} ${reference.pam.motif}; ${reference.pam.reference}`);
        if (hit.pam.reason) rows.push(`PAM limitation: ${hit.pam.reason}`);
        if (reference?.seed) rows.push(`Seed rule: [${reference.seed.start},${reference.seed.end}), max ${reference.seed.maxMismatches}; ${reference.seed.reference}`);
      }
      if (!rows.length) rows.push(STATUSES[result.status]);
    }
    return rows;
  }, [tab, library, result, accepted, acr]);
  const first = Math.min(offset, Math.max(0, lines.length - pageSize));
  useInput((key, info) => {
    if (saving) return;
    if (info.escape) {
      if (prompt) { setPrompt(null); setInput(''); }
      else if (busy) cancel();
      else closeOverlay('crispr');
      return;
    }
    if (prompt) return; // Shortcut letters inside file paths belong only to TextInput.
    if (key === 'c') { cancel(); return; }
    if (key === 'i' || key === 'I') { cancel(); session.deactivate(); closeOverlay('crispr'); return; }
    if (busy) return;
    if (key === 'a' || key === 'A') { void runAcr(); return; }
    if (info.return) { analyze(); return; }
    const requestPrompt = PROMPT_KEYS.get(key);
    if (requestPrompt) { setPrompt(requestPrompt); setInput(''); return; }
    if (key === 'h' && library) {
      const hosts = [null, ...library.hosts.map(host => host.id)];
      setHostId(hosts[(hosts.indexOf(hostId) + 1) % hosts.length]);
    }
    if (key === '+' || key === '=') setMismatches(value => Math.min(5, value + 1));
    if (key === '-' || key === '_') setMismatches(value => Math.max(0, value - 1));
    if (key === 'o') {
      const declared = phage?.localGenome?.topology;
      if (declared && declared !== 'unknown') setFileNotice(`Imported topology is ${declared}; the source metadata is preserved.`);
      else setTopology(value => value === 'unknown' ? 'linear' : value === 'linear' ? 'circular' : 'unknown');
    }
    if (key === '1') setTab('hits');
    if (key === '2') setTab('coverage');
    if (key === '3') setTab('excluded');
    if (key === '4') setTab('source');
    if (key === '5') setTab('acr');
    if (info.downArrow || info.rightArrow || info.pageDown) setOffset(value => Math.min(Math.max(0, lines.length - pageSize), value + pageSize));
    if (info.upArrow || info.leftArrow || info.pageUp) setOffset(value => Math.max(0, value - pageSize));
    if (info.home) setOffset(0);
    if (info.end) setOffset(Math.max(0, lines.length - pageSize));
  });
  const changed = result && (result.options.hostId !== hostId || result.options.maxMismatches !== mismatches || accepted?.genome?.topology !== topology);
  const safe = spacerTerminalLabel;
  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} width={width}>
    <Text bold color={colors.primary}>CRISPR SPACER REFERENCE EVIDENCE</Text>
    {prompt ? <><Text wrap="truncate-end">{PROMPTS[prompt]} (Enter accepts, Esc cancels)</Text>
      <TextInput value={input} onChange={value => {
        if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) setFileNotice('File paths and host IDs cannot contain control characters.');
        else setInput(value.slice(0, 8192));
      }} onSubmit={submit} /></>
      : <Text wrap="truncate-end" color={colors.info}>[l] Library [r] Replay [Enter] Search [A] Acr [c] Cancel [I/Esc] Close</Text>}
    <Text wrap="truncate-end" color={colors.info}>[h/H] Host: {safe(hostId ?? 'all')} · [+/-] Mismatches: {mismatches} · [o] {topology}</Text>
    <Text wrap="truncate-end" color={colors.info}>[1] Hits [2] Coverage [3] Excluded [4] Source [5] Acr · [e/t/b] Export</Text>
    <Text wrap="truncate-end">Genome: {safe(phage?.name ?? 'none')} · {safe(phage?.accession ?? '')}</Text>
    <Text wrap="truncate-end">{library ? `${safe(library.name)}: ${library.spacers.length} records / ${library.hosts.length} hosts · ${library.source.kind === 'demo' ? 'SYNTHETIC EXAMPLE' : 'SUPPLIED REFERENCES'}` : 'No reference library. No DNA has been searched.'}</Text>
    <Text wrap="truncate-end" color={error ? colors.error : colors.textDim}>{safe(fileNotice ?? error ?? (saving ? 'Saving the captured evidence…' : busy ? acrPhase ?? phase : notice ?? 'Files stay local. External sources are not fetched.'))}</Text>
    <Text wrap="truncate-end">{result ? `${result.searchedRecords}/${result.selectedRecords} searched; ${result.hits.length} hit rows. ${STATUSES[result.status]}` : 'No accepted comparison; missing references are not evidence of susceptibility.'}</Text>
    <Text wrap="truncate-end" color={changed ? colors.warning : colors.textDim}>{result ? `Accepted: ${safe(result.options.hostId ?? 'all hosts')}, ${result.options.maxMismatches} substitutions, ${accepted!.genome!.topology}.${changed ? ' Draft changed; Enter applies.' : accepted!.verified ? ' Replay verified.' : ''}` : 'Choose topology explicitly; unknown does not assume origin-spanning DNA.'}</Text>
    <Text color={colors.accent}>{tab}: lines {first + 1}–{Math.min(lines.length, first + pageSize)} of {lines.length} · arrows / Home / End</Text>
    {lines.slice(first, first + pageSize).map((line, index) => <Text key={first + index} wrap="truncate-end" color={colors.text}>{safe(line)}</Text>)}
    <Text wrap="truncate-end" color={colors.warning}>0-based half-open coordinates. Matches do not establish immunity or host range.</Text>
  </Box>;
}
