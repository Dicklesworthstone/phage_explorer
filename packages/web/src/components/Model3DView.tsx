import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  Group,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  buildBallAndStick,
  buildSurfaceImpostor,
  buildTubeFromTraces,
  type LoadedStructure,
} from '../visualization/structure-loader';
import { useStructureQuery } from '../hooks/useStructureQuery';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type RenderMode = 'ball' | 'cartoon' | 'ribbon' | 'surface';

interface Model3DViewProps {
  phage: PhageFull | null;
}

const qualityPixelRatio: Record<string, number> = {
  low: 0.9,
  medium: 1,
  high: 1.3,
  ultra: 1.6,
};

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
  const animationRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const structureDataRef = useRef<LoadedStructure | null>(null);

  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const quality = usePhageStore(s => s.model3DQuality);
  const [renderMode, setRenderMode] = useState<RenderMode>('ball');

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);

  const pdbId = useMemo(() => phage?.pdbIds?.[0] ?? null, [phage?.pdbIds]);

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

    let group: Group | null = null;
    const chainColors = data.chains.map((_, idx) => chainPalette[idx % chainPalette.length]);

    switch (mode) {
      case 'ball':
        group = buildBallAndStick(data.atoms, data.bonds, 0.5, 0.12);
        break;
      case 'cartoon':
        group = buildTubeFromTraces(data.backboneTraces, 0.5, 10, '#38bdf8', 1, chainColors);
        break;
      case 'ribbon':
        group = buildTubeFromTraces(data.backboneTraces, 0.3, 6, '#c084fc', 0.9, chainColors);
        break;
      case 'surface':
        group = buildSurfaceImpostor(data.atoms, 1.6);
        break;
      default:
        group = buildBallAndStick(data.atoms, data.bonds, 0.5, 0.12);
    }

    if (group) {
      structureRef.current = group;
      scene.add(group);
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
      const pr = qualityPixelRatio[quality] ?? 1;
      rendererRef.current.setPixelRatio(Math.min(dpr * pr, 2));
      rendererRef.current.setSize(width, height);
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      return;
    }

    const scene = new Scene();
    scene.background = new Color('#0b1021');
    const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
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
      const pr = qualityPixelRatio[quality] ?? 1;
      renderer.setPixelRatio(Math.min(dpr * pr, 2));
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
  }, [quality]);

  // Animation loop
  useEffect(() => {
    const tick = () => {
      if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;
      if (structureRef.current && !paused) {
        structureRef.current.rotation.y += 0.003 * speed;
      }
      controlsRef.current?.update();
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      animationRef.current = requestAnimationFrame(tick);
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
      rebuildStructure(renderMode);

      // ZOOM TO EXTENTS: Calculate optimal camera distance
      // Using FOV of 50°, formula: dist = radius / tan(fov/2)
      // With padding factor of 1.2 to leave some margin
      const fovRad = (camera.fov * Math.PI) / 180;
      const optimalDist = (structureData.radius / Math.tan(fovRad / 2)) * 1.2;
      const dist = Math.max(optimalDist, structureData.radius * 1.5); // At least 1.5x radius

      // Position camera at slight angle for better 3D perception
      camera.position.copy(
        structureData.center.clone().add(new Vector3(dist * 0.7, dist * 0.5, dist * 0.7))
      );
      camera.near = Math.max(0.1, structureData.radius * 0.01);
      camera.far = Math.max(5000, structureData.radius * 10);
      camera.updateProjectionMatrix();
      controls.target.copy(structureData.center);
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
  }, [renderMode, loadState]);

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
        </div>
      </div>

      <div className="toolbar" style={{ display: 'flex', gap: '8px', padding: '8px 0' }}>
        {(['ball', 'cartoon', 'ribbon', 'surface'] as RenderMode[]).map(mode => (
          <button
            key={mode}
            type="button"
            className={`btn ${renderMode === mode ? 'active' : ''}`}
            onClick={() => setRenderMode(mode)}
          >
            {mode === 'ball' && 'Ball-Stick'}
            {mode === 'cartoon' && 'Cartoon'}
            {mode === 'ribbon' && 'Ribbon'}
            {mode === 'surface' && 'Surface'}
          </button>
        ))}
      </div>

      <div
        className="three-container"
        ref={containerRef}
        role="presentation"
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
      </div>

      <div className="panel-footer text-dim">
        {pdbId
          ? `Source: ${pdbId}${atomCount ? ` · ${atomCount.toLocaleString()} atoms` : ''}`
          : 'No PDB/mmCIF entry for this phage'}
      </div>
    </div>
  );
}

