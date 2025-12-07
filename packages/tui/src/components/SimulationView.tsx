import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { Simulation, SimulationId, SimState } from '@phage-explorer/core';
import { getSimulationRegistry } from '../simulations/registry';
import { RibosomeTrafficView } from './RibosomeTrafficView';

interface SimulationViewProps {
  onClose: () => void;
}

function renderDetails(sim: Simulation, state: SimState): React.ReactElement {
  const spark = (values: number[], width = 20): string => {
    if (values.length === 0) return '';
    const chars = '▁▂▃▄▅▆▇█';
    const trimmed = values.slice(-width);
    const min = Math.min(...trimmed);
    const max = Math.max(...trimmed);
    if (max === min) return chars[0].repeat(trimmed.length);
    return trimmed
      .map(v => {
        const idx = Math.min(chars.length - 1, Math.floor(((v - min) / (max - min)) * (chars.length - 1)));
        return chars[idx];
      })
      .join('');
  };

  const bar = (fraction: number, width = 20): string => {
    const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  };

  switch (state.type) {
    case 'lysogeny-circuit':
      return (
        <Text>
          CI {state.ci.toFixed(2)} · Cro {state.cro.toFixed(2)} · Phase {state.phase}
          {'  '}CI/Cro trend {spark(state.history.map(h => h.ci - h.cro))}
        </Text>
      );
    case 'ribosome-traffic':
      return <RibosomeTrafficView state={state} />;
    case 'plaque-automata':
      return (
        <Text>
          Phage {state.phageCount} · Infected {state.infectionCount} · Bacteria {state.bacteriaCount}
          {'  '}Grid fill {bar(Math.min(1, state.infectionCount / (state.gridSize * state.gridSize)))}
        </Text>
      );
    case 'evolution-replay':
      return (
        <Text>
          Gen {state.generation} · Mutations {state.mutations.length} · Fitness {(state.fitnessHistory.at(-1) ?? 1).toFixed(2)}
          {'  '}Fitness trend {spark(state.fitnessHistory)}
        </Text>
      );
    case 'packaging-motor':
      return (
        <Text>
          Fill {(state.fillFraction * 100).toFixed(1)}% · Pressure {state.pressure.toFixed(1)} atm · Force {state.force.toFixed(1)} pN
          {'  '}Fill gauge {bar(state.fillFraction)}
        </Text>
      );
    default:
      return <Text>State active</Text>;
  }
}

export function SimulationView({ onClose }: SimulationViewProps): React.ReactElement {
  const simId = usePhageStore(s => s.activeSimulationId);
  const simState = usePhageStore(s => s.simulationState);
  const paused = usePhageStore(s => s.simulationPaused);
  const speed = usePhageStore(s => s.simulationSpeed);

  const updateState = usePhageStore(s => s.updateSimulationState);
  const togglePause = usePhageStore(s => s.toggleSimulationPause);
  const speedUp = usePhageStore(s => s.simulationSpeedUp);
  const speedDown = usePhageStore(s => s.simulationSpeedDown);
  const resetSimulation = usePhageStore(s => s.resetSimulation);
  const closeSimulation = usePhageStore(s => s.closeSimulation);

  const registry = useMemo(() => getSimulationRegistry(), []);
  const simulation = simId ? registry.get(simId as SimulationId) : null;

  const initialRef = useRef<SimState | null>(simState);
  const latestStateRef = useRef<SimState | null>(simState);
  useEffect(() => {
    if (simState) {
      initialRef.current = simState;
      latestStateRef.current = simState;
    }
  }, [simState]);

  // Runner loop
  useEffect(() => {
    if (!simulation || !simState) return;
    if (paused) return;
    const interval = setInterval(() => {
      const current = latestStateRef.current;
      if (!current) return;
      const next = simulation.step(current, speed);
      latestStateRef.current = next;
      updateState(next);
    }, 120);
    return () => clearInterval(interval);
  }, [simulation, simState, paused, speed, updateState]);

  useInput((input, key) => {
    if (key.escape) {
      closeSimulation();
      onClose();
      return;
    }
    if (input === ' ' || input === ' ') {
      togglePause();
      return;
    }
    if (input === 'r' || input === 'R') {
      if (initialRef.current) resetSimulation(initialRef.current);
      return;
    }
    if (input === '.' && simState && simulation) {
      updateState(simulation.step(simState, speed));
      return;
    }
    if (key.leftArrow || input === '-') {
      speedDown();
      return;
    }
    if (key.rightArrow || input === '+') {
      speedUp();
      return;
    }
  });

  if (!simulation || !simState) {
    return (
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor="#22c55e"
        paddingX={2}
        paddingY={1}
        width={80}
      >
        <Text color="#e5e7eb">No simulation running.</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="#22c55e"
      paddingX={2}
      paddingY={1}
      width={90}
      height={22}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="#22c55e" bold>{simulation.name}</Text>
        <Text color="#9ca3af">ESC to close</Text>
      </Box>

      <Text color="#9ca3af" dimColor>{simulation.description}</Text>
      <Box marginY={1}>
        <Text color="#e5e7eb">
          {simulation.getSummary(simState)}
        </Text>
      </Box>

      <Box marginBottom={1}>
        {renderDetails(simulation, simState)}
      </Box>

      <Box marginBottom={1}>
        <Text color="#9ca3af">Status: {paused ? 'Paused' : 'Running'} · Speed {speed}x</Text>
      </Box>

      {/* Parameters */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="#9ca3af" dimColor>Parameters</Text>
        <Box flexDirection="column" gap={0}>
          {Object.entries(simState.params).map(([key, value]) => (
            <Text key={key} color="#e5e7eb">
              {key}: {String(value)}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Controls */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="#9ca3af" dimColor>Controls</Text>
        <Text color="#9ca3af" dimColor>Space: Pause/Resume · R: Reset · .: Step · ←/→ or -/+: Speed</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color="#9ca3af" dimColor>Esc: Close simulation</Text>
      </Box>
    </Box>
  );
}

