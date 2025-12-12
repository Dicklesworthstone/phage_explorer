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
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '@phage-explorer/state';
import { formatFasta, downloadString, copyToClipboard, buildSequenceClipboardPayload } from '../../utils/export';

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
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, open, close } = useOverlay();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Get user's experience level from main store
  const experienceLevel = usePhageStore((s) => s.experienceLevel) as ExperienceLevel;
  const setExperienceLevel = usePhageStore((s) => s.setExperienceLevel);
  const viewMode = usePhageStore((s) => s.viewMode);
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

  const executeCommand = useCallback((cmd: Command) => {
    addRecentCommand(cmd.id);
    setRecentCommandIds(getRecentCommands());
    cmd.action();
    close('commandPalette');
  }, [close]);

  // Default commands with experience levels and contexts
  const defaultCommands: Command[] = useMemo(() => [
    // Theme commands (available to all)
    { id: 'theme:classic', label: 'Theme: Classic', category: 'Theme', shortcut: 't', action: () => {}, minLevel: 'novice' },
    { id: 'theme:cyber', label: 'Theme: Cyberpunk', category: 'Theme', action: () => {}, minLevel: 'novice' },
    { id: 'theme:matrix', label: 'Theme: Matrix', category: 'Theme', action: () => {}, minLevel: 'novice' },
    { id: 'theme:ocean', label: 'Theme: Ocean', category: 'Theme', action: () => {}, minLevel: 'novice' },
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

    // Analysis commands (require phage loaded)
    { id: 'analysis:gc', label: 'GC Skew Analysis', category: 'Analysis', shortcut: 'g', action: () => { close(); open('gcSkew'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:complexity', label: 'Sequence Complexity', category: 'Analysis', shortcut: 'x', action: () => { close(); open('complexity'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:bendability', label: 'DNA Bendability', category: 'Analysis', shortcut: 'b', action: () => { close(); open('bendability'); }, minLevel: 'intermediate', contexts: ['has-phage', 'dna-mode'] },
    { id: 'analysis:promoter', label: 'Promoter/RBS Sites', category: 'Analysis', shortcut: 'p', action: () => { close(); open('promoter'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:repeat', label: 'Repeat Finder', category: 'Analysis', shortcut: 'r', action: () => { close(); open('repeats'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:cgr', label: 'Chaos Game Representation', category: 'Analysis', shortcut: 'Alt+Shift+C', action: () => { close(); open('cgr'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:hilbert', label: 'Hilbert Curve Visualization', category: 'Analysis', shortcut: 'H', action: () => { close(); open('hilbert'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:dotplot', label: 'Synteny Dotplot', category: 'Analysis', shortcut: '.', action: () => { close(); open('dotplot'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:gel', label: 'Virtual Gel Electrophoresis', category: 'Analysis', shortcut: 'G', action: () => { close(); open('gel'); }, minLevel: 'intermediate', contexts: ['has-phage'] },
    { id: 'analysis:constraints', label: 'Structure Constraints', category: 'Analysis', action: () => { close(); open('structureConstraints'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:non-b', label: 'Non-B DNA Structures', category: 'Analysis', action: () => { close(); open('nonBDNA'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:crispr', label: 'CRISPR Arrays', category: 'Analysis', action: () => { close(); open('crispr'); }, minLevel: 'intermediate', contexts: ['has-phage'] },

    // Advanced analysis (power users)
    { id: 'analysis:kmer', label: 'K-mer Anomaly Detection', category: 'Advanced', shortcut: 'V', action: () => { close(); open('kmerAnomaly'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:anomaly', label: 'Anomaly Detection', category: 'Advanced', shortcut: 'A', action: () => { close(); open('anomaly'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:hgt', label: 'HGT Provenance', category: 'Advanced', shortcut: 'Y', action: () => { close(); open('hgt'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:tropism', label: 'Tropism & Receptors', category: 'Advanced', shortcut: '0', action: () => { close(); open('tropism'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:bias', label: 'Codon Bias Decomposition', category: 'Advanced', shortcut: 'J', action: () => { close(); open('biasDecomposition'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:phase', label: 'Phase Portrait', category: 'Advanced', shortcut: 'P', action: () => { close(); open('phasePortrait'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:packaging', label: 'Packaging Pressure', category: 'Advanced', action: () => { close(); open('packagingPressure'); }, minLevel: 'power', contexts: ['has-phage'] },
    { id: 'analysis:stability', label: 'Virion Stability', category: 'Advanced', action: () => { close(); open('virionStability'); }, minLevel: 'power', contexts: ['has-phage'] },

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
  ], [close, open]);

  const allCommands = customCommands ?? defaultCommands;

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
  }, [commands, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen('commandPalette') && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
  }, [totalItems, selectedIndex, getCommandAtIndex, close]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (!isOpen('commandPalette')) {
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
      icon=">"
      hotkey=":"
      size="md"
      position="top"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {/* Experience level filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ color: colors.textMuted, fontSize: '0.9rem' }}>Experience</span>
          {(['novice', 'intermediate', 'power'] as ExperienceLevel[]).map((level) => {
            const active = level === experienceLevel;
            return (
              <button
                key={level}
                onClick={() => setExperienceLevel(level)}
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
          <span style={{ color: colors.textMuted, fontSize: '0.85rem' }}>
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
        />

        {/* Command list */}
        <div
          ref={listRef}
          className="scrollable-y"
          style={{ maxHeight: '400px' }}
        >
          {/* Recent commands section (only show when no query) */}
          {showRecent && (
            <div>
              <div className="text-muted text-xs uppercase tracking-wider p-2 border-b border-border-light flex items-center gap-2">
                <span>⏱</span>
                <span>Recent</span>
              </div>
              {recentCommands.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={`recent-${cmd.id}`}
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
                  >
                    <span className={isSelected ? 'text-text' : 'text-dim'}>
                      {cmd.label}
                    </span>
                    {cmd.shortcut && (
                      <span className="key-hint">
                        {cmd.shortcut}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {Object.entries(groupedCommands).map(([category, cmds]) => (
            <div key={category}>
              <div className="text-muted text-xs uppercase tracking-wider p-2 border-b border-border-light">
                {category}
              </div>
              {cmds.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={cmd.id}
                    onClick={() => executeCommand(cmd)}
                    className={`list-item ${isSelected ? 'active' : ''}`}
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
                      <span className="key-hint">
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
        <div style={{
          display: 'flex',
          gap: '1rem',
          padding: '0.5rem',
          borderTop: `1px solid ${colors.borderLight}`,
          color: colors.textMuted,
          fontSize: '0.75rem',
        }}>
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
