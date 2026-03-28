import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

declare const process: {
  env: Record<string, string | undefined>;
};

process.env.TZ = 'UTC';

expect.extend(matchers);

(globalThis as any).__APP_VERSION__ = 'test';
