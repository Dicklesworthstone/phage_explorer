import { useCallback } from 'react';
import { copyToClipboard } from '../utils/export';
import { saveFile, openFile, type SaveFileOptions, type OpenFileOptions } from '../utils/fileSystem';

async function copyBlobToClipboard(content: Blob, mimeType: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const canWriteRich =
    clipboard?.write &&
    typeof ClipboardItem !== 'undefined';

  if (canWriteRich) {
    try {
      await clipboard.write([
        new ClipboardItem({ [mimeType]: content }),
      ]);
      return;
    } catch {
      // Text-like blobs can still use the reliable plain-text fallback below.
    }
  }

  if (mimeType.startsWith('text/') || content.type.startsWith('text/')) {
    await copyToClipboard(await content.text());
    return;
  }

  throw new Error(`Clipboard does not support ${mimeType} content in this browser`);
}

export function useFileSystem() {
  const save = useCallback(async (
    content: string | Blob | ArrayBuffer,
    options?: SaveFileOptions
  ) => {
    await saveFile(content, options);
  }, []);

  const open = useCallback(async (options?: OpenFileOptions) => {
    return await openFile(options);
  }, []);

  const copy = useCallback(async (content: string | Blob, mimeType = 'text/plain') => {
    if (typeof content === 'string') {
      await copyToClipboard(content, mimeType === 'text/html' ? content : undefined);
      return;
    }

    await copyBlobToClipboard(content, mimeType || content.type || 'application/octet-stream');
  }, []);

  return { save, open, copy };
}
