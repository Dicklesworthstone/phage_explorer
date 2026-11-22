import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import { terminalGenomeLabel } from '../local-genome-session';
import { type TerminalNavigationSession, type TerminalView } from '../terminal-navigation-session';
import { readTerminalSize } from './terminal-size';

function describe(entry: TerminalView): string {
  const { view, source } = entry;
  return `${source.kind} · ${source.name} · ${view.viewMode.toUpperCase()} frame ${view.readingFrame >= 0 ? view.readingFrame + 1 : view.readingFrame}`
    + ` · ${view.viewMode === 'aa' ? 'residue' : 'base'} ${view.scrollPosition + 1}`
    + (view.geneId === null ? '' : ` · gene ${view.geneId}`);
}

/** An overlay owns text input, so filenames and view names never reach explorer shortcuts. */
export function SavedViewsView({ session, onClose }: { session: TerminalNavigationSession; onClose: () => void }): React.ReactElement {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const colors = usePhageStore(current => current.currentTheme.colors);
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readTerminalSize(stdout));
  const [tab, setTab] = useState<'saved' | 'history'>('saved');
  const [selected, setSelected] = useState(0);
  const [form, setForm] = useState<'name' | 'rename' | 'open' | 'save' | null>(null);
  const [value, setValue] = useState(''), [error, setError] = useState<string | null>(null);
  const entries = tab === 'saved' ? state.saved : state.history;
  const index = Math.max(0, Math.min(selected, entries.length - 1));
  useEffect(() => {
    const resize = () => setSize(readTerminalSize(stdout));
    stdout.on?.('resize', resize);
    return () => { stdout.off?.('resize', resize); session.cancel(); };
  }, [session, stdout]);
  const begin = (next: NonNullable<typeof form>, initial = '') => { setForm(next); setValue(initial); setError(null); };
  const invoke = (action: () => void) => {
    try { action(); setError(null); } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  const restore = async (direction?: -1 | 1) => {
    setError(null);
    const accepted = direction ? await session.moveHistory(direction)
      : tab === 'saved' ? await session.restoreSaved(index) : await session.restoreHistory(index);
    if (accepted) onClose();
  };
  const submit = async () => {
    if (state.busy || !form) return;
    try {
      if (form === 'name') { session.saveCurrent(value); setSelected(session.getSnapshot().saved.length - 1); setTab('saved'); }
      else if (form === 'rename') session.rename(index, value);
      else if (!(form === 'open' ? await session.open(value) : await session.save(value))) return;
      setForm(null); setValue(''); setError(null);
    } catch (cause) { setError(terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause))); }
  };
  useInput((input, key) => {
    if (state.busy) { if (key.escape) session.cancel(); return; }
    if (form) { if (key.escape) { setForm(null); setValue(''); setError(null); } return; }
    if (key.escape) { onClose(); return; }
    if (key.tab) { setTab(tab === 'saved' ? 'history' : 'saved'); setSelected(tab === 'saved' ? Math.max(0, state.historyIndex) : 0); return; }
    if (key.upArrow) { setSelected(Math.max(0, index - 1)); return; }
    if (key.downArrow) { setSelected(Math.min(Math.max(0, entries.length - 1), index + 1)); return; }
    if (key.return) { void restore(); return; }
    if (input.toLowerCase() === 'b') { void restore(-1); return; }
    if (input.toLowerCase() === 'f') { void restore(1); return; }
    if (input.toLowerCase() === 'n') { begin('name'); return; }
    if (input.toLowerCase() === 'o') { begin('open'); return; }
    if (input.toLowerCase() === 'e') { begin('save'); return; }
    if (tab === 'saved' && entries.length && input.toLowerCase() === 'r') { begin('rename', state.saved[index].name); return; }
    if (tab === 'saved' && entries.length && input.toLowerCase() === 'd') invoke(() => session.forget(index));
  });
  const pageSize = Math.max(1, (size.rows ?? 24) - 13), start = Math.max(0, index - pageSize + 1);
  return <Box flexDirection="column" width={size.columns ?? 80} height={size.rows ?? 24} borderStyle="round" borderColor={colors.accent} paddingX={1}>
    <Text bold color={colors.accent}>Explorer history and saved views</Text>
    <Text wrap="truncate-end">{tab === 'saved' ? 'Named views' : 'Browsing history'} · {entries.length} / 64 · Back {state.historyIndex > 0 ? 'available' : 'unavailable'} · Forward {state.historyIndex < state.history.length - 1 ? 'available' : 'unavailable'}</Text>
    <Text wrap="truncate-end" dimColor>Views preserve the exact genome, selected gene, DNA/AA/dual mode, frame and position.</Text>
    <Box flexDirection="column" flexGrow={1}>
      {!entries.length && <Text>{tab === 'saved' ? 'No named views. Press N to name the current view, or O to open a collection.' : 'History begins when a complete genome has loaded.'}</Text>}
      {entries.slice(start, start + pageSize).map((entry, offset) => {
        const row = start + offset;
        const name = 'name' in entry ? entry.name : `${row + 1}${row === state.historyIndex ? ' (current)' : ''}`;
        return <Text key={row} wrap="truncate-end" color={row === index ? colors.accent : colors.text}>
          {row === index ? '▶ ' : '  '}{terminalGenomeLabel(`${name} — ${describe(entry)}`)}
        </Text>;
      })}
    </Box>
    {form && <Box flexDirection="column">
      <Text>{form === 'name' ? 'Name this view:' : form === 'rename' ? 'Rename selected view:' : form === 'open' ? 'Open collection path:' : 'Export to a new file:'}</Text>
      <TextInput value={value} onChange={next => {
        if (next.length <= (form === 'name' || form === 'rename' ? 120 : 4096)) setValue(next);
        else setError('Input is too long.');
      }} onSubmit={() => { void submit(); }} focus={!state.busy} />
      <Text dimColor>Enter: accept · Esc: cancel field</Text>
    </Box>}
    {state.busy && <Text color={colors.warning}>{state.busy}… Esc cancels; late results cannot restore a view.</Text>}
    {(error || state.error) && <Text wrap="truncate-end" color={colors.error}>{error || state.error}</Text>}
    {state.notice && <Text wrap="truncate-end" color={colors.textDim}>{state.notice}</Text>}
    {!form && <>
      <Text wrap="truncate-end">↑/↓ Select · Enter Restore · Tab Saved/History · B Back · F Forward</Text>
      <Text wrap="truncate-end">N Name current · R Rename · D Forget · O Open · E Export · Esc Return</Text>
    </>}
    <Text wrap="truncate-end" dimColor>Export to keep named views after quitting. Import original local files/bundles before restoring their views.</Text>
  </Box>;
}
