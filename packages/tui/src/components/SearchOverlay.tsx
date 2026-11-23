import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { SearchHit, SearchMode, SearchRequest, SearchResponse, StrandOption } from '../../../web/src/workers/types';
import { loadTerminalSearchSource, runTerminalSearch, TERMINAL_SEARCH_LIMITS, type TerminalSearchSource } from '../terminal-search';
import { terminalGenomeLabel } from '../local-genome-session';

type Mode = 'catalog' | SearchMode;
const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'catalog', label: 'Catalog', hint: 'Name, host, family or accession, e.g. lambda or E. coli' },
  { id: 'sequence', label: 'Sequence', hint: 'Literal DNA, e.g. ATG; optionally allow 0–3 mismatches' },
  { id: 'motif', label: 'Motif', hint: 'IUPAC DNA, e.g. TATAWAW; ambiguous query symbols match resolved bases' },
  { id: 'gene', label: 'Gene', hint: 'Gene name, locus tag or product, e.g. terminase' },
  { id: 'feature', label: 'Feature', hint: 'Annotation type, name or product, e.g. CDS or tRNA' },
  { id: 'position', label: 'Position', hint: '0-based, end exclusive: 0, 1000-2000; returns overlapping features' },
];
interface Owner { repository: PhageRepository; phages: PhageSummary[]; phage: PhageFull | null; index: number; reload: number }
interface Request { repository: PhageRepository; phages: PhageSummary[]; owner: Owner | null; query: string; scan: SearchRequest | null }
interface Outcome { request: Request; generation: number; catalog: PhageSummary[]; hits: SearchHit[]; error: string | null }
interface SearchOverlayProps {
  repository: PhageRepository;
  width?: number;
  height?: number;
  runSearch?: (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
}
const label = terminalGenomeLabel;
const message = (cause: unknown) => label(cause instanceof Error ? cause.message : String(cause));

export function SearchOverlay({ repository, width = 84, height = 22, runSearch = runTerminalSearch }: SearchOverlayProps): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const catalogQuery = usePhageStore(s => s.searchQuery);
  const phages = usePhageStore(s => s.phages);
  const currentPhage = usePhageStore(s => s.currentPhage);
  const index = usePhageStore(s => s.currentPhageIndex);
  const loadingPhage = usePhageStore(s => s.isLoadingPhage);
  const [mode, setMode] = useState<Mode>('catalog');
  const [queries, setQueries] = useState<Partial<Record<Mode, string>>>({});
  const query = mode === 'catalog' ? catalogQuery : queries[mode] ?? '';
  const [cursor, setCursor] = useState(Array.from(query).length);
  const [strand, setStrand] = useState<StrandOption>('both');
  const [mismatches, setMismatches] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fuzzy, setFuzzy] = useState(true);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loaded, setLoaded] = useState<{ owner: Owner; source: TerminalSearchSource | null; error: string | null } | null>(null);
  const generation = useRef(0), queryAbort = useRef<AbortController | null>(null);
  const repositoryRef = useRef(repository); repositoryRef.current = repository;
  const phage = !loadingPhage && currentPhage && phages[index]?.id === currentPhage.id ? currentPhage : null;
  const owner = useMemo<Owner>(() => ({ repository, phages, phage, index, reload }), [repository, phages, phage, index, reload]);
  const genomeMode = mode !== 'catalog';
  const source = loaded?.owner === owner ? loaded.source : null;
  const sourceError = loaded?.owner === owner ? loaded.error : null;
  const [topologyChoice, setTopologyChoice] = useState<{ source: TerminalSearchSource; value: 'linear' | 'circular' } | null>(null);
  const topologyOverride = topologyChoice && topologyChoice.source === source ? topologyChoice.value : null;
  const topology = topologyOverride ?? (source?.topology === 'circular' ? 'circular' : 'linear');
  const owns = (candidate: Owner): boolean => {
    const current = usePhageStore.getState();
    return repositoryRef.current === candidate.repository && current.phages === candidate.phages
      && current.currentPhage === candidate.phage && current.currentPhageIndex === candidate.index
      && !current.isLoadingPhage && current.phages[current.currentPhageIndex]?.id === candidate.phage?.id;
  };

  useEffect(() => {
    if (!genomeMode || !owner.phage) return;
    const controller = new AbortController();
    void loadTerminalSearchSource(repository, owner.phage.id, controller.signal).then(value => {
      if (!controller.signal.aborted && owns(owner)) setLoaded({ owner, source: value, error: null });
    }).catch(cause => {
      if (!controller.signal.aborted && owns(owner)) setLoaded({ owner, source: null, error: message(cause) });
    });
    return () => controller.abort();
  }, [owner, genomeMode]);

  const request = useMemo<Request | null>(() => {
    if (mode !== 'catalog' && !source) return null;
    return { repository, phages, owner: mode === 'catalog' ? null : owner, query: query.trim(),
      scan: mode === 'catalog' ? null : { mode, query: query.trim(), sequence: source!.sequence, features: source!.features,
        options: { strand, topology, mismatches: mode === 'sequence' ? mismatches : 0, caseSensitive,
          fuzzy: (mode === 'gene' || mode === 'feature') && fuzzy, maxResults: TERMINAL_SEARCH_LIMITS.results } } };
  }, [repository, phages, owner, source, mode, query, strand, topology, mismatches, caseSensitive, fuzzy, reload]);
  const currentOutcome = outcome?.request === request && outcome.generation === generation.current ? outcome : null;
  const catalog = currentOutcome?.catalog ?? [], hits = currentOutcome?.hits ?? [];
  const count = mode === 'catalog' ? catalog.length : hits.length;

  useEffect(() => {
    if (!request?.query) return;
    const controller = new AbortController(), version = generation.current;
    queryAbort.current = controller;
    const current = () => !controller.signal.aborted && generation.current === version
      && repositoryRef.current === request.repository && usePhageStore.getState().phages === request.phages
      && (request.scan !== null || usePhageStore.getState().searchQuery.trim() === request.query)
      && (!request.owner || owns(request.owner));
    const fail = (error: string) => {
      if (current()) setOutcome({ request, generation: version, catalog: [], hits: [], error });
    };
    const deadline = setTimeout(() => {
      fail('Search timed out. Press Ctrl+R to retry.'); controller.abort();
    }, TERMINAL_SEARCH_LIMITS.timeoutMs);
    const timer = setTimeout(() => {
      if (!current()) return;
      void (async () => {
        try {
          if (request.query.length > TERMINAL_SEARCH_LIMITS.query) throw new Error('Search queries are limited to 10,000 characters.');
          if (request.scan) {
            const result = await runSearch(request.scan, controller.signal);
            if (current()) setOutcome({ request, generation: version, catalog: [], hits: result.hits, error: null });
          } else {
            const result = await request.repository.searchPhages(request.query);
            const available = new Set(request.phages.map(item => item.id));
            const matches = result.filter(item => available.has(item.id)).slice(0, TERMINAL_SEARCH_LIMITS.results);
            if (current()) {
              setOutcome({ request, generation: version, catalog: matches, hits: [], error: null });
              usePhageStore.getState().setSearchResults(matches);
            }
          }
          if (current()) setSelected(0);
        } catch (cause) { fail(message(cause)); }
        finally { clearTimeout(deadline); }
      })();
    }, 150);
    return () => { clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [request, runSearch]);

  // Invalidate synchronously as well as in effect cleanup: Enter directly after
  // editing cannot select a result from the previous input or pending render.
  const invalidate = () => { generation.current++; queryAbort.current?.abort(); setSelected(0); };
  const changeQuery = (value: string, nextCursor: number) => {
    if (value.length > TERMINAL_SEARCH_LIMITS.query) return;
    invalidate(); setCursor(nextCursor);
    if (mode === 'catalog') {
      usePhageStore.getState().setSearchQuery(value); usePhageStore.getState().setSearchResults([]);
    } else setQueries(previous => ({ ...previous, [mode]: value }));
  };
  const close = () => { invalidate(); usePhageStore.getState().closeOverlay(); };
  const insert = (input: string) => {
    if (!input || query.length + input.length > TERMINAL_SEARCH_LIMITS.query) return;
    const characters = Array.from(query), position = Math.min(cursor, characters.length);
    const insertion = Array.from(input.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '));
    characters.splice(position, 0, ...insertion); changeQuery(characters.join(''), position + insertion.length);
  };
  // Pasted control bytes are text, never mode/option/submit commands.
  usePaste(insert);
  const select = () => {
    const state = usePhageStore.getState();
    if (!currentOutcome || !request || currentOutcome.generation !== generation.current
      || request.repository !== repositoryRef.current || request.phages !== state.phages || currentOutcome.error) return;
    if (mode === 'catalog') {
      if (state.searchQuery.trim() !== request.query) return;
      const target = catalog[selected], nextIndex = target ? state.phages.findIndex(item => item.id === target.id) : -1;
      if (nextIndex < 0) return;
      state.setCurrentPhageIndex(nextIndex); close(); return;
    }
    const hit = hits[selected];
    if (!hit || !request.owner || !owns(request.owner)) return;
    state.setScrollPosition(state.viewMode === 'aa' ? Math.floor(hit.position / 3) : hit.position);
    state.setSelectedGeneId(hit.feature?.id ?? null);
    close();
  };
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) { close(); return; }
    if (key.tab) {
      invalidate();
      const next = MODES[(MODES.findIndex(item => item.id === mode) + (key.shift ? MODES.length - 1 : 1)) % MODES.length].id;
      setMode(next); setCursor(Array.from(next === 'catalog' ? catalogQuery : queries[next] ?? '').length); return;
    }
    if (key.downArrow || key.upArrow) { setSelected(value => Math.max(0, Math.min(count - 1, value + (key.downArrow ? 1 : -1)))); return; }
    if (key.return) { select(); return; }
    const characters = Array.from(query), position = Math.min(cursor, characters.length);
    if (key.ctrl) {
      if (input === 'u') changeQuery('', 0);
      else if (input === 'a') setCursor(0);
      else if (input === 'e') setCursor(characters.length);
      else if (input === 'r') { invalidate(); setReload(value => value + 1); }
      else if (input === 's' && (mode === 'sequence' || mode === 'motif')) { invalidate(); setStrand(value => value === 'both' ? '+' : value === '+' ? '-' : 'both'); }
      else if (input === 'o' && source && (mode === 'sequence' || mode === 'motif')) {
        invalidate();
        setTopologyChoice(topologyOverride === 'linear' ? null : { source, value: topologyOverride === 'circular' ? 'linear' : 'circular' });
      }
      else if (input === 'n' && mode === 'sequence') { invalidate(); setMismatches(value => (value + 1) % 4); }
      else if (input === 't' && genomeMode && mode !== 'position') { invalidate(); setCaseSensitive(value => !value); }
      else if (input === 'f' && (mode === 'gene' || mode === 'feature')) { invalidate(); setFuzzy(value => !value); }
      return;
    }
    if (key.home || key.end) { setCursor(key.home ? 0 : characters.length); return; }
    if (key.leftArrow || key.rightArrow) { setCursor(Math.max(0, Math.min(characters.length, position + (key.leftArrow ? -1 : 1)))); return; }
    if (key.backspace) {
      if (position > 0) { characters.splice(position - 1, 1); changeQuery(characters.join(''), position - 1); }
      return;
    }
    if (key.delete) {
      if (position < characters.length) { characters.splice(position, 1); changeQuery(characters.join(''), position); }
      return;
    }
    if (key.meta || !input) return;
    insert(input);
  });

  const modeInfo = MODES.find(item => item.id === mode)!;
  const sequenceMode = mode === 'sequence' || mode === 'motif';
  const pageSize = Math.max(1, Math.min(8, height - (sequenceMode ? 14 : 13))), offset = Math.max(0, selected - pageSize + 1);
  const chosen = hits[selected];
  const characters = Array.from(query), position = Math.min(cursor, characters.length);
  const inputWidth = Math.max(8, width - 13), start = Math.max(0, position - inputWidth + 2);
  const unavailable = genomeMode && (!phage ? (loadingPhage ? 'Selected genome is loading; wait before searching.' : 'Select a loaded genome to search its bases and annotations.') : sourceError);
  const status = unavailable ? `Unavailable: ${unavailable}` : genomeMode && !source ? 'Loading complete selected genome…'
    : currentOutcome?.error ? `Unavailable: ${currentOutcome.error}` : !query.trim() ? 'Type a query to search.'
    : !currentOutcome ? 'Searching…' : `${count} match${count === 1 ? '' : 'es'}${count >= TERMINAL_SEARCH_LIMITS.results ? ' — result limit reached; refine the query' : ''}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} width={width} height={height}>
      <Text bold color={colors.primary} wrap="truncate-end">SEARCH · {modeInfo.label}</Text>
      <Text color={colors.textMuted} wrap="truncate-end">{MODES.map(item => item.id === mode ? `[${item.label}]` : item.label).join('  ')}</Text>
      <Text color={colors.info} wrap="truncate-end">{genomeMode ? `Genome: ${phage ? label(phage.name) : 'unavailable'}${source ? ` · ${source.sequence.length.toLocaleString()} bp` : ''}` : 'Catalog: choose a phage to explore'}</Text>
      <Box height={1} overflow="hidden"><Text color={colors.info}>Query: </Text><Text wrap="truncate-end">{start > 0 ? '…' : ''}{label(characters.slice(start, position).join(''))}<Text inverse>{label(characters[position] ?? ' ')}</Text>{label(characters.slice(position + 1, start + inputWidth).join(''))}</Text></Box>
      <Text color={colors.textMuted} wrap="truncate-end">{modeInfo.hint}</Text>
      {sequenceMode && <Text color={colors.textMuted} wrap="truncate-end">{source
        ? `Topology: ${topologyOverride ? `${topology} (user)` : source.topology === 'unknown' ? 'unknown (linear interval)' : `${topology} (annotation)`} · ^O change · ${topology === 'circular' ? 'one traversal; | marks origin' : 'ends do not wrap'}`
        : 'Topology unavailable until the complete genome is loaded.'}</Text>}
      <Text color={colors.textDim} wrap="truncate-end">{mode === 'sequence' || mode === 'motif' ? `Strand ${strand} (^S)${mode === 'sequence' ? ` · mismatches ${mismatches} (^N)` : ''} · case ${caseSensitive ? 'on' : 'off'} (^T)`
        : mode === 'gene' || mode === 'feature' ? `Fuzzy ${fuzzy ? 'on' : 'off'} (^F) · case ${caseSensitive ? 'on' : 'off'} (^T)` : 'Ctrl+U clear query · Ctrl+R reload and retry'}</Text>
      <Text color={unavailable || currentOutcome?.error ? colors.warning : colors.textDim} wrap="truncate-end">{label(status)}</Text>
      <Box flexDirection="column" height={pageSize}>
        {(mode === 'catalog' ? catalog : hits).slice(offset, offset + pageSize).map((item, relative) => {
          const active = offset + relative === selected;
          const text = 'accession' in item ? `${item.name} · ${item.accession}${item.host ? ` · ${item.host}` : ''}`
            : `${item.wrapsOrigin && item.segments ? item.segments.map(segment => `[${segment.start},${segment.end})`).join(' + ') + ' wraps origin' : `[${item.position},${item.end})`} ${item.strand} · ${item.label}`;
          return <Text key={offset + relative} color={active ? colors.accent : colors.textDim} bold={active} wrap="truncate-end">{active ? '▶ ' : '  '}{label(text)}</Text>;
        })}
      </Box>
      <Text color={colors.textMuted} wrap="truncate-end">{count > 0 ? `${selected + 1}/${count}${count > pageSize ? ' · ↑↓ to see more results' : ''}` : ' '}</Text>
      <Text color={colors.textMuted} wrap="truncate-end">{chosen?.context ? `Context: ${label(chosen.context)}` : ' '}</Text>
      <Text color={colors.info} wrap="truncate-end">Tab/Shift+Tab mode · ↑↓ select · Enter open · Esc close</Text>
      <Text color={colors.textMuted} wrap="truncate-end">Ctrl+R retry · Ctrl+U clear · coordinates 0-based, end exclusive</Text>
    </Box>
  );
}
