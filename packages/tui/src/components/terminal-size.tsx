import React from 'react';
import { Box, Text, useStdout } from 'ink';

/**
 * Terminal size floor, and the message shown below it.
 *
 * ## Why
 *
 * The TUI had no width or height guard anywhere. Overlays hardcode widths
 * between 68 and 92 columns with `borderStyle="double"`, so in a split pane or a
 * tmux sidebar the layout degrades into unreadable wrapping with no explanation.
 * Meanwhile the README's troubleshooting table says:
 *
 *     Terminal too small -> Resize to at least 80x24 for best experience
 *
 * which describes graceful degradation that did not exist. This is the least
 * forgiving place for that: a terminal app that goes to pieces in a narrow
 * window is the first impression for anyone who tries it beside their editor.
 *
 * ## What this does, and does not
 *
 * It renders a clear, actionable message instead of a broken layout, and it
 * names the current and required size so the user knows how far off they are.
 * It does NOT try to reflow the app into 40 columns. Reflowing thirty overlays
 * that were designed against a fixed width is a much larger change, and the
 * honest interim is to say "this needs 80x24" rather than to render something
 * mangled and let the user work out why.
 *
 * ## The 80x24 floor
 *
 * Taken from the README rather than invented, so the code and the documentation
 * agree. 80 columns is also the widest overlay's requirement once
 * `clampOverlayWidth` below is applied; 24 rows is the classic terminal height
 * and enough for the header, a sequence viewport and the footer hints.
 */

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

/**
 * Clamp an overlay's designed width to what the terminal can actually show.
 *
 * Overlays declare widths up to 92. At exactly 80 columns a 92-wide bordered box
 * overflows and wraps, which is the "usable at 80x24" claim failing at its own
 * stated minimum. Clamping costs the overlay some columns and keeps the border
 * intact.
 *
 * The two-column margin leaves room for the border characters themselves.
 */
export function clampOverlayWidth(designed: number, columns: number | undefined): number {
  const available = (columns ?? MIN_COLUMNS) - 2;
  return Math.max(20, Math.min(designed, available));
}

/**
 * `clampOverlayWidth` bound to the live terminal size.
 *
 * Overlays call this instead of plumbing `useStdout` through themselves. It is
 * an ordinary hook: call it unconditionally at render, as these do.
 */
export function useOverlayWidth(designed: number): number {
  const { stdout } = useStdout();
  return clampOverlayWidth(designed, stdout?.columns);
}

export interface TerminalSizeGateProps {
  children: React.ReactNode;
}

/**
 * Render children only when the terminal is big enough, else explain.
 *
 * Ink re-renders on resize, so the message disappears as soon as the user grows
 * the window; there is nothing to restart.
 */
export function TerminalSizeGate({ children }: TerminalSizeGateProps): React.ReactElement {
  const { stdout } = useStdout();

  // `columns` and `rows` are undefined when stdout is not a TTY -- a pipe, a
  // CI capture, a test harness. Treat that as "big enough" rather than blocking:
  // refusing to render because the size is unknown would break every non-TTY
  // use, and there is no user there to resize anything.
  const columns = stdout?.columns;
  const rows = stdout?.rows;
  const known = typeof columns === 'number' && typeof rows === 'number';

  if (known && (columns < MIN_COLUMNS || rows < MIN_ROWS)) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">
          Terminal too small
        </Text>
        <Text>
          Phage Explorer needs at least {MIN_COLUMNS}x{MIN_ROWS}. This terminal is{' '}
          {columns}x{rows}.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Resize the window and this message will clear on its own. Press q or Ctrl+C to
            quit.
          </Text>
        </Box>
      </Box>
    );
  }

  return <>{children}</>;
}
