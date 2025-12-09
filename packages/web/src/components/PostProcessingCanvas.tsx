/**
 * PostProcessingCanvas Component
 *
 * Wraps the PostProcessingPipeline in a React component.
 * Takes a source canvas (via ref) or renders its own content and applies effects.
 */

import React, { useRef, useEffect } from 'react';
import { PostProcessingPipeline } from '../rendering/PostProcessingPipeline';
import { useWebPreferences } from '../store/createWebStore';
import { useReducedMotion } from '../hooks/useReducedMotion';

interface PostProcessingCanvasProps {
  width: number;
  height: number;
  sourceCanvas?: HTMLCanvasElement;
  className?: string;
  style?: React.CSSProperties;
}

export const PostProcessingCanvas: React.FC<PostProcessingCanvasProps> = ({
  width,
  height,
  sourceCanvas,
  className,
  style,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipelineRef = useRef<PostProcessingPipeline | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Get user preferences
  const scanlines = useWebPreferences(s => s.scanlines);
  const scanlineIntensity = useWebPreferences(s => s.scanlineIntensity);
  const glow = useWebPreferences(s => s.glow);
  const reducedMotion = useReducedMotion();

  // Initialize pipeline - depends on dimensions to ensure correct initial size
  // Note: We use width/height deps because the pipeline must be created with correct dims.
  // Options are handled separately by updateOptions below for efficiency.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dispose existing pipeline before creating new one (handles dimension changes)
    if (pipelineRef.current) {
      pipelineRef.current.dispose();
      pipelineRef.current = null;
    }

    // Initialize pipeline
    try {
      pipelineRef.current = new PostProcessingPipeline({
        canvas,
        width,
        height,
        enableScanlines: scanlines && !reducedMotion,
        enableBloom: glow,
        enableAberration: !reducedMotion,
        intensity: scanlineIntensity,
      });
    } catch (err) {
      console.error('Failed to initialize post-processing pipeline:', err);
    }

    return () => {
      pipelineRef.current?.dispose();
      pipelineRef.current = null;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [width, height, scanlines, glow, reducedMotion, scanlineIntensity]);

  // Animation loop
  useEffect(() => {
    if (!sourceCanvas) return;

    const render = () => {
      if (pipelineRef.current && sourceCanvas) {
        pipelineRef.current.render(sourceCanvas);
      }
      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [sourceCanvas]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={style}
      width={width}
      height={height}
    />
  );
};

export default PostProcessingCanvas;
