import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

(globalThis as any).__APP_VERSION__ = 'test';
