import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import { Model3DSkeleton } from './ui/Skeleton';
import { Badge, SubtleBadge } from './ui/Badge';
import { Tooltip } from './ui/Tooltip';
import { IconAlertTriangle, IconCamera, IconChevronDown, IconCube, IconDna, IconFlask, IconRepeat } from './ui';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  Vector3,
} from 'three';
import type { Group } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  buildBallAndStick,
  buildSurfaceImpostor,
  buildTubeFromTraces,
  buildFunctionalGroupHighlights,
  type FunctionalGroupStyle,
  type LoadedStructure,
} from '../visualization/structure-loader';
import { useStructureQuery, usePrefetchAdjacentStructures } from '../hooks/useStructureQuery';
import { getKeyboardManager, type HotkeyDefinition } from '../keyboard';
import { useOverlay } from './overlays/OverlayProvider';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type RenderMode = 'ball' | 'ribbon' | 'surface';

export const THREE_FULLSCREEN_CLASS = 'pe-three-fullscreen';

export function applyThreeFullscreenClass(
  root: { classList: { add: (name: string) => void; remove: (name: string) => void } } | null,
  fullscreen: boolean
): void {
  if (!root) return;
  if (fullscreen) {
    root.classList.add(THREE_FULLSCREEN_CLASS);
  } else {
    root.classList.remove(THREE_FULLSCREEN_CLASS);
  }
}

interface Model3DViewProps {
  phage: PhageFull | null;
}

interface PickedResidueInfo {
  chainId: string;
  resSeq: number;
  resName: string;
  atomName: string;
  geneLabel?: string;
  genomePos?: number;
}

function isCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
}

/**
 * Check if WebGL is supported by the browser
 */
function detectWebGLSupport(): { supported: boolean; version: 1 | 2 | null } {
  if (typeof window === 'undefined') return { supported: false, version: null };
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (gl2) return { supported: true, version: 2 };
    const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl1) return { supported: true, version: 1 };
    return { supported: false, version: null };
  } catch {
    return { supported: false, version: null };
  }
}

/**
 * Get human-readable error message for structure loading failures
 */
function getStructureErrorMessage(error: Error | unknown): string {
  if (!(error instanceof Error)) return 'An unexpected error occurred loading the structure.';
  const msg = error.message.toLowerCase();
  if (msg.includes('404') || msg.includes('not found')) {
    return 'Structure not found in the database.';
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  if (msg.includes('timeout')) {
    return 'Request timed out. The server may be slow or unavailable.';
  }
  if (msg.includes('cors') || msg.includes('cross-origin')) {
    return 'Unable to access the structure server.';
  }
  if (msg.includes('parse') || msg.includes('invalid') || msg.includes('corrupt')) {
    return 'The structure data appears to be corrupted.';
  }
  return error.message || 'An unexpected error occurred loading the structure.';
}

function getRcsbEntryUrl(idOrUrl: string): string | null {
  if (idOrUrl.includes('://')) return idOrUrl;
  const bareId = idOrUrl.replace(/\.(pdb|cif|mmcif)$/i, '');
  if (!bareId) return null;
  return `https://www.rcsb.org/structure/${encodeURIComponent(bareId)}`;
}

const QUALITY_PRESETS = {
  low: {
    pixelRatio: 0.5,
    shadows: false,
    sphereSegments: 6,
    bondRadialSegments: 4,
    tubeRadialSegments: 4,
    tubeMinSegments: 12,
    surfaceSegments: 6,
  },
  medium: {
    pixelRatio: 0.75,
    shadows: false,
    sphereSegments: 8,
    bondRadialSegments: 5,
    tubeRadialSegments: 5,
    tubeMinSegments: 16,
    surfaceSegments: 8,
  },
  high: {
    pixelRatio: 1.0,
    shadows: true,
    sphereSegments: 12,
    bondRadialSegments: 8,
    tubeRadialSegments: 8,
    tubeMinSegments: 24,
    surfaceSegments: 12,
  },
  ultra: {
    pixelRatio: 1.5,
    shadows: true,
    sphereSegments: 16,
    bondRadialSegments: 10,
    tubeRadialSegments: 10,
    tubeMinSegments: 32,
    surfaceSegments: 16,
  },
} as const;

type QualityLevel = keyof typeof QUALITY_PRESETS;

const chainPalette = [
  '#3b82f6',
  '#a855f7',
  '#22c55e',
  '#f97316',
  '#ec4899',
  '#14b8a6',
  '#eab308',
];

const TEXTURE_PROPERTIES = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'displacementMap',
  'alphaMap',
  'bumpMap',
  'lightMap',
] as const;

function disposeMaterial(material: unknown): void {
  if (!material) return;
  for (const key of TEXTURE_PROPERTIES) {
    const texture = (material as Record<string, unknown>)[key];
    if (texture && typeof (texture as { dispose?: () => void }).dispose === 'function') {
      (texture as { dispose: () => void }).dispose();
    }
  }
  (material as { dispose?: () => void }).dispose?.();
}

function disposeGroup(group: Group | null): void {
  if (!group) return;
  group.traverse(obj => {
    if ('geometry' in obj && obj.geometry) {
      (obj.geometry as { dispose?: () => void }).dispose?.();
    }
    if ('material' in obj) {
      const material = (obj as { material?: unknown }).material;
      if (Array.isArray(material)) {
        material.forEach(disposeMaterial);
      } else {
        disposeMaterial(material);
      }
    }
  });
}

function suggestInitialRenderMode(options: {
  coarsePointer: boolean;
  atomCount: number;
  hasBackboneTraces: boolean;
}): RenderMode {
  const { coarsePointer, atomCount, hasBackboneTraces } = options;
  if (!hasBackboneTraces) return 'ball';
  if (coarsePointer || atomCount > 15000) return 'ribbon';
  return 'ball';
}

/**
 * Format a number with K/M suffix for readability
 */
function formatAtomEstimate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

const DEFAULT_VIEW_DIR = new Vector3(1, 0.7, 1).normalize();
const HIGHLIGHT_VIEW_DIR = new Vector3(1, 0.8, 1).normalize();
const TEMP_NDC = new Vector2();

/**
 * Generate tooltip content explaining asymmetric unit vs full virion.
 * Shows estimated full virion atom counts based on common icosahedral symmetries.
 */
function getAsymmetricUnitTooltip(atomCount: number): string {
  // Common icosahedral symmetries for bacteriophages:
  // T=1: 60 copies, T=3: 180 copies (MS2, Qβ), T=7: 420 copies (T7, P22)
  const t3Estimate = atomCount * 180;  // Most common for small phages
  const t7Estimate = atomCount * 420;  // Common for larger phages

  return `This shows the asymmetric unit from PDB (${atomCount.toLocaleString()} atoms) — the unique protein chains deposited in the structure.\n\nFull icosahedral virion estimates:\n• T=3 capsid (MS2-like): ~${formatAtomEstimate(t3Estimate)} atoms\n• T=7 capsid (T7-like): ~${formatAtomEstimate(t7Estimate)} atoms\n\nActual count depends on capsid symmetry and whether RNA/DNA is included.`;
}

function Model3DViewBase({ phage }: Model3DViewProps): React.ReactElement {
  const coarsePointer = useMemo(() => isCoarsePointerDevice(), []);
  const supportsDvh = useMemo(() => {
    if (typeof CSS === 'undefined') return false;
    try {
      return CSS.supports('height', '1dvh');
    } catch {
      return false;
    }
  }, []);
  const webglSupport = useMemo(() => detectWebGLSupport(), []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const renderModeRef = useRef<RenderMode>(coarsePointer ? 'ribbon' : 'ball');
  const structureRef = useRef<Group | null>(null);
  const highlightRef = useRef<Group | null>(null);
  const animationRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const structureDataRef = useRef<LoadedStructure | null>(null);
  const tickRef = useRef<(now: number) => void>(() => {});
  const isInViewportRef = useRef(true);
  const lastTickTimeRef = useRef<number | null>(null);
  const wasRotatingRef = useRef(false);
  const lastCameraPoseRef = useRef<{ pos: Vector3; quat: Quaternion; initialized: boolean }>({
    pos: new Vector3(),
    quat: new Quaternion(),
    initialized: false,
  });
  const qualityGuardRef = useRef<{ lowStreak: number; highStreak: number; lastChange: number }>({
    lowStreak: 0,
    highStreak: 0,
    lastChange: 0,
  });
  const initialModeForPdbRef = useRef<string | null>(null);
  const chainMappingRef = useRef(
    new Map<
      string,
      {
        minResSeq: number;
        geneStart: number;
        geneEnd: number;
        geneStrand: string | null;
        geneAaLen: number;
        geneLabel: string;
      }
    >()
  );
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const raycasterRef = useRef(new Raycaster());
  const [pickedResidue, setPickedResidue] = useState<PickedResidueInfo | null>(null);

  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const fullscreen = usePhageStore(s => s.model3DFullscreen);
  const toggleFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const togglePause = usePhageStore(s => s.toggle3DModelPause);

  const { stack: overlayStack } = useOverlay();
  const overlaysOpen = overlayStack.length > 0;

  // Auto-quality: start at 'high' and adapt based on performance
  const [autoQuality, setAutoQuality] = useState<QualityLevel>(() => (coarsePointer ? 'medium' : 'high'));
  // Manual quality override: null means auto, otherwise locked to a specific level
  const [manualQuality, setManualQuality] = useState<QualityLevel | null>(null);
  const quality = manualQuality ?? autoQuality;
  type QualityPickerValue = 'auto' | QualityLevel;

  const qualityPickerValue: QualityPickerValue = manualQuality ?? 'auto';
  const qualityOptions = useMemo(() => {
    return [
      { value: 'auto' as const, label: `auto (${autoQuality})` },
      { value: 'low' as const, label: 'low' },
      { value: 'medium' as const, label: 'medium' },
      { value: 'high' as const, label: 'high' },
      { value: 'ultra' as const, label: 'ultra' },
    ];
  }, [autoQuality]);

  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [qualityMenuActiveIndex, setQualityMenuActiveIndex] = useState(0);
  const qualityMenuContainerRef = useRef<HTMLDivElement>(null);
  const qualityMenuButtonRef = useRef<HTMLButtonElement>(null);
  const qualityMenuListRef = useRef<HTMLDivElement>(null);

  const closeQualityMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    setQualityMenuOpen(false);
    if (!opts?.restoreFocus) return;
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => qualityMenuButtonRef.current?.focus());
  }, []);

  const openQualityMenu = useCallback(() => {
    const selectedIndex = qualityOptions.findIndex((opt) => opt.value === qualityPickerValue);
    setQualityMenuActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setQualityMenuOpen(true);
  }, [qualityOptions, qualityPickerValue]);

  const applyQualityOption = useCallback((value: QualityPickerValue, opts?: { restoreFocus?: boolean }) => {
    setManualQuality(value === 'auto' ? null : value);
    closeQualityMenu(opts);
  }, [closeQualityMenu]);

  useEffect(() => {
    if (!qualityMenuOpen) return;
    if (typeof window === 'undefined') return;
    const raf = window.requestAnimationFrame(() => qualityMenuListRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [qualityMenuOpen]);

  useEffect(() => {
    if (!qualityMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const container = qualityMenuContainerRef.current;
      if (!container) return;
      if (event.target instanceof Node && container.contains(event.target)) return;
      closeQualityMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [closeQualityMenu, qualityMenuOpen]);

  const handleQualityTriggerKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!qualityMenuOpen) {
        openQualityMenu();
      } else {
        closeQualityMenu({ restoreFocus: true });
      }
    }
  }, [closeQualityMenu, openQualityMenu, qualityMenuOpen]);

  const handleQualityMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeQualityMenu({ restoreFocus: true });
      return;
    }

    if (event.key === 'Tab') {
      // Allow natural focus navigation, but close the menu.
      setQualityMenuOpen(false);
      qualityMenuButtonRef.current?.focus();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setQualityMenuActiveIndex((prev) => (prev + 1) % qualityOptions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setQualityMenuActiveIndex((prev) => (prev - 1 + qualityOptions.length) % qualityOptions.length);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setQualityMenuActiveIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      setQualityMenuActiveIndex(Math.max(0, qualityOptions.length - 1));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const option = qualityOptions[qualityMenuActiveIndex];
      if (!option) return;
      applyQualityOption(option.value, { restoreFocus: true });
    }
  }, [applyQualityOption, closeQualityMenu, qualityMenuActiveIndex, qualityOptions]);

  // Track whether to show keyboard hints in fullscreen
  const [showKeyHints, setShowKeyHints] = useState(true);

  const [renderMode, setRenderMode] = useState<RenderMode>(() => (coarsePointer ? 'ribbon' : 'ball'));

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);
  const frameCounterRef = useRef<{ count: number; lastSample: number }>({
    count: 0,
    lastSample: performance.now(),
  });
  const [showFunctionalGroups, setShowFunctionalGroups] = useState(false);
  const [functionalGroupStyle] = useState<FunctionalGroupStyle>('halo');

  const pdbId = useMemo(() => phage?.pdbIds?.[0] ?? null, [phage?.pdbIds]);
  const qualityPreset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.medium;

  // Prefetch additional PDB structures from the current phage (if it has multiple)
  // Note: Adjacent phage prefetching requires pdbIds in PhageSummary (future enhancement)
  const additionalPdbIds = useMemo(() => {
    if (!phage?.pdbIds || phage.pdbIds.length <= 1) return [];
    return phage.pdbIds.slice(1); // Skip the first one (already loading)
  }, [phage?.pdbIds]);

  usePrefetchAdjacentStructures(additionalPdbIds, show3DModel && Boolean(pdbId));

  useEffect(() => {
    renderModeRef.current = renderMode;
  }, [renderMode]);

  const requestRender = useMemo(() => {
    return () => {
      if (animationRef.current !== null) return;
      animationRef.current = requestAnimationFrame((now) => tickRef.current(now));
    };
  }, []);

  // Stop rendering when the viewer is offscreen (battery/GPU saver, especially on mobile).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!('IntersectionObserver' in window)) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        isInViewportRef.current = entry.isIntersecting;

        if (entry.isIntersecting) {
          requestRender();
          return;
        }

        if (animationRef.current !== null) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        lastTickTimeRef.current = null;
      },
      // Resume rendering as soon as *any* pixel is visible. WebKit can otherwise
      // keep the loop paused during fast scroll / fullscreen transitions, leaving
      // the canvas in a blank/black state.
      { threshold: 0 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [requestRender]);

  // Avoid background GPU/CPU work when the tab is hidden.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (animationRef.current !== null) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        lastTickTimeRef.current = null;
        return;
      }
      if (show3DModel) {
        requestRender();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [requestRender, show3DModel]);

  const {
    data: structureData,
    isLoading: structureLoading,
    isFetching: structureFetching,
    isError: structureError,
    error: structureErr,
    refetch: refetchStructure,
    progress: structureProgress,
    loadingStage,
    fromCache,
  } = useStructureQuery({
    idOrUrl: pdbId ?? undefined,
    enabled: show3DModel && Boolean(pdbId),
    // Force bond detection when ball-and-stick mode is selected.
    // Without bonds, the sticks won't render. 'auto' skips bonds for large
    // structures (>15K atoms) to save computation, which is fine for ribbon/surface
    // modes but breaks ball-and-stick.
    includeBonds: renderMode === 'ball' ? true : 'auto',
    includeFunctionalGroups: showFunctionalGroups,
  });

  // Build a lightweight mapping index from PDB chain residues -> likely gene coordinates (heuristic by length).
  useEffect(() => {
    if (!structureData || !phage?.genes?.length) {
      chainMappingRef.current = new Map();
      setPickedResidue(null);
      return;
    }

    const chainRanges = new Map<string, { minResSeq: number; maxResSeq: number }>();
    for (const atom of structureData.atoms) {
      const chainId = atom.chainId || 'A';
      const resSeq = atom.resSeq;
      if (!Number.isFinite(resSeq)) continue;
      const existing = chainRanges.get(chainId);
      if (existing) {
        existing.minResSeq = Math.min(existing.minResSeq, resSeq);
        existing.maxResSeq = Math.max(existing.maxResSeq, resSeq);
      } else {
        chainRanges.set(chainId, { minResSeq: resSeq, maxResSeq: resSeq });
      }
    }

    const genes = phage.genes.filter((g) => Number.isFinite(g.startPos) && Number.isFinite(g.endPos));
    const mapping = new Map<
      string,
      { minResSeq: number; geneStart: number; geneEnd: number; geneStrand: string | null; geneAaLen: number; geneLabel: string }
    >();

    for (const [chainId, range] of chainRanges.entries()) {
      const chainLen = Math.max(1, range.maxResSeq - range.minResSeq + 1);
      let bestGene = genes[0] ?? null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const gene of genes) {
        const aaLen = Math.max(1, Math.floor((gene.endPos - gene.startPos) / 3));
        const score = Math.abs(aaLen - chainLen);
        if (score < bestScore) {
          bestScore = score;
          bestGene = gene;
        }
      }

      if (!bestGene) continue;
      const label = bestGene.product ?? bestGene.name ?? bestGene.locusTag ?? `Gene ${bestGene.id}`;
      const geneAaLen = Math.max(1, Math.floor((bestGene.endPos - bestGene.startPos) / 3));
      mapping.set(chainId, {
        minResSeq: range.minResSeq,
        geneStart: bestGene.startPos,
        geneEnd: bestGene.endPos,
        geneStrand: bestGene.strand ?? null,
        geneAaLen,
        geneLabel: label,
      });
    }

    chainMappingRef.current = mapping;
    setPickedResidue(null);
  }, [phage?.genes, phage?.id, structureData]);

  // Handle retry with useCallback to avoid stale closures
  const handleRetry = useCallback(() => {
    setError(null);
    setLoadState('loading');
    void refetchStructure();
  }, [refetchStructure]);

  const rebuildStructure = (mode: RenderMode) => {
    const data = structureDataRef.current;
    const scene = sceneRef.current;
    if (!data || !scene) return;

    if (structureRef.current) {
      scene.remove(structureRef.current);
      disposeGroup(structureRef.current);
      structureRef.current = null;
    }
    if (highlightRef.current) {
      scene.remove(highlightRef.current);
      disposeGroup(highlightRef.current);
      highlightRef.current = null;
    }

    let group: Group | null = null;
    const chainColors = data.chains.map((_, idx) => chainPalette[idx % chainPalette.length]);

    switch (mode) {
      case 'ball':
        group = buildBallAndStick(data.atoms, data.bonds, {
          sphereRadius: 0.5,
          bondRadius: 0.12,
          sphereSegments: qualityPreset.sphereSegments,
          bondRadialSegments: qualityPreset.bondRadialSegments,
        });
        break;
      case 'ribbon':
        group = buildTubeFromTraces(
          data.backboneTraces,
          0.3,
          Math.max(4, qualityPreset.tubeRadialSegments - 2),
          '#c084fc',
          0.9,
          chainColors,
          qualityPreset.tubeMinSegments
        );
        break;
      case 'surface':
        group = buildSurfaceImpostor(
          data.atoms,
          1.6,
          qualityPreset.surfaceSegments
        );
        break;
      default:
        group = buildBallAndStick(data.atoms, data.bonds, {
          sphereRadius: 0.5,
          bondRadius: 0.12,
          sphereSegments: qualityPreset.sphereSegments,
          bondRadialSegments: qualityPreset.bondRadialSegments,
        });
    }

    if (group) {
      // Center the group at origin by shifting it opposite to the data center
      const cx = data.center?.x ?? 0;
      const cy = data.center?.y ?? 0;
      const cz = data.center?.z ?? 0;
      group.position.set(-cx, -cy, -cz);

      structureRef.current = group;
      scene.add(group);

      if (showFunctionalGroups && data.functionalGroups?.length) {
        const fg = buildFunctionalGroupHighlights(data.atoms, data.functionalGroups, {
          style: functionalGroupStyle,
        });
        fg.position.set(-cx, -cy, -cz);
        highlightRef.current = fg;
        scene.add(fg);
      }
    }

    requestRender();
  };

  // Initialize scene + renderer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Quality change: update pixel ratio/size without recreating renderer
    if (rendererRef.current && cameraRef.current && sceneRef.current) {
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 260;
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      const dpr = window.devicePixelRatio ?? 1;
      rendererRef.current.shadowMap.enabled = qualityPreset.shadows;
      rendererRef.current.outputColorSpace = SRGBColorSpace;
      rendererRef.current.toneMapping = ACESFilmicToneMapping;
      rendererRef.current.toneMappingExposure = 1.12;
      rendererRef.current.setPixelRatio(Math.min(dpr * qualityPreset.pixelRatio, 2));
      rendererRef.current.setSize(width, height);
      requestRender();
      return;
    }

    const scene = new Scene();
    scene.background = new Color('#0f1529');
    scene.fog = new Fog(0x0f1529, 120, 2600);
    const camera = new PerspectiveCamera(50, 1, 0.1, 5000);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: !coarsePointer && quality !== 'low',
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      setLoadState('error');
      setError(err instanceof Error ? err.message : 'Unable to create WebGL renderer');
      return;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.setClearColor('#0f1529', 1);
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    // Surface context-loss to the user (recovery would require rebuilding the scene)
    const handleContextLost = () => {
      setLoadState('error');
      setError('3D rendering context was lost. WebGL may have been reclaimed by the browser.');
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    // Enhanced lighting setup for better 3D perception
    const ambient = new AmbientLight(0xffffff, 0.9);
    scene.add(ambient);

    // Hemisphere light for natural sky/ground lighting
    const hemiLight = new HemisphereLight(0xd7e7ff, 0x0b1020, 0.9);
    scene.add(hemiLight);

    // Key light (main light from top-right)
    const keyLight = new DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(4.8, 6.6, 5.6);
    scene.add(keyLight);

    // Fill light (softer, from left)
    const fillLight = new DirectionalLight(0xb0c4de, 1.0); // Light steel blue tint
    fillLight.position.set(-3.4, 2.6, 3.4);
    scene.add(fillLight);

    // Rim light (from behind for depth)
    const rimLight = new DirectionalLight(0x88ccff, 0.8); // Cyan tint
    rimLight.position.set(0.3, 0.15, -4.4);
    scene.add(rimLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;
    
    // Wake up on user interaction
    controls.addEventListener('start', requestRender);

    // Headlamp (camera-attached light) to ensure visibility from all angles
    const headlamp = new DirectionalLight(0xffffff, 1.05);
    scene.add(headlamp);
    const syncHeadlamp = () => {
      headlamp.position.copy(camera.position);
      requestRender();
    };
    // Note: syncHeadlamp is redundant if we listen to 'change' for requestRender, but needed for light update.
    // Actually, 'change' fires every frame of damping. 'start' fires on interaction.
    // We need to sync headlamp on every frame if camera moves.
    controls.addEventListener('change', syncHeadlamp);
    syncHeadlamp();

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDownRef.current = { x: event.clientX, y: event.clientY };
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const start = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!start) return;

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx * dx + dy * dy > 9 * 9) return; // treat as drag, not click

      const group = structureRef.current;
      const data = structureDataRef.current;
      if (!group || !data) return;

      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      TEMP_NDC.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      );

      const raycaster = raycasterRef.current;
      raycaster.setFromCamera(TEMP_NDC, camera);
      const hits = raycaster.intersectObject(group, true);
      const hit = hits.find((h) => typeof (h as any).instanceId === 'number' && (h.object as any)?.userData?.pickKind === 'atom');
      if (!hit) return;

      const instanceId = (hit as any).instanceId as number;
      const atom = data.atoms[instanceId];
      if (!atom) return;

      const chainId = atom.chainId || 'A';
      const mapping = chainMappingRef.current.get(chainId);
      if (!mapping) {
        setPickedResidue({
          chainId,
          resSeq: atom.resSeq,
          resName: atom.resName,
          atomName: atom.atomName,
        });
        return;
      }

      const residueIndex = atom.resSeq - mapping.minResSeq;
      if (!Number.isFinite(residueIndex) || residueIndex < 0) return;

      const strand = mapping.geneStrand;
      const clampedResidueIndex = Math.min(residueIndex, Math.max(0, mapping.geneAaLen - 1));
      let basePos = strand === '-' ? mapping.geneEnd - clampedResidueIndex * 3 : mapping.geneStart + clampedResidueIndex * 3;

      const state = usePhageStore.getState();
      const genomeLen = state.currentPhage?.genomeLength;
      if (typeof genomeLen === 'number' && Number.isFinite(genomeLen)) {
        basePos = Math.max(0, Math.min(basePos, Math.max(0, genomeLen - 1)));
      }
      const scrollPos = state.viewMode === 'aa' ? Math.floor(basePos / 3) : basePos;
      state.setScrollPosition(scrollPos);

      setPickedResidue({
        chainId,
        resSeq: atom.resSeq,
        resName: atom.resName,
        atomName: atom.atomName,
        geneLabel: mapping.geneLabel,
        genomePos: basePos,
      });
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

    container.appendChild(renderer.domElement);

    const resize = () => {
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 260;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const dpr = window.devicePixelRatio ?? 1;
      renderer.shadowMap.enabled = qualityPreset.shadows;
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.setPixelRatio(Math.min(dpr * qualityPreset.pixelRatio, 2));
      renderer.setSize(width, height);
      requestRender();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      controls.removeEventListener('start', requestRender);
      controls.removeEventListener('change', syncHeadlamp);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      controls.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      disposeGroup(structureRef.current);
      disposeGroup(highlightRef.current);
      structureDataRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      structureRef.current = null;
      highlightRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [coarsePointer, quality, qualityPreset.pixelRatio, qualityPreset.shadows, requestRender]);

  // Render loop (on-demand): keep animating only while rotating or damping is active.
  useEffect(() => {
    tickRef.current = (now: number) => {
      animationRef.current = null;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return;

      if (!show3DModel) {
        lastTickTimeRef.current = null;
        wasRotatingRef.current = false;
        lastCameraPoseRef.current.initialized = false;
        return;
      }

      if (!isInViewportRef.current || document.hidden) {
        lastTickTimeRef.current = null;
        wasRotatingRef.current = false;
        lastCameraPoseRef.current.initialized = false;
        return;
      }

      const lastTick = lastTickTimeRef.current;
      const deltaMs = lastTick !== null ? now - lastTick : 16.6667;
      lastTickTimeRef.current = now;
      const deltaSeconds = deltaMs / 1000;

      const hasStructure = Boolean(structureRef.current);
      const rotating = hasStructure && !paused;

      if (rotating !== wasRotatingRef.current) {
        wasRotatingRef.current = rotating;
        frameCounterRef.current.count = 0;
        frameCounterRef.current.lastSample = now;
        qualityGuardRef.current.lowStreak = 0;
        qualityGuardRef.current.highStreak = 0;
        setFps(0);
      }

      if (rotating && structureRef.current) {
        // ~0.18 rad/s at speed=1 to match the old 0.003/frame @ 60fps behavior.
        structureRef.current.rotation.y += 0.18 * speed * deltaSeconds;
      }

      // OrbitControls.update() returns void in Three.js; detect damping/interaction by camera deltas.
      let controlsChanged = false;
      const controls = controlsRef.current;
      if (controls) {
        const pose = lastCameraPoseRef.current;
        if (!pose.initialized) {
          pose.pos.copy(camera.position);
          pose.quat.copy(camera.quaternion);
          pose.initialized = true;
        }

        controls.update();

        const posDelta = pose.pos.distanceToSquared(camera.position);
        const rotDelta = 1 - Math.abs(pose.quat.dot(camera.quaternion));
        controlsChanged = posDelta > 1e-8 || rotDelta > 1e-8;

        if (controlsChanged) {
          pose.pos.copy(camera.position);
          pose.quat.copy(camera.quaternion);
        }
      }
      renderer.render(scene, camera);

      if (rotating) {
        frameCounterRef.current.count += 1;
        const elapsed = now - frameCounterRef.current.lastSample;
        if (elapsed >= 1000) {
          const currentFps = (frameCounterRef.current.count * 1000) / elapsed;
          const roundedFps = Math.round(currentFps);
          setFps(roundedFps);
          frameCounterRef.current.count = 0;
          frameCounterRef.current.lastSample = now;

          // Auto-quality with hysteresis. On coarse pointers (phones/tablets), never upgrade beyond "high".
          const guard = qualityGuardRef.current;
          const low = roundedFps < 24;
          const high = roundedFps > 58;
          guard.lowStreak = low ? guard.lowStreak + 1 : 0;
          guard.highStreak = high ? guard.highStreak + 1 : 0;

          const canChangeNow = now - guard.lastChange > 2500;
          if (canChangeNow && guard.lowStreak >= 2) {
            guard.lastChange = now;
            guard.lowStreak = 0;
            setAutoQuality(prev => (prev === 'ultra' ? 'high' : prev === 'high' ? 'medium' : 'low'));
          } else if (!coarsePointer && canChangeNow && guard.highStreak >= 6) {
            guard.lastChange = now;
            guard.highStreak = 0;
            setAutoQuality(prev => (prev === 'low' ? 'medium' : prev === 'medium' ? 'high' : 'ultra'));
          } else if (coarsePointer && canChangeNow && guard.highStreak >= 10) {
            guard.lastChange = now;
            guard.highStreak = 0;
            setAutoQuality(prev => (prev === 'low' ? 'medium' : 'high'));
          }
        }
      }

      // Keep animating while rotation is on or controls are still damping.
      if ((rotating || controlsChanged) && show3DModel) {
        requestRender();
      } else {
        // Stop the loop if nothing is changing
        animationRef.current = null;
      }
    };
  }, [coarsePointer, paused, requestRender, show3DModel, speed]);

  // Kick the loop when 3D becomes visible or unpaused.
  useEffect(() => {
    if (!show3DModel) return;
    requestRender();
  }, [paused, show3DModel, requestRender]);

  // Ensure pending RAF is cleaned up on unmount.
  useEffect(() => {
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Load structure via TanStack Query
  useEffect(() => {
    if (!show3DModel) return;
    if (!pdbId) {
      setLoadState('idle');
      setError(null);
      setProgress(0);
      setAtomCount(null);
      structureDataRef.current = null;
      if (structureRef.current && sceneRef.current) {
        sceneRef.current.remove(structureRef.current);
      }
      disposeGroup(structureRef.current);
      structureRef.current = null;
      if (highlightRef.current && sceneRef.current) {
        sceneRef.current.remove(highlightRef.current);
      }
      disposeGroup(highlightRef.current);
      highlightRef.current = null;
      return;
    }

    if (structureError) {
      setLoadState('error');
      setError(getStructureErrorMessage(structureErr));
      setAtomCount(null);
      structureDataRef.current = null;
      if (structureRef.current && sceneRef.current) {
        sceneRef.current.remove(structureRef.current);
      }
      disposeGroup(structureRef.current);
      structureRef.current = null;
      if (highlightRef.current && sceneRef.current) {
        sceneRef.current.remove(highlightRef.current);
      }
      disposeGroup(highlightRef.current);
      highlightRef.current = null;
      return;
    }

    if (structureLoading || structureFetching) {
      // If we already have a rendered structure, keep it visible while we fetch
      // additional detail (e.g. functional groups) in the background.
      if (!structureData) {
        setLoadState('loading');
        // Use actual progress from hook instead of static 20%
        setProgress(structureProgress > 0 ? structureProgress : 5);
      }
      setError(null);
      return;
    }

    if (structureData) {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      const hasExistingStructureForPdb =
        structureDataRef.current !== null && initialModeForPdbRef.current === pdbId;
      structureDataRef.current = structureData;
      const hasBackboneTraces = structureData.backboneTraces.some(trace => trace.length >= 2);

      // If we already rendered this structure, don't reset camera pose just because
      // we're upgrading detail (e.g. adding functional group highlights).
      if (!hasExistingStructureForPdb) {
        let mode: RenderMode = renderModeRef.current;
        if (initialModeForPdbRef.current !== pdbId) {
          initialModeForPdbRef.current = pdbId;
          const suggested = suggestInitialRenderMode({
            coarsePointer,
            atomCount: structureData.atomCount,
            hasBackboneTraces,
          });
          if (suggested !== renderModeRef.current) {
            setRenderMode(suggested);
            mode = suggested;
          }
        }

        // Build immediately in addition to the loadState effect to avoid a race
        // where the renderMode effect fires before loadState flips to "ready".
        rebuildStructure(mode);

        // ZOOM TO EXTENTS: Calculate optimal camera distance
        // Formula: dist = radius / tan(fov/2), with 1.15 padding for ~10% margin
        // Must consider BOTH vertical and horizontal FOV for proper fit
        const vFovRad = (camera.fov * Math.PI) / 180;
        const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * camera.aspect);
        // Use the tighter (smaller) FOV to ensure molecule fits in both dimensions
        const effectiveFov = Math.min(vFovRad, hFovRad);
        const optimalDist = (structureData.radius / Math.tan(effectiveFov / 2)) * 1.15;
        const dist = Math.max(optimalDist, structureData.radius * 2); // At least 2x radius

        // Structure is centered at origin by rebuildStructure, so camera targets origin
        // Position camera at slight angle for better 3D perception
        // IMPORTANT: Normalize the direction vector then scale to exact distance
        camera.position.copy(DEFAULT_VIEW_DIR).multiplyScalar(dist);
        camera.near = Math.max(0.1, structureData.radius * 0.01);
        camera.far = Math.max(5000, structureData.radius * 10);
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      } else {
        rebuildStructure(renderModeRef.current);
      }
      setAtomCount(structureData.atomCount);
      setProgress(100);
      setLoadState('ready');
      requestRender();
    }
  }, [coarsePointer, pdbId, show3DModel, structureData, structureError, structureErr, structureFetching, structureLoading, structureProgress, requestRender]);

  useEffect(() => {
    if (loadState === 'ready') {
      rebuildStructure(renderMode);
    }
  }, [renderMode, loadState, quality, showFunctionalGroups, functionalGroupStyle]);

  // iOS CSS fullscreen fallback: disable shell transforms that can interfere with `position: fixed`.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    applyThreeFullscreenClass(root, fullscreen);
    if (!fullscreen) return;
    return () => applyThreeFullscreenClass(root, false);
  }, [fullscreen]);

  // When entering fullscreen, ensure rendering resumes and the renderer syncs to final dimensions.
  // This is defensive against WebKit quirks where IntersectionObserver/ResizeObserver may lag.
  useEffect(() => {
    if (!fullscreen) return;
    if (!show3DModel) return;
    if (typeof window === 'undefined') return;
    isInViewportRef.current = true;

    const raf = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (container && renderer && camera) {
        const width = container.clientWidth || 320;
        const height = container.clientHeight || 260;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      }
      requestRender();
    });

    return () => window.cancelAnimationFrame(raf);
  }, [fullscreen, requestRender, show3DModel]);

  // Fullscreen management: sync store state with DOM fullscreen API
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleFsChange = () => {
      const domFullscreen = document.fullscreenElement === container;
      // If DOM exited but store still true, flip store flag back
      if (!domFullscreen && fullscreen) {
        toggleFullscreen();
      }
    };
    const handleKeyEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fullscreen) {
        toggleFullscreen();
      }
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('keydown', handleKeyEsc);

    if (fullscreen && !document.fullscreenElement) {
      // Try native fullscreen, but fall back to CSS fullscreen on iOS/unsupported browsers
      void container.requestFullscreen().catch((err) => {
        if (import.meta.env.DEV) {
          console.warn('Fullscreen request failed (using CSS fallback)', err);
        }
        // Don't revert - CSS fullscreen class will handle the visual fullscreen
      });
    } else if (!fullscreen && document.fullscreenElement === container) {
      void document.exitFullscreen();
    }

    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('keydown', handleKeyEsc);
      if (document.fullscreenElement === container) {
        void document.exitFullscreen();
      }
    };
  }, [fullscreen, toggleFullscreen]);

  const handleScreenshot = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'phage-explorer-3d.png';
    link.click();
  }, []);

  const handleResetView = useCallback(() => {
    const data = structureDataRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!data || !camera || !controls || !scene) return;
    const vFovRad = (camera.fov * Math.PI) / 180;
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * camera.aspect);
    const effectiveFov = Math.min(vFovRad, hFovRad);
    const optimalDist = (data.radius / Math.tan(effectiveFov / 2)) * 1.08;
    const dist = Math.max(optimalDist, data.radius * 1.8);
    camera.position.copy(HIGHLIGHT_VIEW_DIR).multiplyScalar(dist);
    camera.near = Math.max(0.1, data.radius * 0.01);
    camera.far = Math.max(5000, data.radius * 10);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    rendererRef.current?.render(scene, camera);
  }, []);

  // Keyboard controls only in fullscreen: arrows rotate, +/- zoom, space toggles rotation
  useEffect(() => {
    if (!fullscreen) return;
    if (!show3DModel) return;
    if (overlaysOpen) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();

    const getReadyRefs = () => {
      const scene = sceneRef.current;
      const structure = structureRef.current;
      const controls = controlsRef.current;
      if (!scene || !structure || !controls) return null;
      return { structure, controls };
    };

    const rotateLeft = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      refs.structure.rotation.y -= 0.05;
      requestRender();
    };
    const rotateRight = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      refs.structure.rotation.y += 0.05;
      requestRender();
    };
    const rotateUp = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      refs.structure.rotation.x -= 0.05;
      requestRender();
    };
    const rotateDown = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      refs.structure.rotation.x += 0.05;
      requestRender();
    };
    const zoomIn = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      // dollyIn/dollyOut are internal OrbitControls methods, not in public typings
      (refs.controls as OrbitControls & { dollyIn?: (scale: number) => void }).dollyIn?.(1.1);
      refs.controls.update();
      requestRender();
    };
    const zoomOut = () => {
      const refs = getReadyRefs();
      if (!refs) return;
      (refs.controls as OrbitControls & { dollyOut?: (scale: number) => void }).dollyOut?.(1.1);
      refs.controls.update();
      requestRender();
    };

    const cycleQuality = () => {
      // Cycle quality: auto -> low -> medium -> high -> ultra -> auto
      const levels: (QualityLevel | null)[] = [null, 'low', 'medium', 'high', 'ultra'];
      setManualQuality((prev) => {
        const currentIdx = levels.indexOf(prev);
        const nextIdx = (currentIdx + 1) % levels.length;
        return levels[nextIdx];
      });
      requestRender();
    };

    const definitions: HotkeyDefinition[] = [
      // Rotation
      { combo: { key: 'ArrowLeft' }, description: '3D fullscreen: rotate left', action: rotateLeft, priority: 10 },
      { combo: { key: 'ArrowRight' }, description: '3D fullscreen: rotate right', action: rotateRight, priority: 10 },
      { combo: { key: 'ArrowUp' }, description: '3D fullscreen: rotate up', action: rotateUp, priority: 10 },
      { combo: { key: 'ArrowDown' }, description: '3D fullscreen: rotate down', action: rotateDown, priority: 10 },

      // Zoom
      { combo: { key: '+' }, description: '3D fullscreen: zoom in', action: zoomIn, priority: 10 },
      { combo: { key: '=' }, description: '3D fullscreen: zoom in', action: zoomIn, priority: 10 },
      { combo: { key: '-' }, description: '3D fullscreen: zoom out', action: zoomOut, priority: 10 },
      { combo: { key: '_' }, description: '3D fullscreen: zoom out', action: zoomOut, priority: 10 },

      // Playback
      { combo: { key: ' ' }, description: '3D fullscreen: toggle pause', action: togglePause, priority: 10 },

      // Quality cycle (q / Q)
      { combo: { key: 'q' }, description: '3D fullscreen: cycle quality', action: cycleQuality, priority: 10 },
      { combo: { key: 'q', modifiers: { shift: true } }, description: '3D fullscreen: cycle quality', action: cycleQuality, priority: 10 },

      // Key hints (h / H)
      { combo: { key: 'h' }, description: '3D fullscreen: toggle key hints', action: () => setShowKeyHints((v) => !v), priority: 10 },
      { combo: { key: 'h', modifiers: { shift: true } }, description: '3D fullscreen: toggle key hints', action: () => setShowKeyHints((v) => !v), priority: 10 },

      // Reset view (r / R)
      { combo: { key: 'r' }, description: '3D fullscreen: reset view', action: handleResetView, priority: 10 },
      { combo: { key: 'r', modifiers: { shift: true } }, description: '3D fullscreen: reset view', action: handleResetView, priority: 10 },

      // Screenshot (s / S)
      { combo: { key: 's' }, description: '3D fullscreen: screenshot', action: handleScreenshot, priority: 10 },
      { combo: { key: 's', modifiers: { shift: true } }, description: '3D fullscreen: screenshot', action: handleScreenshot, priority: 10 },
    ];

    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [fullscreen, handleResetView, handleScreenshot, overlaysOpen, requestRender, show3DModel, togglePause]);

  const stateLabel = loadState === 'ready'
    ? (fromCache ? 'Cached' : 'Loaded')
    : loadState === 'loading'
      ? 'Loading…'
      : loadState === 'error'
        ? 'Error'
        : 'Idle';

  // Show fallback if WebGL is not supported
  if (!webglSupport.supported) {
    return (
      <div className="panel" aria-label="3D structure viewer">
        <div className="panel-header">
          <h3>3D Structure</h3>
          <Badge>Not Available</Badge>
        </div>
        <div
          className="three-container"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            padding: '32px',
            textAlign: 'center',
            minHeight: '280px',
            background: 'var(--color-background-alt)',
          }}
          role="alert"
          aria-live="polite"
        >
          <div style={{ opacity: 0.6 }} aria-hidden="true">
            <IconCube size={48} />
          </div>
          <h4 style={{ margin: 0, color: 'var(--color-text)' }}>3D Viewer Not Available</h4>
          <p className="text-dim" style={{ margin: 0, maxWidth: '320px' }}>
            Your browser doesn't support WebGL, which is required for 3D visualization.
            Try using a modern browser like Chrome, Firefox, or Edge.
          </p>
        </div>
        <div className="panel-footer text-dim">
          WebGL support required for 3D structures
        </div>
      </div>
    );
  }

  // Show empty state if phage has no structure
  const hasNoStructure = !pdbId && loadState !== 'loading';
  const rcsbEntryUrl = pdbId ? getRcsbEntryUrl(pdbId) : null;

  return (
    <div className="panel" aria-label="3D structure viewer">
      <div className="panel-header">
        <h3>3D Structure</h3>
        <div className="badge-row">
          <Badge>{hasNoStructure ? 'No Data' : stateLabel}</Badge>
          {atomCount !== null && (
            <Tooltip
              content={
                <div style={{ whiteSpace: 'pre-line', maxWidth: '280px', textAlign: 'left' }}>
                  {getAsymmetricUnitTooltip(atomCount)}
                </div>
              }
              position="bottom"
              hintType="definition"
            >
              <SubtleBadge>{atomCount.toLocaleString()} atoms (asymmetric unit)</SubtleBadge>
            </Tooltip>
          )}
          {!hasNoStructure && <SubtleBadge>FPS {fps || '—'}</SubtleBadge>}
        </div>
      </div>

      <div className="toolbar" style={{ display: 'flex', gap: '8px', padding: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Render mode selector - segmented control style */}
        <div className="segmented-control" style={{ display: 'flex', gap: '1px', background: 'var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
          {(['ball', 'ribbon', 'surface'] as RenderMode[]).map(mode => (
            <button
              key={mode}
              type="button"
              className={`btn compact ${renderMode === mode ? 'active' : ''}`}
              onClick={() => setRenderMode(mode)}
              style={{ borderRadius: 0, margin: 0, minHeight: '36px', minWidth: '40px' }}
              title={`View mode: ${mode}`}
            >
              {mode === 'ball' ? '⚛' : mode === 'ribbon' ? '〰' : '◉'}
            </button>
          ))}
        </div>

        <span className="separator" style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 8px' }} />

        {/* Essential controls */}
        <button
          type="button"
          className={`btn compact ${!paused ? 'active' : ''}`}
          onClick={() => togglePause()}
          style={{ minHeight: '36px', minWidth: '40px' }}
          title={paused ? 'Resume rotation' : 'Pause rotation'}
        >
          {paused ? '▶' : '⏸'}
        </button>
        <button
          type="button"
          className="btn compact"
          onClick={toggleFullscreen}
          style={{ minHeight: '36px', minWidth: '40px' }}
          title="Fullscreen"
        >
          {fullscreen ? '⤓' : '⤢'}
        </button>
        <button
          type="button"
          className="btn compact"
          onClick={handleResetView}
          style={{ minHeight: '36px', minWidth: '40px' }}
          aria-label="Reset view"
          title="Reset view"
        >
          <IconRepeat size={18} />
        </button>
        <button
          type="button"
          className="btn compact"
          onClick={handleScreenshot}
          style={{ minHeight: '36px', minWidth: '40px' }}
          aria-label="Save screenshot"
          title="Save screenshot"
        >
          <IconCamera size={18} />
        </button>

        {/* Functional groups - only show if available */}
        {structureDataRef.current?.functionalGroups?.length ? (
          <>
            <span className="separator" style={{ width: '1px', height: '20px', background: 'var(--border)', margin: '0 4px' }} />
            <button
              type="button"
              className={`btn compact ${showFunctionalGroups ? 'active' : ''}`}
              onClick={() => setShowFunctionalGroups(v => !v)}
              aria-label="Toggle functional group highlights"
              title="Toggle functional group highlights"
            >
              <IconFlask size={18} />
            </button>
          </>
        ) : null}

        {/* Quality selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="text-dim" style={{ fontSize: '11px' }}>Quality:</span>
          <div ref={qualityMenuContainerRef} style={{ position: 'relative' }}>
            <button
              ref={qualityMenuButtonRef}
              type="button"
              className="btn compact"
              aria-haspopup="listbox"
              aria-expanded={qualityMenuOpen}
              onClick={() => {
                if (qualityMenuOpen) {
                  setQualityMenuOpen(false);
                  return;
                }
                openQualityMenu();
              }}
              onKeyDown={handleQualityTriggerKeyDown}
              style={{ minHeight: '28px', padding: '4px 8px', fontSize: '11px', gap: '6px' }}
              data-testid="model3d-quality-trigger"
            >
              <span style={{ color: 'var(--color-text)' }}>
                {qualityPickerValue === 'auto' ? `auto (${autoQuality})` : qualityPickerValue}
              </span>
              <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.8 }}>
                <IconChevronDown size={14} />
              </span>
            </button>
            {qualityMenuOpen && (
              <div
                ref={qualityMenuListRef}
                role="listbox"
                aria-label="Quality"
                tabIndex={-1}
                onKeyDown={handleQualityMenuKeyDown}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 6px)',
                  minWidth: '160px',
                  padding: '6px',
                  background: 'var(--color-background-elevated)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: '12px',
                  boxShadow: 'var(--shadow-lg, 0 12px 36px rgba(0,0,0,0.35))',
                  zIndex: 50,
                }}
                data-testid="model3d-quality-menu"
              >
                {qualityOptions.map((opt, idx) => {
                  const selected = opt.value === qualityPickerValue;
                  const active = idx === qualityMenuActiveIndex;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="btn btn-ghost btn-sm"
                      onClick={() => applyQualityOption(opt.value, { restoreFocus: true })}
                      onMouseEnter={() => setQualityMenuActiveIndex(idx)}
                      style={{
                        width: '100%',
                        justifyContent: 'space-between',
                        fontSize: '11px',
                        padding: '6px 8px',
                        borderRadius: '10px',
                        background: active ? 'var(--color-background-hover)' : 'transparent',
                      }}
                      data-testid={`model3d-quality-option-${opt.value}`}
                    >
                      <span style={{ color: 'var(--color-text)' }}>{opt.label}</span>
                      {selected && (
                        <span aria-hidden="true" style={{ color: 'var(--color-primary)', fontWeight: 700 }}>
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className={`three-container${fullscreen ? ' three-container--fullscreen' : ''}`}
        ref={containerRef}
        role="presentation"
        style={
          fullscreen
            ? {
                width: '100%',
                height: supportsDvh
                  ? 'calc(100dvh - 120px)'
                  : 'calc(var(--vvh, 1vh) * 100 - 120px)',
              }
            : undefined
        }
      >
        {/* Loading state with skeleton */}
        {loadState === 'loading' && (
          <div className="three-overlay" aria-busy="true" aria-label="Loading 3D structure">
            <Model3DSkeleton />
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{ marginTop: '12px' }}
            >
              <div className="progress" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
            </div>
            <p className="text-dim" style={{ marginTop: '16px' }}>
              {loadingStage === 'fetching' && 'Fetching from RCSB PDB…'}
              {loadingStage === 'parsing' && 'Parsing structure…'}
              {loadingStage === 'bonds' && 'Detecting bonds…'}
              {loadingStage === 'traces' && 'Building traces…'}
              {loadingStage === 'functional' && 'Analyzing functional groups…'}
              {loadingStage === 'finalizing' && 'Finalizing…'}
              {!loadingStage && 'Loading structure…'}
              {' '}{Math.round(progress)}%
            </p>
          </div>
        )}

        {/* Error state with retry button */}
        {loadState === 'error' && (
          <div
            className="three-overlay"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              padding: '24px',
              textAlign: 'center',
            }}
            role="alert"
            aria-live="polite"
          >
            <div style={{ opacity: 0.6, color: 'var(--color-error)' }} aria-hidden="true">
              <IconAlertTriangle size={40} />
            </div>
            <h4 style={{ margin: 0, color: 'var(--color-text)' }}>Unable to Load Structure</h4>
            <p className="text-dim" style={{ margin: 0, maxWidth: '280px' }}>
              {error}
            </p>
            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRetry}
                style={{ minWidth: '80px' }}
              >
                Retry
              </button>
            </div>
            {rcsbEntryUrl && (
              <a
                href={rcsbEntryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link"
                style={{
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  color: 'var(--color-accent)',
                }}
              >
                Open in RCSB PDB →
              </a>
            )}
          </div>
        )}

        {/* Empty state - no structure available for this phage */}
        {hasNoStructure && show3DModel && (
          <div
            className="three-overlay"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              padding: '24px',
              textAlign: 'center',
            }}
            role="status"
            aria-live="polite"
          >
            <div style={{ opacity: 0.5 }} aria-hidden="true">
              <IconDna size={40} />
            </div>
            <h4 style={{ margin: 0, color: 'var(--color-text)' }}>No Structure Available</h4>
            <p className="text-dim" style={{ margin: 0, maxWidth: '320px' }}>
              This phage doesn't have a 3D structure in our database yet.
              Not all phages have experimentally determined or predicted structures.
            </p>
            <a
              href={`https://www.rcsb.org/search?request=%7B%22query%22%3A%7B%22type%22%3A%22terminal%22%2C%22service%22%3A%22text%22%2C%22parameters%22%3A%7B%22value%22%3A%22${encodeURIComponent(phage?.name ?? 'bacteriophage')}%22%7D%7D%2C%22return_type%22%3A%22entry%22%7D`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link"
              style={{
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                color: 'var(--color-accent)',
              }}
            >
              Search RCSB PDB →
            </a>
          </div>
        )}

        {/* Hidden state */}
        {!show3DModel && (
          <div className="three-overlay">
            <p className="text-dim">3D model hidden (toggle with M)</p>
          </div>
        )}

        {/* Residue selection */}
        {loadState === 'ready' && show3DModel && pickedResidue && (
          <div
            className="three-hud"
            style={{
              left: '1rem',
              top: '1rem',
              right: 'auto',
              bottom: 'auto',
              width: 'auto',
              background: 'rgba(15, 21, 41, 0.85)',
              backdropFilter: 'blur(4px)',
              borderRadius: '8px',
              padding: '10px 14px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Badge>Selected</Badge>
                <span style={{ color: 'var(--color-text)', fontSize: '12px' }}>
                  {pickedResidue.chainId}:{pickedResidue.resName}{pickedResidue.resSeq}
                </span>
              </div>
              {pickedResidue.geneLabel && (
                <div className="text-dim" style={{ fontSize: '11px' }}>
                  Gene: {pickedResidue.geneLabel}
                </div>
              )}
              {pickedResidue.geneLabel && (
                <div className="text-dim" style={{ fontSize: '11px' }}>
                  Mapping: chain length heuristic
                </div>
              )}
              {pickedResidue.genomePos !== undefined && (
                <div className="text-dim" style={{ fontSize: '11px' }}>
                  Jumped to {pickedResidue.genomePos.toLocaleString()} bp
                </div>
              )}
            </div>
          </div>
        )}

        {/* Fullscreen HUD - Stats overlay top right */}
        {fullscreen && show3DModel && (
          <div
            className="three-hud"
            style={{
              right: '1rem',
              top: '1rem',
              left: 'auto',
              bottom: 'auto',
              width: 'auto',
              background: 'rgba(15, 21, 41, 0.85)',
              backdropFilter: 'blur(4px)',
              borderRadius: '8px',
              padding: '10px 14px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '140px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="text-dim" style={{ fontSize: '11px' }}>FPS</span>
                <Badge>{fps || '—'}</Badge>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="text-dim" style={{ fontSize: '11px' }}>Quality</span>
                <SubtleBadge style={{ cursor: 'pointer' }} title="Press Q to cycle">
                  {manualQuality ? quality : `auto (${quality})`}
                </SubtleBadge>
              </div>
              {atomCount && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="text-dim" style={{ fontSize: '11px' }}>Atoms</span>
                  <SubtleBadge>{atomCount.toLocaleString()}</SubtleBadge>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Fullscreen HUD - Keyboard hints bottom left */}
        {fullscreen && show3DModel && showKeyHints && (
          <div
            className="three-hud"
            style={{
              left: '1rem',
              bottom: '1rem',
              top: 'auto',
              right: 'auto',
              width: 'auto',
              background: 'rgba(15, 21, 41, 0.85)',
              backdropFilter: 'blur(4px)',
              borderRadius: '8px',
              padding: '12px 16px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-dim)', marginBottom: '4px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Keyboard Controls
              </span>
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span><kbd>↑↓←→</kbd> Rotate</span>
                  <span><kbd>+/-</kbd> Zoom</span>
                  <span><kbd>Space</kbd> {paused ? 'Play' : 'Pause'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span><kbd>Q</kbd> Quality</span>
                  <span><kbd>R</kbd> Reset view</span>
                  <span><kbd>S</kbd> Screenshot</span>
                </div>
              </div>
              <span style={{ color: 'var(--text-dim)', marginTop: '6px', fontSize: '10px' }}>
                <kbd>H</kbd> hide hints · <kbd>Esc</kbd> exit
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="panel-footer text-dim">
        {pdbId
          ? `Source: ${pdbId}${atomCount ? ` · ${atomCount.toLocaleString()} atoms (asymmetric unit) · Full virion: ~${formatAtomEstimate(atomCount * 180)}` : ''}`
          : 'No PDB/mmCIF structure available for this phage'}
      </div>
    </div>
  );
}

// Memoize to prevent re-renders when parent updates but props haven't changed
export const Model3DView = memo(Model3DViewBase);
