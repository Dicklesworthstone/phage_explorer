import { GeneInfo } from '@phage-explorer/core';

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

// Clipboard helper
export async function copyToClipboard(text: string, html?: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error('Clipboard API not available');
  }

  if (html) {
    const blobText = new Blob([text], { type: 'text/plain' });
    const blobHtml = new Blob([html], { type: 'text/html' });
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': blobText,
        'text/html': blobHtml,
      }),
    ]);
  } else {
    await navigator.clipboard.writeText(text);
  }
}