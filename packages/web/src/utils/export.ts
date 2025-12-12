// In-browser download helper
export function downloadString(content: string, filename: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// FASTA Formatter
export function formatFasta(header: string, sequence: string, lineLength = 80): string {
  const lines = [];
  lines.push(`>${header}`);
  for (let i = 0; i < sequence.length; i += lineLength) {
    lines.push(sequence.slice(i, i + lineLength));
  }
  return lines.join('\n');
}

// Clipboard helper (rich: text + html when supported)
export async function copyToClipboard(text: string, html?: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error('Clipboard API not available');
  }

  if (html && 'ClipboardItem' in window) {
    try {
      const blobText = new Blob([text], { type: 'text/plain' });
      const blobHtml = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': blobText,
          'text/html': blobHtml,
        }),
      ]);
      return;
    } catch {
      // Fall through to plain-text path
    }
  }
  await navigator.clipboard.writeText(text);
}

// Build dual-format clipboard payload for sequences
export function buildSequenceClipboardPayload(opts: {
  header: string;
  sequence: string;
  wrap?: number;
  palette?: Partial<Record<string, string>>; // nucleotide -> color
}): { text: string; html: string } {
  const { header, sequence, wrap = 80, palette = {} } = opts;
  const fasta = formatFasta(header, sequence, wrap);

  const defaultColors: Record<string, string> = {
    A: '#22c55e',
    C: '#3b82f6',
    G: '#f59e0b',
    T: '#ef4444',
    N: '#9ca3af',
  };
  const colors = { ...defaultColors, ...palette };

  // Build HTML with inline colored spans and monospace styling
  const lines: string[] = [];
  lines.push(`<div style="font-family: 'SFMono-Regular', Menlo, Consolas, monospace; background:#0b0f17; color:#e5e7eb; padding:8px; border:1px solid #1f2937; border-radius:6px;">`);
  lines.push(`<div style="color:#a855f7; margin-bottom:4px;">&gt;${escapeHtml(header)}</div>`);

  for (let i = 0; i < sequence.length; i += wrap) {
    const chunk = sequence.slice(i, i + wrap);
    const colored = Array.from(chunk)
      .map(ch => {
        const color = colors[ch.toUpperCase()] ?? colors.N;
        return `<span style="color:${color}">${escapeHtml(ch)}</span>`;
      })
      .join('');
    lines.push(`<div style="line-height:1.3;">${colored}</div>`);
  }
  lines.push(`</div>`);

  return { text: fasta, html: lines.join('') };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
