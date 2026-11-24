import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { SIMULATION_METADATA, selectRibosomeTrafficGene, type PhageFull, type SimulationMeta } from '@phage-explorer/core';
import { getSimulationRegistry } from '../simulations/registry';

interface SimulationHubOverlayProps {
  onClose: () => void;
  /** Only supplied when the sequence belongs to the currently selected repository and phage. */
  genomeSequence: string | null;
}

export function SimulationHubOverlay({ onClose, genomeSequence }: SimulationHubOverlayProps): React.ReactElement {
  const currentPhage = usePhageStore(s => s.currentPhage);
  const selectedGeneId = usePhageStore(s => s.selectedGeneId);
  const activeSim = usePhageStore(s => s.activeSimulationId);
  const launchSimulation = usePhageStore(s => s.launchSimulation);
  const closeSimulation = usePhageStore(s => s.closeSimulation);

  const [selected, setSelected] = useState(0);
  const [geneSelection, setGeneSelection] = useState<{ phage: PhageFull; id: number } | null>(null);
  const [failure, setFailure] = useState<{ phage: PhageFull | null; message: string } | null>(null);
  const genes = useMemo(() => currentPhage?.genes.filter(gene => gene.type === 'CDS') ?? [], [currentPhage]);
  const chosenGene = useMemo(() => {
    if (!currentPhage) return null;
    const id = geneSelection?.phage === currentPhage ? geneSelection.id
      : genes.some(gene => gene.id === selectedGeneId) ? selectedGeneId! : undefined;
    try { return selectRibosomeTrafficGene(currentPhage, id); } catch { return null; }
  }, [currentPhage, genes, geneSelection, selectedGeneId]);

  const simulations = useMemo(
    () => [...SIMULATION_METADATA].sort((a, b) => a.priority - b.priority),
    []
  );

  const registry = getSimulationRegistry();

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setFailure(null);
      setSelected(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setFailure(null);
      setSelected(i => Math.min(simulations.length - 1, i + 1));
      return;
    }
    if ((key.leftArrow || key.rightArrow) && simulations[selected]?.id === 'ribosome-traffic' && currentPhage && genes.length) {
      const index = genes.findIndex(gene => gene.id === chosenGene?.id);
      const next = Math.min(genes.length - 1, Math.max(0, index + (key.leftArrow ? -1 : 1)));
      setGeneSelection({ phage: currentPhage, id: genes[next].id });
      setFailure(null);
      return;
    }
    if (key.return) {
      const meta = simulations[selected];
      const sim = registry.get(meta.id);
      if (sim) {
        if (meta.requiresPhage && !currentPhage) {
          return;
        }
        try {
          // Build from the owned input before replacing any accepted simulation.
          const context = (sim.id === 'ribosome-traffic' || sim.id === 'lysogeny-circuit') && currentPhage && genomeSequence !== null
            ? { genomeSequence, ...(sim.id === 'ribosome-traffic' && chosenGene ? { geneId: chosenGene.id } : {}) } : undefined;
          const initial = sim.init(currentPhage, undefined, undefined, context);
          if (activeSim) closeSimulation();
          launchSimulation(sim.id, initial);
          setFailure(null);
        } catch (cause) {
          setFailure({ phage: currentPhage, message: cause instanceof Error ? cause.message : String(cause) });
          return;
        }
      }
      onClose();
    }
  });

  const selectedMeta: SimulationMeta | undefined = simulations[selected];
  const phageName = currentPhage?.name ?? 'None';

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="#22c55e"
      width={80}
      height={24}
      paddingX={1}
      paddingY={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="#22c55e" bold>SIMULATION HUB</Text>
        <Text color="#9ca3af">ESC to close · Enter to start · Current phage: {phageName}</Text>
      </Box>

      <Box>
        <Box flexDirection="column" width={30}>
          {simulations.map((sim, idx) => (
            <Text
              key={sim.id}
              color={sim.requiresPhage && !currentPhage ? '#4b5563' : idx === selected ? '#22c55e' : '#e5e7eb'}
              bold={idx === selected}
            >
              {idx === selected ? '▶ ' : '  '}
              {sim.icon} {sim.name}
              {activeSim === sim.id ? ' (running)' : ''}
              {sim.requiresPhage && !currentPhage ? ' [needs phage]' : ''}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" paddingLeft={2} width={46}>
          {selectedMeta ? (
            <>
              <Text color="#e5e7eb" bold>{selectedMeta.name}</Text>
              <Text color="#9ca3af">{selectedMeta.description}</Text>
              {selectedMeta.id === 'ribosome-traffic' && (
                <>
                  <Text color="#e5e7eb">CDS: {chosenGene?.locusTag ?? chosenGene?.name ?? chosenGene?.product ?? 'unavailable'} · ←/→ choose</Text>
                  <Text color="#9ca3af">Exact coding order; codon-frequency teaching model, not measured translation rates.</Text>
                  {genomeSequence === null && <Text color="#f87171">Wait for this genome sequence to finish loading.</Text>}
                </>
              )}
              {selectedMeta.id === 'lysogeny-circuit' && (
                <>
                  <Text color="#9ca3af">Scans the complete genome for regulatory candidates. The toggle and fate score remain teaching models.</Text>
                  {currentPhage && genomeSequence === null && <Text color="#f87171">Wait for this genome sequence to finish loading.</Text>}
                </>
              )}
              <Text color="#9ca3af" dimColor>
                Requires phage: {selectedMeta.requiresPhage ? 'Yes' : 'No'}
              </Text>
              <Text color="#9ca3af" dimColor>
                Keywords: {selectedMeta.keywords.join(', ')}
              </Text>
              {selectedMeta.requiresPhage && !currentPhage && (
                <Text color="#f87171">Load a phage to start this simulation.</Text>
              )}
            </>
          ) : (
            <Text color="#9ca3af">Select a simulation</Text>
          )}
        </Box>
      </Box>
      {failure?.phage === currentPhage && <Text color="#f87171">{failure.message}</Text>}
    </Box>
  );
}

