/**
 * CommandPalette - Fuzzy Search & Keyboard Navigation
 *
 * A VS Code-style command palette with:
 * - Fuzzy search with highlighting
 * - Category grouping
 * - Keyboard navigation
 * - Recent commands
 * - Context-sensitive filtering
 * - Experience-level filtering
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as Comlink from 'comlink';
import { useTheme } from '../../hooks/useTheme';
import { useFileSystem } from '../../hooks/useFileSystem';
import type { PhageRepository } from '../../db';
import type { BrowserNavigationSession } from '../../hooks/BrowserNavigationSession';
import {
  ActionIds,
  ActionRegistryList,
  isVisibleToUser,
} from '../../keyboard/actionRegistry';
import {
  OverlayProvenance,
  provenanceLabel,
  type ProvenanceLevel,
} from './primitives/OverlayProvenance';
import {
  formatKeyCombo,
  type KeyCombo,
  type ExperienceLevel as KbExperienceLevel,
} from '../../keyboard/types';
import { detectShortcutPlatform, formatPrimaryActionShortcut } from '../../keyboard/actionSurfaces';
import { Overlay } from './Overlay';
import { useOverlay, type OverlayId } from './OverlayProvider';
import { usePhageStore } from '@phage-explorer/state';
import { formatFasta, downloadString, copyToClipboard, buildSequenceClipboardPayload } from '../../utils/export';
import { getSearchWorker, type SearchWorkerAPI, type FuzzySearchEntry, type FuzzySearchResult } from '../../workers';
import { useToast } from '../ui/Toast';
import {
  IconAperture,
  IconArrowRight,
  IconBookmark,
  IconContrast,
  IconDownload,
  IconLayers,
  IconLearn,
  IconTrendingUp,
  IconZap,
} from '../ui/icons';

// Experience levels for progressive disclosure
type ExperienceLevel = 'novice' | 'intermediate' | 'power';

// Context tags for filtering
type CommandContext =
  | 'always'           // Always show
  | 'has-phage'        // When a phage is loaded
  | 'dna-mode'         // When in DNA view
  | 'amino-mode'       // When in amino acid view
  | 'has-selection'    // When sequence is selected
  | 'has-diff-ref'     // When diff reference is set
  | 'simulation-active'; // When simulation is running

interface Command {
  id: string;
  label: string;
  description?: string;
  category: string;
  shortcut?: string;
  action: () => void;
  matchIndices?: number[];
  // New fields for filtering
  minLevel?: ExperienceLevel;        // Minimum experience level to show
  contexts?: CommandContext[];       // Show only in these contexts (empty = always)
  /**
   * Where this command's overlay gets its numbers, when it opens one.
   *
   * Shown in the result row so a demo-driven or heuristic overlay is
   * identifiable BEFORE it is opened. The Analysis Menu already did this; the
   * palette is the other way in and was missing it, so the same overlay was
   * labelled by one entry point and not the other.
   */
  provenance?: ProvenanceLevel;
  /** The weaker level it degrades to, for overlays that can fall back. */
  provenanceFallback?: ProvenanceLevel;
}

type CommandPaletteFuzzyMeta =
  | { kind: 'phage'; phageId: number; host?: string | null }
  | { kind: 'gene'; phageId: number; startPos: number; endPos?: number; locusTag?: string | null };

// Fuzzy search scoring
function fuzzyMatch(pattern: string, str: string): { match: boolean; score: number; indices: number[] } {
  const patternLower = pattern.toLowerCase();
  const strLower = str.toLowerCase();
  const indices: number[] = [];
  let patternIdx = 0;
  let score = 0;
  let prevMatchIdx = -1;

  for (let i = 0; i < strLower.length && patternIdx < patternLower.length; i++) {
    if (strLower[i] === patternLower[patternIdx]) {
      indices.push(i);
      // Bonus for consecutive matches
      if (prevMatchIdx === i - 1) {
        score += 2;
      }
      // Bonus for matching at start or after separator
      if (i === 0 || strLower[i - 1] === ' ' || strLower[i - 1] === ':') {
        score += 3;
      }
      score += 1;
      prevMatchIdx = i;
      patternIdx++;
    }
  }

  return {
    match: patternIdx === patternLower.length,
    score,
    indices,
  };
}

// Highlight matched characters
function highlightMatch(text: string, indices: number[], highlightColor: string): React.ReactNode {
  if (indices.length === 0) return text;

  const result: React.ReactNode[] = [];
  let lastIdx = 0;

  for (const idx of indices) {
    if (idx > lastIdx) {
      result.push(text.slice(lastIdx, idx));
    }
    result.push(
      <span key={idx} style={{ color: highlightColor, fontWeight: 'bold' }}>
        {text[idx]}
      </span>
    );
    lastIdx = idx + 1;
  }

  if (lastIdx < text.length) {
    result.push(text.slice(lastIdx));
  }

  return result;
}

// Experience level hierarchy for comparison
const LEVEL_ORDER: Record<ExperienceLevel, number> = {
  novice: 0,
  intermediate: 1,
  power: 2,
};

function meetsLevelRequirement(userLevel: ExperienceLevel, requiredLevel?: ExperienceLevel): boolean {
  if (!requiredLevel) return true;
  return LEVEL_ORDER[userLevel] >= LEVEL_ORDER[requiredLevel];
}

/**
 * Format shortcuts from ActionRegistry for display
 * Returns empty string if no shortcut defined
 */
function formatRegistryShortcut(shortcut: KeyCombo | KeyCombo[]): string {
  if (!shortcut || (Array.isArray(shortcut) && shortcut.length === 0)) {
    return '';
  }
  const combos = Array.isArray(shortcut) ? shortcut : [shortcut];
  return combos.map(formatKeyCombo).join(' / ');
}

/**
 * Map experience level from keyboard types to command palette types
 */
function mapExperienceLevel(level?: KbExperienceLevel): ExperienceLevel | undefined {
  return level as ExperienceLevel | undefined;
}

// Category icons for visual scanning
const CATEGORY_ICON_SIZE = 14;
const DEFAULT_CATEGORY_ICON = <IconLayers size={CATEGORY_ICON_SIZE} />;
const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Theme: <IconContrast size={CATEGORY_ICON_SIZE} />,
  Navigation: <IconArrowRight size={CATEGORY_ICON_SIZE} />,
  Analysis: <IconTrendingUp size={CATEGORY_ICON_SIZE} />,
  Advanced: <IconLayers size={CATEGORY_ICON_SIZE} />,
  View: <IconAperture size={CATEGORY_ICON_SIZE} />,
  Export: <IconDownload size={CATEGORY_ICON_SIZE} />,
  Simulation: <IconZap size={CATEGORY_ICON_SIZE} />,
  Reference: <IconBookmark size={CATEGORY_ICON_SIZE} />,
  Education: <IconLearn size={CATEGORY_ICON_SIZE} />,
};

// Recent commands storage
const RECENT_COMMANDS_KEY = 'phage-explorer-recent-commands';
const MAX_RECENT_COMMANDS = 5;

function getRecentCommands(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addRecentCommand(commandId: string): void {
  try {
    const recent = getRecentCommands().filter(id => id !== commandId);
    recent.unshift(commandId);
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_COMMANDS)));
  } catch {
    // Ignore storage errors
  }
}

// Current context detection (simplified - would hook into actual app state)
interface AppContext {
  hasPhage: boolean;
  viewMode: 'dna' | 'amino';
  hasSelection: boolean;
  hasDiffRef: boolean;
  simulationActive: boolean;
}

function matchesContext(cmd: Command, ctx: AppContext): boolean {
  const contexts = cmd.contexts;
  if (!contexts || contexts.length === 0 || contexts.includes('always')) {
    return true;
  }

  for (const c of contexts) {
    switch (c) {
      case 'has-phage': if (ctx.hasPhage) return true; break;
      case 'dna-mode': if (ctx.viewMode === 'dna') return true; break;
      case 'amino-mode': if (ctx.viewMode === 'amino') return true; break;
      case 'has-selection': if (ctx.hasSelection) return true; break;
      case 'has-diff-ref': if (ctx.hasDiffRef) return true; break;
      case 'simulation-active': if (ctx.simulationActive) return true; break;
    }
  }
  return false;
}

interface CommandPaletteProps {
  navigationSession?: BrowserNavigationSession;
  repository: PhageRepository | null;
  onSelectPhage: (index: number) => Promise<void>;
  commands?: Command[];
  /** Current app context for filtering */
  context?: Partial<AppContext>;
}

export function CommandPalette({ repository, onSelectPhage, navigationSession, commands: customCommands, context: propContext }: CommandPaletteProps): React.ReactElement | null {
  const { theme, setTheme, availableThemes } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, open, close, isMobile } = useOverlay();
  const { toast: showToast } = useToast();
  const { save: saveFileWithPicker, copy: copyWithFileSystem } = useFileSystem();
  const paletteOpen = isOpen('commandPalette');
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const [query, setQuery] = useState('');
  const [requestedIndex, setSelectedIndex] = useState(0);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  type PaletteEntries = Array<FuzzySearchEntry<CommandPaletteFuzzyMeta>>;
  const [indexedEntries, setIndexedEntries] = useState<PaletteEntries | null>(null);
  const [catalogMatches, setCatalogMatches] = useState<{
    query: string;
    entries: PaletteEntries;
    commands: Command[];
  } | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const usingPreloadedRef = useRef(false);

  // Get user's experience level from main store
  const experienceLevel = usePhageStore((s) => s.experienceLevel) as ExperienceLevel;
  const setExperienceLevel = usePhageStore((s) => s.setExperienceLevel);
  const viewMode = usePhageStore((s) => s.viewMode);
  const phageSummaries = usePhageStore((s) => s.phages);
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const diffReferenceSequence = usePhageStore((s) => s.diffReferenceSequence);
  const activeSimulationId = usePhageStore((s) => s.activeSimulationId);
  const beginnerModeEnabled = usePhageStore((s) => s.beginnerModeEnabled);
  const toggleBeginnerMode = usePhageStore((s) => s.toggleBeginnerMode);
  const setBeginnerModeEnabled = usePhageStore((s) => s.setBeginnerModeEnabled);
  const openGlossary = usePhageStore((s) => s.openGlossary);
  const startTour = usePhageStore((s) => s.startTour);
  // We need these for action implementations
  const toggleSequenceViewMode = usePhageStore((s) => s.toggleViewMode);
  const setReadingFrame = usePhageStore((s) => s.setReadingFrame);
  const readingFrame = usePhageStore((s) => s.readingFrame);
  const setScrollPosition = usePhageStore((s) => s.setScrollPosition);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const currentPhageIndex = usePhageStore((s) => s.currentPhageIndex);

  // Merge prop context with inferred context
  const appContext: AppContext = useMemo(() => ({
    hasPhage: Boolean(currentPhage),
    viewMode: viewMode === 'aa' ? 'amino' : 'dna',
    hasSelection: false,
    hasDiffRef: Boolean(diffReferenceSequence),
    simulationActive: Boolean(activeSimulationId),
    ...propContext,
  }), [activeSimulationId, currentPhage, diffReferenceSequence, propContext, viewMode]);

  // Load recent commands on mount
  useEffect(() => {
    setRecentCommandIds(getRecentCommands());
  }, []);

  // Initialize search worker for off-main-thread fuzzy search (prefer preloaded).
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;

    const preloaded = getSearchWorker();
    if (preloaded) {
      usingPreloadedRef.current = true;
      workerInstanceRef.current = preloaded.worker;
      workerRef.current = preloaded.api;
      if (preloaded.ready) {
        setWorkerReady(true);
      } else {
        void (async () => {
          try {
            await preloaded.api.ping();
            if (!cancelled) setWorkerReady(true);
          } catch {
            // Keep workerReady false; the palette still works for commands.
          }
        })();
      }
      return () => {
        cancelled = true;
        workerInstanceRef.current = null;
        workerRef.current = null;
        setWorkerReady(false);
      };
    }

    usingPreloadedRef.current = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url));
      } catch {
        // A browser may disallow workers entirely. Registered commands still work.
        return;
      }
    }
    workerInstanceRef.current = worker;
    const wrapped = Comlink.wrap<SearchWorkerAPI>(worker);
    workerRef.current = wrapped;

    void (async () => {
      try {
        await wrapped.ping();
        if (!cancelled) setWorkerReady(true);
      } catch {
        // Keep workerReady false; the palette still works for commands.
      }
    })();

    return () => {
      cancelled = true;
      if (!usingPreloadedRef.current && workerInstanceRef.current) {
        workerInstanceRef.current.terminate();
      }
      workerInstanceRef.current = null;
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, [paletteOpen]);

  const executeCommand = useCallback((cmd: Command) => {
    addRecentCommand(cmd.id);
    setRecentCommandIds(getRecentCommands());
    cmd.action();
    close('commandPalette');
  }, [close]);

  const readSelectedSequence = useCallback(async () => {
    const phage = usePhageStore.getState().currentPhage;
    if (!repository || !phage) throw new Error('No genome is selected.');
    const length = phage.genomeLength ?? await repository.getFullGenomeLength(phage.id);
    const sequence = await repository.getSequenceWindow(phage.id, 0, length);
    if (!sequence) throw new Error('The selected genome has no sequence available.');
    return { phage, sequence };
  }, [repository]);

  // Implementations for non-overlay actions
  const commandImpls = useMemo<Record<string, () => void>>(() => ({
    [ActionIds.NavBack]: () => { void navigationSession?.moveHistory(-1).then(ok => {
      if (!ok) showToast({ variant: 'error', message: navigationSession.getSnapshot().error ?? 'Previous view restoration was cancelled.' });
    }); },
    [ActionIds.NavForward]: () => { void navigationSession?.moveHistory(1).then(ok => {
      if (!ok) showToast({ variant: 'error', message: navigationSession.getSnapshot().error ?? 'Next view restoration was cancelled.' });
    }); },
    [ActionIds.NavNextPhage]: () => {
      if (phageSummaries.length > 0) {
        const nextIndex = (currentPhageIndex + 1) % phageSummaries.length;
        void onSelectPhage(nextIndex);
      }
    },
    [ActionIds.NavPrevPhage]: () => {
      if (phageSummaries.length > 0) {
        const prevIndex = (currentPhageIndex - 1 + phageSummaries.length) % phageSummaries.length;
        void onSelectPhage(prevIndex);
      }
    },
    [ActionIds.ViewCycleTheme]: () => {
      const idx = availableThemes.findIndex((t) => t.id === theme.id);
      const next = availableThemes[(idx + 1) % availableThemes.length];
      setTheme(next.id);
    },
    [ActionIds.ViewCycleMode]: () => {
      toggleSequenceViewMode();
    },
    [ActionIds.ViewCycleReadingFrame]: () => {
      const frames: Array<0 | 1 | 2 | -1 | -2 | -3> = [0, 1, 2, -1, -2, -3];
      const currentIdx = frames.indexOf(readingFrame as typeof frames[number]);
      const nextIdx = (currentIdx + 1) % frames.length;
      setReadingFrame(frames[nextIdx]);
    },
    [ActionIds.ViewScrollStart]: () => {
      setScrollPosition(0);
    },
    [ActionIds.ViewScrollEnd]: () => {
      const len = currentPhage?.genomeLength || 0;
      setScrollPosition(len);
    },
    [ActionIds.ViewZoomIn]: () => {
      const store = usePhageStore.getState();
      const current = store.zoomScale ?? 1.0;
      store.setZoomScale(Math.min(4.0, current * 1.2));
    },
    [ActionIds.ViewZoomOut]: () => {
      const store = usePhageStore.getState();
      const current = store.zoomScale ?? 1.0;
      store.setZoomScale(Math.max(0.1, current / 1.2));
    },
    [ActionIds.ViewToggle3DModel]: () => {
      toggle3DModel();
    },
    [ActionIds.EducationToggleBeginnerMode]: () => {
      toggleBeginnerMode();
    },
    [ActionIds.ExportFasta]: async () => {
      let selected: Awaited<ReturnType<typeof readSelectedSequence>>;
      try { selected = await readSelectedSequence(); }
      catch (error) {
        showToast({ variant: 'error', message: error instanceof Error ? error.message : 'Could not load the selected sequence.' });
        return;
      }
      const name = selected.phage.name;
      const fasta = formatFasta(`${name} [exported from Phage Explorer]`, selected.sequence);
      try {
        await saveFileWithPicker(fasta, {
          suggestedName: `${name.replace(/\s+/g, '_')}.fasta`,
          types: [{
            description: 'FASTA File',
            accept: { 'text/plain': ['.fasta', '.fa', '.fna'] },
          }],
        });
        showToast({ variant: 'success', message: 'Sequence exported as FASTA.' });
      } catch {
        downloadString(fasta, `${name.replace(/\s+/g, '_')}.fasta`);
      }
    },
    [ActionIds.ExportCopy]: async () => {
      let selected: Awaited<ReturnType<typeof readSelectedSequence>>;
      try { selected = await readSelectedSequence(); }
      catch (error) {
        showToast({ variant: 'error', message: error instanceof Error ? error.message : 'Could not load the selected sequence.' });
        return;
      }
      const header = `${selected.phage.name} | ${selected.phage.accession}`;
      const payload = buildSequenceClipboardPayload({ header, sequence: selected.sequence, wrap: 80 });
      copyWithFileSystem(payload.text, 'text/plain')
        .then(() => showToast({ variant: 'success', message: 'Sequence copied as FASTA text.' }))
        .catch(() => copyToClipboard(payload.text, payload.html)
          .then(() => showToast({ variant: 'success', message: 'Sequence copied (text + HTML).' }))
          .catch(() => showToast({ variant: 'error', message: 'Failed to copy sequence.' })));
    },
    [ActionIds.ExportJson]: async () => {
      const state = usePhageStore.getState();
      const exportData = {
        phage: state.currentPhage,
        overlays: state.overlayData,
        timestamp: new Date().toISOString(),
      };
      const jsonStr = JSON.stringify(exportData, null, 2);
      try {
        await saveFileWithPicker(jsonStr, {
          suggestedName: `${(state.currentPhage?.name || 'phage').replace(/\s+/g, '_')}_analysis.json`,
          types: [{
            description: 'JSON Analysis Export',
            accept: { 'application/json': ['.json'] },
          }],
        });
        showToast({ variant: 'success', message: 'Analysis exported as JSON.' });
      } catch {
        downloadString(jsonStr, 'analysis_export.json', 'application/json');
      }
    },
    'edu:enable-beginner': () => {
      if (!beginnerModeEnabled) setBeginnerModeEnabled(true);
    },
    'edu:open-glossary': () => {
      setBeginnerModeEnabled(true);
      openGlossary();
    },
    'edu:start-welcome-tour': () => {
      setBeginnerModeEnabled(true);
      startTour('welcome');
      open('tour');
    },
  }), [
    availableThemes, beginnerModeEnabled, currentPhage, currentPhageIndex, navigationSession,
    open, openGlossary, phageSummaries, readingFrame, setBeginnerModeEnabled, onSelectPhage,
    setReadingFrame, setScrollPosition, setTheme, showToast, startTour, theme.id,
    toggle3DModel, toggleBeginnerMode, toggleSequenceViewMode, readSelectedSequence
  ]);

  // Generate commands from ActionRegistry (single source of truth for shortcuts)
  const registryCommands: Command[] = useMemo(() => {
    const actionCommands: Command[] = [];

    for (const def of ActionRegistryList) {
      if (!isVisibleToUser(def)) continue;
      let action: (() => void) | undefined;

      if (def.overlayId) {
        const overlayId = def.overlayId as OverlayId;
        action = def.overlayAction === 'toggle'
          ? () => { close('commandPalette'); toggle(overlayId); }
          : () => { close('commandPalette'); open(overlayId); };
      } else {
        action = commandImpls[def.id];
      }

      if (!action) continue;

      let contexts: CommandContext[] | undefined = undefined;
      // Supplied-locus excision and saved attachment replay are self-contained.
      if (def.id !== ActionIds.OverlayProphageExcision &&
          ['Analysis', 'Simulation', 'Comparison', 'Advanced'].includes(def.category)) {
        contexts = ['has-phage'];
      }
      if (def.id === ActionIds.ExportFasta || def.id === ActionIds.ExportCopy || def.id === ActionIds.ExportJson) {
        contexts = ['has-phage'];
      }

      const shortcut = formatPrimaryActionShortcut(def, shortcutPlatform) ?? undefined;

      actionCommands.push({
        id: def.id,
        label: def.title,
        category: def.category,
        description: def.description,
        shortcut,
        action,
        minLevel: mapExperienceLevel(def.minLevel),
        contexts,
        provenance: def.provenance,
        provenanceFallback: def.provenanceFallback,
      });
    }

    const themeCommands: Command[] = availableThemes.map((next) => ({
      id: `theme:${next.id}`,
      label: next.id === theme.id ? `Theme: ${next.name} (current)` : `Theme: ${next.name}`,
      category: 'Theme',
      action: () => setTheme(next.id),
      minLevel: 'novice' as const,
    }));

    const eduCommands: Command[] = [
      {
        id: 'edu:open-glossary',
        label: 'Open Glossary',
        category: 'Education',
        action: commandImpls['edu:open-glossary']!,
        minLevel: 'novice' as const,
      },
      {
        id: 'edu:start-welcome-tour',
        label: 'Start Welcome Tour',
        category: 'Education',
        action: commandImpls['edu:start-welcome-tour']!,
        minLevel: 'novice' as const,
      },
    ];

    return [...themeCommands, ...actionCommands, ...eduCommands];
  }, [availableThemes, close, commandImpls, open, setTheme, shortcutPlatform, theme.id, toggle]);

  const allCommands = customCommands ?? registryCommands;

  // The worker indexes the catalog. Registered commands are immediately searchable
  // by title, category and description even while the worker is starting.
  const entries = useMemo(() => {
    const entries: PaletteEntries = [];
    if (!paletteOpen) return entries;

    for (const p of phageSummaries) {
      entries.push({
        id: `phage:${p.id}`,
        text: p.name,
        meta: { kind: 'phage', phageId: p.id, host: p.host },
      });
    }

    if (currentPhage?.id && Array.isArray(currentPhage.genes)) {
      for (const g of currentPhage.genes) {
        const label = g.product ?? g.name ?? g.locusTag ?? '';
        if (!label) continue;
        entries.push({
          id: `gene:${g.id}`,
          text: label,
          meta: {
            kind: 'gene',
            phageId: currentPhage.id,
            startPos: g.startPos ?? 0,
            endPos: g.endPos ?? undefined,
            locusTag: g.locusTag ?? null,
          },
        });
      }
    }

    return entries;
  }, [currentPhage?.genes, currentPhage?.id, paletteOpen, phageSummaries]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!paletteOpen || !workerReady || !worker) return;
    let active = true;
    void worker.setFuzzyIndex({ index: 'command-palette', entries }).then(() => {
      if (active) setIndexedEntries(entries);
    }).catch(() => {
      if (active) setIndexedEntries(null);
    });
    return () => { active = false; };
  }, [entries, paletteOpen, workerReady]);

  // Filter commands by experience level and context
  const commands = useMemo(() => {
    return allCommands.filter(cmd => {
      // Check experience level
      if (!meetsLevelRequirement(experienceLevel, cmd.minLevel)) {
        return false;
      }
      // Check context
      if (!matchesContext(cmd, appContext)) {
        return false;
      }
      return true;
    });
  }, [allCommands, experienceLevel, appContext]);

  // Get recent commands that are still available
  const recentCommands = useMemo(() => {
    return recentCommandIds
      .map(id => commands.find(cmd => cmd.id === id))
      .filter((cmd): cmd is Command => cmd !== undefined)
      .slice(0, 5);
  }, [recentCommandIds, commands]);

  const searchTerm = query.trim();
  const matchingCommands = useMemo(() => {
    if (!searchTerm) return commands;

    return commands.flatMap(command => {
      const label = fuzzyMatch(searchTerm, command.label);
      const category = fuzzyMatch(searchTerm, command.category);
      const description = fuzzyMatch(searchTerm, command.description ?? '');
      const matches = [label, category, description].filter(result => result.match);
      if (!matches.length) return [];
      return [{
        command: { ...command, matchIndices: label.match ? label.indices : [] },
        titleMatch: label.match,
        score: Math.max(...matches.map(result => result.score)),
      }];
    }).sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.score - a.score)
      .map(result => result.command);
  }, [commands, searchTerm]);

  // Append catalog results so an asynchronous reply cannot move the highlighted
  // command. Tag replies with their query AND source to exclude stale targets
  // during rendering, even before the previous effect's cleanup has run.
  const filteredCommands = useMemo(() => {
    if (!workerReady || !searchTerm || catalogMatches?.query !== searchTerm ||
        catalogMatches.entries !== entries || indexedEntries !== entries) return matchingCommands;
    return [...matchingCommands, ...catalogMatches.commands];
  }, [catalogMatches, entries, indexedEntries, matchingCommands, searchTerm, workerReady]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!paletteOpen || !workerReady || !worker || indexedEntries !== entries || !searchTerm) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const results = await worker.fuzzySearch({
            index: 'command-palette', query: searchTerm, limit: 30,
          }) as Array<FuzzySearchResult<CommandPaletteFuzzyMeta>>;
          if (!active) return;

          const catalogCommands: Command[] = [];
          for (const result of results) {
            const meta = result.meta;
            if (meta?.kind === 'phage') {
              catalogCommands.push({
                id: `nav:phage:${meta.phageId}`, label: result.text, matchIndices: result.indices,
                description: meta.host ? `Host: ${meta.host}` : undefined,
                category: 'Phages',
                action: () => {
                  const idx = usePhageStore.getState().phages.findIndex(p => p.id === meta.phageId);
                  if (idx >= 0) void onSelectPhage(idx);
                },
              });
            } else if (meta?.kind === 'gene') {
              catalogCommands.push({
                id: `nav:gene:${result.id}`, label: result.text, matchIndices: result.indices,
                description: `Jump to ${meta.startPos.toLocaleString()} bp${meta.locusTag ? ` · ${meta.locusTag}` : ''}`,
                category: 'Genes',
                action: () => {
                  const state = usePhageStore.getState();
                  if (state.currentPhage?.id !== meta.phageId) return;
                  const target = state.viewMode === 'aa' ? Math.floor(meta.startPos / 3) : meta.startPos;
                  state.setScrollPosition(target);
                },
              });
            }
          }
          setCatalogMatches({ query: searchTerm, entries, commands: catalogCommands });
        } catch {
          if (active) setCatalogMatches(null);
        }
      })();
    }, 80);

    return () => { active = false; window.clearTimeout(timer); };
  }, [entries, indexedEntries, onSelectPhage, paletteOpen, searchTerm, workerReady]);

  // Focus input when opened
  useEffect(() => {
    if (paletteOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [paletteOpen]);

  const groupedCommands = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const cmd of filteredCommands) {
      const group = groups.get(cmd.category);
      if (group) group.push(cmd);
      else groups.set(cmd.category, [cmd]);
    }
    return Array.from(groups.entries());
  }, [filteredCommands]);

  // A command can appear twice (recent and by category). Keep the keyboard index
  // in exactly the same section and row order as the rendered listbox.
  const showRecent = !query.trim() && recentCommands.length > 0;
  const visibleCommands = useMemo(() => [
    ...(showRecent ? recentCommands : []),
    ...groupedCommands.flatMap(([, group]) => group),
  ], [groupedCommands, recentCommands, showRecent]);
  const totalItems = visibleCommands.length;
  const selectedIndex = Math.min(requestedIndex, Math.max(0, totalItems - 1));

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'Escape':
        if (query.trim()) {
          e.preventDefault();
          setQuery('');
          setSelectedIndex(0);
        }
        break;
      case 'ArrowDown':
        if (totalItems === 0) break;
        e.preventDefault();
        setSelectedIndex(Math.min(selectedIndex + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        if (totalItems === 0) break;
        e.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        const cmd = visibleCommands[selectedIndex];
        if (cmd) {
          executeCommand(cmd);
        }
        break;
      case 'Tab':
        if (e.shiftKey || totalItems === 0) break;
        e.preventDefault();
        // Tab completion: fill in the selected command's label
        const tabCmd = visibleCommands[selectedIndex];
        if (tabCmd) {
          setQuery(tabCmd.label);
          setSelectedIndex(0);
        }
        break;
    }
  }, [executeCommand, query, selectedIndex, totalItems, visibleCommands]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selectedElement = list.querySelector<HTMLElement>(`[data-cmd-index="${selectedIndex}"]`);
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const paletteHotkey = useMemo(() => {
    const action = ActionRegistryList.find((a) => a.id === ActionIds.OverlayCommandPalette);
    return action ? formatRegistryShortcut(action.defaultShortcut) : '';
  }, []);

  if (!paletteOpen) {
    return null;
  }

  let flatIndex = 0;

  return (
    <Overlay
      id="commandPalette"
      title="Command palette"
      hotkey={paletteHotkey || undefined}
      size="md"
      position={isMobile ? 'bottom' : 'top'}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          height: isMobile ? '100%' : undefined,
          minHeight: isMobile ? 0 : undefined,
        }}
      >
        {/* Experience level filter */}
        <div
          role="group"
          aria-label="Experience level filter"
          aria-labelledby="exp-level-label"
          className="command-palette__experience"
        >
          <span id="exp-level-label" className="command-palette__experience-label">Experience</span>
          {(['novice', 'intermediate', 'power'] as ExperienceLevel[]).map((level) => {
            const active = level === experienceLevel;
            const descriptions: Record<ExperienceLevel, string> = {
              novice: 'Show only essential commands',
              intermediate: 'Show standard and analysis commands',
              power: 'Show all commands including advanced features',
            };
            return (
              <button
                key={level}
                onClick={() => { setExperienceLevel(level); setSelectedIndex(0); }}
                aria-pressed={active}
                aria-label={`${level} experience level: ${descriptions[level]}`}
                className={`btn command-palette__experience-btn ${active ? 'is-active' : ''}`}
                type="button"
              >
                {level}
              </button>
            );
          })}
          <span className="command-palette__experience-hint" aria-hidden="true">
            Novice shows core actions; Power reveals everything.
          </span>
        </div>

        {/* Search input */}
        <input
          ref={inputRef}
          data-overlay-autofocus="true"
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder="Type to search commands..."
          className="input"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search commands"
          aria-describedby="command-palette-hints"
          aria-controls="command-palette-list"
          aria-activedescendant={totalItems > 0 ? `cmd-item-${selectedIndex}` : undefined}
          role="combobox"
          aria-expanded="true"
          aria-haspopup="listbox"
          data-testid="command-palette-input"
        />

        {/* Screen reader result announcement */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          style={{ position: 'absolute', left: '-9999px', height: '1px', overflow: 'hidden' }}
        >
          {query.trim() ? `${filteredCommands.length} commands found` : `${totalItems} commands available`}
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Available commands"
          className="scrollable-y"
          data-testid="command-palette-results"
          style={
            isMobile
              ? { flex: 1, minHeight: 0 }
              : { maxHeight: '400px' }
          }
        >
          {/* Recent commands section (only show when no query) */}
          {showRecent && (
            <div role="group" aria-label="Recent commands">
              <div className="text-muted text-xs uppercase tracking-wider p-2 border-b border-border-light flex items-center gap-2" aria-hidden="true">
                <span>⏱</span>
                <span>Recent</span>
              </div>
              {recentCommands.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={`recent-${cmd.id}`}
                    id={`cmd-item-${currentIndex}`}
                    data-cmd-index={currentIndex}
                    data-testid="command-palette-result"
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                  >
                    <span className={isSelected ? 'text-text' : 'text-dim'}>
                      {cmd.label}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                      {/* Measured is the majority and needs no badge; anything
                          weaker does, and it has to be visible here rather than
                          only after the overlay opens. */}
                      {cmd.provenance && cmd.provenance !== 'measured' && (
                        <OverlayProvenance
                          level={cmd.provenance}
                          source={
                            cmd.provenanceFallback
                              ? `falls back to ${provenanceLabel(cmd.provenanceFallback).toLowerCase()}`
                              : undefined
                          }
                        />
                      )}
                      {cmd.shortcut && (
                        <span className="key-hint" aria-label={`Shortcut: ${cmd.shortcut}`}>
                          {cmd.shortcut}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {groupedCommands.map(([category, cmds]) => (
            <div key={category} role="group" aria-label={`${category} commands`}>
              <div className="text-muted text-xs uppercase tracking-wider p-2 border-b border-border-light flex items-center gap-2" aria-hidden="true">
                <span className="command-palette-category-icon" aria-hidden="true">
                  {CATEGORY_ICONS[category] ?? DEFAULT_CATEGORY_ICON}
                </span>
                <span>{category}</span>
                <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>({cmds.length})</span>
              </div>
              {cmds.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={cmd.id}
                    id={`cmd-item-${currentIndex}`}
                    data-cmd-index={currentIndex}
                    data-testid="command-palette-result"
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                  >
                    <div>
                      <span className={isSelected ? 'text-text' : 'text-dim'}>
                        {cmd.matchIndices
                          ? highlightMatch(cmd.label, cmd.matchIndices, colors.accent)
                          : cmd.label}
                      </span>
                      {cmd.description && (
                        <span className="text-muted text-xs ml-2">
                          {cmd.description}
                        </span>
                      )}
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                      {/* The main results list. The recent-commands list above
                          renders the same badge; both are needed, because the
                          palette shows one or the other depending on whether a
                          query has been typed, and labelling only one means half
                          the users see no warning. */}
                      {cmd.provenance && cmd.provenance !== 'measured' && (
                        <OverlayProvenance
                          level={cmd.provenance}
                          source={
                            cmd.provenanceFallback
                              ? `falls back to ${provenanceLabel(cmd.provenanceFallback).toLowerCase()}`
                              : undefined
                          }
                        />
                      )}
                      {cmd.shortcut && (
                        <span className="key-hint" aria-label={`Shortcut: ${cmd.shortcut}`}>
                          {cmd.shortcut}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          {filteredCommands.length === 0 && (
            <div style={{
              padding: '2rem',
              textAlign: 'center',
              color: colors.textMuted,
            }}>
              No commands found for "{query}"
            </div>
          )}
        </div>

        {/* Footer hints */}
        <div id="command-palette-hints" className="command-palette__hints">
          <span>↑↓ Navigate</span>
          <span>Enter Select</span>
          <span>Tab Complete</span>
          <span>ESC Close</span>
        </div>
      </div>
    </Overlay>
  );
}

export default CommandPalette;
