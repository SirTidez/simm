import { describe, expect, it } from 'vitest';
import { getEffectiveLevel } from './logLevel';

describe('MelonLoader display severity', () => {
  it.each([
    ['ERROR', 'ERROR'], ['FATAL', 'ERROR'], ['WARN', 'WARN'], ['WARNING', 'WARN'],
    ['INFO', 'INFO'], ['DEBUG', 'DEBUG'], ['TRACE', 'DEBUG'],
  ] as const)('preserves parsed %s severity', (level, expected) => {
    expect(getEffectiveLevel({ level, content: 'A message' })).toBe(expected);
  });

  it('keeps incidental error and warning words informational without a parsed severity', () => {
    expect(getEffectiveLevel({ level: null, content: 'Warning counts reset; failed interop cache rebuilt without errors.' })).toBe('INFO');
    expect(getEffectiveLevel({ level: 'INFO', content: 'No exception occurred.' })).toBe('INFO');
  });
});
