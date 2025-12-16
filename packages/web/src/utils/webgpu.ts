export type WebGPUSupport =
  | { supported: false; reason: string }
  | {
      supported: true;
      adapterInfo: {
        name?: string;
        vendor?: string;
        architecture?: string;
        description?: string;
      };
    };

/**
 * Detects WebGPU support and retrieves basic adapter info when available.
 * No side effects beyond a single requestAdapter call.
 */
export async function detectWebGPU(): Promise<WebGPUSupport> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { supported: false, reason: 'WebGPU not available in navigator.gpu' };
  }

  try {
    const adapter = await (navigator as unknown as { gpu: GPU }).gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, reason: 'No GPU adapter found' };
    }

    // getInfo() may not be in all type definitions yet
    const adapterWithInfo = adapter as GPUAdapter & { getInfo?: () => Record<string, string | undefined> };
    const info = adapterWithInfo.getInfo?.() ?? {};
    const { name, vendor, architecture, description } = info as {
      name?: string; vendor?: string; architecture?: string; description?: string
    };
    return {
      supported: true,
      adapterInfo: { name, vendor, architecture, description },
    };
  } catch (error) {
    return { supported: false, reason: `Detection failed: ${String(error)}` };
  }
}

