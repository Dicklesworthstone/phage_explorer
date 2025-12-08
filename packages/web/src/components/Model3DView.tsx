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
import { loadStructure } from '../visualization/structure-loader';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface Model3DViewProps {
  phage: PhageFull | null;
}

const qualityPixelRatio: Record<string, number> = {
  low: 0.9,
  medium: 1,
  high: 1.3,
  ultra: 1.6,
};

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
  const abortRef = useRef<AbortController | null>(null);

  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const quality = usePhageStore(s => s.model3DQuality);

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);

  const pdbId = useMemo(() => phage?.pdbIds?.[0] ?? null, [phage?.pdbIds]);

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

    const ambient = new AmbientLight(0xffffff, 0.5);
    const directional = new DirectionalLight(0xffffff, 0.8);
    directional.position.set(1, 1, 1);
    scene.add(ambient);
    scene.add(directional);

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

  // Load structure on phage change
  useEffect(() => {
    if (!show3DModel) return;
    if (!pdbId) {
      setLoadState('error');
      setError('No structure available for this phage');
      setAtomCount(null);
      disposeGroup(structureRef.current);
      structureRef.current = null;
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadState('loading');
    setProgress(15);
    setError(null);

    loadStructure(pdbId, controller.signal)
      .then(({ group, center, radius, atomCount }) => {
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!scene || !camera || !controls) return;

        // Swap out existing structure
        if (structureRef.current) {
          scene.remove(structureRef.current);
        }
        disposeGroup(structureRef.current);
        structureRef.current = group;
        scene.add(group);

        // Frame camera
        const dist = radius * 3;
        camera.position.copy(center.clone().add(new Vector3(dist, dist * 0.8, dist)));
        camera.near = Math.max(0.1, radius * 0.01);
        camera.far = Math.max(5000, radius * 4);
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();
        setAtomCount(atomCount);
        setProgress(100);
        setLoadState('ready');
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load structure');
        setLoadState('error');
      });

    return () => controller.abort();
  }, [pdbId, show3DModel]);

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

