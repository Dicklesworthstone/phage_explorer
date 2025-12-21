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
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '@phage-explorer/state';
import { formatFasta, downloadString, copyToClipboard, buildSequenceClipboardPayload } from '../../utils/export';
import { getSearchWorker, type SearchWorkerAPI, type FuzzySearchEntry, type FuzzySearchResult } from '../../workers';
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
} from '../ui';

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
  // New fields for filtering
  minLevel?: ExperienceLevel;        // Minimum experience level to show
  contexts?: CommandContext[];       // Show only in these contexts (empty = always)
}

type CommandPaletteFuzzyMeta =
  | { kind: 'phage'; phageId: number; host?: string | null }
  | { kind: 'gene'; phageId: number; startPos: number; endPos?: number; locusTag?: string | null }
  | { kind: 'command'; commandId: string };

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
  commands?: Command[];
  /** Current app context for filtering */
  context?: Partial<AppContext>;
}

export function CommandPalette({ commands: customCommands, context: propContext }: CommandPaletteProps): React.ReactElement | null {
  const { theme, setTheme, availableThemes } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, open, close } = useOverlay();
  const paletteOpen = isOpen('commandPalette');
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const [fuzzyCommands, setFuzzyCommands] = useState<Command[]>([]);
  const [workerReady, setWorkerReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const usingPreloadedRef = useRef(false);
  const workerSeqRef = useRef(0);

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
      return;
    }

    usingPreloadedRef.current = false;
    const worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
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
  }, []);

  const executeCommand = useCallback((cmd: Command) => {
    addRecentCommand(cmd.id);
    setRecentCommandIds(getRecentCommands());
    cmd.action();
    close('commandPalette');
  }, [close]);

  // Default commands with experience levels and contexts
  const defaultCommands: Command[] = useMemo(() => [
    // Theme commands (available to all)
    ...availableThemes.map((next) => ({
      id: `theme:${next.id}`,
      label: next.id === theme.id ? `Theme: ${next.name} (current)` : `Theme: ${next.name}`,
      category: 'Theme',
      action: () => setTheme(next.id),
      minLevel: 'novice' as const,
    })),
    {
      id: 'nav:settings',
      label: 'Open Settings',
      category: 'Navigation',
      shortcut: 'Ctrl+,',
      action: () => { close(); open('settings'); },
      minLevel: 'novice',
    },

    // Overlay commands
    { id: 'overlay:help', label: 'Show Help', category: 'Navigation', shortcut: '?', action: () => { close(); open('help'); }, minLevel: 'novice' },
    { id: 'overlay:search', label: 'Search Phages', category: 'Navigation', shortcut: 's', action: () => { close(); open('search'); }, minLevel: 'novice' },
    { id: 'overlay:analysis', label: 'Analysis Menu', category: 'Analysis', shortcut: 'a', action: () => { close(); open('analysisMenu'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'overlay:simulation', label: 'Simulation Hub', category: 'Simulation', shortcut: 'S', action: () => { close(); open('simulationHub'); }, minLevel: 'intermediate' },
    { id: 'overlay:comparison', label: 'Genome Comparison', category: 'Analysis', shortcut: 'c', action: () => { close(); open('comparison'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'overlay:collaboration', label: 'Collaboration', category: 'Navigation', action: () => { close(); open('collaboration'); }, minLevel: 'intermediate' },

    // Analysis commands (require phage loaded)
    { id: 'analysis:gc', label: 'GC Skew Analysis', category: 'Analysis', shortcut: 'g', action: () => { close(); open('gcSkew'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:complexity', label: 'Sequence Complexity', category: 'Analysis', shortcut: 'x', action: () => { close(); open('complexity'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:bendability', label: 'DNA Bendability', category: 'Analysis', shortcut: 'b', action: () => { close(); open('bendability'); }, minLevel: 'intermediate', contexts: ['has-phage', 'dna-mode'] },
    { id: 'analysis:promoter', label: 'Promoter/RBS Sites', category: 'Analysis', shortcut: 'p', action: () => { close(); open('promoter'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:repeat', label: 'Repeat Finder', category: 'Analysis', shortcut: 'r', action: () => { close(); open('repeats'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:cgr', label: 'Chaos Game Representation', category: 'Analysis', shortcut: 'Alt+Shift+C', action: () => { close(); open('cgr'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:hilbert', label: 'Hilbert Curve Visualization', category: 'Analysis', shortcut: 'Alt+Shift+H', action: () => { close(); open('hilbert'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:dotplot', label: 'Dot Plot', category: 'Analysis', shortcut: 'Alt+O', action: () => { close(); open('dotPlot'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:gel', label: 'Virtual Gel Electrophoresis', category: 'Analysis', shortcut: 'Alt+G', action: () => { close(); open('gel'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:constraints', label: 'Structure Constraints', category: 'Analysis', shortcut: 'Alt+R', action: () => { close(); open('structureConstraint'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:non-b', label: 'Non-B DNA Structures', category: 'Analysis', shortcut: 'Alt+N', action: () => { close(); open('nonBDNA'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:crispr', label: 'CRISPR Arrays', category: 'Analysis', shortcut: 'Alt+C', action: () => { close(); open('crispr'); }, minLevel: 'intermediate', contexts: ['has-phage'] },

    // Advanced analysis (power users)
    { id: 'analysis:kmer', label: 'K-mer Anomaly Detection', category: 'Advanced', shortcut: 'j', action: () => { close(); open('kmerAnomaly'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:anomaly', label: 'Anomaly Detection', category: 'Advanced', shortcut: 'Alt+Y', action: () => { close(); open('anomaly'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:hgt', label: 'HGT Provenance', category: 'Advanced', shortcut: 'Alt+H', action: () => { close(); open('hgt'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:tropism', label: 'Tropism & Receptors', category: 'Advanced', shortcut: '0', action: () => { close(); open('tropism'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:bias', label: 'Codon Bias Decomposition', category: 'Advanced', shortcut: 'Alt+B', action: () => { close(); open('biasDecomposition'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:phase', label: 'Phase Portrait', category: 'Advanced', shortcut: 'Alt+Shift+P', action: () => { close(); open('phasePortrait'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:packaging', label: 'Packaging Pressure', category: 'Advanced', shortcut: 'v', action: () => { close(); open('pressure'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:stability', label: 'Virion Stability', category: 'Advanced', shortcut: 'Alt+V', action: () => { close(); open('stability'); }, minLevel: 'power', contexts: ['has-phage'] },

    { id: 'reference:aa-key', label: 'Amino Acid Key', category: 'Reference', shortcut: 'k', action: () => { close(); open('aaKey'); }, minLevel: 'novice' },
    { id: 'reference:aa-legend', label: 'Amino Acid Legend (compact)', category: 'Reference', shortcut: 'l', action: () => { close(); open('aaLegend'); }, minLevel: 'novice' },

    // Education commands
    {
      id: 'edu:toggle-beginner',
      label: beginnerModeEnabled ? 'Disable Beginner Mode' : 'Enable Beginner Mode',
      category: 'Education',
      shortcut: 'Ctrl+B',
      action: () => {
        toggleBeginnerMode();
      },
      minLevel: 'novice',
    },
    {
      id: 'edu:enable-beginner',
      label: 'Enable Beginner Mode',
      category: 'Education',
      action: () => {
        if (!beginnerModeEnabled) {
          setBeginnerModeEnabled(true);
        }
      },
      minLevel: 'novice',
    },
    {
      id: 'edu:open-glossary',
      label: 'Open Glossary',
      category: 'Education',
      action: () => {
        setBeginnerModeEnabled(true);
        openGlossary();
      },
      minLevel: 'novice',
    },
    {
      id: 'edu:start-welcome-tour',
      label: 'Start Welcome Tour',
      category: 'Education',
      action: () => {
        setBeginnerModeEnabled(true);
        startTour('welcome');
      },
      minLevel: 'novice',
    },

    // View commands (context-dependent)
    { id: 'view:dna', label: 'Switch to DNA Mode', category: 'View', shortcut: 'Space', action: () => {}, minLevel: 'novice', contexts: ['amino-mode'] },
    { id: 'view:aa', label: 'Switch to Amino Acid Mode', category: 'View', shortcut: 'Space', action: () => {}, minLevel: 'novice', contexts: ['dna-mode'] },
    { id: 'view:diff', label: 'Toggle Diff Mode', category: 'View', shortcut: 'd', action: () => {}, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'view:3d', label: 'Toggle 3D Model', category: 'View', shortcut: 'm', action: () => {}, minLevel: 'intermediate', contexts: ['has-phage'] },

    // Navigation commands
    { id: 'nav:start', label: 'Go to Start', category: 'Navigation', shortcut: 'gg', action: () => {}, minLevel: 'novice', contexts: ['has-phage'] },
    { id: 'nav:end', label: 'Go to End', category: 'Navigation', shortcut: 'G', action: () => {}, minLevel: 'novice', contexts: ['has-phage'] },
    { id: 'nav:goto', label: 'Go to Position...', category: 'Navigation', shortcut: 'Ctrl+g', action: () => { close(); open('goto'); }, minLevel: 'novice', contexts: ['has-phage'] },

    // Export commands (power users, require selection/phage)
    {
      id: 'export:fasta',
      label: 'Export as FASTA',
      category: 'Export',
      action: () => {
        const { currentPhage, diffReferenceSequence } = usePhageStore.getState();
        const seq = diffReferenceSequence;
        if (!seq || seq.length === 0) {
          alert('No sequence available to export yet.');
          return;
        }
        const name = currentPhage?.name || 'phage';
        const fasta = formatFasta(`${name} [exported from Phage Explorer]`, seq);
        downloadString(fasta, `${name.replace(/\s+/g, '_')}.fasta`);
        close();
      },
      minLevel: 'intermediate',
      contexts: ['has-phage']
    },
    {
      id: 'export:copy',
      label: 'Copy Sequence (rich clipboard)',
      category: 'Export',
      action: () => {
        const { currentPhage, diffReferenceSequence } = usePhageStore.getState();
        const seq = diffReferenceSequence;
        if (!seq || seq.length === 0) {
          alert('No sequence loaded to copy.');
          return;
        }
        const header = currentPhage ? `${currentPhage.name} | ${currentPhage.accession}` : 'phage-sequence';
        const payload = buildSequenceClipboardPayload({ header, sequence: seq, wrap: 80 });
        copyToClipboard(payload.text, payload.html)
          .then(() => alert('Sequence copied (text + HTML).'))
          .catch(() => alert('Failed to copy sequence.'));
        close();
      },
      minLevel: 'novice',
      contexts: ['has-phage'] // Sequence availability implied by context
    },
    {
      id: 'export:json',
      label: 'Export Analysis as JSON',
      category: 'Export',
      action: () => {
        const state = usePhageStore.getState();
        const exportData = {
          phage: state.currentPhage,
          overlays: state.overlayData,
          timestamp: new Date().toISOString(),
        };
        downloadString(JSON.stringify(exportData, null, 2), 'analysis_export.json', 'application/json');
        close();
      },
      minLevel: 'power',
      contexts: ['has-phage']
    },
  ], [availableThemes, close, open, setTheme, theme.id]);

  const allCommands = customCommands ?? defaultCommands;

  // Keep worker index in sync with current phage list + current phage genes.
  useEffect(() => {
    if (!workerReady || !workerRef.current) return;

    const entries: Array<FuzzySearchEntry<CommandPaletteFuzzyMeta>> = [];

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

    for (const cmd of allCommands) {
      if (!meetsLevelRequirement(experienceLevel, cmd.minLevel)) continue;
      if (!matchesContext(cmd, appContext)) continue;
      entries.push({
        id: `cmd:${cmd.id}`,
        text: cmd.label,
        meta: { kind: 'command', commandId: cmd.id },
      });
    }

    void workerRef.current.setFuzzyIndex({ index: 'command-palette', entries });
  }, [allCommands, appContext, currentPhage?.genes, currentPhage?.id, experienceLevel, phageSummaries, workerReady]);

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

  // Filter and sort commands based on query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return commands;
    }

    if (workerReady) {
      return fuzzyCommands;
    }

    const results = commands
      .map(cmd => {
        const labelMatch = fuzzyMatch(query, cmd.label);
        const categoryMatch = fuzzyMatch(query, cmd.category);
        const descMatch = cmd.description ? fuzzyMatch(query, cmd.description) : { match: false, score: 0, indices: [] };

        const bestMatch = [labelMatch, categoryMatch, descMatch].reduce((best, curr) =>
          curr.match && curr.score > best.score ? curr : best
        );

        return {
          command: cmd,
          match: labelMatch.match || categoryMatch.match || descMatch.match,
          score: bestMatch.score,
          labelIndices: labelMatch.indices,
        };
      })
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score);

    return results.map(r => ({ ...r.command, _indices: r.labelIndices }));
  }, [commands, fuzzyCommands, query, workerReady]);

  // Run off-main-thread fuzzy search (phages + current genes) as the user types.
  useEffect(() => {
    if (!paletteOpen) return;
    if (!workerReady || !workerRef.current) return;
    if (!query.trim()) {
      setFuzzyCommands([]);
      return;
    }

    const seq = ++workerSeqRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const results = (await workerRef.current!.fuzzySearch({
            index: 'command-palette',
            query,
            limit: 30,
          })) as Array<FuzzySearchResult<CommandPaletteFuzzyMeta>>;
          if (workerSeqRef.current !== seq) return;

          const commandById = new Map(commands.map((c) => [c.id, c] as const));

          const cmds = results
            .map((r) => {
              if (r.meta?.kind === 'command') {
                const base = commandById.get(r.meta.commandId);
                if (!base) return null;
                const cmd: Command = { ...base };
                (cmd as any)._indices = r.indices;
                return cmd;
              }

            if (r.meta?.kind === 'phage') {
              const phageId = r.meta.phageId;
              const cmd: Command = {
                id: `nav:phage:${phageId}`,
                label: r.text,
                description: r.meta.host ? `Host: ${r.meta.host}` : undefined,
                category: 'Phages',
                action: () => {
                  const state = usePhageStore.getState();
                  const idx = state.phages.findIndex((p) => p.id === phageId);
                  if (idx >= 0) state.setCurrentPhageIndex(idx);
                },
                minLevel: 'novice',
              };
              (cmd as any)._indices = r.indices;
              return cmd;
            }

            if (r.meta?.kind === 'gene') {
              const startBase = r.meta.startPos;
              const cmd: Command = {
                id: `nav:gene:${r.id}`,
                label: r.text,
                description: `Jump to ${startBase.toLocaleString()} bp${r.meta.locusTag ? ` · ${r.meta.locusTag}` : ''}`,
                category: 'Genes',
                action: () => {
                  const state = usePhageStore.getState();
                  const target = state.viewMode === 'aa' ? Math.floor(startBase / 3) : startBase;
                  state.setScrollPosition(target);
                },
                minLevel: 'novice',
                contexts: ['has-phage'],
              };
              (cmd as any)._indices = r.indices;
              return cmd;
            }

            const cmd: Command = {
              id: `nav:fuzzy:${r.id}`,
              label: r.text,
              category: 'Search',
              action: () => {},
              minLevel: 'novice',
            };
            (cmd as any)._indices = r.indices;
            return cmd;
            })
            .filter((c): c is Command => Boolean(c));

          setFuzzyCommands(cmds);
        } catch {
          if (workerSeqRef.current !== seq) return;
          setFuzzyCommands([]);
        }
      })();
    }, 80);

    return () => window.clearTimeout(timer);
  }, [commands, paletteOpen, query, workerReady]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length]);

  // Focus input when opened
  useEffect(() => {
    if (paletteOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [paletteOpen]);

  // Register hotkey
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return Boolean(target.closest('input, textarea, select'));
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === ':' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggle('commandPalette');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  // Total navigable items (recent commands + filtered commands)
  const showRecent = !query.trim() && recentCommands.length > 0;
  const totalItems = (showRecent ? recentCommands.length : 0) + filteredCommands.length;

  // Get command at a given flat index (accounting for recent commands)
  const getCommandAtIndex = useCallback((index: number): Command | undefined => {
    if (showRecent) {
      if (index < recentCommands.length) {
        return recentCommands[index];
      }
      return filteredCommands[index - recentCommands.length];
    }
    return filteredCommands[index];
  }, [showRecent, recentCommands, filteredCommands]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        const cmd = getCommandAtIndex(selectedIndex);
        if (cmd) {
          executeCommand(cmd);
        }
        break;
      case 'Tab':
        e.preventDefault();
        // Tab completion: fill in the selected command's label
        const tabCmd = getCommandAtIndex(selectedIndex);
        if (tabCmd) {
          setQuery(tabCmd.label);
        }
        break;
    }
  }, [executeCommand, getCommandAtIndex, selectedIndex, totalItems]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selectedElement = list.querySelector<HTMLElement>(`[data-cmd-index="${selectedIndex}"]`);
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!paletteOpen) {
    return null;
  }

  // Group commands by category
  const groupedCommands = filteredCommands.reduce((acc, cmd) => {
    if (!acc[cmd.category]) {
      acc[cmd.category] = [];
    }
    acc[cmd.category].push(cmd);
    return acc;
  }, {} as Record<string, Command[]>);

  let flatIndex = 0;

  return (
    <Overlay
      id="commandPalette"
      title="COMMAND PALETTE"
      hotkey=":"
      size="md"
      position="top"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {/* Experience level filter */}
        <div
          role="group"
          aria-label="Experience level filter"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
        >
          <span id="exp-level-label" style={{ color: colors.textMuted, fontSize: '0.9rem' }}>Experience</span>
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
                onClick={() => setExperienceLevel(level)}
                aria-pressed={active}
                aria-label={`${level} experience level: ${descriptions[level]}`}
                style={{
                  padding: '0.35rem 0.65rem',
                  borderRadius: '4px',
                  border: `1px solid ${active ? colors.accent : colors.border}`,
                  backgroundColor: active ? colors.accent : colors.background,
                  color: active ? '#000' : colors.text,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  fontWeight: active ? 700 : 500,
                }}
              >
                {level}
              </button>
            );
          })}
          <span style={{ color: colors.textMuted, fontSize: '0.85rem' }} aria-hidden="true">
            Novice shows core actions; Power reveals everything.
          </span>
        </div>

        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
          style={{ maxHeight: '400px' }}
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
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                  >
                    <span className={isSelected ? 'text-text' : 'text-dim'}>
                      {cmd.label}
                    </span>
                    {cmd.shortcut && (
                      <span className="key-hint" aria-label={`Shortcut: ${cmd.shortcut}`}>
                        {cmd.shortcut}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {Object.entries(groupedCommands).map(([category, cmds]) => (
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
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                  >
                    <div>
                      <span className={isSelected ? 'text-text' : 'text-dim'}>
                        {(cmd as any)._indices
                          ? highlightMatch(cmd.label, (cmd as any)._indices, colors.accent)
                          : cmd.label}
                      </span>
                      {cmd.description && (
                        <span className="text-muted text-xs ml-2">
                          {cmd.description}
                        </span>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <span className="key-hint" aria-label={`Shortcut: ${cmd.shortcut}`}>
                        {cmd.shortcut}
                      </span>
                    )}
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
        <div
          id="command-palette-hints"
          style={{
            display: 'flex',
            gap: '1rem',
            padding: '0.5rem',
            borderTop: `1px solid ${colors.borderLight}`,
            color: colors.textMuted,
            fontSize: '0.75rem',
          }}
        >
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
