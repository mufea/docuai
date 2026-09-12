import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

export const requestContext = {
  run<T>(store: RequestStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
