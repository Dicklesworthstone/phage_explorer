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
import { DataLoadingOverlay } from './components/DataLoadingOverlay';
import { useDatabase } from './hooks/useDatabase';
import {
  useHotkeys,
  useKeyboardMode,
  usePendingSequence,
  useExperienceLevelSync,
  useBlockedHotkeyNotification,
} from './hooks';
import { useTheme } from './hooks/useTheme';
import { useReducedMotion } from './hooks';
import { BlockedHotkeyToast } from './components/BlockedHotkeyToast';
import type { PhageRepository } from './db';
import {
  initializeStorePersistence,
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

// Mobile controls
import { ControlDeck } from './components/mobile/ControlDeck';
import { DataFreshnessIndicator } from './components/ui/DataFreshnessIndicator';
import { IconSettings } from './components/ui/icons';

// Desktop UI components for surfacing hidden functionality
import { ActionToolbar } from './components/ActionToolbar';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { QuickStats } from './components/QuickStats';

/** Number of bases to show in the sequence preview */
const SEQUENCE_PREVIEW_LENGTH = 500;
const BREAKPOINT_PHONE_PX = 640;
const BREAKPOINT_NARROW_PX = 1100;
const BREAKPOINT_WIDE_PX = 1400; // Show analysis sidebar on wide screens

const LazyModel3DView = lazy(async () => {
  const mod = await import('./components/Model3DView');
  return { default: mod.Model3DView };
});

export default function App(): JSX.Element {
  const { theme, nextTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const highContrast = useWebPreferences((s) => s.highContrast);
  const backgroundEffects = useWebPreferences((s) => s.backgroundEffects);
  const webPrefsHydrated = useWebPreferences((s) => s._hasHydrated);
  const hasSeenWelcome = useWebPreferences((s) => s.hasSeenWelcome);

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
  const [beginnerToast, setBeginnerToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const welcomeOpenedRef = useRef(false);
  const [srStatusMessage, setSrStatusMessage] = useState('');
  const [srAlertMessage, setSrAlertMessage] = useState('');
  const lastAnnouncedPhageRef = useRef<string | null>(null);
  const lastRepositoryReadyRef = useRef(false);
  const lastLoadingPhageRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
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
  const isLoadingPhage = usePhageStore((s) => s.isLoadingPhage);
  const setPhages = usePhageStore((s) => s.setPhages);
  const setCurrentPhageIndex = usePhageStore((s) => s.setCurrentPhageIndex);
  const setCurrentPhage = usePhageStore((s) => s.setCurrentPhage);
  const setLoadingPhage = usePhageStore((s) => s.setLoadingPhage);
  const setError = usePhageStore((s) => s.setError);
  const storeSetTheme = usePhageStore((s) => s.setTheme);
  const storeCloseAllOverlays = usePhageStore((s) => s.closeAllOverlays);
  const show3DModel = usePhageStore((s) => s.show3DModel);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const { open: openOverlayCtx, closeAll: closeAllOverlaysCtx, hasBlockingOverlay } = useOverlay();
  const { mode } = useKeyboardMode();
  const pendingSequence = usePendingSequence();

  // Sync experience level to keyboard manager and handle blocked hotkey notifications
  useExperienceLevelSync();
  const { blockedHotkey, dismiss: dismissBlockedHotkey } = useBlockedHotkeyNotification();
  const [sequencePreview, setSequencePreview] = useState<string>('');
  const [fullSequence, setFullSequence] = useState<string>('');
  const [selectedGene, setSelectedGene] = useState<GeneInfo | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [analysisSidebarCollapsed, setAnalysisSidebarCollapsed] = useState(false);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const glossaryShellRef = useRef<HTMLDivElement | null>(null);
  const glossaryOpenerRef = useRef<HTMLElement | null>(null);
  const wasGlossaryOpenRef = useRef(false);
  const glossaryTitleId = useId();
  const activePhageItemRef = useRef<HTMLButtonElement>(null);
  const enableBackgroundEffects = backgroundEffects && !reducedMotion;
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
      return { isNarrow: false, isMobile: false, isLandscape: false, isWide: false };
    }
    const width = window.innerWidth;
    const height = window.innerHeight || 1;
    return {
      isNarrow: width <= BREAKPOINT_NARROW_PX,
      isMobile: width <= BREAKPOINT_PHONE_PX,
      isLandscape: width > height,
      isWide: width >= BREAKPOINT_WIDE_PX,
    };
  }, []);

  const [{ isNarrow, isMobile, isLandscape, isWide }, setLayout] = useState(() => getLayoutSnapshot());

  useLayoutEffect(() => {
    const mobileMql = window.matchMedia(`(max-width: ${BREAKPOINT_PHONE_PX}px)`);
    const narrowMql = window.matchMedia(`(max-width: ${BREAKPOINT_NARROW_PX}px)`);
    const wideMql = window.matchMedia(`(min-width: ${BREAKPOINT_WIDE_PX}px)`);
    const landscapeMql = window.matchMedia('(orientation: landscape)');

    const updateLayout = () => {
      setLayout({
        isNarrow: narrowMql.matches,
        isMobile: mobileMql.matches,
        isLandscape: landscapeMql.matches,
        isWide: wideMql.matches,
      });
    };

    updateLayout();

    mobileMql.addEventListener('change', updateLayout);
    narrowMql.addEventListener('change', updateLayout);
    wideMql.addEventListener('change', updateLayout);
    landscapeMql.addEventListener('change', updateLayout);
    window.addEventListener('resize', updateLayout);

    return () => {
      mobileMql.removeEventListener('change', updateLayout);
      narrowMql.removeEventListener('change', updateLayout);
      wideMql.removeEventListener('change', updateLayout);
      landscapeMql.removeEventListener('change', updateLayout);
      window.removeEventListener('resize', updateLayout);
    };
  }, []);

  // Dynamic sequence height based on screen size
  // Mobile/narrow: use viewport height; desktop: use clamp for responsive scaling
  const sequenceHeight = isNarrow
    ? (isLandscape ? '85dvh' : '65dvh')
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
  const shouldLockScroll = hasBlockingOverlay || (isMobile && mobileListOpen);

  // Prevent background scroll on mobile when a blocking overlay or the list drawer is open.
  useEffect(() => {
    if (!shouldLockScroll) return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
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
    const cleanup = initializeStorePersistence();
    return cleanup;
  }, []);

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
      setLoadingPhage(true);
      try {
        setCurrentPhageIndex(index);
        setSequencePreview('');
        setFullSequence('');
        const phage = await repo.getPhageByIndex(index);
        if (!phage) return;
        setCurrentPhage(phage);
        const genomeLength = phage.genomeLength ?? 0;
        if (genomeLength > 0) {
          const seq = await repo.getSequenceWindow(phage.id, 0, genomeLength);
          setFullSequence(seq);
          setSequencePreview(seq.slice(0, SEQUENCE_PREVIEW_LENGTH));
        }
        // Prefetch adjacent phages for instant navigation feel
        void repo.prefetchAround(index, 2);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load phage';
        setError(message);
      } finally {
        setLoadingPhage(false);
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

  // Scroll active phage list item into view when navigating with j/k
  useEffect(() => {
    const node = activePhageItemRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [currentPhageIndex, reducedMotion]);

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

      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        const vibrate = (navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean }).vibrate;
        if (typeof vibrate === 'function') {
          try {
            vibrate.call(navigator, 10);
          } catch {
            // Ignore vibration errors (some browsers may block / throw).
          }
        }
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

    const shouldIgnoreTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return true;
      return Boolean(
        target.closest(
          'input, textarea, select, button, a, .phage-list, .sequence-view, .three-container, .control-deck, .overlay, .glossary-shell'
        )
      );
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      if (shouldIgnoreTarget(event.target)) return;
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
  }, [handleNextPhage, handlePrevPhage, hasBlockingOverlay, isMobile, mobileListOpen]);

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

  const headerSubtitle = useMemo(() => {
    if (error) return 'db: error';
    if (isLoading) return 'db: loading';
    if (repository) return isCached ? 'db: cached' : 'db: ready';
    return 'db: idle';
  }, [error, isCached, isLoading, repository]);

  const showBeginnerToast = useCallback(
    (nextEnabled: boolean) => {
      setBeginnerToast(nextEnabled ? 'Beginner Mode enabled' : 'Beginner Mode disabled');
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => setBeginnerToast(null), 2000);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const handleToggleBeginnerMode = useCallback(() => {
    const nextState = !beginnerModeEnabled;
    showBeginnerToast(nextState);
    toggleBeginnerMode();
  }, [beginnerModeEnabled, showBeginnerToast, toggleBeginnerMode]);

  const loadingOverlayNeeded = isLoading || (!repository && progress);
  const showErrorOverlay = !!error && !repository;

  useHotkeys([
    { combo: { key: 'j' }, description: 'Next phage', action: handleNextPhage, modes: ['NORMAL'] },
    { combo: { key: 'k' }, description: 'Previous phage', action: handlePrevPhage, modes: ['NORMAL'] },
    { combo: { key: 't' }, description: 'Cycle theme', action: nextTheme, modes: ['NORMAL'] },
    { combo: { key: '?' }, description: 'Help overlay', action: () => openOverlayCtx('help'), modes: ['NORMAL'] },
    { combo: { key: '/' }, description: 'Search', action: () => openOverlayCtx('search'), modes: ['NORMAL'] },
    { combo: { key: ':' }, description: 'Command palette', action: () => openOverlayCtx('commandPalette'), modes: ['NORMAL'] },
    { combo: { key: ',', modifiers: { ctrl: true } }, description: 'Open settings', action: () => openOverlayCtx('settings'), modes: ['NORMAL'] },
    {
      combo: { key: 'b', modifiers: { ctrl: true } },
      description: 'Toggle beginner mode',
      action: handleToggleBeginnerMode,
      modes: ['NORMAL'],
      category: 'Education',
    },
    {
      combo: { key: 'Escape' },
      description: 'Close overlays or glossary',
      action: () => {
        if (isGlossaryOpen && !hasBlockingOverlay) {
          closeGlossary();
          return;
        }
        closeAllOverlaysCtx();
        storeCloseAllOverlays();
      },
      modes: ['NORMAL'],
    },
  ]);

  const footerHints = useMemo(() => ([
    { key: 'j/k', label: 'navigate', description: 'Next/previous phage' },
    { key: '/', label: 'search', description: 'Search phages' },
    { key: ':', label: 'command', description: 'Open command palette' },
    { key: 't', label: 'theme', description: 'Cycle theme' },
    { key: '?', label: 'help', description: 'Show keyboard shortcuts' },
    { key: 'v/f', label: 'view/frame', description: 'Toggle DNA/AA view and reading frame' },
    { key: 'Home/End', label: 'jump', description: 'Jump to start/end of sequence' },
    { key: 'Esc', label: 'close', description: 'Close overlays or glossary' },
    { key: 'Ctrl+,', label: 'settings', description: 'Open settings' },
    { key: 'Ctrl+B', label: 'beginner', description: 'Toggle beginner mode' },
  ]), []);

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
          title: currentPhage?.name ?? 'Phage Explorer',
          subtitle: headerSubtitle,
          mode,
          pendingSequence: pendingSequence ?? undefined,
          children: (
            <>
              <button
                className="btn"
                type="button"
                onClick={() => openOverlayCtx('settings')}
                aria-label="Open settings"
              >
                <IconSettings size={14} />
                Settings
              </button>
              <LearnMenu />
            </>
          ),
        }}
        footer={{
          version: '0.0.0',
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
              <div className={`column column--list ${isMobile && hasSelection ? 'mobile-drawer' : ''}`}>
              <div className="panel-header">
                <h3>Phages</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="badge">{phages.length}</span>
                  {isMobile && hasSelection && (
                    <button
                      className="btn btn-sm"
                      onClick={() => setMobileListOpen(false)}
                      type="button"
                      aria-label="Close phage list"
                    >
                      Close
                    </button>
                  )}
                </div>
              </div>
              <div className="list">
                {phages.map((phage, idx) => {
                  const isActive = idx === currentPhageIndex;
                  return (
                    <button
                      key={phage.id}
                      ref={isActive ? activePhageItemRef : undefined}
                      className={`list-item ${isActive ? 'active' : ''}`}
                      onClick={() => handleSelectPhage(idx)}
                      type="button"
                    >
                      <div className="list-item-main">
                        <div className="list-title">{phage.name}</div>
                        <div className="list-subtitle text-dim">
                          {phage.host ?? 'Unknown host'} · {(phage.genomeLength ?? 0).toLocaleString()} bp
                        </div>
                      </div>
                      <div className="list-item-meta">
                        {phage.lifecycle && (
                          <span className={`badge badge-tiny ${phage.lifecycle === 'lytic' ? 'badge-warning' : 'badge-info'}`}>
                            {phage.lifecycle}
                          </span>
                        )}
                        {phage.gcContent != null && (
                          <span className="meta-gc text-dim">{phage.gcContent.toFixed(1)}%</span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {phages.length === 0 && (
                  <div className="text-dim">Phage list will appear once the database loads.</div>
                )}
              </div>
            </div>
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
                <div className="detail-card">
                  <h4>{currentPhage.name}</h4>
                  <p className="text-dim">
                    {currentPhage.family ?? 'Unassigned family'} · {currentPhage.lifecycle ?? 'Lifecycle n/a'}
                  </p>
                  <div className="metrics">
                    <div>
                      <div className="metric-label">Genome length</div>
                      <div className="metric-value">{(currentPhage.genomeLength ?? 0).toLocaleString()} bp</div>
                    </div>
                    <div>
                      <div className="metric-label">GC content</div>
                      <div className="metric-value">
                        {currentPhage.gcContent != null ? `${currentPhage.gcContent.toFixed(2)}%` : '—'}
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
                      <SequenceView
                        sequence={fullSequence}
                        height={sequenceHeight}
                      />
                      {!fullSequence && (
                        <pre className="sequence-block" style={{ marginTop: '0.5rem' }}>
                          {sequencePreview
                            ? sequencePreview
                            : 'Sequence preview will appear after phage load completes.'}
                        </pre>
                  )}
                </div>
                    {show3DInLayout && (
                      <div className="viewer-panel">
                        {show3DModel ? (
                          <Suspense
                            fallback={
                              <div className="panel" aria-label="3D structure viewer loading">
                                <div className="panel-header">
                                  <h3>3D Structure</h3>
                                  <span className="badge">Loading…</span>
                                </div>
                                <div className="panel-body text-dim">Loading 3D renderer…</div>
                              </div>
                            }
                          >
                            <LazyModel3DView phage={currentPhage} />
                          </Suspense>
                        ) : (
                          <div className="viewer-placeholder" aria-label="3D structure viewer disabled">
                            <svg className="viewer-placeholder__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                              <polyline points="3.27,6.96 12,12.01 20.73,6.96" />
                              <line x1="12" y1="22.08" x2="12" y2="12" />
                            </svg>
                            <div className="viewer-placeholder__title">3D Structure Viewer</div>
                            <div className="viewer-placeholder__description">
                              Explore protein structures in interactive 3D. Disabled by default to conserve battery.
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
      {beginnerToast && (
        <div className="toast toast-info" role="status" aria-live="polite">
          {beginnerToast}
        </div>
      )}
      <BlockedHotkeyToast info={blockedHotkey} onDismiss={dismissBlockedHotkey} />
      <ControlDeck />
      <DataFreshnessIndicator isCached={isCached} isLoading={isLoading} />
    </>
  );
}
