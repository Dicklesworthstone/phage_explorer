import React, {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GeneInfo } from '@phage-explorer/core';
import { AppShell } from './components/layout/AppShell';
import OverlayManager from './components/overlays/OverlayManager';
import { useOverlay } from './components/overlays/OverlayProvider';
import type { OverlayId } from './components/overlays/OverlayProvider';
import { DataLoadingOverlay } from './components/DataLoadingOverlay';
import { useDatabase } from './hooks/useDatabase';
import { useHotkeys, useKeyboardMode, usePendingSequence } from './hooks/useHotkey';
import { useExperienceLevelSync, useBlockedHotkeyNotification } from './hooks/useExperienceLevelSync';
import { useDiffReferenceSequence } from './hooks/useDiffReferenceSequence';
import { ActionIds, getOverlayHotkeyActions } from './keyboard/actionRegistry';
import {
  APP_SHELL_FOOTER_HINTS,
  detectShortcutPlatform,
  formatActionShortcutForSurface,
  formatHintKeys,
} from './keyboard/actionSurfaces';
import { useTheme } from './hooks/useTheme';
import { useReducedMotion } from './hooks/useReducedMotion';
import { BlockedHotkeyToast } from './components/BlockedHotkeyToast';
import { useToast } from './components/ui/Toast';
import type { PhageRepository } from './db';
import {
  detectCoarsePointerDevice,
  get3DViewerDisabledDescription,
  getEffectiveBackgroundEffects,
  getEffectiveGlow,
  getEffectiveScanlines,
  usePhageStore,
  useWebPreferences,
} from './store';
import { preloadWorkers } from './workers';
import { getGeneProductContext, useBeginnerMode, useBeginnerModeInit, TourEngine } from './education';
import { GeneMapCanvas } from './components/GeneMapCanvas';
import { SequenceView } from './components/SequenceView';
import { BeginnerModeIndicator } from './components/BeginnerModeIndicator';
import { ReadingFrameVisualizer } from './components/ReadingFrameVisualizer';
import { GlossaryPanel } from './education/glossary/GlossaryPanel';
import { LearnMenu } from './components/LearnMenu';
import { PhageIllustration, hasIllustration } from './components/PhageIllustration';
import { PhageList } from './components/PhageList';

// Mobile controls
import {
  ControlDeck,
  SwipeIndicators,
  PhagePickerTrigger,
  PhagePickerSheet,
} from './components/mobile';
import { FloatingActionButton, ActionDrawer } from './components/controls';
import { DataFreshnessIndicator } from './components/ui/DataFreshnessIndicator';
import {
  IconSettings,
  IconCommand,
} from './components/ui/icons';
import { Model3DSkeleton, SequenceViewSkeleton } from './components/ui/Skeleton';
import { FeatureErrorBoundary } from './components/layout/FeatureErrorBoundary';

// Desktop UI components for surfacing hidden functionality
import { ActionToolbar } from './components/ActionToolbar';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { QuickStats } from './components/QuickStats';
import { haptics } from './utils/haptics';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';

const BREAKPOINT_PHONE_PX = 640;
const BREAKPOINT_TOUCH_UI_PX = 900;
const BREAKPOINT_NARROW_PX = 1100;
const BREAKPOINT_WIDE_PX = 1400; // Show analysis sidebar on wide screens

export function shouldIgnoreMobileSwipeTarget(target: EventTarget | null): boolean {
  const maybeElement = target as unknown as { closest?: (selector: string) => unknown };
  if (!maybeElement || typeof maybeElement.closest !== 'function') return true;
  return Boolean(
    maybeElement.closest(
      'input, textarea, select, button, a, .phage-list, .sequence-view, .three-container, .control-deck, .overlay, .glossary-shell, .quick-stats, .db-status-bar'
    )
  );
}

const LazyModel3DView = lazy(async () => {
  const mod = await import('./components/Model3DView');
  return { default: mod.Model3DView };
});

export default function App(): React.ReactElement {
  const { theme, nextTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const highContrast = useWebPreferences((s) => s.highContrast);
  const backgroundEffects = useWebPreferences((s) => s.backgroundEffects);
  const scanlines = useWebPreferences((s) => s.scanlines);
  const glow = useWebPreferences((s) => s.glow);
  const fxSafeMode = useWebPreferences((s) => s.fxSafeMode);
  const setFxSafeMode = useWebPreferences((s) => s.setFxSafeMode);
  const webPrefsHydrated = useWebPreferences((s) => s._hasHydrated);
  const hasSeenWelcome = useWebPreferences((s) => s.hasSeenWelcome);
  const hasLearnedMobileSwipe = useWebPreferences((s) => s.hasLearnedMobileSwipe);
  const setHasLearnedMobileSwipe = useWebPreferences((s) => s.setHasLearnedMobileSwipe);

  useBeginnerModeInit();
  const {
    repository,
    isLoading,
    progress,
    error,
    isCached,
    load,
    reload,
  } = useDatabase({ autoLoad: true });
  const {
    toggle: toggleBeginnerMode,
    isEnabled: beginnerModeEnabled,
    isGlossaryOpen,
    closeGlossary,
    showContextFor,
  } = useBeginnerMode();
  const { toast: showToast } = useToast();
  const welcomeOpenedRef = useRef(false);
  const [srStatusMessage, setSrStatusMessage] = useState('');
  const [srAlertMessage, setSrAlertMessage] = useState('');
  const lastAnnouncedPhageRef = useRef<string | null>(null);
  const lastRepositoryReadyRef = useRef(false);
  const lastLoadingPhageRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  // Request token to guard against stale async results when rapidly switching phages
  const loadRequestIdRef = useRef(0);
  const announceSr = useCallback((kind: 'status' | 'alert', message: string) => {
    if (typeof window === 'undefined') return;
    if (kind === 'alert') {
      setSrAlertMessage('');
      window.requestAnimationFrame(() => setSrAlertMessage(message));
      return;
    }
    setSrStatusMessage('');
    window.requestAnimationFrame(() => setSrStatusMessage(message));
  }, []);

  const phages = usePhageStore((s) => s.phages);
  const currentPhageIndex = usePhageStore((s) => s.currentPhageIndex);
  const currentPhage = usePhageStore((s) => s.currentPhage);
  /**
   * Diff toggle.
   *
   * The registry declared `d` for this and the toolbar rendered the shortcut in
   * its button label, so the UI told the user the key worked. Nothing ever
   * registered the handler: a search for ActionIds.DiffToggle found the registry
   * entry and the label formatter, and no listener. Diff mode is Layer 0 of the
   * README's "sacred surface" and one of the ten headline features.
   *
   * The machinery was all present -- the store action, the toolbar button, and
   * DiffHighlighter's next/prev-diff hotkeys. Only the toggle was missing.
   */
  const toggleDiff = usePhageStore((s) => s.toggleDiff);
  const isLoadingPhage = usePhageStore((s) => s.isLoadingPhage);
  const setPhages = usePhageStore((s) => s.setPhages);
  const setCurrentPhageIndex = usePhageStore((s) => s.setCurrentPhageIndex);
  const setCurrentPhage = usePhageStore((s) => s.setCurrentPhage);
  const setLoadingPhage = usePhageStore((s) => s.setLoadingPhage);
  const setError = usePhageStore((s) => s.setError);
  const storeSetTheme = usePhageStore((s) => s.setTheme);
  const storeCloseOverlay = usePhageStore((s) => s.closeOverlay);
  const show3DModel = usePhageStore((s) => s.show3DModel);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const viewerDisabledDescription = useMemo(() => get3DViewerDisabledDescription(), []);
  const { open: openOverlayCtx, close: closeOverlayCtx, toggle: toggleOverlayCtx, hasBlockingOverlay } = useOverlay();
  const { mode } = useKeyboardMode();
  const pendingSequence = usePendingSequence();

  // Load the diff reference genome whenever diff mode is on. Without this the
  // store's diffReferenceSequence stayed null in the browser forever, which
  // left the selection-pressure dN/dS overlay permanently empty.
  useDiffReferenceSequence(repository);

  // Sync experience level to keyboard manager and handle blocked hotkey notifications
  useExperienceLevelSync();
  const { blockedHotkey, dismiss: dismissBlockedHotkey } = useBlockedHotkeyNotification();
  const [fullSequence, setFullSequence] = useState<string>('');
  const [selectedGene, setSelectedGene] = useState<GeneInfo | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [actionDrawerOpen, setActionDrawerOpen] = useState(false);
  const [phagePickerOpen, setPhagePickerOpen] = useState(false);
  const [analysisSidebarCollapsed, setAnalysisSidebarCollapsed] = useState(false);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const sessionSwipeCountRef = useRef(0); // Track successful swipes for learning hint
  const glossaryShellRef = useRef<HTMLDivElement | null>(null);
  const glossaryOpenerRef = useRef<HTMLElement | null>(null);
  const wasGlossaryOpenRef = useRef(false);
  const glossaryTitleId = useId();
  const geneHint = useMemo(() => {
    if (!beginnerModeEnabled || !selectedGene) return null;

    const haystack = `${selectedGene.name ?? ''} ${selectedGene.locusTag ?? ''} ${selectedGene.product ?? ''}`.toLowerCase();
    const key =
      haystack.includes('tail fiber') || haystack.includes('tail-fiber') || haystack.includes('tailspike')
        ? 'tail-fiber'
        : haystack.includes('capsid') || haystack.includes('coat protein') || haystack.includes('head protein')
          ? 'capsid'
          : haystack.includes('holin')
            ? 'holin'
            : haystack.includes('endolysin') || haystack.includes('lysin') || haystack.includes('lysozyme')
              ? 'endolysin'
              : haystack.includes('integrase') || haystack.includes('repressor') || haystack.includes('lysogen')
                ? 'lysogeny'
                : null;

    return key ? getGeneProductContext(key) ?? null : null;
  }, [beginnerModeEnabled, selectedGene]);

  useEffect(() => {
    setSelectedGene(null);
  }, [currentPhage?.id]);
  const getLayoutSnapshot = useCallback(() => {
    if (typeof window === 'undefined') {
      return {
        isNarrow: false,
        isMobile: false,
        isTouchUi: false,
        isLandscape: false,
        isWide: false,
        isCoarsePointer: false,
      };
    }
    const width = window.innerWidth;
    const height = window.innerHeight || 1;
    return {
      isNarrow: width <= BREAKPOINT_NARROW_PX,
      isMobile: width <= BREAKPOINT_PHONE_PX,
      isTouchUi: width <= BREAKPOINT_TOUCH_UI_PX,
      isLandscape: width > height,
      isWide: width >= BREAKPOINT_WIDE_PX,
      isCoarsePointer: detectCoarsePointerDevice(),
    };
  }, []);

  const [{ isNarrow, isMobile, isTouchUi, isLandscape, isWide, isCoarsePointer }, setLayout] = useState(() =>
    getLayoutSnapshot()
  );
  const enableBackgroundEffects = useMemo(
    () =>
      getEffectiveBackgroundEffects(backgroundEffects, {
        reducedMotion,
        coarsePointer: isCoarsePointer,
        safeMode: fxSafeMode,
        narrowViewport: isNarrow,
      }),
    [backgroundEffects, reducedMotion, isCoarsePointer, fxSafeMode, isNarrow]
  );

  const effectiveScanlines = useMemo(
    () =>
      getEffectiveScanlines(scanlines, {
        reducedMotion,
        coarsePointer: isCoarsePointer,
        safeMode: fxSafeMode,
      }),
    [scanlines, reducedMotion, isCoarsePointer, fxSafeMode]
  );

  const effectiveGlow = useMemo(
    () =>
      getEffectiveGlow(glow, {
        reducedMotion,
        coarsePointer: isCoarsePointer,
        safeMode: fxSafeMode,
      }),
    [glow, reducedMotion, isCoarsePointer, fxSafeMode]
  );

  const heavyFxActive = enableBackgroundEffects || effectiveScanlines || effectiveGlow;
  const safeModeCooldownUntilRef = useRef(0);
  const lastScrollActivityAtRef = useRef(0);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const markWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      lastScrollActivityAtRef.current = performance.now();
    };

    const markTouch = () => {
      lastScrollActivityAtRef.current = performance.now();
    };

    // IMPORTANT: options must match exactly for removeEventListener to work
    const wheelOptions = { passive: true, capture: true } as const;
    const touchOptions = { passive: true, capture: true } as const;
    document.addEventListener('wheel', markWheel, wheelOptions);
    document.addEventListener('touchmove', markTouch, touchOptions);
    return () => {
      document.removeEventListener('wheel', markWheel, wheelOptions);
      document.removeEventListener('touchmove', markTouch, touchOptions);
    };
  }, []);

  useEffect(() => {
    if (!heavyFxActive) return;
    if (fxSafeMode) return;

    let rafId: number | null = null;
    let last = performance.now();
    let windowStart = last;
    let slowFrames = 0;
    let scrollingFrames = 0;

    const tick = (now: number) => {
      const dt = now - last;
      last = now;

      // Ignore tab-switch / background hitches so we don't trigger safe mode spuriously.
      if (dt > 250) {
        windowStart = now;
        slowFrames = 0;
        scrollingFrames = 0;
      } else {
        const scrolling = now - lastScrollActivityAtRef.current < 700;
        if (scrolling) {
          scrollingFrames += 1;
          if (dt > 40) slowFrames += 1;
        }

        if (now - windowStart > 2000) {
          if (now > safeModeCooldownUntilRef.current && scrollingFrames >= 30 && slowFrames >= 6) {
            safeModeCooldownUntilRef.current = now + 30_000;
            setFxSafeMode(true);
            showToast({
              id: 'fx-safe-mode',
              title: 'Safe mode enabled',
              message: 'Heavy visual effects were paused to keep scrolling smooth. Your settings are unchanged.',
              variant: 'warning',
              duration: 8000,
              actions: [
                {
                  label: 'Resume FX',
                  onClick: () => {
                    safeModeCooldownUntilRef.current = performance.now() + 30_000;
                    setFxSafeMode(false);
                  },
                },
              ],
            });
            return;
          }
          windowStart = now;
          slowFrames = 0;
          scrollingFrames = 0;
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [heavyFxActive, fxSafeMode, setFxSafeMode]);


  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

    const mobileMql = window.matchMedia(`(max-width: ${BREAKPOINT_PHONE_PX}px)`);
    const touchUiMql = window.matchMedia(`(max-width: ${BREAKPOINT_TOUCH_UI_PX}px)`);
    const narrowMql = window.matchMedia(`(max-width: ${BREAKPOINT_NARROW_PX}px)`);
    const wideMql = window.matchMedia(`(min-width: ${BREAKPOINT_WIDE_PX}px)`);
    const landscapeMql = window.matchMedia('(orientation: landscape)');
    const coarsePointerMql = window.matchMedia('(pointer: coarse)');
    const hoverNoneMql = window.matchMedia('(hover: none)');

    const updateLayout = () => {
      setLayout({
        isNarrow: narrowMql.matches,
        isMobile: mobileMql.matches,
        isTouchUi: touchUiMql.matches,
        isLandscape: landscapeMql.matches,
        isWide: wideMql.matches,
        isCoarsePointer: detectCoarsePointerDevice(),
      });
    };

    updateLayout();

    mobileMql.addEventListener('change', updateLayout);
    touchUiMql.addEventListener('change', updateLayout);
    narrowMql.addEventListener('change', updateLayout);
    wideMql.addEventListener('change', updateLayout);
    landscapeMql.addEventListener('change', updateLayout);
    coarsePointerMql.addEventListener('change', updateLayout);
    hoverNoneMql.addEventListener('change', updateLayout);
    window.addEventListener('resize', updateLayout);

    return () => {
      mobileMql.removeEventListener('change', updateLayout);
      touchUiMql.removeEventListener('change', updateLayout);
      narrowMql.removeEventListener('change', updateLayout);
      wideMql.removeEventListener('change', updateLayout);
      landscapeMql.removeEventListener('change', updateLayout);
      coarsePointerMql.removeEventListener('change', updateLayout);
      hoverNoneMql.removeEventListener('change', updateLayout);
      window.removeEventListener('resize', updateLayout);
    };
  }, []);

  // Dynamic sequence height based on screen size
  // Mobile: let SequenceView handle it (accounts for control deck height)
  // Tablet/narrow: use viewport height
  // Desktop: use clamp for responsive scaling
  const sequenceHeight = isMobile
    ? undefined // Let SequenceView calculate height accounting for control deck
    : isNarrow
      ? (isLandscape ? 'calc(var(--vvh, 1vh) * 85)' : 'calc(var(--vvh, 1vh) * 65)')
      : 'clamp(500px, 70vh, 1000px)';

  // Dynamic gene map height - scales with screen width for better visibility on large monitors
  const geneMapHeight = isNarrow ? 60 : (
    typeof window !== 'undefined' && window.innerWidth >= 2560 ? 100 :
    typeof window !== 'undefined' && window.innerWidth >= 1920 ? 85 :
    typeof window !== 'undefined' && window.innerWidth >= 1440 ? 75 :
    65
  );
  const show3DInLayout = (!isMobile && (!isNarrow || !isLandscape)) || (isMobile && show3DModel);
  const hasSelection = currentPhage !== null || isLoadingPhage;
  const showList = !isMobile || !hasSelection || mobileListOpen;
  const showDetail = !isMobile || hasSelection;
  const shouldLockScroll = isMobile && mobileListOpen;

  // Prevent background scroll on mobile when the list drawer is open.
  useEffect(() => {
    if (!shouldLockScroll) return;
    const body = document.body;
    const appBody = document.querySelector<HTMLElement>('.app-body');
    const prevAppBodyOverflow = appBody?.style.overflow ?? null;
    const prevAppBodyOverscroll = appBody?.style.overscrollBehaviorY ?? null;
    if (appBody) {
      appBody.style.overflow = 'hidden';
      appBody.style.overscrollBehaviorY = 'none';
    }

    // If another component already fixed the body (e.g. BottomSheet), avoid double-locking.
    const bodyAlreadyFixed = body.style.position === 'fixed';

    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    const prevPosition = body.style.position;
    const prevTop = body.style.top;
    const prevLeft = body.style.left;
    const prevRight = body.style.right;
    const prevWidth = body.style.width;
    const scrollY = window.scrollY;

    if (!bodyAlreadyFixed) {
      body.style.overflow = 'hidden';
      body.style.overscrollBehavior = 'none';
      // iOS: prevent background scroll by fixing the body.
      body.style.position = 'fixed';
      body.style.top = `-${scrollY}px`;
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
    }

    return () => {
      if (appBody) {
        if (prevAppBodyOverflow === null) {
          appBody.style.removeProperty('overflow');
        } else {
          appBody.style.overflow = prevAppBodyOverflow;
        }
        if (prevAppBodyOverscroll === null) {
          appBody.style.removeProperty('overscroll-behavior-y');
        } else {
          appBody.style.overscrollBehaviorY = prevAppBodyOverscroll;
        }
      }
      if (!bodyAlreadyFixed) {
        if (prevOverflow) {
          body.style.overflow = prevOverflow;
        } else {
          body.style.removeProperty('overflow');
        }
        if (prevOverscroll) {
          body.style.overscrollBehavior = prevOverscroll;
        } else {
          body.style.removeProperty('overscroll-behavior');
        }
        if (prevPosition) {
          body.style.position = prevPosition;
        } else {
          body.style.removeProperty('position');
        }
        if (prevTop) {
          body.style.top = prevTop;
        } else {
          body.style.removeProperty('top');
        }
        if (prevLeft) {
          body.style.left = prevLeft;
        } else {
          body.style.removeProperty('left');
        }
        if (prevRight) {
          body.style.right = prevRight;
        } else {
          body.style.removeProperty('right');
        }
        if (prevWidth) {
          body.style.width = prevWidth;
        } else {
          body.style.removeProperty('width');
        }
        window.scrollTo(0, scrollY);
      }
    };
  }, [shouldLockScroll]);

  useEffect(() => {
    const root = document.documentElement;
    if (highContrast) {
      root.classList.add('high-contrast');
    } else {
      root.classList.remove('high-contrast');
    }
  }, [highContrast]);

  useEffect(() => {
    if (!webPrefsHydrated) return;
    if (hasSeenWelcome) return;
    if (welcomeOpenedRef.current) return;
    welcomeOpenedRef.current = true;
    openOverlayCtx('welcome');
  }, [hasSeenWelcome, openOverlayCtx, webPrefsHydrated]);

  useEffect(() => {
    storeSetTheme(theme.id);
  }, [storeSetTheme, theme.id]);

  const currentPhageName = currentPhage?.name ?? null;

  useEffect(() => {
    if (!error) {
      lastErrorRef.current = null;
      setSrAlertMessage('');
      return;
    }
    // When the DB fails before initialization, DataLoadingOverlay handles the announcement.
    if (!repository) return;
    if (error === lastErrorRef.current) return;
    lastErrorRef.current = error;
    announceSr('alert', `Error: ${error}`);
  }, [announceSr, error, repository]);

  useEffect(() => {
    const isReady = Boolean(repository);
    if (isReady && !lastRepositoryReadyRef.current) {
      lastRepositoryReadyRef.current = true;
      announceSr('status', isCached ? 'Database ready (cached).' : 'Database ready.');
      return;
    }
    if (!isReady) {
      lastRepositoryReadyRef.current = false;
    }
  }, [announceSr, isCached, repository]);

  useEffect(() => {
    if (isLoadingPhage) {
      if (!lastLoadingPhageRef.current) {
        lastLoadingPhageRef.current = true;
        announceSr('status', 'Loading phage details...');
      }
      return;
    }

    if (lastLoadingPhageRef.current) {
      lastLoadingPhageRef.current = false;
      if (currentPhageName && currentPhageName !== lastAnnouncedPhageRef.current) {
        lastAnnouncedPhageRef.current = currentPhageName;
        announceSr('status', `Showing ${currentPhageName}.`);
      }
    }
  }, [announceSr, currentPhageName, isLoadingPhage]);

  const loadPhage = useCallback(
    async (repo: PhageRepository, index: number) => {
      // Increment request ID to invalidate any in-flight requests
      const requestId = ++loadRequestIdRef.current;

      setLoadingPhage(true);
      setCurrentPhageIndex(index);
      setFullSequence('');

      try {
        const phage = await repo.getPhageByIndex(index);

        // Guard: if a newer request started, discard these results
        if (requestId !== loadRequestIdRef.current) return;

        if (!phage) {
          // Guard: only clear loading if this is still the current request
          if (requestId === loadRequestIdRef.current) {
            setLoadingPhage(false);
          }
          return;
        }

        setCurrentPhage(phage);

        const genomeLength = phage.genomeLength ?? 0;
        if (genomeLength > 0) {
          const seq = await repo.getSequenceWindow(phage.id, 0, genomeLength);

          // Guard again after second async operation
          if (requestId !== loadRequestIdRef.current) return;

          setFullSequence(seq);
        }

        // Prefetch adjacent phages for instant navigation feel
        void repo.prefetchAround(index, 2);
      } catch (err) {
        // Only set error if this is still the current request
        if (requestId !== loadRequestIdRef.current) return;

        const message = err instanceof Error ? err.message : 'Failed to load phage';
        setError(message);
      } finally {
        // Only clear loading if this is still the current request
        if (requestId === loadRequestIdRef.current) {
          setLoadingPhage(false);
        }
      }
    },
    [setCurrentPhage, setCurrentPhageIndex, setError, setLoadingPhage]
  );

  // Preload workers on mount for instant overlay feel
  useEffect(() => {
    void preloadWorkers();
  }, []);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!repository || hydratedRef.current) return;
    hydratedRef.current = true;

    void (async () => {
      try {
        const list = await repository.listPhages();
        setPhages(list);

        if (list.length > 0) {
          await loadPhage(repository, 0);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load phages';
        setError(message);
      }
    })();
  }, [loadPhage, repository, setError, setPhages]);

  const handleSelectPhage = useCallback(
    async (index: number) => {
      if (!repository) return;
      await loadPhage(repository, index);
      setMobileListOpen(false);
    },
    [loadPhage, repository]
  );

  const handleNextPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const nextIndex = (currentPhageIndex + 1) % phages.length;
    void loadPhage(repository, nextIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository]);

  const handlePrevPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const prevIndex = (currentPhageIndex - 1 + phages.length) % phages.length;
    void loadPhage(repository, prevIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository]);

  // Touch feedback: set ripple origin vars and trigger light haptics when supported.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const interactive = target.closest('.btn, .deck-btn, .tab-btn');
      if (!(interactive instanceof HTMLElement)) return;
      if (interactive.getAttribute('aria-disabled') === 'true') return;
      if (interactive instanceof HTMLButtonElement && interactive.disabled) return;

      const rect = interactive.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const xPct = Math.round(((event.clientX - rect.left) / rect.width) * 100);
        const yPct = Math.round(((event.clientY - rect.top) / rect.height) * 100);
        interactive.style.setProperty('--ripple-x', `${Math.min(100, Math.max(0, xPct))}%`);
        interactive.style.setProperty('--ripple-y', `${Math.min(100, Math.max(0, yPct))}%`);
      } else {
        interactive.style.setProperty('--ripple-x', '50%');
        interactive.style.setProperty('--ripple-y', '50%');
      }

      const isTouchLike = event.pointerType === 'touch' || event.pointerType === 'pen';
      const hapticsHandledByComponent = Boolean(
        interactive.closest('.control-deck, .bottom-sheet, .fab, .action-drawer')
      );
      if (isTouchLike && !hapticsHandledByComponent) {
        haptics.light();
      }
    };

    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // Phone swipe gestures: left/right to change phage (avoids stealing gestures from sequence/3D).
  useEffect(() => {
    if (!isMobile) return;
    if (hasBlockingOverlay) return;
    if (mobileListOpen) return;

    const container = document.getElementById('main-content');
    if (!container) return;

    const SWIPE_DISTANCE_PX = 120;
    const SWIPE_FAST_DISTANCE_PX = 80;
    const SWIPE_VERTICAL_TOLERANCE_PX = 40;
    const SWIPE_FAST_VELOCITY_PX_PER_MS = 0.5;
    const SWIPE_HORIZONTAL_DOMINANCE_RATIO = 1.6;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      if (shouldIgnoreMobileSwipeTarget(event.target)) return;
      const t = event.touches[0];
      swipeStartRef.current = { x: t.clientX, y: t.clientY, time: performance.now() };
    };

    const onTouchEnd = (event: TouchEvent) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;
      if (event.changedTouches.length !== 1) return;

      const t = event.changedTouches[0];
      const elapsedMs = Math.max(1, performance.now() - start.time);
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Only consider swipes that are clearly horizontal (avoid triggering while vertically scrolling).
      if (absDy > 0 && absDx / absDy < SWIPE_HORIZONTAL_DOMINANCE_RATIO) return;

      const velocityX = absDx / elapsedMs; // px/ms
      const isFastSwipe =
        absDx >= SWIPE_FAST_DISTANCE_PX &&
        velocityX >= SWIPE_FAST_VELOCITY_PX_PER_MS &&
        absDy <= SWIPE_VERTICAL_TOLERANCE_PX;

      // Require a deliberate horizontal swipe.
      if (!isFastSwipe) {
        if (absDx < SWIPE_DISTANCE_PX) return;
        if (absDy > SWIPE_VERTICAL_TOLERANCE_PX) return;
      }

      if (dx < 0) {
        handleNextPhage();
      } else {
        handlePrevPhage();
      }

      // Track successful swipes for learning the gesture
      sessionSwipeCountRef.current += 1;
      if (sessionSwipeCountRef.current >= 2 && !hasLearnedMobileSwipe) {
        setHasLearnedMobileSwipe(true);
      }
    };

    const onTouchCancel = () => {
      swipeStartRef.current = null;
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [handleNextPhage, handlePrevPhage, hasBlockingOverlay, hasLearnedMobileSwipe, isMobile, mobileListOpen, setHasLearnedMobileSwipe]);

  useEffect(() => {
    if (!isGlossaryOpen) return;
    if (typeof window === 'undefined') return;

    const active = document.activeElement as HTMLElement | null;
    glossaryOpenerRef.current =
      active && active !== document.body && active !== document.documentElement ? active : null;

    const shell = glossaryShellRef.current;
    if (!shell) return;

    const raf = window.requestAnimationFrame(() => {
      const target =
        shell.querySelector<HTMLElement>('[data-glossary-search]') ??
        shell.querySelector<HTMLElement>('[data-glossary-listbox]') ??
        shell.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ??
        shell;

      target.focus();
    });

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const focusables = Array.from(
        shell.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => {
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.tabIndex < 0) return false;
        if (
          (el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement) &&
          el.disabled
        ) {
          return false;
        }
        return true;
      });

      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    shell.addEventListener('keydown', handleTab);

    return () => {
      window.cancelAnimationFrame(raf);
      shell.removeEventListener('keydown', handleTab);
    };
  }, [isGlossaryOpen]);

  useEffect(() => {
    const wasOpen = wasGlossaryOpenRef.current;
    wasGlossaryOpenRef.current = isGlossaryOpen;

    if (!wasOpen || isGlossaryOpen) return;
    if (typeof window === 'undefined') return;

    const opener = glossaryOpenerRef.current;
    glossaryOpenerRef.current = null;
    if (!opener || !opener.isConnected) return;

    const raf = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      const shouldRestore = !active || active === document.body || active === document.documentElement;
      if (shouldRestore) {
        opener.focus();
      }
    });

    return () => window.cancelAnimationFrame(raf);
  }, [isGlossaryOpen]);

  // User-friendly status: only show when there's meaningful info
  // Debug/dev info moved to Settings > About
  const headerSubtitle = useMemo(() => {
    if (error) return undefined; // Error already shown via DataLoadingOverlay
    if (isLoading) return 'Loading...';
    // When ready, no need to show status (clean UI)
    return undefined;
  }, [error, isLoading]);

  const showBeginnerToast = useCallback(
    (nextEnabled: boolean) => {
      showToast({
        id: 'beginner-mode',
        message: nextEnabled ? 'Beginner Mode enabled' : 'Beginner Mode disabled',
        variant: 'info',
        duration: 2000,
      });
    },
    [showToast]
  );

  const handleToggleBeginnerMode = useCallback(() => {
    const nextState = !beginnerModeEnabled;
    showBeginnerToast(nextState);
    toggleBeginnerMode();
  }, [beginnerModeEnabled, showBeginnerToast, toggleBeginnerMode]);

  const handleToggleActionDrawer = useCallback(() => {
    setActionDrawerOpen((prev) => !prev);
  }, []);

  const handleCloseActionDrawer = useCallback(() => {
    setActionDrawerOpen(false);
  }, []);

  const loadingOverlayNeeded = isLoading || (!repository && progress);
  const showErrorOverlay = !!error && !repository;

  const overlayHotkeyDefinitions = useMemo(() => {
    return getOverlayHotkeyActions()
      .map((action) => ({
        actionId: action.actionId,
        action: () => {
          const overlayId = action.overlayId as OverlayId;
          if (action.overlayAction === 'toggle') {
            toggleOverlayCtx(overlayId);
            return;
          }
          openOverlayCtx(overlayId);
        },
        modes: ['NORMAL'] as const,
      }));
  }, [openOverlayCtx, toggleOverlayCtx]);

  useHotkeys(overlayHotkeyDefinitions);

  const globalHotkeys = useMemo(() => ([
    { actionId: ActionIds.NavNextPhage, action: handleNextPhage, modes: ['NORMAL'] as const, priority: 2 },
    { actionId: ActionIds.NavPrevPhage, action: handlePrevPhage, modes: ['NORMAL'] as const, priority: 2 },
    { actionId: ActionIds.ViewCycleTheme, action: nextTheme, modes: ['NORMAL'] as const, priority: 2 },
    { actionId: ActionIds.ViewToggle3DModel, action: toggle3DModel, modes: ['NORMAL'] as const, priority: 2 },
    { actionId: ActionIds.DiffToggle, action: toggleDiff, modes: ['NORMAL'] as const, priority: 2 },
    {
      actionId: ActionIds.EducationToggleBeginnerMode,
      action: handleToggleBeginnerMode,
      modes: ['NORMAL'] as const,
    },
    {
      actionId: ActionIds.OverlayCloseAll,
      action: () => {
        if (isGlossaryOpen && !hasBlockingOverlay) {
          closeGlossary();
          return;
        }
        closeOverlayCtx();
        storeCloseOverlay();
      },
      modes: ['NORMAL'] as const,
      priority: 1,
    },
  ]), [
    closeGlossary,
    closeOverlayCtx,
    handleNextPhage,
    handlePrevPhage,
    handleToggleBeginnerMode,
    hasBlockingOverlay,
    isGlossaryOpen,
    nextTheme,
    storeCloseOverlay,
    toggle3DModel,
    toggleDiff,
  ]);

  useHotkeys(globalHotkeys);

  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);

  const footerHints = useMemo(
    () => APP_SHELL_FOOTER_HINTS.map((hint) => ({
      key: formatHintKeys(hint, shortcutPlatform),
      label: hint.label,
      description: hint.description,
    })),
    [shortcutPlatform]
  );

  const commandPaletteShortcut = useMemo(
    () => formatActionShortcutForSurface(ActionIds.OverlayCommandPalette, shortcutPlatform),
    [shortcutPlatform]
  );
  const settingsShortcut = useMemo(
    () => formatActionShortcutForSurface(ActionIds.OverlaySettings, shortcutPlatform),
    [shortcutPlatform]
  );

  const documentTitle = currentPhage
    ? `${currentPhage.name} - Phage Explorer`
    : 'Phage Explorer';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = documentTitle;
    }
  }, [documentTitle]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {srStatusMessage}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {srAlertMessage}
      </div>
      {loadingOverlayNeeded && (
        <DataLoadingOverlay
          progress={progress}
          error={null}
          onRetry={load}
        />
      )}
      {showErrorOverlay && (
        <DataLoadingOverlay
          progress={progress}
          error={error}
          onRetry={reload}
        />
      )}

      <AppShell
        enableBackgroundEffects={enableBackgroundEffects}
        header={{
          title: isMobile && phages.length > 0 ? (
            <PhagePickerTrigger
              phageName={currentPhage?.name ?? 'Select Phage'}
              currentIndex={currentPhageIndex}
              totalCount={phages.length}
              onClick={() => setPhagePickerOpen(true)}
              isOpen={phagePickerOpen}
            />
          ) : (
            currentPhage?.name ?? 'Phage Explorer'
          ),
          subtitle: headerSubtitle,
          mode,
          pendingSequence: pendingSequence ?? undefined,
          children: (
            <>
              <button
                className="btn btn-ghost header-action"
                type="button"
                onClick={() => openOverlayCtx('commandPalette')}
                aria-label="Open command palette"
                title={commandPaletteShortcut ? `Command Palette (${commandPaletteShortcut})` : 'Command Palette'}
                data-testid="header-command-palette-btn"
              >
                <IconCommand size={16} />
                <span className="header-action__label">Palette</span>
                {commandPaletteShortcut && (
                  <kbd className="header-action__shortcut">{commandPaletteShortcut}</kbd>
                )}
              </button>
              <button
                className="btn btn-ghost header-action"
                type="button"
                onClick={() => openOverlayCtx('settings')}
                aria-label="Open settings"
                title={settingsShortcut ? `Settings (${settingsShortcut})` : 'Settings'}
                data-testid="header-settings-btn"
              >
                <IconSettings size={16} />
                <span className="header-action__label">Settings</span>
              </button>
              <LearnMenu />
            </>
          ),
        }}
        footer={{
          hints: footerHints,
          children: <BeginnerModeIndicator />,
        }}
      >
        {(!repository || error) && (
          <section className="panel panel-compact" aria-label="Repository status">
            <div className="panel-header">
              <h2>Database</h2>
              {isCached && <span className="badge">Cached</span>}
            </div>
            {!repository && !error && (
              <p className="text-dim" role="status" aria-live="polite" aria-atomic="true">
                Loading database...
              </p>
            )}
            {progress && (
              <div
                className="status-line"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                aria-label="Database loading progress"
              >
                <span>{progress.stage}</span>
                <div className="progress-bar">
                  <div className="progress" style={{ width: `${progress.percent}%` }} />
                </div>
                <span>{progress.percent}%</span>
              </div>
            )}
            {error && <div className="text-error">Error: {error}</div>}
          </section>
        )}

        {/* Desktop Action Toolbar - surfaces hidden functionality */}
        {!isMobile && (
          <ActionToolbar
            onOpenSearch={() => openOverlayCtx('search')}
            onOpenAnalysis={() => openOverlayCtx('analysisMenu')}
            onOpenComparison={() => openOverlayCtx('comparison')}
            onOpenSettings={() => openOverlayCtx('settings')}
            onOpenHelp={() => openOverlayCtx('help')}
            onOpenCommandPalette={() => openOverlayCtx('commandPalette')}
          />
        )}

        {/* Quick stats bar when phage is selected - shows on all devices */}
        {currentPhage && <QuickStats className={isMobile ? 'quick-stats--mobile' : ''} />}

        {/* Main content area with optional analysis sidebar */}
        <div className={`dashboard-layout ${isWide ? 'dashboard-layout--with-sidebar' : ''}`}>
          <section className="panel two-column" aria-label="Phage browser">
            {showList && (
              <PhageList
                phages={phages}
                currentIndex={currentPhageIndex}
                onSelect={handleSelectPhage}
                onClose={() => setMobileListOpen(false)}
                mobileListOpen={mobileListOpen}
                hasSelection={hasSelection}
                isMobile={isMobile}
                loading={!repository || (phages.length === 0 && isLoading)}
              />
            )}

          {showDetail && (
            <div className="column column--detail">
                  <div className="panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {isMobile && (
                    <button 
                      className="btn btn-sm"
                      onClick={() => setMobileListOpen(true)}
                      type="button"
                      aria-label="Open phage list"
                    >
                      Phages
                    </button>
                  )}
                  <h3>Details</h3>
                </div>
                {isLoadingPhage && <span className="badge">Loading</span>}
              </div>
              {currentPhage ? (
                <div className="detail-card detail-card--enter" key={currentPhage.accession ?? currentPhageIndex}>
                  <div style={{ display: 'flex', flexDirection: isNarrow ? 'column' : 'row', gap: '1rem', alignItems: isNarrow ? 'stretch' : 'flex-start' }}>
                    {/* Illustration - larger display for high-res images */}
                    {hasIllustration(currentPhage.slug ?? '') && (
                      <div style={{ flexShrink: 0, width: isNarrow ? '100%' : '320px', maxWidth: isNarrow ? '400px' : '320px' }}>
                        <PhageIllustration
                          slug={currentPhage.slug ?? ''}
                          name={currentPhage.name}
                          compact={false}
                        />
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h4 style={{ marginTop: 0 }}>{currentPhage.name}</h4>
                      <p className="text-dim" style={{ marginBottom: '0.5rem' }}>
                        {currentPhage.family ?? 'Unassigned family'} · {currentPhage.lifecycle ?? 'Lifecycle n/a'}
                      </p>
                    </div>
                  </div>
                  <div className="metrics">
                    <div>
                      <div className="metric-label">Genome length</div>
                      <div className="metric-value">{(currentPhage.genomeLength ?? 0).toLocaleString()} bp</div>
                    </div>
                    <div>
	                      <div className="metric-label">GC content</div>
	                      <div className="metric-value">
	                        {currentPhage.gcContent !== null ? `${currentPhage.gcContent.toFixed(2)}%` : '—'}
	                      </div>
	                    </div>
                    <div>
                      <div className="metric-label">Genes</div>
                      <div className="metric-value">{currentPhage.genes.length}</div>
                    </div>
                  </div>
                  <div className="text-muted">
                    Accession: {currentPhage.accession} · Baltimore: {currentPhage.baltimoreGroup ?? 'n/a'}
                  </div>
                  <div className="detail-viewers">
                    <div className="viewer-panel">
                      <div className="metric-label" style={{ marginBottom: '0.5rem' }}>Sequence</div>
                      {currentPhage && (
                        <GeneMapCanvas
                          height={geneMapHeight}
                          onGeneClick={(pos) => usePhageStore.getState().setScrollPosition(pos)}
                          onGeneSelect={(gene) => setSelectedGene(gene)}
                        />
                      )}
                      {selectedGene && (
                        <div className="panel panel-compact" aria-label="Selected gene details" style={{ marginTop: '0.5rem' }}>
                          <div className="panel-header" style={{ marginBottom: '0.5rem' }}>
                            <h3 style={{ fontSize: '0.95rem' }}>Selected gene</h3>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setSelectedGene(null)}
                              aria-label="Clear selected gene"
                            >
                              Clear
                            </button>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ color: theme.colors.text, fontWeight: 700 }}>
                              {selectedGene.name ?? selectedGene.locusTag ?? 'Gene'}
                            </div>
                            {selectedGene.product && (
                              <div className="text-dim" style={{ fontSize: '0.85rem' }}>
                                {selectedGene.product}
                              </div>
                            )}
                            <div className="text-dim" style={{ fontSize: '0.85rem' }}>
                              {selectedGene.startPos?.toLocaleString() ?? '—'}–{selectedGene.endPos?.toLocaleString() ?? '—'}{' '}
                              {selectedGene.strand ? `(${selectedGene.strand} strand)` : ''}
                            </div>
                          </div>

                          {beginnerModeEnabled && (
                            <details style={{ marginTop: '0.5rem' }}>
                              <summary style={{ cursor: 'pointer', color: theme.colors.textMuted, fontSize: '0.85rem' }}>
                                Beginner hints
                              </summary>
                              <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {geneHint ? (
                                  <>
                                    <div style={{ color: theme.colors.text, fontWeight: 600 }}>{geneHint.heading}</div>
                                    <div className="text-dim" style={{ fontSize: '0.9rem' }}>{geneHint.summary}</div>
                                    {geneHint.tips?.length ? (
                                      <ul style={{ margin: 0, paddingLeft: '1.1rem', color: theme.colors.textMuted, fontSize: '0.85rem' }}>
                                        {geneHint.tips.slice(0, 3).map((tip) => (
                                          <li key={tip}>{tip}</li>
                                        ))}
                                      </ul>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      onClick={() => {
                                        const target = geneHint.glossary?.[0];
                                        if (target) showContextFor(String(target));
                                      }}
                                    >
                                      Open glossary context
                                    </button>
                                  </>
                                ) : (
                                  <div className="text-dim" style={{ fontSize: '0.9rem' }}>
                                    Tip: gene <strong>start/end</strong> show where the coding region sits on the genome; the <strong>strand</strong> indicates which DNA strand encodes the protein.
                                  </div>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      )}
                      {fullSequence ? (
                        <FeatureErrorBoundary name="Sequence View">
                          <SequenceView
                            sequence={fullSequence}
                            height={sequenceHeight}
                          />
                        </FeatureErrorBoundary>
                      ) : (
                        <SequenceViewSkeleton rows={15} className="mt-2" />
                      )}
                    </div>
                    {show3DInLayout && (
                      <div className="viewer-panel">
                        {show3DModel ? (
                          <FeatureErrorBoundary name="3D Viewer">
                            <Suspense
                              fallback={<Model3DSkeleton />}
                            >
                              <LazyModel3DView phage={currentPhage} />
                            </Suspense>
                          </FeatureErrorBoundary>
                        ) : (
                          <div className="viewer-placeholder" aria-label="3D structure viewer disabled">
                            <svg className="viewer-placeholder__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                              <polyline points="3.27,6.96 12,12.01 20.73,6.96" />
                              <line x1="12" y1="22.08" x2="12" y2="12" />
                            </svg>
                            <div className="viewer-placeholder__title">3D Structure Viewer</div>
                            <div className="viewer-placeholder__description">
                              {viewerDisabledDescription}
                            </div>
                            <button
                              type="button"
                              className="btn"
                              onClick={toggle3DModel}
                              aria-label="Enable 3D structure viewer"
                            >
                              Enable 3D Viewer
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {beginnerModeEnabled && fullSequence && (
                    <div style={{ marginTop: '1rem' }}>
                      <ReadingFrameVisualizer sequence={fullSequence} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-state__icon empty-state__icon--animated">
                    🧬
                  </div>
                  <div className="empty-state__title">
                    {isLoadingPhage ? 'Loading...' : 'No Phage Selected'}
                  </div>
                  <div className="empty-state__description">
                    {isLoadingPhage
                      ? 'Fetching phage data from the database...'
                      : 'Select a phage from the list to explore its genome, genes, and 3D structure.'}
                  </div>
                  {!isLoadingPhage && isMobile && (
                    <div className="empty-state__action">
                      <button
                        className="btn"
                        onClick={() => setMobileListOpen(true)}
                        type="button"
                      >
                        Browse Phages
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </section>

          {/* Analysis Sidebar - visible on wide screens */}
          {isWide && (
            <AnalysisSidebar
              collapsed={analysisSidebarCollapsed}
              onToggleCollapse={() => setAnalysisSidebarCollapsed(!analysisSidebarCollapsed)}
            />
          )}
        </div>
      </AppShell>
      {isGlossaryOpen && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close glossary"
            className="glossary-backdrop"
            onClick={closeGlossary}
          />
          <div
            ref={glossaryShellRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={glossaryTitleId}
            className={`glossary-shell is-open ${beginnerModeEnabled ? 'glossary-shell--beginner' : ''}`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              if (event.defaultPrevented) return;
              if (hasBlockingOverlay) return;
              event.preventDefault();
              event.stopPropagation();
              closeGlossary();
            }}
          >
            <div className="glossary-shell__header">
              <div>
                {beginnerModeEnabled && <div className="glossary-drawer__eyebrow">Beginner Mode</div>}
                <div className="glossary-shell__title" id={glossaryTitleId}>
                  Glossary
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={closeGlossary}>
                Close
              </button>
            </div>
            <div className="glossary-shell__body">
              <GlossaryPanel />
            </div>
          </div>
        </>
      )}
      <TourEngine />
      <OverlayManager repository={repository} currentPhage={currentPhage} />
      {/* All toasts (beginner mode, fx safe mode, blocked hotkey) rendered via ToastProvider */}
      <BlockedHotkeyToast info={blockedHotkey} onDismiss={dismissBlockedHotkey} showToast={showToast} />
      <ControlDeck onPrevPhage={handlePrevPhage} onNextPhage={handleNextPhage} />
      {isTouchUi && (
        <>
          {isMobile && (
            <SwipeIndicators
              isFirst={currentPhageIndex === 0}
              isLast={currentPhageIndex === phages.length - 1}
              isVisible={phages.length > 1}
              showPulse={!hasLearnedMobileSwipe}
              isSubtle={hasLearnedMobileSwipe}
              onPrev={handlePrevPhage}
              onNext={handleNextPhage}
            />
          )}
          <FloatingActionButton
            isOpen={actionDrawerOpen}
            onToggle={handleToggleActionDrawer}
          />
          <ActionDrawer
            isOpen={actionDrawerOpen}
            onClose={handleCloseActionDrawer}
          />
          {isMobile && (
            <PhagePickerSheet
              isOpen={phagePickerOpen}
              onClose={() => setPhagePickerOpen(false)}
              phages={phages}
              currentIndex={currentPhageIndex}
              onSelectPhage={(index) => {
                if (repository) {
                  void loadPhage(repository, index);
                }
              }}
            />
          )}
        </>
      )}
      <DataFreshnessIndicator isCached={isCached} isLoading={isLoading} />
      {typeof window !== 'undefined' &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1' && (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        )}
    </>
  );
}
