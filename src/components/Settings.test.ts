import { describe, expect, it } from 'vitest';
import { normalizeModIconCacheLimitMb } from './Settings';

describe('normalizeModIconCacheLimitMb', () => {
  it('clamps below the minimum', () => {
    expect(normalizeModIconCacheLimitMb(0)).toBe(100);
    expect(normalizeModIconCacheLimitMb('99')).toBe(100);
  });

  it('clamps above the maximum', () => {
    expect(normalizeModIconCacheLimitMb(9000)).toBe(8192);
    expect(normalizeModIconCacheLimitMb('100000')).toBe(8192);
  });

  it('returns integer value inside bounds', () => {
    expect(normalizeModIconCacheLimitMb(512.9)).toBe(512);
    expect(normalizeModIconCacheLimitMb('2048')).toBe(2048);
  });

  it('falls back to default when value is not numeric', () => {
    expect(normalizeModIconCacheLimitMb(undefined)).toBe(500);
    expect(normalizeModIconCacheLimitMb('invalid')).toBe(500);
  });
});
