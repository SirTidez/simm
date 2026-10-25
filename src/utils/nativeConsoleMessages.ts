import type { NativeConsoleMessageOrigin, NativeConsoleSourceCounts } from '../types';

export function nativeConsoleOriginKey(origin: NativeConsoleMessageOrigin) {
  return `origin:${JSON.stringify([origin.kind, origin.fileName ?? origin.name])}`;
}

export function nativeConsoleSourceKey(value: { source: string | null; origin: NativeConsoleMessageOrigin | null }) {
  return value.origin && ['Mod', 'Plugin'].includes(value.origin.kind)
    ? nativeConsoleOriginKey(value.origin) : `source:${value.source ?? ''}`;
}

export function nativeConsoleOriginCounts(sources: NativeConsoleSourceCounts[]) {
  const counts = new Map<string, { errors: number; warnings: number }>();
  for (const source of sources) {
    if (!source.origin || !['Mod', 'Plugin'].includes(source.origin.kind)) continue;
    const key = nativeConsoleOriginKey(source.origin);
    const previous = counts.get(key) ?? { errors: 0, warnings: 0 };
    counts.set(key, { errors: previous.errors + source.errors, warnings: previous.warnings + source.warnings });
  }
  return counts;
}
