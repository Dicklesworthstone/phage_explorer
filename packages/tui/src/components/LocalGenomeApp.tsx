import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { usePhageStore } from '@phage-explorer/state';
import type { LocalGenomeView } from '../../../core/src/genome-import';
import { TerminalGenomeSession, terminalGenomeLabel, type TerminalGenomeAccepted } from '../local-genome-session';
import { registerCommand, unregisterCommand } from '../commands/registry';
import { App } from './App';

const IMPORT_COMMAND = 'overlay.genomeImport';
/** Literal filesystem paths only; neither shell commands nor environment variables are evaluated. */
export function terminalGenomePath(value: string): string {
  if (!value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Enter a local path without control characters.');
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value);
}
export function currentTerminalGenomeView(): LocalGenomeView | undefined {
  const state = usePhageStore.getState();
  // App loads the selected record asynchronously. Never attach an old record's
  // identity to the position of a newly selected (not yet loaded) genome.
  if (state.phages[state.currentPhageIndex]?.id !== state.currentPhage?.id) {
    throw new Error('The selected genome is still loading. Return to the explorer before exporting its view.');
  }
  const contentId = state.currentPhage?.localGenome?.contentId;
  return contentId ? { contentId, viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition } : undefined;
}
/** One store write: setters that individually reset scroll must not reorder the restored view. */
export function installTerminalGenomes(accepted: TerminalGenomeAccepted): void {
  const currentPhageIndex = accepted.phages.findIndex(phage => phage.id === accepted.selected.id);
  if (currentPhageIndex < 0) throw new Error('The selected local genome is not in the accepted repository.');
  usePhageStore.setState({
    phages: accepted.phages, currentPhageIndex, currentPhage: accepted.selected,
    viewMode: accepted.view.viewMode, readingFrame: accepted.view.readingFrame, scrollPosition: accepted.view.scrollPosition,
    selectedGeneId: null, overlays: [], overlayData: {}, model3DFullscreen: false, isLoadingPhage: false, error: null, quitConfirmPending: false,
    diffEnabled: false, diffReferencePhageId: null, diffReferenceSequence: null,
  });
}

/** The explorer is suspended while this full-screen form owns input. Cancelling
 * the form cannot leave App's key handlers consuming the filename as shortcuts.
 * On return App remounts, dropping old sequence/analysis caches while retaining
 * the accepted store selection and view. No active repository is closed here.
 */
export function LocalGenomeApp({ session, initiallyOpen = false }: {
  session: TerminalGenomeSession; initiallyOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    registerCommand({ id: IMPORT_COMMAND, label: 'Local genomes: import, restore or export',
      description: 'Review private FASTA/GenBank or save the current local inputs and view without restarting.',
      keywords: ['file', 'fasta', 'genbank', 'bundle', 'private', 'import', 'export'], category: 'Research',
      action: () => { session.discardReview(); setOpen(true); } });
    return () => { unregisterCommand(IMPORT_COMMAND); session.cancel(); };
  }, [session]);
  return open
    ? <TerminalGenomeView session={session} onReturn={() => setOpen(false)} />
    : <App repository={state.repository} />;
}

export function TerminalGenomeView({ session, onReturn }: {
  session: TerminalGenomeSession; onReturn: () => void;
}): React.ReactElement {
  const { exit } = useApp(), { stdout } = useStdout();
  const { colors } = usePhageStore(state => state.currentTheme);
  const canReturn = usePhageStore(state => state.phages.length > 0);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [mode, setMode] = useState<'menu' | 'import' | 'export'>('menu');
  const [path, setPath] = useState('');
  const [allowCollisions, setAllowCollisions] = useState(false);
  const [page, setPage] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [rows, setRows] = useState(stdout.rows || 24);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const resize = () => setRows(stdout.rows || 24);
    stdout.on?.('resize', resize);
    return () => { mounted.current = false; stdout.off?.('resize', resize); session.cancel(); };
  }, [session, stdout]);
  const perPage = Math.max(1, Math.min(8, Math.floor((rows - 15) / 3)));
  const review = state.review;
  const pages = Math.max(1, Math.ceil((review?.genomes.length ?? 0) / perPage));
  const currentPage = Math.min(page, pages - 1);
  const leave = () => { session.discardReview(); if (canReturn) onReturn(); else exit(); };
  const submitPath = () => {
    if (session.getSnapshot().busy) return;
    try {
      const selectedPath = terminalGenomePath(path);
      setFormError(null);
      if (mode === 'import') {
        setAllowCollisions(false); setPage(0); setMode('menu');
        void session.prepare(selectedPath).catch(cause => {
          if (mounted.current) setFormError(terminalGenomeLabel(String(cause)));
        });
      } else if (mode === 'export') {
        const view = currentTerminalGenomeView();
        void session.save(selectedPath, view).then(saved => {
          if (saved && mounted.current) { setMode('menu'); setPath(''); }
        }).catch(cause => { if (mounted.current) setFormError(terminalGenomeLabel(String(cause))); });
      }
    } catch (cause) { setFormError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  useInput((input, key) => {
    // Consult the session synchronously: two input events before React rerenders
    // must not submit or accept a second operation.
    if (session.getSnapshot().busy) { if (key.escape) session.cancel(); return; }
    if (mode !== 'menu') {
      if (key.escape) { setMode('menu'); setFormError(null); }
      return; // TextInput exclusively owns filename editing and Enter.
    }
    if (key.escape || input === 'q') { leave(); return; }
    if (input.toLowerCase() === 'i') { session.discardReview(); setMode('import'); setPath(''); setFormError(null); return; }
    if (input.toLowerCase() === 'e' && state.localCount) { setMode('export'); setPath(''); setFormError(null); return; }
    if (!review) return;
    if (input.toLowerCase() === 'c') { setAllowCollisions(value => !value); return; }
    if (key.leftArrow) setPage(Math.max(0, currentPage - 1));
    else if (key.rightArrow) setPage(Math.min(pages - 1, currentPage + 1));
    else if (key.return) {
      void session.accept(allowCollisions, installTerminalGenomes).then(accepted => {
        if (accepted && mounted.current) onReturn();
      }).catch(cause => { if (mounted.current) setFormError(terminalGenomeLabel(String(cause))); });
    }
  });
  return <Box flexDirection="column" borderStyle="round" borderColor={colors.borderLight} paddingX={1}>
    <Text bold color={colors.accent}>LOCAL GENOMES — PRIVATE SESSION</Text>
    <Text>{state.localCount} accepted local records · {state.localBases.toLocaleString()} bases</Text>
    <Text color={colors.textDim}>Importing never replaces existing records or writes genome data to the catalog.</Text>
    {state.notice && <Text color={colors.text}>{state.notice}</Text>}
    {(formError || state.error) && <Text color={colors.accent}>{formError ?? state.error}</Text>}
    {state.busy ? <>
      <Text>Working: {state.busy}. Press Esc to cancel.</Text>
      {state.busy === 'saving' && <Text color={colors.textDim}>An interrupted disk write can leave a partial new file. Existing files are never overwritten.</Text>}
    </> : mode !== 'menu' ? <>
      <Text bold>{mode === 'import' ? 'FASTA, GenBank or portable bundle path:' : 'New portable bundle destination:'}</Text>
      <TextInput value={path} onChange={setPath} onSubmit={submitPath} />
      <Text color={colors.textDim}>Enter submits · Esc returns · Paths are literal (~/ is supported; do not add shell quotes).</Text>
    </> : review ? <>
      <Text bold>Review {review.genomes.length} parsed records — not yet added</Text>
      {review.genomes.slice(currentPage * perPage, (currentPage + 1) * perPage).map(genome => <Box key={genome.phage.id} flexDirection="column">
        <Text wrap="truncate-end">{terminalGenomeLabel(genome.phage.accession)} · {terminalGenomeLabel(genome.phage.name)}</Text>
        <Text>{genome.sequence.length.toLocaleString()} bases · {genome.phage.genes.filter(g => g.type === 'CDS').length} mapped CDS · {genome.phage.localGenome!.contentId.slice(0, 12)}</Text>
        <Text wrap="truncate-end" color={colors.textDim}>{genome.warnings.length ? `${genome.warnings.length} warnings: ${terminalGenomeLabel(genome.warnings.join(' | '))}` : 'No parser warnings.'}</Text>
      </Box>)}
      <Text>Page {currentPage + 1}/{pages} · Left/Right changes page</Text>
      <Text>{review.view ? `Restore saved ${review.view.viewMode} view, frame ${review.view.readingFrame}, position ${review.view.scrollPosition}.` : 'Select the first imported record in DNA view.'}</Text>
      <Text>[C] Keep different records with matching accessions: {allowCollisions ? 'YES — keep both' : 'NO — reject collisions'}</Text>
      <Text bold>Enter: add reviewed records and return · I: choose another file · Esc: discard</Text>
    </> : <>
      <Text>[I] Import or restore a local file</Text>
      <Text dimColor={!state.localCount}>[E] Export ALL accepted original inputs and the current local view</Text>
      <Text>[Esc] {canReturn ? 'Return to the current explorer session' : 'Quit (or import a file to begin)'}</Text>
      <Text color={colors.textDim}>Local records stay in memory. Export before quitting to retain them.</Text>
    </>}
  </Box>;
}
