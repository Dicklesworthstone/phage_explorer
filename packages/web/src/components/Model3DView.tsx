import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  Group,
  Vector3,
} from 'three';
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

const QUALITY_PRESETS = {
  low: {
    pixelRatio: 0.9,
    shadows: false,
    sphereSegments: 12,
    bondRadialSegments: 10,
    tubeRadialSegments: 6,
    tubeMinSegments: 24,
    surfaceSegments: 10,
  },
  medium: {
    pixelRatio: 1,
    shadows: true,
    sphereSegments: 18,
    bondRadialSegments: 14,
    tubeRadialSegments: 8,
    tubeMinSegments: 30,
    surfaceSegments: 12,
  },
  high: {
    pixelRatio: 1.3,
    shadows: true,
    sphereSegments: 24,
    bondRadialSegments: 16,
    tubeRadialSegments: 10,
    tubeMinSegments: 36,
    surfaceSegments: 16,
  },
  ultra: {
    pixelRatio: 1.6,
    shadows: true,
    sphereSegments: 32,
    bondRadialSegments: 20,
    tubeRadialSegments: 12,
    tubeMinSegments: 42,
    surfaceSegments: 20,
  },
} as const;

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

export function Model3DView({ phage }: Model3DViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const structureRef = useRef<Group | null>(null);
  const highlightRef = useRef<Group | null>(null);
  const animationRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const structureDataRef = useRef<LoadedStructure | null>(null);

  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const quality = usePhageStore(s => s.model3DQuality);
  const fullscreen = usePhageStore(s => s.model3DFullscreen);
  const toggleFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const cycleQuality = usePhageStore(s => s.cycle3DModelQuality);
  const togglePause = usePhageStore(s => s.toggle3DModelPause);
  const setSpeed = usePhageStore(s => s.set3DModelSpeed);

  const [renderMode, setRenderMode] = useState<RenderMode>('ball');

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);
  const lastFrameTimeRef = useRef<number | null>(null);
  const frameCounterRef = useRef<{ count: number; lastSample: number }>({
    count: 0,
    lastSample: performance.now(),
  });
  const [showFunctionalGroups, setShowFunctionalGroups] = useState(false);
  const [functionalGroupStyle, setFunctionalGroupStyle] = useState<FunctionalGroupStyle>('halo');

  const pdbId = useMemo(() => phage?.pdbIds?.[0] ?? null, [phage?.pdbIds]);
  const qualityPreset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.medium;

  const {
    data: structureData,
    isLoading: structureLoading,
    isFetching: structureFetching,
    isError: structureError,
    error: structureErr,
    refetch: refetchStructure,
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
          Math.max(6, qualityPreset.tubeRadialSegments - 2),
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
      rendererRef.current.setPixelRatio(Math.min(dpr * qualityPreset.pixelRatio, 2));
      rendererRef.current.setSize(width, height);
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      return;
    }

    const scene = new Scene();
    scene.background = new Color('#0b1021');
    const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
    const renderer = new WebGLRenderer({ antialias: quality !== 'low', alpha: true });
    renderer.setClearColor('#0b1021', 0);
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    // Enhanced lighting setup for better 3D perception
    const ambient = new AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    // Key light (main light from top-right)
    const keyLight = new DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(1, 1.5, 1);
    scene.add(keyLight);

    // Fill light (softer, from left)
    const fillLight = new DirectionalLight(0xb0c4de, 0.5); // Light steel blue tint
    fillLight.position.set(-1, 0.5, 0.5);
    scene.add(fillLight);

    // Rim light (from behind for depth)
    const rimLight = new DirectionalLight(0x88ccff, 0.4); // Cyan tint
    rimLight.position.set(0, 0, -1);
    scene.add(rimLight);

    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    const resize = () => {
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 260;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const dpr = window.devicePixelRatio ?? 1;
      renderer.shadowMap.enabled = qualityPreset.shadows;
      renderer.setPixelRatio(Math.min(dpr * qualityPreset.pixelRatio, 2));
      renderer.setSize(width, height);
      renderer.render(scene, camera);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      disposeGroup(structureRef.current);
      structureDataRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      controlsRef.current = null;
      structureRef.current = null;
    };
  }, [quality, qualityPreset.pixelRatio, qualityPreset.shadows]);

  // Animation loop - CRITICAL: always schedule next frame first to keep loop running
  useEffect(() => {
    const tick = () => {
      // Always schedule next frame FIRST to keep loop running even if refs not ready
      animationRef.current = requestAnimationFrame(tick);

      // Only render if everything is ready
      if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;

      if (structureRef.current && !paused) {
        structureRef.current.rotation.y += 0.003 * speed;
      }
      controlsRef.current?.update();
      rendererRef.current.render(sceneRef.current, cameraRef.current);

      // FPS sampling
      const now = performance.now();
      const last = lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      if (last != null) {
        frameCounterRef.current.count += 1;
        const elapsed = now - frameCounterRef.current.lastSample;
        if (elapsed >= 500) {
          const currentFps = (frameCounterRef.current.count * 1000) / elapsed;
          setFps(Math.round(currentFps));
          frameCounterRef.current.count = 0;
          frameCounterRef.current.lastSample = now;
        }
      }
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [paused, speed]);

  // Load structure via TanStack Query
  useEffect(() => {
    if (!show3DModel) return;
    if (!pdbId) {
      setLoadState('error');
      setError('No structure available for this phage');
      setAtomCount(null);
      if (structureRef.current && sceneRef.current) {
        sceneRef.current.remove(structureRef.current);
      }
      disposeGroup(structureRef.current);
      structureRef.current = null;
      return;
    }

    if (structureError) {
      setLoadState('error');
      setError(structureErr instanceof Error ? structureErr.message : 'Failed to load structure');
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
      // Note: Don't call rebuildStructure here - the renderMode useEffect handles it
      // when loadState becomes 'ready' (avoids double-building on initial load)

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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuildStructure is stable via refs
  }, [pdbId, renderMode, show3DModel, structureData, structureError, structureErr, structureFetching, structureLoading]);

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
        console.warn('Fullscreen request failed', err);
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

  const handleSpeedChange = (delta: number) => {
    const next = Math.max(0, Math.min(4, speed + delta));
    setSpeed(next);
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

      <div className="toolbar" style={{ display: 'flex', gap: '8px', padding: '8px 0' }}>
        {(['ball', 'ribbon', 'surface'] as RenderMode[]).map(mode => (
          <button
            key={mode}
            type="button"
            className={`btn ${renderMode === mode ? 'active' : ''}`}
            onClick={() => setRenderMode(mode)}
          >
            {mode === 'ball' && 'Ball-Stick'}
            {mode === 'ribbon' && 'Ribbon'}
            {mode === 'surface' && 'Surface'}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          onClick={cycleQuality}
        >
          Quality: {quality}
        </button>
        <button
          type="button"
          className={`btn ${showFunctionalGroups ? 'active' : ''}`}
          disabled={!structureDataRef.current?.functionalGroups?.length}
          onClick={() => setShowFunctionalGroups(v => !v)}
        >
          {showFunctionalGroups ? 'Hide Groups' : 'Show Groups'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={
            !showFunctionalGroups || !structureDataRef.current?.functionalGroups?.length
          }
          onClick={() => {
            const order: FunctionalGroupStyle[] = ['halo', 'bounds', 'lines'];
            const currentIdx = order.indexOf(functionalGroupStyle);
            const next = order[(currentIdx + 1) % order.length];
            setFunctionalGroupStyle(next);
          }}
        >
          Group Style: {functionalGroupStyle}
        </button>
        <button
          type="button"
          className={`btn ${fullscreen ? 'active' : ''}`}
          onClick={toggleFullscreen}
        >
          {fullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => togglePause()}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleScreenshot}
        >
          Save PNG
        </button>
        <div className="badge-row" style={{ gap: '4px' }}>
          <button
            type="button"
            className="btn subtle"
            onClick={() => handleSpeedChange(-0.5)}
            title="Decrease auto-rotation speed"
          >
            −speed
          </button>
          <button
            type="button"
            className="btn subtle"
            onClick={() => handleSpeedChange(0.5)}
            title="Increase auto-rotation speed"
          >
            +speed
          </button>
        </div>
      </div>

      <div
        className="three-container"
        ref={containerRef}
        role="presentation"
        style={fullscreen ? { width: '100%', height: 'calc(100vh - 120px)' } : undefined}
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

