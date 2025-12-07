/**
 * Export Utilities - Multi-format export capabilities
 *
 * Supports:
 * - Rich clipboard (HTML + plain text)
 * - FASTA format
 * - File System Access API (where supported)
 * - Fallback downloads
 */

/**
 * Copy text to clipboard with optional HTML formatting
 */
export async function copyToClipboard(
  text: string,
  html?: string
): Promise<boolean> {
  try {
    if (html && navigator.clipboard.write) {
      // Rich clipboard with HTML
      const blob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([text], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blob,
          'text/plain': textBlob,
        }),
      ]);
    } else {
      // Plain text fallback
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch (err) {
    console.error('Clipboard copy failed:', err);
    return false;
  }
}

/**
 * Format sequence as FASTA
 */
export function formatFASTA(
  sequence: string,
  header: string,
  lineWidth = 60
): string {
  const lines: string[] = [];
  lines.push(`>${header}`);

  for (let i = 0; i < sequence.length; i += lineWidth) {
    lines.push(sequence.slice(i, i + lineWidth));
  }

  return lines.join('\n');
}

/**
 * Format multiple sequences as multi-FASTA
 */
export function formatMultiFASTA(
  sequences: Array<{ header: string; sequence: string }>,
  lineWidth = 60
): string {
  return sequences
    .map(({ header, sequence }) => formatFASTA(sequence, header, lineWidth))
    .join('\n\n');
}

/**
 * Download data as a file
 */
export function downloadFile(
  data: string | Blob,
  filename: string,
  mimeType = 'text/plain'
): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Save using File System Access API (Chrome/Edge)
 * Falls back to download if not supported
 */
export async function saveFile(
  data: string | Blob,
  suggestedName: string,
  options?: {
    description?: string;
    accept?: Record<string, string[]>;
  }
): Promise<boolean> {
  try {
    // Check for File System Access API support
    if ('showSaveFilePicker' in window) {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: options?.accept
          ? [
              {
                description: options.description || 'File',
                accept: options.accept,
              },
            ]
          : undefined,
      });

      const writable = await handle.createWritable();
      await writable.write(data instanceof Blob ? data : new Blob([data]));
      await writable.close();
      return true;
    }
  } catch (err) {
    // User cancelled or API not available
    if ((err as Error).name === 'AbortError') {
      return false;
    }
  }

  // Fallback to download
  downloadFile(
    data,
    suggestedName,
    options?.accept ? Object.keys(options.accept)[0] : undefined
  );
  return true;
}

/**
 * Export sequence as FASTA file
 */
export async function exportFASTA(
  sequence: string,
  header: string,
  filename?: string
): Promise<boolean> {
  const fasta = formatFASTA(sequence, header);
  const defaultFilename = filename || `${header.replace(/[^a-zA-Z0-9]/g, '_')}.fasta`;

  return saveFile(fasta, defaultFilename, {
    description: 'FASTA sequence file',
    accept: { 'text/plain': ['.fasta', '.fa', '.fna', '.faa'] },
  });
}

/**
 * Export data as JSON file
 */
export async function exportJSON(
  data: unknown,
  filename: string
): Promise<boolean> {
  const json = JSON.stringify(data, null, 2);

  return saveFile(json, filename, {
    description: 'JSON data file',
    accept: { 'application/json': ['.json'] },
  });
}

/**
 * Export data as CSV file
 */
export async function exportCSV(
  rows: Array<Record<string, unknown>>,
  filename: string
): Promise<boolean> {
  if (rows.length === 0) return false;

  const headers = Object.keys(rows[0]);
  const csvRows: string[] = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map((header) => {
      const val = row[header];
      // Quote strings that contain commas or quotes
      if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return String(val ?? '');
    });
    csvRows.push(values.join(','));
  }

  const csv = csvRows.join('\n');

  return saveFile(csv, filename, {
    description: 'CSV spreadsheet',
    accept: { 'text/csv': ['.csv'] },
  });
}

/**
 * Generate HTML representation of sequence with colors
 */
export function sequenceToHTML(
  sequence: string,
  nucleotideColors: Record<string, { fg: string; bg: string }>
): string {
  const chars = sequence.toUpperCase().split('');
  const spans = chars.map((char) => {
    const colors = nucleotideColors[char] || { fg: '#888', bg: 'transparent' };
    return `<span style="color: ${colors.fg}; background-color: ${colors.bg}; font-family: monospace;">${char}</span>`;
  });
  return `<div style="font-family: monospace; white-space: pre-wrap;">${spans.join('')}</div>`;
}

/**
 * Copy sequence to clipboard with syntax highlighting
 */
export async function copySequence(
  sequence: string,
  nucleotideColors: Record<string, { fg: string; bg: string }>,
  header?: string
): Promise<boolean> {
  const plainText = header ? `>${header}\n${sequence}` : sequence;
  const html = sequenceToHTML(sequence, nucleotideColors);
  return copyToClipboard(plainText, html);
}
