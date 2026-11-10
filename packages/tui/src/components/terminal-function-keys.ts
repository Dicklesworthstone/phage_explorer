/** Exact unmodified terminal function keys, before Ink discards their input payload. */
export type TerminalFunctionKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';
const FUNCTION_KEYS: Readonly<Record<string, TerminalFunctionKey>> = {
  '\x1bOP': 'F1', '\x1b[11~': 'F1',
  '\x1bOQ': 'F2', '\x1b[12~': 'F2',
  '\x1bOR': 'F3', '\x1b[13~': 'F3',
  '\x1bOS': 'F4', '\x1b[14~': 'F4',
  '\x1b[15~': 'F5', '\x1b[17~': 'F6', '\x1b[18~': 'F7',
  '\x1b[19~': 'F8', '\x1b[20~': 'F9', '\x1b[21~': 'F10',
};

/** Never recognize a substring, pasted text or modified sequence as a bare function key. */
export function bindTerminalFunctionKeys(stdin: NodeJS.ReadableStream,
  onKey: (key: TerminalFunctionKey) => void): () => void {
  const receive = (chunk: unknown) => {
    const sequence = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    if (Object.hasOwn(FUNCTION_KEYS, sequence)) onKey(FUNCTION_KEYS[sequence]);
  };
  stdin.on('data', receive);
  return () => { stdin.off('data', receive); };
}
