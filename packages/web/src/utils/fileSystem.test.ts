import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exportLocalGenomeBundle, importLocalGenomes } from '../../../core/src/genome-import';
import {
  isFileSystemAccessSupported,
  saveFile,
  openFile,
  fallbackSaveFile,
  readLocalTextFile,
} from './fileSystem';

describe('private input file integrity', () => {
  const maximumBytes = 10 * 1024 * 1024;

  it('preserves Unicode and line endings through reading and a portable genome round trip', async () => {
    const text = '>PRIVATE_β exact α metadata\r\nACGTRYN\r\n';
    const file = new File(['\ufeff' + text], 'private.fa');
    const read = await readLocalTextFile(file, maximumBytes, new AbortController().signal);
    // UTF-8 BOM handling agrees with the existing native import boundary.
    expect(read).toBe(text);
    const parsed = await importLocalGenomes({ name: file.name, text: read });
    expect(parsed.genomes[0].phage.accession).toBe('PRIVATE_β');
    expect(parsed.genomes[0].phage.name).toBe('PRIVATE_β exact α metadata');
    expect(parsed.genomes[0].sequence).toBe('ACGTRYN');
    const reopened = await importLocalGenomes({ name: 'workspace.json', text: exportLocalGenomeBundle(parsed.genomes) });
    expect(reopened.genomes).toEqual(parsed.genomes);
  });

  it('rejects malformed bytes in metadata before the parser can save replacement characters', async () => {
    const file = new File([new TextEncoder().encode('>PRIVATE_'), new Uint8Array([0xff]), '\nACGT\n'], 'broken.fa');
    // The former File.text() path accepts a different source under a new identity.
    const replaced = await importLocalGenomes({ name: file.name, text: await file.text() });
    expect(replaced.genomes[0].phage.accession).toBe('PRIVATE_\ufffd');
    await expect(readLocalTextFile(file, maximumBytes, new AbortController().signal)).rejects.toThrow('invalid UTF-8');
    for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x92]]) {
      await expect(readLocalTextFile(new File([new Uint8Array(bytes)], 'broken.json'), maximumBytes,
        new AbortController().signal)).rejects.toThrow('invalid UTF-8');
    }
  });

  it('rejects over-budget, empty and incomplete reads without accepting their contents', async () => {
    let reads = 0;
    for (const size of [NaN, Infinity, -1, 0, 1.5, maximumBytes + 1]) {
      await expect(readLocalTextFile({ size, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } },
        maximumBytes, new AbortController().signal)).rejects.toThrow('10 MiB');
    }
    expect(reads).toBe(0);
    for (const length of [0, 2, maximumBytes + 1]) {
      await expect(readLocalTextFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(length) }, maximumBytes,
        new AbortController().signal)).rejects.toThrow('size changed');
    }
  });

  it('settles cancellation before an unresponsive read finishes and observes a late failure', async () => {
    const controller = new AbortController();
    let rejectRead!: (error: Error) => void;
    const pending = readLocalTextFile({ size: 1, arrayBuffer: () => new Promise((_resolve, reject) => { rejectRead = reject; }) }, maximumBytes, controller.signal);
    const cancelled = pending.catch(error => error);
    await Promise.resolve();
    controller.abort();
    expect(await cancelled).toHaveProperty('name', 'AbortError');
    rejectRead(new Error('Late disk failure'));
    await Promise.resolve();
    expect(await readLocalTextFile(new File(['next'], 'next.txt'), maximumBytes, new AbortController().signal)).toBe('next');
  });

  it('does not start reading after immediate or prior cancellation', async () => {
    let reads = 0;
    const file = { size: 1, arrayBuffer: async () => { reads++; return new Uint8Array([65]).buffer; } };
    const controller = new AbortController();
    const pending = readLocalTextFile(file, maximumBytes, controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await expect(readLocalTextFile(file, maximumBytes, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    expect(reads).toBe(0);
  });

  it('rejects read failures even when the provider rejects without an Error object', async () => {
    await expect(readLocalTextFile({ size: 1, arrayBuffer: () => Promise.reject(undefined) }, maximumBytes,
      new AbortController().signal)).rejects.toBeInstanceOf(Error);
  });
});

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
