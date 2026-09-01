import React, { useState, useEffect, useRef, memo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import {
  getPhageModel,
  renderModel,
  createAnimationState,
  updateAnimation,
  createRenderContext,
  type AnimationState,
  type RenderContext,
} from '@phage-explorer/renderer-3d';

interface Model3DViewProps {
  width?: number;
  height?: number;
  fullscreen?: boolean;
}

// Memoized inner component to prevent unnecessary re-renders from parent
const Model3DViewInner = memo(function Model3DViewInner({
  width = 24,
  height = 16,
  fullscreen = false,
}: Model3DViewProps): React.ReactElement {
  const show3DModel = usePhageStore(s => s.show3DModel);
  const paused = usePhageStore(s => s.model3DPaused);
  const speed = usePhageStore(s => s.model3DSpeed);
  const quality = usePhageStore(s => s.model3DQuality);
  const currentPhage = usePhageStore(s => s.currentPhage);
  const theme = usePhageStore(s => s.currentTheme);

  // Use ref for animation state to avoid triggering re-renders on every tick
  const animStateRef = useRef<AnimationState>(createAnimationState());
  const renderContextRef = useRef<RenderContext | null>(null);
  const [frameLines, setFrameLines] = useState<string[]>([]);

  const colors = theme.colors;

  // Get the appropriate model
  const model = React.useMemo(() => {
    if (!currentPhage) return null;
    return getPhageModel(currentPhage.slug ?? 'lambda');
  }, [currentPhage?.slug]);

  // Rendering dimensions (account for border and title/footer rows)
  // Use Math.max to ensure dimensions are always at least 1
  const renderWidth = Math.max(1, width - 2); // Account for border on both sides
  const renderHeight = Math.max(1, fullscreen ? height - 2 : height - 3); // Fullscreen has title only, PiP has title + footer

  // Bound render buffer dimensions so an enormous terminal cannot allocate
  // an unbounded Float32Array (each pixel uses two Float32 values).
  const boundedWidth = Math.min(renderWidth, 500);
  const boundedHeight = Math.min(renderHeight, 300);

  // Release the off-screen buffer when the component unmounts or 3D is hidden.
  useEffect(() => {
    return () => {
      renderContextRef.current = null;
    };
  }, []);

  // Animation loop - uses ref to avoid re-creating interval on state changes
  useEffect(() => {
    if (!show3DModel || !model || paused) return;

    // Use faster refresh rate in fullscreen for smoother animation
    // Values are intervals in ms: 60ms (~16 FPS) in fullscreen, 100ms (10 FPS) in PiP
    const frameInterval = fullscreen ? 60 : 100;

    const interval = setInterval(() => {
      // Update animation state in ref (no React state update)
      animStateRef.current = updateAnimation(animStateRef.current, 1, speed);

      // Ensure context exists and matches dimensions
      if (!renderContextRef.current || renderContextRef.current.width !== boundedWidth || renderContextRef.current.height !== boundedHeight) {
        renderContextRef.current = createRenderContext(boundedWidth, boundedHeight);
      }

      // Render the new frame with quality settings
      const frame = renderModel(
        model,
        { rx: animStateRef.current.rx, ry: animStateRef.current.ry, rz: animStateRef.current.rz },
        {
          width: boundedWidth,
          height: boundedHeight,
          quality,
          useBlocks: fullscreen && quality === 'ultra',
        },
        renderContextRef.current
      );

      // Only update state with the rendered lines
      setFrameLines(frame.lines);
    }, frameInterval);

    return () => clearInterval(interval);
  }, [show3DModel, model, paused, speed, boundedWidth, boundedHeight, quality, fullscreen]);

  // Initial render when model changes
  useEffect(() => {
    if (!show3DModel || !model) {
      setFrameLines([]);
      return;
    }

    if (!renderContextRef.current || renderContextRef.current.width !== boundedWidth || renderContextRef.current.height !== boundedHeight) {
      renderContextRef.current = createRenderContext(boundedWidth, boundedHeight);
    }

    const frame = renderModel(
      model,
      { rx: animStateRef.current.rx, ry: animStateRef.current.ry, rz: animStateRef.current.rz },
      {
        width: boundedWidth,
        height: boundedHeight,
        quality,
        useBlocks: fullscreen && quality === 'ultra',
      },
      renderContextRef.current
    );

    setFrameLines(frame.lines);
  }, [show3DModel, model, boundedWidth, boundedHeight, quality, fullscreen]);

  if (!show3DModel) {
    return <></>;
  }

  // Fullscreen rendering
  if (fullscreen) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="round"
        borderColor={colors.accent}
      >
        {/* Title bar */}
        <Box paddingX={1} justifyContent="space-between">
          <Text color={colors.primary} bold>
            {model?.name ?? '3D Model'} {paused ? '⏸' : '▶'}
          </Text>
          <Text color={colors.textDim}>
            Quality: {quality.toUpperCase()}
          </Text>
        </Box>

        {/* Model render - larger area */}
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
          {model ? (
            frameLines.map((line, i) => (
              <Text key={i} color={colors.accent}>
                {line}
              </Text>
            ))
          ) : (
            <Box
              flexGrow={1}
              alignItems="center"
              justifyContent="center"
            >
              <Text color={colors.textDim}>No model available</Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // PiP (Picture-in-Picture) rendering
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={colors.border}
    >
      {/* Title */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color={colors.primary} bold>3D Model</Text>
        <Text color={colors.textDim}>
          {paused ? '⏸' : '▶'}
        </Text>
      </Box>

      {/* Model render */}
      <Box flexDirection="column" paddingX={0}>
        {model ? (
          frameLines.map((line, i) => (
            <Text key={i} color={colors.accent}>
              {line.padEnd(width - 2)}
            </Text>
          ))
        ) : (
          <Box
            height={height - 3}
            alignItems="center"
            justifyContent="center"
          >
            <Text color={colors.textDim}>No model</Text>
          </Box>
        )}
      </Box>

      {/* Model name and hint */}
      {model && (
        <Box paddingX={1} justifyContent="space-between">
          <Text color={colors.textDim} dimColor>
            {model.name}
          </Text>
          <Text color={colors.textDim} dimColor>
            {paused ? 'P:play ' : 'P:stop '}Z:zoom
          </Text>
        </Box>
      )}
    </Box>
  );
});

// Wrapper component that passes props
export function Model3DView(props: Model3DViewProps): React.ReactElement {
  return <Model3DViewInner {...props} />;
}
