/** Bound response bytes before decoding/parsing. Provider responses are untrusted input. */
export class ProviderResponseError extends Error {
  readonly code: 'invalid' | 'too_large';

  constructor(code: 'invalid' | 'too_large') {
    super(code === 'too_large' ? 'Provider response exceeded its size limit.' : 'Provider response was not valid JSON.');
    this.name = 'ProviderResponseError';
    this.code = code;
  }
}

export function discardProviderBody(response: Response): void {
  // Cancellation must not delay the caller, including implementations with a stalled body.
  void response.body?.cancel().catch(() => {});
}

export async function readBoundedJson(
  response: Response,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 65_536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ProviderResponseError('invalid');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    discardProviderBody(response);
    throw new ProviderResponseError('too_large');
  }
  if (!response.body) throw new ProviderResponseError('invalid');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    options.signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ProviderResponseError('too_large');
      if (value.byteLength) chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ProviderResponseError('invalid'); }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
