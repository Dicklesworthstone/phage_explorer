import React from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { HilbertView } from './HilbertView';

export function HilbertOverlay({ sequence }: { sequence: string }): React.ReactElement {
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('hilbert');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={1}
      width={70}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>HILBERT CURVE ATLAS</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>
      
      <HilbertView sequence={sequence} />
    </Box>
  );
}
