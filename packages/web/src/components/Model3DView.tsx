import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
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
import { useStructureQuery } from '../hooks/useStructureQuery';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type RenderMode = 'ball' | 'ribbon' | 'surface';

interface Model3DViewProps {
  phage: PhageFull | null;
}

function isCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
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

function disposeGroup(group: Group | null): void {
  if (!group) return;
  group.traverse(obj => {
    if ('geometry' in obj && obj.geometry) {
      obj.geometry.dispose();
    }
    if ('material' in obj) {
      const material = (obj as any).material;
      if (Array.isArray(material)) {
        material.forEach(m => m?.dispose?.());
      } else {
        material?.dispose?.();
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

export function Model3DView({ phage }: Model3DViewProps): JSX.Element {
  const coarsePointer = useMemo(() => isCoarsePointerDevice(), []);
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

  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const fullscreen = usePhageStore(s => s.model3DFullscreen);
  const toggleFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const togglePause = usePhageStore(s => s.toggle3DModelPause);

  // Auto-quality: start at 'high' and adapt based on performance
  const [autoQuality, setAutoQuality] = useState<QualityLevel>(() => (coarsePointer ? 'medium' : 'high'));
  const quality = autoQuality;

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

  useEffect(() => {
    renderModeRef.current = renderMode;
  }, [renderMode]);

  const requestRender = useMemo(() => {
    return () => {
      if (animationRef.current != null) return;
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

        if (animationRef.current != null) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        lastTickTimeRef.current = null;
      },
      { threshold: 0.05 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [requestRender]);

  // Avoid background GPU/CPU work when the tab is hidden.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (animationRef.current != null) {
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
  } = useStructureQuery({
    idOrUrl: pdbId ?? undefined,
    enabled: show3DModel && Boolean(pdbId),
  });

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
    const renderer = new WebGLRenderer({
      antialias: !coarsePointer && quality !== 'low',
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.setClearColor('#0f1529', 1);
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

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
      const deltaMs = lastTick != null ? now - lastTick : 16.6667;
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
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Load structure via TanStack Query
  useEffect(() => {
    if (!show3DModel) return;
    if (!pdbId) {
      setLoadState('error');
      setError('No structure available for this phage');
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
      setError(structureErr instanceof Error ? structureErr.message : 'Failed to load structure');
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
      setLoadState('loading');
      setProgress(20);
      setError(null);
      return;
    }

    if (structureData) {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      structureDataRef.current = structureData;
      const hasBackboneTraces = structureData.backboneTraces.some(trace => trace.length >= 2);
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
      const viewDirection = new Vector3(1, 0.7, 1).normalize();
      camera.position.copy(viewDirection.multiplyScalar(dist));
      camera.near = Math.max(0.1, structureData.radius * 0.01);
      camera.far = Math.max(5000, structureData.radius * 10);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      setAtomCount(structureData.atomCount);
      setProgress(100);
      setLoadState('ready');
      requestRender();
    }
  }, [coarsePointer, pdbId, show3DModel, structureData, structureError, structureErr, structureFetching, structureLoading, requestRender]);

  useEffect(() => {
    if (loadState === 'ready') {
      rebuildStructure(renderMode);
    }
  }, [renderMode, loadState, quality, showFunctionalGroups, functionalGroupStyle]);

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
      void container.requestFullscreen().catch((err) => {
        if (import.meta.env.DEV) {
          console.warn('Fullscreen request failed', err);
        }
        // Revert state if browser rejected fullscreen
        toggleFullscreen();
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

  // Keyboard controls only in fullscreen: arrows rotate, +/- zoom, space toggles rotation
  useEffect(() => {
    if (!fullscreen) return;

    const handleKey = (event: KeyboardEvent) => {
      if (!sceneRef.current || !structureRef.current || !controlsRef.current) return;
      switch (event.key) {
        case 'ArrowLeft':
          structureRef.current.rotation.y -= 0.05;
          event.preventDefault();
          break;
        case 'ArrowRight':
          structureRef.current.rotation.y += 0.05;
          event.preventDefault();
          break;
        case 'ArrowUp':
          structureRef.current.rotation.x -= 0.05;
          event.preventDefault();
          break;
        case 'ArrowDown':
          structureRef.current.rotation.x += 0.05;
          event.preventDefault();
          break;
        case '+':
        case '=':
          controlsRef.current.dollyIn?.(1.1);
          controlsRef.current.update();
          event.preventDefault();
          break;
        case '-':
        case '_':
          controlsRef.current.dollyOut?.(1.1);
          controlsRef.current.update();
          event.preventDefault();
          break;
        case ' ':
          togglePause();
          event.preventDefault();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [fullscreen, togglePause]);

  const handleScreenshot = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'phage-explorer-3d.png';
    link.click();
  };

  const handleResetView = () => {
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
    const viewDirection = new Vector3(1, 0.8, 1).normalize();
    camera.position.copy(viewDirection.multiplyScalar(dist));
    camera.near = Math.max(0.1, data.radius * 0.01);
    camera.far = Math.max(5000, data.radius * 10);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    rendererRef.current?.render(scene, camera);
  };

  const stateLabel = loadState === 'ready'
    ? 'Loaded'
    : loadState === 'loading'
      ? 'Loading…'
      : loadState === 'error'
        ? 'Error'
        : 'Idle';

  return (
    <div className="panel" aria-label="3D structure viewer">
      <div className="panel-header">
        <h3>3D Structure</h3>
        <div className="badge-row">
          <span className="badge">{stateLabel}</span>
          {atomCount !== null && <span className="badge subtle">{atomCount} atoms</span>}
          <span className="badge subtle">FPS {fps || '—'}</span>
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
          title="Reset view"
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn compact"
          onClick={handleScreenshot}
          style={{ minHeight: '36px', minWidth: '40px' }}
          title="Save screenshot"
        >
          📷
        </button>

        {/* Functional groups - only show if available */}
        {structureDataRef.current?.functionalGroups?.length ? (
          <>
            <span className="separator" style={{ width: '1px', height: '20px', background: 'var(--border)', margin: '0 4px' }} />
            <button
              type="button"
              className={`btn compact ${showFunctionalGroups ? 'active' : ''}`}
              onClick={() => setShowFunctionalGroups(v => !v)}
              title="Toggle functional group highlights"
            >
              🔬
            </button>
          </>
        ) : null}

        {/* Auto quality indicator (read-only) */}
        <span className="badge subtle" style={{ marginLeft: 'auto', fontSize: '11px' }}>
          {quality}
        </span>
      </div>

      <div
        className="three-container"
        ref={containerRef}
        role="presentation"
        style={fullscreen ? { width: '100%', height: 'calc(100dvh - 120px)' } : undefined}
      >
        {loadState === 'loading' && (
          <div className="three-overlay">
            <div className="spinner" aria-label="Loading structure" />
            <p className="text-dim">Loading structure… {Math.round(progress)}%</p>
          </div>
        )}
        {loadState === 'error' && (
          <div className="three-overlay error">
            <p className="text-error">Error: {error}</p>
          </div>
        )}
        {!show3DModel && (
          <div className="three-overlay">
            <p className="text-dim">3D model hidden (toggle with M)</p>
          </div>
        )}
        {fullscreen && (
          <div className="three-overlay" style={{ right: '1rem', top: '1rem', left: 'auto', width: 'auto' }}>
            <div className="badge-row" style={{ gap: '6px' }}>
              <span className="badge">FPS {fps || '—'}</span>
              <span className="badge subtle">Quality {quality}</span>
            </div>
          </div>
        )}
      </div>

      <div className="panel-footer text-dim">
        {pdbId
          ? `Source: ${pdbId}${atomCount ? ` · ${atomCount.toLocaleString()} atoms` : ''}`
          : 'No PDB/mmCIF entry for this phage'}
      </div>
    </div>
  );
}
