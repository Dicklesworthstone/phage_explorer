/**
 * HelpOverlay - Dynamic Hotkey Reference
 *
 * Shows all available keyboard shortcuts organized by Depth Layer:
 * - Layer 0: Sacred Surface (Navigation, View, Search, Help, Quit)
 * - Layer 1: Quick Overlays (single-key analysis toggles)
 * - Layer 2: Analysis Menu (via 'A' key)
 * - Layer 3: Simulation Hub (via Shift+S)
 * - Layer 4: Command Palette (via ':')
 *
 * Shortcuts are rendered from ActionRegistry - never hardcoded.
 */

import React, { useMemo, useState, useCallback } from 'react';
import { useExperienceLevel, usePhageStore } from '@phage-explorer/state';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay, useIsTopOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayToolbar,
  OverlaySection,
  OverlaySectionHeader,
  OverlayGrid,
  OverlayRow,
  OverlayKeyValue,
  OverlayBadge,
} from './primitives';
import {
  ActionIds,
  ActionRegistryList,
  formatKeyCombo,
  type KeyCombo,
  type ActionScope,
  type ExperienceLevel,
  isVisibleToUser,
} from '../../keyboard';

type DepthLayer = 0 | 1 | 2 | 3 | 4;

interface HotkeyInfo {
  key: string;
  description: string;
  category: string;
  layer: DepthLayer;
  scope: ActionScope;
  minLevel?: ExperienceLevel;
}

const LAYER_LABELS: Record<DepthLayer, { name: string; description: string }> = {
  0: { name: 'Core Controls', description: 'Always available - navigation, view, search' },
  1: { name: 'Quick Overlays', description: 'Single-key analysis toggles' },
  2: { name: 'Analysis Menu', description: 'Advanced analysis tools (A key)' },
  3: { name: 'Simulation Hub', description: 'Interactive simulations (⇧S)' },
  4: { name: 'Power User', description: 'Command palette & dev tools' },
};

/**
 * Determine the Depth Layer for an action based on its category and shortcut complexity.
 * Layer 0 = sacred surface (nav, view, search, help)
 * Layer 1 = single-key quick overlays (g, x, b, p, r, etc.)
 * Layer 2 = analysis menu items (require alt or multiple modifiers)
 * Layer 3 = simulation
 * Layer 4 = command palette, dev tools
 */
function getDepthLayer(category: string, shortcut: KeyCombo | KeyCombo[], actionId: string): DepthLayer {
  // Layer 0: Core controls
  if (['Navigation', 'View', 'Search'].includes(category)) return 0;
  if (actionId.includes('overlay.help') || actionId.includes('overlay.closeAll')) return 0;

  // Layer 3: Simulation
  if (category === 'Simulation') return 3;

  // Layer 4: Dev/Power tools
  if (category === 'Dev') return 4;
  if (actionId.includes('commandPalette')) return 4;

  // Layer 1 vs 2: Check shortcut complexity
  const combos = Array.isArray(shortcut) ? shortcut : [shortcut];
  const hasModifiers = combos.some(c =>
    c.modifiers && (c.modifiers.alt || c.modifiers.ctrl || c.modifiers.meta || c.modifiers.shift)
  );

  // Single key without modifiers = Layer 1 (quick overlays)
  if (!hasModifiers) return 1;

  // With modifiers = Layer 2 (analysis menu depth)
  return 2;
}

function formatShortcut(shortcut: KeyCombo | KeyCombo[]): string {
  const combos = Array.isArray(shortcut) ? shortcut : [shortcut];
  return combos.map(formatKeyCombo).join(' / ');
}

const EXPERIENCE_LEVEL_ORDER: ExperienceLevel[] = ['novice', 'intermediate', 'power'];

/**
 * Check if a shortcut should be visible for the given experience level.
 * A shortcut is visible if the user's level is >= the shortcut's minLevel.
 */
function isVisibleForLevel(
  userLevel: ExperienceLevel,
  minLevel: ExperienceLevel | undefined
): boolean {
  if (!minLevel) return true; // No minLevel = visible to all
  const userIdx = EXPERIENCE_LEVEL_ORDER.indexOf(userLevel);
  const minIdx = EXPERIENCE_LEVEL_ORDER.indexOf(minLevel);
  return userIdx >= minIdx;
}

// Group hotkeys by depth layer
function groupByLayer(hotkeys: HotkeyInfo[]): Record<DepthLayer, HotkeyInfo[]> {
  const result: Record<DepthLayer, HotkeyInfo[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  for (const hotkey of hotkeys) {
    result[hotkey.layer].push(hotkey);
  }
  // Sort within each layer by category then description
  for (const layer of [0, 1, 2, 3, 4] as DepthLayer[]) {
    result[layer].sort((a, b) =>
      a.category.localeCompare(b.category) || a.description.localeCompare(b.description)
    );
  }
  return result;
}

export function HelpOverlay(): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const experienceLevel = useExperienceLevel();
  const promoteExperienceLevel = usePhageStore((s) => s.promoteExperienceLevel);

  // Default detail level is based on experience level:
  // - novice: start with essential (Layer 0 only)
  // - intermediate/power: can handle more detail by default
  const defaultDetail = experienceLevel === 'novice' ? 'essential' : 'detailed';
  const [detailLevel, setDetailLevel] = useState<'essential' | 'detailed'>(defaultDetail);

  const overlayOpen = isOpen('help');
  const isTopmost = useIsTopOverlay('help');

  // Cycle through detail levels and promote experience if user explores advanced shortcuts
  const cycleDetailLevel = useCallback(() => {
    setDetailLevel(prev => {
      const next = prev === 'essential' ? 'detailed' : 'essential';
      // If user toggles to detailed, they're ready for at least intermediate
      if (next === 'detailed' && experienceLevel === 'novice') {
        promoteExperienceLevel('intermediate');
      }
      return next;
    });
  }, [experienceLevel, promoteExperienceLevel]);

  useHotkey(
    ActionIds.OverlayHelp,
    () => toggle('help'),
    { modes: ['NORMAL'] }
  );

  // Overlay-internal hotkeys only active when this overlay is topmost
  useHotkey(
    ActionIds.HelpToggleDetail,
    cycleDetailLevel,
    { modes: ['NORMAL'], enabled: overlayOpen && isTopmost }
  );

  const hotkeys = useMemo(() => {
    return ActionRegistryList
      .filter((action) => isVisibleToUser(action))
      // Filter by experience level - only show shortcuts the user's level can access
      .filter((action) => isVisibleForLevel(experienceLevel, action.minLevel))
      .map((action): HotkeyInfo => ({
        key: formatShortcut(action.defaultShortcut),
        description: action.title,
        category: action.category,
        layer: getDepthLayer(action.category, action.defaultShortcut, action.id),
        scope: action.scope,
        minLevel: action.minLevel,
      }));
  }, [experienceLevel]);

  if (!overlayOpen) {
    return null;
  }

  const grouped = groupByLayer(hotkeys);
  // Essential mode: Layer 0 only; Detailed mode: all layers
  const visibleLayers: DepthLayer[] = detailLevel === 'essential'
    ? [0]
    : [0, 1, 2, 3, 4];

  return (
    <Overlay
      id="help"
      title="KEYBOARD SHORTCUTS"
      hotkey="?"
      size="lg"
    >
      <OverlayStack>
        {/* Detail level toggle with experience level info */}
        <OverlayToolbar>
          <span
            style={{
              color: 'var(--overlay-description-color)',
              fontSize: 'var(--overlay-description-size)',
              lineHeight: 'var(--overlay-description-line-height)',
            }}
          >
            {detailLevel === 'essential' ? 'Essential' : 'All'} shortcuts
            {experienceLevel !== 'novice' && (
              <> • {experienceLevel.charAt(0).toUpperCase() + experienceLevel.slice(1)} user</>
            )}
          </span>
          <button
            onClick={cycleDetailLevel}
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-background)',
              border: 'none',
              padding: 'var(--chrome-padding-compact-y) var(--chrome-padding-x)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 'var(--overlay-body-size)',
              fontWeight: 'var(--font-medium)',
              transition: 'opacity var(--duration-fast) var(--ease-out)',
            }}
          >
            {detailLevel === 'essential' ? 'Show all (D)' : 'Show essential (D)'}
          </button>
        </OverlayToolbar>

        {/* Depth Layers */}
        <OverlayStack>
          {visibleLayers.map(layer => {
            const layerHotkeys = grouped[layer];
            if (layerHotkeys.length === 0) return null;
            const layerInfo = LAYER_LABELS[layer];

            return (
              <OverlaySection
                key={layer}
                header={
                  <OverlaySectionHeader
                    badge={`L${layer}`}
                    title={layerInfo.name}
                    description={layerInfo.description}
                  />
                }
              >
                <OverlayGrid>
                  {layerHotkeys.map((hotkey, index) => (
                    <OverlayRow key={`${hotkey.key}-${index}`} alternate={index % 2 !== 0}>
                      <OverlayKeyValue label={hotkey.key} value={hotkey.description} />
                      {hotkey.minLevel === 'power' && (
                        <OverlayBadge variant="accent">power</OverlayBadge>
                      )}
                      {hotkey.minLevel === 'intermediate' && (
                        <OverlayBadge variant="subtle">int</OverlayBadge>
                      )}
                      {hotkey.scope === 'contextual' && (
                        <OverlayBadge variant="muted">contextual</OverlayBadge>
                      )}
                    </OverlayRow>
                  ))}
                </OverlayGrid>
              </OverlaySection>
            );
          })}
        </OverlayStack>
      </OverlayStack>
    </Overlay>
  );
}

export default HelpOverlay;
