/** Explicit, checksum-pinned published inputs. This module never infers a phage's host. */
import { HOST_FLUX_LIMITS, validateHostModelInput, type HostModelInput } from './host-metabolism';

// Retain the publisher's required notice in every exported reference dataset.
// The external model is not covered by the application's MIT license.
export const BIGG_MODEL_LICENSE = 'Copyright © 2019 The Regents of the University of California. All Rights Reserved. ' +
  'Permission to use, copy, modify and distribute any part of BiGG Models for educational, research and non-profit purposes, without fee, and without a written agreement is hereby granted, provided that the above copyright notice, this paragraph and the following three paragraphs appear in all copies. ' +
  'Those desiring to incorporate BiGG Models into commercial products or use for commercial purposes should contact the Technology Transfer & Intellectual Property Services, University of California, San Diego, 9500 Gilman Drive, Mail Code 0910, La Jolla, CA 92093-0910, Ph: (858) 534-5815, FAX: (858) 534-7345, e-mail: invent@ucsd.edu. ' +
  'In no event shall the University of California be liable to any party for direct, indirect, special, incidental, or consequential damages, including lost profits, arising out of the use of this bigg database, even if the University of California has been advised of the possibility of such damage. ' +
  'The BiGG Models provided herein is on an "as is" basis, and the University of California has no obligation to provide maintenance, support, updates, enhancements, or modifications. The University of California makes no representations and extends no warranties of any kind, either implied or express, including, but not limited to, the implied warranties of merchantability or fitness for a particular purpose, or that the use of the BiGG Models will not infringe any patent, trademark or other rights. ' +
  'Source: https://bigg.ucsd.edu/license';

export const ECOLI_CORE_REFERENCE = Object.freeze({
  id: 'e-coli-core',
  name: 'E. coli K-12 MG1655 central metabolism (BiGG e_coli_core)',
  url: 'https://bigg.ucsd.edu/static/models/e_coli_core.json',
  sha256: '7bedec10576cfe935b19218dc881f3fb14f890a1871448fc19a9b4ee15b448d8',
  version: 'BiGG download 2019-10-31',
  publication: 'https://doi.org/10.1128/ecosalplus.10.2.1',
  licenseUrl: 'https://bigg.ucsd.edu/license',
  license: BIGG_MODEL_LICENSE,
  // Independent download pin also published by COBREXA, not computed from a test oracle.
  checksumSource: 'https://cobrexa.github.io/COBREXA.jl/stable/examples/03b-parsimonious-flux-balance/',
});

export function getHostMetabolismReference(id: string): typeof ECOLI_CORE_REFERENCE {
  if (id !== ECOLI_CORE_REFERENCE.id) throw new Error(`Unknown host-model reference: ${id}`);
  return ECOLI_CORE_REFERENCE;
}

/** Accept only the original UTF-8 bytes; a renamed or edited network cannot inherit this identity. */
export async function importHostMetabolismReference(content: string, id: string = ECOLI_CORE_REFERENCE.id): Promise<HostModelInput> {
  const reference = getHostMetabolismReference(id);
  if (typeof content !== 'string') throw new Error('Reference input must be UTF-8 JSON text.');
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > HOST_FLUX_LIMITS.bytes) throw new Error('Reference model exceeds the 2 MiB limit.');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== reference.sha256) {
    throw new Error(`Reference checksum mismatch for ${id}. Do not relabel changed files as the published model; use the ordinary model importer with explicit provenance.`);
  }
  return validateHostModelInput({
    format: 'phage-explorer-host-model', version: 1,
    source: {
      kind: 'reference', name: reference.name, version: `${reference.version}; sha256:${reference.sha256}`,
      organism: 'Escherichia coli', strain: 'K-12 substr. MG1655', accession: 'NC_000913.3',
      reference: `${reference.publication}; ${reference.url}; raw UTF-8 SHA-256 ${reference.sha256}`,
      license: reference.license, fluxUnits: 'mmol gDW^-1 h^-1', objectiveUnits: 'h^-1 (model biomass objective)',
    },
    medium: {
      name: 'Published aerobic glucose exchange bounds',
      reference: 'Unchanged source reaction bounds, including exchange and ATP-maintenance bounds. This is a model condition, not a measured medium or infected-host calibration.',
      bounds: [],
    },
    cobra: JSON.parse(content),
  });
}

/** Only this explicit operation accesses the network. No local model or sequence is sent. */
export async function fetchHostMetabolismReference(id: string = ECOLI_CORE_REFERENCE.id, options: {
  signal?: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
} = {}): Promise<HostModelInput> {
  const reference = getHostMetabolismReference(id);
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new DOMException('Reference download cancelled.', 'AbortError'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('Reference download timed out.', 'TimeoutError')), 30_000);
  const signal = controller.signal;
  try {
    signal.throwIfAborted();
    const response = await (options.fetcher ?? globalThis.fetch)(reference.url, {
      signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Published host-model download failed (HTTP ${response.status}). Import a previously saved dataset to work offline.`);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > HOST_FLUX_LIMITS.bytes)) {
      await response.body?.cancel();
      throw new Error('Reference model exceeds the 2 MiB limit or has an invalid content length.');
    }
    if (!response.body) throw new Error('Reference download has no readable body.');
    const reader = response.body.getReader();
    const abortRead = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abortRead, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > HOST_FLUX_LIMITS.bytes) {
          await reader.cancel();
          throw new Error('Reference model exceeds the 2 MiB limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener('abort', abortRead);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input = await importHostMetabolismReference(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), id);
    signal.throwIfAborted();
    return input;
  } catch (cause) {
    signal.throwIfAborted();
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
