import React from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { GelView } from './GelView';

export function GelOverlay({ sequence }: { sequence: string }): React.ReactElement {
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('gel');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={1}
      width={85}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>RESTRICTION DIGEST</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>
      
      <GelView sequence={sequence} />
    </Box>
  );
}
