import { describe, expect, it } from 'bun:test';
import {
  buildSequenceClipboardPayload,
  copyToClipboard,
  formatFasta,
  type ClipboardAdapter,
} from './export';

describe('formatFasta', () => {
  it('wraps sequences deterministically', () => {
    expect(formatFasta('example', 'AACCGGTT', 3)).toBe('>example\nAAC\nCGG\nTT');
  });

  it('uses a safe default for invalid wrap lengths', () => {
    const sequence = 'A'.repeat(81);
    expect(formatFasta('example', sequence, 0).split('\n').map((line) => line.length))
      .toEqual([8, 80, 1]);
  });
});

describe('copyToClipboard', () => {
  it('prefers rich clipboard output when it succeeds', async () => {
    const calls: string[] = [];
    const adapter: ClipboardAdapter = {
      writeRich: async () => { calls.push('rich'); },
      writeText: async () => { calls.push('text'); },
      legacyCopy: () => { calls.push('legacy'); return true; },
    };

    await copyToClipboard('plain', '<strong>rich</strong>', adapter);
    expect(calls).toEqual(['rich']);
  });

  it('falls back from rejected rich and plain clipboard APIs', async () => {
    const calls: string[] = [];
    const adapter: ClipboardAdapter = {
      writeRich: async () => { calls.push('rich'); throw new Error('blocked'); },
      writeText: async () => { calls.push('text'); throw new Error('denied'); },
      legacyCopy: (text) => { calls.push(`legacy:${text}`); return true; },
    };

    await copyToClipboard('fallback text', '<b>fallback</b>', adapter);
    expect(calls).toEqual(['rich', 'text', 'legacy:fallback text']);
  });

  it('reports failure only after every available path fails', async () => {
    const adapter: ClipboardAdapter = {
      writeText: async () => { throw new Error('denied'); },
      legacyCopy: () => false,
    };

    await expect(copyToClipboard('text', undefined, adapter)).rejects.toThrow(
      'Unable to copy text to the clipboard'
    );
  });
});

describe('buildSequenceClipboardPayload', () => {
  it('escapes user-controlled headers and sequence characters in HTML', () => {
    const payload = buildSequenceClipboardPayload({
      header: '<script>alert(1)</script>',
      sequence: 'A<&',
      wrap: 80,
    });

    expect(payload.html).not.toContain('<script>');
    expect(payload.html).toContain('&lt;script&gt;');
    expect(payload.html).toContain('&lt;');
    expect(payload.html).toContain('&amp;');
  });
});
