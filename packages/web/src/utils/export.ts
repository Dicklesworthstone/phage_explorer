export function downloadString(content: string, filename: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function formatFasta(header: string, sequence: string, lineLength = 80): string {
  const safeLineLength = Number.isFinite(lineLength) && lineLength > 0
    ? Math.max(1, Math.floor(lineLength))
    : 80;
  const lines = [`>${header}`];
  for (let index = 0; index < sequence.length; index += safeLineLength) {
    lines.push(sequence.slice(index, index + safeLineLength));
  }
  return lines.join('\n');
}

export interface ClipboardAdapter {
  writeRich?: (text: string, html: string) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
  legacyCopy?: (text: string) => boolean;
}

function createLegacyCopy(documentRef: Document): (text: string) => boolean {
  return (text: string) => {
    if (!documentRef.body || typeof documentRef.execCommand !== 'function') return false;

    const activeElement = documentRef.activeElement;
    const textArea = documentRef.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    documentRef.body.appendChild(textArea);

    let copied = false;
    try {
      textArea.focus({ preventScroll: true });
      textArea.select();
      textArea.setSelectionRange(0, textArea.value.length);
      copied = documentRef.execCommand('copy');
    } finally {
      textArea.remove();
      if (activeElement instanceof HTMLElement) {
        try {
          activeElement.focus({ preventScroll: true });
        } catch {
          activeElement.focus();
        }
      }
    }

    return copied;
  };
}

export function createBrowserClipboardAdapter(): ClipboardAdapter {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const documentRef = typeof document !== 'undefined' ? document : undefined;
  const windowRef = typeof window !== 'undefined' ? window : undefined;

  return {
    writeRich:
      clipboard?.write && windowRef && 'ClipboardItem' in windowRef
        ? async (text, html) => {
            const item = new ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([html], { type: 'text/html' }),
            });
            await clipboard.write([item]);
          }
        : undefined,
    writeText: clipboard?.writeText
      ? async (text) => clipboard.writeText(text)
      : undefined,
    legacyCopy: documentRef ? createLegacyCopy(documentRef) : undefined,
  };
}

export async function copyToClipboard(
  text: string,
  html?: string,
  adapter: ClipboardAdapter = createBrowserClipboardAdapter()
): Promise<void> {
  if (html && adapter.writeRich) {
    try {
      await adapter.writeRich(text, html);
      return;
    } catch {
      // Fall through to plain-text clipboard paths.
    }
  }

  if (adapter.writeText) {
    try {
      await adapter.writeText(text);
      return;
    } catch {
      // Fall through to the legacy selection-based path.
    }
  }

  if (adapter.legacyCopy?.(text)) return;
  throw new Error('Unable to copy text to the clipboard');
}

export function buildSequenceClipboardPayload(options: {
  header: string;
  sequence: string;
  wrap?: number;
  palette?: Partial<Record<string, string>>;
}): { text: string; html: string } {
  const { header, sequence, wrap = 80, palette = {} } = options;
  const safeWrap = Number.isFinite(wrap) && wrap > 0 ? Math.max(1, Math.floor(wrap)) : 80;
  const fasta = formatFasta(header, sequence, safeWrap);

  const defaultColors: Record<string, string> = {
    A: '#22c55e',
    C: '#3b82f6',
    G: '#f59e0b',
    T: '#ef4444',
    N: '#9ca3af',
  };
  const colors = { ...defaultColors, ...palette };
  const lines: string[] = [];
  lines.push(`<div style="font-family: 'SFMono-Regular', Menlo, Consolas, monospace; background:#0b0f17; color:#e5e7eb; padding:8px; border:1px solid #1f2937; border-radius:6px;">`);
  lines.push(`<div style="color:#a855f7; margin-bottom:4px;">&gt;${escapeHtml(header)}</div>`);

  for (let index = 0; index < sequence.length; index += safeWrap) {
    const chunk = sequence.slice(index, index + safeWrap);
    const colored = Array.from(chunk)
      .map((character) => {
        const color = colors[character.toUpperCase()] ?? colors.N;
        return `<span style="color:${color}">${escapeHtml(character)}</span>`;
      })
      .join('');
    lines.push(`<div style="line-height:1.3;">${colored}</div>`);
  }
  lines.push('</div>');

  return { text: fasta, html: lines.join('') };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
