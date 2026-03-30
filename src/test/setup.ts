import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

declare const process: {
  env: Record<string, string | undefined>;
};

process.env.TZ = 'UTC';

expect.extend(matchers);

(globalThis as any).__APP_VERSION__ = 'test';

const storageState = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return storageState.size;
  },
  clear() {
    storageState.clear();
  },
  getItem(key: string) {
    return storageState.has(key) ? storageState.get(key)! : null;
  },
  key(index: number) {
    return Array.from(storageState.keys())[index] ?? null;
  },
  removeItem(key: string) {
    storageState.delete(String(key));
  },
  setItem(key: string, value: string) {
    storageState.set(String(key), String(value));
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryStorage,
});
