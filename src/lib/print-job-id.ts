let sequence = 0;

/** Identifies print jobs for deduplication; never use as a session or security token. */
export function createPrintJobId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID();

  // LAN HTTP pages may expose getRandomValues without the secure-context UUID API.
  sequence += 1;
  const entropy = typeof browserCrypto?.getRandomValues === 'function'
    ? Array.from(browserCrypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join('-')
    : Math.random().toString(36).slice(2);
  return `print-${Date.now().toString(36)}-${sequence.toString(36)}-${entropy}`;
}
