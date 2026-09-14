import { AsyncLocalStorage } from 'node:async_hooks';

// One async provider invocation can issue several HTTP requests after long
// waits. Re-check the channel for every new request, including retries.
const authorization = new AsyncLocalStorage<() => Promise<unknown>>();

export function withProviderAuthorization<T>(check: () => Promise<unknown>, action: () => Promise<T>): Promise<T> {
  return authorization.run(check, async () => { await check(); return action(); });
}

export const providerFetch: typeof globalThis.fetch = async (input, init) => {
  await authorization.getStore()?.();
  return globalThis.fetch(input, init);
};
