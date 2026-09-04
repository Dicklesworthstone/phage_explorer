/**
 * File System Access API Utilities
 *
 * Provides wrappers for the File System Access API to save and open files directly.
 * Gracefully degrades to standard download/upload for unsupported browsers.
 */

export interface SaveFileOptions {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

export interface OpenFileOptions {
  multiple?: boolean;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

/**
 * Checks if the browser natively supports the File System Access API
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

/**
 * Save content to a file
 */
export async function saveFile(
  content: string | Blob | ArrayBuffer,
  options: SaveFileOptions = {}
): Promise<void> {
  try {
    // Try File System Access API
    if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: options.suggestedName || 'download.txt',
        types: options.types,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.warn('File System Access API failed, falling back to download link:', err);
    } else {
      // User cancelled
      return;
    }
  }

  // Fallback: Download link
  fallbackSaveFile(content, options.suggestedName);
}

/**
 * Open a file
 */
export async function openFile(
  options: OpenFileOptions = {}
): Promise<File[]> {
  try {
    // Try File System Access API
    if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
      const handles = await (window as any).showOpenFilePicker({
        multiple: options.multiple || false,
        types: options.types,
      });
      
      const files: File[] = [];
      for (const handle of handles) {
        const file = await handle.getFile();
        files.push(file);
      }
      return files;
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.warn('File System Access API failed, falling back to input:', err);
    } else {
      return [];
    }
  }

  // Fallback: Input element
  if (typeof document === 'undefined') return [];
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple || false;
    
    if (options.types && options.types.length > 0) {
      const accept = options.types
        .flatMap(t => Object.values(t.accept).flat())
        .join(',');
      input.accept = accept;
    }

    input.onchange = () => {
      if (input.files) {
        resolve(Array.from(input.files));
      } else {
        resolve([]);
      }
    };

    input.click();
  });
}

/**
 * Fallback implementation using <a> tag
 */
export function fallbackSaveFile(content: string | Blob | ArrayBuffer, filename = 'download.txt'): void {
  if (typeof document === 'undefined') return;
  const blob = content instanceof Blob 
    ? content 
    : new Blob([content], { type: 'application/octet-stream' });
    
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
