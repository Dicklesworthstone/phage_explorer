import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isFileSystemAccessSupported,
  saveFile,
  openFile,
  fallbackSaveFile,
} from './fileSystem';

describe('File System Access utilities and offline support (phage_explorer-9vk4.5)', () => {
  it('detects File System Access API support correctly', () => {
    // In Bun test runner without browser globals, isFileSystemAccessSupported should return false
    expect(typeof isFileSystemAccessSupported()).toBe('boolean');
  });

  it('fallbackSaveFile handles non-DOM / SSR environments safely without throwing', () => {
    expect(() => fallbackSaveFile('test content', 'test.txt')).not.toThrow();
  });

  it('saveFile uses showSaveFilePicker when available on window', async () => {
    let writtenContent = '';
    let closed = false;
    let pickerOptions: unknown = null;

    const originalWindow = globalThis.window;
    try {
      (globalThis as unknown as { window: unknown }).window = {
        showSaveFilePicker: async (opts: unknown) => {
          pickerOptions = opts;
          return {
            createWritable: async () => ({
              write: async (c: string) => { writtenContent = c; },
              close: async () => { closed = true; },
            }),
          };
        },
      };

      await saveFile('sample fasta sequence', {
        suggestedName: 'lambda.fasta',
        types: [{ description: 'FASTA', accept: { 'text/plain': ['.fasta'] } }],
      });

      expect(writtenContent).toBe('sample fasta sequence');
      expect(closed).toBe(true);
      expect((pickerOptions as { suggestedName: string }).suggestedName).toBe('lambda.fasta');
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });

  it('saveFile catches AbortError without throwing when user cancels picker', async () => {
    const originalWindow = globalThis.window;
    try {
      (globalThis as unknown as { window: unknown }).window = {
        showSaveFilePicker: async () => {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        },
      };

      await expect(saveFile('data', { suggestedName: 'cancelled.txt' })).resolves.toBeUndefined();
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });

  it('openFile uses showOpenFilePicker when available on window', async () => {
    let pickerOptions: unknown = null;
    const mockFile = new File(['>seq\nATGC'], 'lambda.fasta', { type: 'text/plain' });

    const originalWindow = globalThis.window;
    try {
      (globalThis as unknown as { window: unknown }).window = {
        showOpenFilePicker: async (opts: unknown) => {
          pickerOptions = opts;
          return [
            {
              getFile: async () => mockFile,
            },
          ];
        },
      };

      const files = await openFile({
        multiple: false,
        types: [{ description: 'FASTA', accept: { 'text/plain': ['.fasta'] } }],
      });

      expect(files.length).toBe(1);
      expect(files[0].name).toBe('lambda.fasta');
      expect((pickerOptions as { multiple: boolean }).multiple).toBe(false);
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });

  it('openFile returns empty array on AbortError when user cancels picker', async () => {
    const originalWindow = globalThis.window;
    try {
      (globalThis as unknown as { window: unknown }).window = {
        showOpenFilePicker: async () => {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        },
      };

      const files = await openFile();
      expect(files).toEqual([]);
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });

  it('offline.html exists in public and is wired to service worker navigation catch handler', () => {
    const publicOfflinePath = join(import.meta.dir, '../../public/offline.html');
    const swPath = join(import.meta.dir, '../sw.ts');

    expect(existsSync(publicOfflinePath)).toBe(true);
    const offlineHtml = readFileSync(publicOfflinePath, 'utf8');
    expect(offlineHtml).toContain("You're Offline");
    expect(offlineHtml).toContain('Phage Explorer');

    const swSource = readFileSync(swPath, 'utf8');
    expect(swSource).toContain('setCatchHandler');
    expect(swSource).toContain('/offline.html');
    expect(swSource).toContain('matchPrecache');
  });
});
