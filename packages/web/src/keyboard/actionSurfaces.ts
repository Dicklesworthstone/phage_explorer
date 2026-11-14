import { ActionIds, ActionRegistry, type ActionDefinition, type ActionId } from './actionRegistry';
import { formatKeyCombo, type ExperienceLevel, type KeyCombo } from './types';

export type ShortcutPlatform = 'mac' | 'default';

export interface ActionSurfaceToolConfig {
  actionId: ActionId;
  description: string;
}

export interface ActionSurfaceCategoryConfig {
  id: string;
  name: string;
  level?: ExperienceLevel;
  tools: ActionSurfaceToolConfig[];
}

export const ANALYSIS_SIDEBAR_CATEGORIES: ActionSurfaceCategoryConfig[] = [
  {
    id: 'sequence',
    name: 'Sequence Analysis',
    tools: [
      { actionId: ActionIds.OverlayGCSkew, description: 'Origin/terminus detection' },
      { actionId: ActionIds.OverlayComplexity, description: 'Shannon entropy analysis' },
      { actionId: ActionIds.OverlayBendability, description: 'DNA curvature prediction' },
      { actionId: ActionIds.OverlayHilbert, description: 'Space-filling visualization' },
      { actionId: ActionIds.OverlayCGR, description: 'Fractal genome view' },
      { actionId: ActionIds.OverlayDotPlot, description: 'Self-similarity matrix' },
    ],
  },
  {
    id: 'genes',
    name: 'Gene Features',
    tools: [
      { actionId: ActionIds.OverlayPromoter, description: 'Regulatory elements' },
      { actionId: ActionIds.OverlayRepeats, description: 'Direct, inverted, palindromic' },
      { actionId: ActionIds.OverlayGel, description: 'Restriction digest simulation' },
    ],
  },
  {
    id: 'codon',
    name: 'Codon Analysis',
    level: 'intermediate',
    tools: [
      { actionId: ActionIds.OverlayBiasDecomposition, description: 'PCA of codon usage' },
      { actionId: ActionIds.OverlayPhasePortrait, description: 'Codon phase space' },
    ],
  },
  {
    id: 'structural',
    name: 'Structural',
    level: 'intermediate',
    tools: [
      { actionId: ActionIds.OverlayPackagingPressure, description: 'Capsid fill & pressure' },
      { actionId: ActionIds.OverlayVirionStability, description: 'Measured infectivity loss' },
      { actionId: ActionIds.OverlayNonBDNA, description: 'Z-DNA, G-quadruplexes' },
      {
        actionId: ActionIds.OverlayStructureConstraint,
        description: 'RNA signals + capsid/tail fragility scan',
      },
    ],
  },
  {
    id: 'evolution',
    name: 'Evolutionary',
    level: 'power',
    tools: [
      { actionId: ActionIds.OverlayKmerAnomaly, description: 'Unusual composition' },
      { actionId: ActionIds.OverlayAnomaly, description: 'Multi-metric detection' },
      { actionId: ActionIds.OverlayHGT, description: 'Horizontal gene transfer' },
      { actionId: ActionIds.OverlaySynteny, description: 'Gene order conservation' },
    ],
  },
  {
    id: 'host',
    name: 'Host Interaction',
    level: 'power',
    tools: [
      { actionId: ActionIds.OverlayTropism, description: 'Host binding predictions' },
      { actionId: ActionIds.OverlayCRISPR, description: 'Spacer matches' },
      { actionId: ActionIds.OverlayDefenseArmsRace, description: 'Host-phage coevolution' },
    ],
  },
  {
    id: 'simulations',
    name: 'Simulations',
    tools: [
      { actionId: ActionIds.OverlaySimulationHub, description: 'All simulations' },
    ],
  },
] as const;

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'default';
  // Use User-Agent Client Hints API if available, fallback to navigator.platform
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
  return platform.includes('mac') ? 'mac' : 'default';
}

function getActionCombos(action: ActionDefinition): KeyCombo[] {
  const shortcut = action.defaultShortcut;
  return Array.isArray(shortcut) ? shortcut : [shortcut];
}

export function getPrimaryShortcutCombo(
  action: ActionDefinition,
  platform: ShortcutPlatform = 'default'
): KeyCombo | null {
  const combos = getActionCombos(action);
  if (combos.length === 0) return null;
  if (combos.length === 1) return combos[0];

  if (platform === 'mac') {
    const metaFirst = combos.find((combo) => Boolean(combo.modifiers?.meta));
    if (metaFirst) return metaFirst;
    return combos[0];
  }

  const ctrlFirst = combos.find((combo) => Boolean(combo.modifiers?.ctrl));
  if (ctrlFirst) return ctrlFirst;
  return combos[0];
}

export function formatPrimaryActionShortcut(
  action: ActionDefinition,
  platform: ShortcutPlatform = 'default'
): string | null {
  const combo = getPrimaryShortcutCombo(action, platform);
  if (!combo) return null;
  return formatKeyCombo(combo);
}

export function getActionFromRegistry(actionId: ActionId): ActionDefinition | null {
  return ActionRegistry[actionId] ?? null;
}

export interface AppShellHintConfig {
  label: string;
  description: string;
  actionIds: ActionId[];
  separator?: string;
}

export const APP_SHELL_FOOTER_HINTS: AppShellHintConfig[] = [
  {
    label: 'navigate',
    description: 'Next/previous phage',
    actionIds: [ActionIds.NavNextPhage, ActionIds.NavPrevPhage],
  },
  {
    label: 'search',
    description: 'Search phages',
    actionIds: [ActionIds.OverlaySearch],
  },
  {
    label: 'command',
    description: 'Open command palette',
    actionIds: [ActionIds.OverlayCommandPalette],
  },
  {
    label: 'theme',
    description: 'Cycle theme',
    actionIds: [ActionIds.ViewCycleTheme],
  },
  {
    label: 'help',
    description: 'Show keyboard shortcuts',
    actionIds: [ActionIds.OverlayHelp],
  },
  {
    label: 'view/frame',
    description: 'Toggle DNA/Amino Acids view and reading frame',
    actionIds: [ActionIds.ViewCycleMode, ActionIds.ViewCycleReadingFrame],
  },
  {
    label: 'jump',
    description: 'Jump to start/end of sequence',
    actionIds: [ActionIds.ViewScrollStart, ActionIds.ViewScrollEnd],
  },
  {
    label: 'close',
    description: 'Close overlays or glossary',
    actionIds: [ActionIds.OverlayCloseAll],
  },
  {
    label: 'settings',
    description: 'Open settings',
    actionIds: [ActionIds.OverlaySettings],
  },
  {
    label: 'beginner',
    description: 'Toggle beginner mode',
    actionIds: [ActionIds.EducationToggleBeginnerMode],
  },
] as const;

export function formatActionShortcutForSurface(
  actionId: ActionId,
  platform: ShortcutPlatform = 'default'
): string | null {
  const action = getActionFromRegistry(actionId);
  if (!action) return null;
  return formatPrimaryActionShortcut(action, platform);
}

export function formatHintKeys(
  hint: Pick<AppShellHintConfig, 'actionIds' | 'separator'>,
  platform: ShortcutPlatform = 'default'
): string {
  const separator = hint.separator ?? '/';
  return hint.actionIds
    .map((actionId) => formatActionShortcutForSurface(actionId, platform))
    .filter((shortcut): shortcut is string => Boolean(shortcut))
    .join(separator);
}

export type ActionDrawerLabelStrategy = 'registryTitle' | 'viewMode';

export interface ActionDrawerItemConfig {
  actionId: ActionId;
  /** Whether the drawer should close after invoking the action (default: true). */
  closeAfter?: boolean;
  /** Optional label strategy for cases where the drawer needs stateful copy (e.g., current view mode). */
  labelStrategy?: ActionDrawerLabelStrategy;
}

export interface ActionDrawerSectionConfig {
  id: string;
  label: string;
  items: ActionDrawerItemConfig[];
}

export const ACTION_DRAWER_SECTIONS: ActionDrawerSectionConfig[] = [
  {
    id: 'view',
    label: 'View',
    items: [
      { actionId: ActionIds.ViewCycleMode, labelStrategy: 'viewMode' },
      { actionId: ActionIds.ViewToggle3DModel },
      { actionId: ActionIds.ViewZoomIn, closeAfter: false },
      { actionId: ActionIds.ViewZoomOut, closeAfter: false },
    ],
  },
  {
    id: 'sequence',
    label: 'Sequence',
    items: [
      { actionId: ActionIds.OverlayGCSkew },
      { actionId: ActionIds.OverlayComplexity },
      { actionId: ActionIds.OverlayBendability },
      { actionId: ActionIds.OverlayRepeats },
      { actionId: ActionIds.OverlayPromoter },
      { actionId: ActionIds.OverlayHilbert },
      { actionId: ActionIds.OverlayCGR },
      { actionId: ActionIds.OverlayDotPlot },
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    items: [
      { actionId: ActionIds.OverlayPackagingPressure },
      { actionId: ActionIds.OverlaySynteny },
      { actionId: ActionIds.OverlayCRISPR },
      { actionId: ActionIds.OverlayHGT },
      { actionId: ActionIds.OverlayDefenseArmsRace },
      { actionId: ActionIds.OverlayGel },
      { actionId: ActionIds.OverlaySimulationHub },
      { actionId: ActionIds.OverlayAnalysisMenu },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    items: [
      { actionId: ActionIds.OverlaySearch },
      { actionId: ActionIds.OverlayCommandPalette },
      { actionId: ActionIds.OverlaySettings },
      { actionId: ActionIds.OverlayHelp },
    ],
  },
] as const;
