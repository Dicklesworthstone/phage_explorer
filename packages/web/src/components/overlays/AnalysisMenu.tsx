/**
 * AnalysisMenu - Drawer Component
 *
 * A drawer menu showing analysis overlays organized by category.
 * Shortcut labels are rendered from ActionRegistry - never hardcoded.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { detectShortcutPlatform, formatPrimaryActionShortcut, getPrimaryShortcutCombo } from '../../keyboard/actionSurfaces';
import {
  ActionIds,
  ActionRegistry,
  ActionRegistryList,
  getKeyboardManager,
  type ActionDefinition,
  type HotkeyDefinition,
  type KeyCombo,
  isVisibleToUser,
} from '../../keyboard';
import { Overlay } from './Overlay';
import { OverlayProvenance, provenanceLabel } from './primitives';
import { useIsTopOverlay, useOverlay, type OverlayId } from './OverlayProvider';
import {
  IconAlertTriangle,
  IconAperture,
  IconBookmark,
  IconCube,
  IconDiff,
  IconDna,
  IconGitCompare,
  IconLayers,
  IconMagnet,
  IconRepeat,
  IconShield,
  IconTarget,
  IconTrendingUp,
  IconZap,
  IconFlask,
} from '../ui';

const ITEM_ICON_SIZE = 18;

interface AnalysisMenuItem {
  action: ActionDefinition;
  overlayId: OverlayId;
  category: string;
  icon: React.ReactNode;
  shortcutLabel: string | null;
  shortcutCombos: KeyCombo[];
}

const EXCLUDED_OVERLAY_IDS: ReadonlySet<OverlayId> = new Set([
  'analysisMenu',
  'help',
  'search',
  'commandPalette',
  'settings',
  'goto',
]);

const CATEGORY_ORDER: readonly string[] = ['Analysis', 'Comparison', 'Simulation', 'Reference', 'Dev'];

const ICON_BY_OVERLAY_ID: Partial<Record<OverlayId, React.ReactNode>> = {
  // Reference
  aaKey: <IconDna size={ITEM_ICON_SIZE} />,
  aaLegend: <IconBookmark size={ITEM_ICON_SIZE} />,
  // Simulation & comparison
  simulationHub: <IconZap size={ITEM_ICON_SIZE} />,
  resistanceEvolution: <IconZap size={ITEM_ICON_SIZE} />,
  comparison: <IconDiff size={ITEM_ICON_SIZE} />,
  // Sequence analysis
  gcSkew: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  complexity: <IconCube size={ITEM_ICON_SIZE} />,
  bendability: <IconAperture size={ITEM_ICON_SIZE} />,
  promoter: <IconTarget size={ITEM_ICON_SIZE} />,
  repeats: <IconRepeat size={ITEM_ICON_SIZE} />,
  transcriptionFlow: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  // Visualizations / comparative
  cgr: <IconDna size={ITEM_ICON_SIZE} />,
  hilbert: <IconAperture size={ITEM_ICON_SIZE} />,
  dotPlot: <IconDiff size={ITEM_ICON_SIZE} />,
  synteny: <IconDiff size={ITEM_ICON_SIZE} />,
  pangenomeGraph: <IconGitCompare size={ITEM_ICON_SIZE} />,
  phasePortrait: <IconAperture size={ITEM_ICON_SIZE} />,
  gel: <IconAperture size={ITEM_ICON_SIZE} />,
  logo: <IconBookmark size={ITEM_ICON_SIZE} />,
  mosaicRadar: <IconLayers size={ITEM_ICON_SIZE} />,
  periodicity: <IconRepeat size={ITEM_ICON_SIZE} />,
  // Genomic analysis
  hgt: <IconMagnet size={ITEM_ICON_SIZE} />,
  crispr: <IconDna size={ITEM_ICON_SIZE} />,
  nonBDNA: <IconDna size={ITEM_ICON_SIZE} />,
  anomaly: <IconAlertTriangle size={ITEM_ICON_SIZE} />,
  genomicSignaturePCA: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  prophageExcision: <IconRepeat size={ITEM_ICON_SIZE} />,
  // Codon & protein
  codonBias: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  codonAdaptation: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  biasDecomposition: <IconTrendingUp size={ITEM_ICON_SIZE} />,
  proteinDomains: <IconLayers size={ITEM_ICON_SIZE} />,
  foldQuickview: <IconAperture size={ITEM_ICON_SIZE} />,
  latentSpaceAtlas: <IconAperture size={ITEM_ICON_SIZE} />,
  rnaStructure: <IconDna size={ITEM_ICON_SIZE} />,
  // Host interactions
  tropism: <IconTarget size={ITEM_ICON_SIZE} />,
  hostInteractions: <IconTarget size={ITEM_ICON_SIZE} />,
  amgPathway: <IconFlask size={ITEM_ICON_SIZE} />,
  defenseArmsRace: <IconShield size={ITEM_ICON_SIZE} />,
  cocktailCompatibility: <IconShield size={ITEM_ICON_SIZE} />,
  nicheNetwork: <IconLayers size={ITEM_ICON_SIZE} />,
  // Structural
  pressure: <IconMagnet size={ITEM_ICON_SIZE} />,
  stability: <IconShield size={ITEM_ICON_SIZE} />,
  structureConstraint: <IconCube size={ITEM_ICON_SIZE} />,
  modules: <IconLayers size={ITEM_ICON_SIZE} />,
  epistasis: <IconLayers size={ITEM_ICON_SIZE} />,
  // Dev
  gpuWasmBenchmark: <IconCube size={ITEM_ICON_SIZE} />,
};

function getShortcutCombos(action: ActionDefinition): KeyCombo[] {
  const shortcut = action.defaultShortcut;
  if (Array.isArray(shortcut)) return shortcut;
  return shortcut ? [shortcut] : [];
}

function formatMenuCategory(action: ActionDefinition, overlayId: OverlayId): string {
  if (overlayId === 'aaKey' || overlayId === 'aaLegend') return 'Reference';
  return action.category;
}

function sortCategory(a: string, b: string): number {
  const aIdx = CATEGORY_ORDER.indexOf(a);
  const bIdx = CATEGORY_ORDER.indexOf(b);
  const aRank = aIdx === -1 ? CATEGORY_ORDER.length : aIdx;
  const bRank = bIdx === -1 ? CATEGORY_ORDER.length : bIdx;
  if (aRank !== bRank) return aRank - bRank;
  return a.localeCompare(b);
}

export function AnalysisMenu(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, open, close } = useOverlay();
  const menuOpen = isOpen('analysisMenu');
  const isTopmost = useIsTopOverlay('analysisMenu');
  const shouldCaptureHotkeys = menuOpen && isTopmost;
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // The Analysis Menu is modal: switch to a dedicated keyboard mode while it's topmost,
  // so global hotkeys (NORMAL) don't compete with menu navigation/selection.
  useEffect(() => {
    if (!shouldCaptureHotkeys) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();
    const previousMode = manager.getMode();
    manager.setMode('COMMAND');

    return () => {
      manager.setMode(previousMode);
    };
  }, [shouldCaptureHotkeys]);

  const menuHotkey = useMemo(() => {
    const action = ActionRegistry[ActionIds.OverlayAnalysisMenu];
    return formatPrimaryActionShortcut(action, shortcutPlatform) ?? 'a';
  }, [shortcutPlatform]);

  const menuHotkeyCombo = useMemo(() => {
    const action = ActionRegistry[ActionIds.OverlayAnalysisMenu];
    return getPrimaryShortcutCombo(action, shortcutPlatform);
  }, [shortcutPlatform]);

  const { grouped, flatItems } = useMemo(() => {
    const items: AnalysisMenuItem[] = ActionRegistryList
      .filter((action): action is ActionDefinition & { overlayId: string } => Boolean(action.overlayId))
      .filter((action) => isVisibleToUser(action))
      .map((action) => {
        const overlayId = action.overlayId as OverlayId;
        return {
          action,
          overlayId,
          category: formatMenuCategory(action, overlayId),
          icon: ICON_BY_OVERLAY_ID[overlayId] ?? <IconFlask size={ITEM_ICON_SIZE} />,
          shortcutLabel: formatPrimaryActionShortcut(action, shortcutPlatform),
          shortcutCombos: getShortcutCombos(action),
        };
      })
      .filter((item) => !EXCLUDED_OVERLAY_IDS.has(item.overlayId));

    items.sort((a, b) =>
      sortCategory(a.category, b.category) ||
      a.action.title.localeCompare(b.action.title)
    );

    const groupedByCategory: Record<string, AnalysisMenuItem[]> = {};
    for (const item of items) {
      groupedByCategory[item.category] ??= [];
      groupedByCategory[item.category].push(item);
    }

    return { grouped: groupedByCategory, flatItems: items };
  }, [shortcutPlatform]);

  useEffect(() => {
    if (!menuOpen) return;
    if (selectedIndex < flatItems.length) return;
    setSelectedIndex(0);
  }, [flatItems.length, menuOpen, selectedIndex]);

  useEffect(() => {
    if (!shouldCaptureHotkeys) return;
    if (flatItems.length === 0) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();
    const definitions: HotkeyDefinition[] = [];

    const moveDown = () => {
      setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
    };
    const moveUp = () => {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    };
    const select = () => {
      const item = flatItems[selectedIndexRef.current];
      if (!item) return;
      close('analysisMenu');
      open(item.overlayId);
    };

    // Menu navigation (vim + arrows)
    definitions.push(
      {
        combo: { key: 'j' },
        description: 'Analysis menu: next item',
        action: moveDown,
        modes: ['COMMAND'],
        priority: 10,
      },
      {
        combo: { key: 'ArrowDown' },
        description: 'Analysis menu: next item',
        action: moveDown,
        modes: ['COMMAND'],
        priority: 10,
      },
      {
        combo: { key: 'k' },
        description: 'Analysis menu: previous item',
        action: moveUp,
        modes: ['COMMAND'],
        priority: 10,
      },
      {
        combo: { key: 'ArrowUp' },
        description: 'Analysis menu: previous item',
        action: moveUp,
        modes: ['COMMAND'],
        priority: 10,
      },
      {
        combo: { key: 'Enter' },
        description: 'Analysis menu: open selected overlay',
        action: select,
        modes: ['COMMAND'],
        priority: 10,
      },
    );

    if (menuHotkeyCombo && !('sequence' in menuHotkeyCombo)) {
      definitions.push({
        combo: menuHotkeyCombo,
        description: 'Analysis menu: close',
        action: () => close('analysisMenu'),
        modes: ['COMMAND'],
        priority: 10,
      });
    }

    // Overlay shortcuts while the menu is open:
    // register contextual handlers so pressing an overlay hotkey closes the menu first.
    for (const item of flatItems) {
      for (const combo of item.shortcutCombos) {
        if ('sequence' in combo) continue; // AnalysisMenu doesn't support sequences today
        definitions.push({
          combo,
          description: `Open ${item.action.title} (from analysis menu)`,
          action: () => {
            close('analysisMenu');
            open(item.overlayId);
          },
          modes: ['COMMAND'],
          priority: 10,
        });
      }
    }

    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [close, flatItems, menuHotkeyCombo, open, shouldCaptureHotkeys]);

  if (!menuOpen) {
    return null;
  }

  let flatIndex = 0;

  return (
    <Overlay
      id="analysisMenu"
      title="ANALYSIS MENU"
      hotkey={menuHotkey}
      size="lg"
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
        gap: '1rem',
      }}>
        {Object.entries(grouped).map(([category, items]) => (
          <div
            key={category}
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            {/* Category header */}
            <div style={{
              backgroundColor: colors.backgroundAlt,
              padding: '0.5rem 0.75rem',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ color: colors.primary, fontWeight: 'bold' }}>
                {category}
              </span>
            </div>

            {/* Items */}
            <div>
              {items.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={item.action.id}
                    onClick={() => {
                      close('analysisMenu');
                      open(item.overlayId);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                      borderLeft: isSelected ? `3px solid ${colors.accent}` : '3px solid transparent',
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    <span className="analysis-menu-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}>
                        <span style={{
                          color: isSelected ? colors.text : colors.textDim,
                          fontWeight: isSelected ? 'bold' : 'normal',
                        }}>
                          {item.action.title}
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                          {/*
                            Provenance sits in the list, not only inside the
                            overlay, so a demo-data panel is identifiable
                            BEFORE it is opened. Measured is the overwhelming
                            majority and needs no badge; anything weaker does.
                          */}
                          {item.action.provenance && item.action.provenance !== 'measured' && (
                            <OverlayProvenance
                              level={item.action.provenance}
                              /*
                                An overlay that can degrade says so here. The
                                menu is drawn before the overlay opens, so the
                                achieved provenance is genuinely unknown at this
                                point; badging only the success case was wrong
                                precisely when the fetch failed.
                              */
                              source={
                                item.action.provenanceFallback
                                  ? `falls back to ${provenanceLabel(item.action.provenanceFallback).toLowerCase()}`
                                  : undefined
                              }
                            />
                          )}
                          {item.shortcutLabel && (
                            <span className="key-hint">
                              {item.shortcutLabel}
                            </span>
                          )}
                        </span>
                      </div>
                      <div style={{
                        color: colors.textMuted,
                        fontSize: '0.85rem',
                        marginTop: '0.25rem',
                      }}>
                        {item.action.description ?? ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer hints */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginTop: '1rem',
        padding: '0.5rem',
        borderTop: `1px solid ${colors.borderLight}`,
        color: colors.textMuted,
        fontSize: '0.75rem',
      }}>
        <span>↑↓ or j/k Navigate</span>
        <span>Enter or shortcut key to open</span>
        <span>ESC{menuHotkey ? ` or ${menuHotkey}` : ''} to close</span>
      </div>
    </Overlay>
  );
}

export default AnalysisMenu;
