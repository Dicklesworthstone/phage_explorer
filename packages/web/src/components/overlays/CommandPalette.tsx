/**
 * CommandPalette - Fuzzy Search & Keyboard Navigation
 *
 * A VS Code-style command palette with:
 * - Fuzzy search with highlighting
 * - Category grouping
 * - Keyboard navigation
 * - Recent commands
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay, type OverlayId } from './OverlayProvider';

interface Command {
  id: string;
  label: string;
  description?: string;
  category: string;
  shortcut?: string;
  action: () => void;
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

interface CommandPaletteProps {
  commands?: Command[];
}

export function CommandPalette({ commands: customCommands }: CommandPaletteProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, open, close } = useOverlay();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Default commands
  const defaultCommands: Command[] = useMemo(() => [
    // Theme commands
    { id: 'theme:classic', label: 'Theme: Classic', category: 'Theme', shortcut: 't', action: () => {} },
    { id: 'theme:cyber', label: 'Theme: Cyberpunk', category: 'Theme', action: () => {} },
    { id: 'theme:matrix', label: 'Theme: Matrix', category: 'Theme', action: () => {} },
    { id: 'theme:ocean', label: 'Theme: Ocean', category: 'Theme', action: () => {} },

    // Overlay commands
    { id: 'overlay:help', label: 'Show Help', category: 'Overlay', shortcut: '?', action: () => { close(); open('help'); } },
    { id: 'overlay:search', label: 'Search Phages', category: 'Overlay', shortcut: 's', action: () => { close(); open('search'); } },
    { id: 'overlay:analysis', label: 'Analysis Menu', category: 'Overlay', shortcut: 'a', action: () => { close(); open('analysisMenu'); } },
    { id: 'overlay:simulation', label: 'Simulation Hub', category: 'Overlay', shortcut: 'S', action: () => { close(); open('simulationHub'); } },
    { id: 'overlay:comparison', label: 'Genome Comparison', category: 'Overlay', shortcut: 'c', action: () => { close(); open('comparison'); } },

    // Analysis commands
    { id: 'analysis:gc', label: 'GC Skew Analysis', category: 'Analysis', shortcut: 'g', action: () => { close(); open('gcSkew'); } },
    { id: 'analysis:complexity', label: 'Sequence Complexity', category: 'Analysis', shortcut: 'x', action: () => { close(); open('complexity'); } },
    { id: 'analysis:bendability', label: 'DNA Bendability', category: 'Analysis', shortcut: 'b', action: () => { close(); open('bendability'); } },
    { id: 'analysis:promoter', label: 'Promoter/RBS Sites', category: 'Analysis', shortcut: 'p', action: () => { close(); open('promoter'); } },
    { id: 'analysis:repeat', label: 'Repeat Finder', category: 'Analysis', shortcut: 'r', action: () => { close(); open('repeats'); } },

    // View commands
    { id: 'view:dna', label: 'View: DNA Mode', category: 'View', shortcut: 'Space', action: () => {} },
    { id: 'view:aa', label: 'View: Amino Acid Mode', category: 'View', shortcut: 'Space', action: () => {} },
    { id: 'view:diff', label: 'Toggle Diff Mode', category: 'View', shortcut: 'd', action: () => {} },
    { id: 'view:3d', label: 'Toggle 3D Model', category: 'View', shortcut: 'm', action: () => {} },

    // Navigation commands
    { id: 'nav:start', label: 'Go to Start', category: 'Navigation', shortcut: 'gg', action: () => {} },
    { id: 'nav:end', label: 'Go to End', category: 'Navigation', shortcut: 'G', action: () => {} },
    { id: 'nav:goto', label: 'Go to Position...', category: 'Navigation', shortcut: 'Ctrl+g', action: () => { close(); open('goto'); } },
  ], [close, open]);

  const commands = customCommands ?? defaultCommands;

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

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          filteredCommands[selectedIndex].action();
          close('commandPalette');
        }
        break;
      case 'Tab':
        e.preventDefault();
        // Tab completion: fill in the selected command's label
        if (filteredCommands[selectedIndex]) {
          setQuery(filteredCommands[selectedIndex].label);
        }
        break;
    }
  }, [filteredCommands, selectedIndex, close]);

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
        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type to search commands..."
          style={{
            width: '100%',
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '4px',
            color: colors.text,
            fontSize: '1rem',
            fontFamily: 'inherit',
            outline: 'none',
          }}
          autoComplete="off"
          spellCheck={false}
        />

        {/* Command list */}
        <div
          ref={listRef}
          style={{
            maxHeight: '400px',
            overflowY: 'auto',
          }}
        >
          {Object.entries(groupedCommands).map(([category, cmds]) => (
            <div key={category}>
              <div style={{
                padding: '0.5rem',
                color: colors.textMuted,
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                borderBottom: `1px solid ${colors.borderLight}`,
              }}>
                {category}
              </div>
              {cmds.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={cmd.id}
                    onClick={() => {
                      cmd.action();
                      close('commandPalette');
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.5rem 0.75rem',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                      borderLeft: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent',
                    }}
                  >
                    <div>
                      <span style={{ color: isSelected ? colors.text : colors.textDim }}>
                        {(cmd as any)._indices
                          ? highlightMatch(cmd.label, (cmd as any)._indices, colors.accent)
                          : cmd.label}
                      </span>
                      {cmd.description && (
                        <span style={{ color: colors.textMuted, marginLeft: '0.5rem', fontSize: '0.85rem' }}>
                          {cmd.description}
                        </span>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <span style={{
                        color: colors.accent,
                        fontSize: '0.8rem',
                        padding: '0.1rem 0.4rem',
                        backgroundColor: colors.background,
                        border: `1px solid ${colors.borderLight}`,
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                      }}>
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
