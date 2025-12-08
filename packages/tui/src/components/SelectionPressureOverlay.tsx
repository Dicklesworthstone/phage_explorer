import React, { useMemo, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import { calculateSelectionPressure } from '@phage-explorer/core';

interface Props {
  repository: PhageRepository;
}

export function SelectionPressureOverlay({ repository }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  
  const currentPhage = usePhageStore(s => s.currentPhage);
  const phages = usePhageStore(s => s.phages);
  const diffRefId = usePhageStore(s => s.diffReferencePhageId);
  
  const [referenceSeq, setReferenceSeq] = useState<string | null>(null);
  const [targetSeq, setTargetSeq] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
        if (!currentPhage) return;
        
        setLoading(true);
        // Use diff reference if set, else previous phage
        let refId = diffRefId;
        if (!refId) {
            const idx = phages.findIndex(p => p.id === currentPhage.id);
            const prevIdx = idx > 0 ? idx - 1 : (idx + 1) % phages.length;
            refId = phages[prevIdx]?.id;
        }
        
        if (!refId || refId === currentPhage.id) {
            setLoading(false);
            return;
        }

        try {
            const [tSeq, rSeq] = await Promise.all([
                repository.getSequenceWindow(currentPhage.id, 0, 100000), // Limit for performance
                repository.getSequenceWindow(refId, 0, 100000)
            ]);
            setTargetSeq(tSeq);
            setReferenceSeq(rSeq);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };
    load();
  }, [currentPhage, diffRefId, phages, repository]);

  const analysis = useMemo(() => {
    if (!targetSeq || !referenceSeq) return null;
    return calculateSelectionPressure(targetSeq, referenceSeq, 300); // 100 AA window
  }, [targetSeq, referenceSeq]);

  useInput((input, key) => {
    if (key.escape || input === 'v' || input === 'V') {
      closeOverlay('pressure'); // Using 'pressure' ID as mapped in MenuOverlays, though it might be 'selectionPressure'
    }
  });

  if (loading) return <Text>Loading sequences...</Text>;
  if (!analysis) return <Text>Comparison data unavailable (needs 2 phages)</Text>;

  const width = 80;
  const { windows, globalOmega } = analysis;
  
  // Render chromosome paint bar
  // ░ = neutral, ▒ = purifying (blue), █ = positive (red)
  const bar = windows.map(w => {
      if (w.classification === 'purifying') return '▒'; // Should act as blue
      if (w.classification === 'positive') return '█'; // Should act as red
      return '░';
  }).join('').slice(0, width);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={width + 4}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>SELECTION PRESSURE (dN/dS)</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>
      
      <Box marginBottom={1}>
        <Text>Global ω (dN/dS): <Text bold color={globalOmega > 1 ? colors.error : colors.success}>{globalOmega.toFixed(3)}</Text></Text>
      </Box>

      <Box flexDirection="column">
          <Text bold>Landscape:</Text>
          <Box>
            {/* Render the bar string with coloring */}
            {bar.split('').map((char, i) => {
                let color = colors.textDim;
                if (char === '▒') color = colors.primary;
                if (char === '█') color = colors.error;
                return <Text key={i} color={color}>{char}</Text>;
            })}
          </Box>
          <Box justifyContent="space-between">
              <Text color={colors.textDim}>Start</Text>
              <Text color={colors.textDim}>~{windows.length * 300}bp</Text>
          </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" flexDirection="column" paddingX={1}>
          <Text underline>Hotspots (Positive Selection):</Text>
          {windows.filter(w => w.classification === 'positive').slice(0, 3).map((w, i) => (
              <Text key={i}>
                  {w.start}-{w.end}: ω={w.omega.toFixed(2)} (dN={w.dN.toFixed(3)}, dS={w.dS.toFixed(3)})
              </Text>
          ))}
          {windows.filter(w => w.classification === 'positive').length === 0 && (
              <Text color={colors.textDim}>None detected.</Text>
          )}
      </Box>
    </Box>
  );
}
