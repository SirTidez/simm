export type EffectiveLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/**
 * Level of a log line: the parsed level when MelonLoader wrote one, otherwise
 * inferred from the text. Shared by the Logs view and the Logs tab badge so
 * both count the same errors.
 */
export function getEffectiveLevel(line: { level: string | null; content: string }): EffectiveLevel {
  const normalizedLevel = line.level?.toUpperCase();

  if (normalizedLevel === 'ERROR' || normalizedLevel === 'FATAL') return 'ERROR';
  if (normalizedLevel === 'WARN' || normalizedLevel === 'WARNING') return 'WARN';
  if (normalizedLevel === 'DEBUG' || normalizedLevel === 'TRACE') return 'DEBUG';
  if (normalizedLevel === 'INFO') return 'INFO';

  const sourceText = line.content.toLowerCase();

  if (/\b(error|fatal|exception|failed|failure)\b/.test(sourceText)) return 'ERROR';
  if (/\bwarn(ing)?\b/.test(sourceText)) return 'WARN';
  if (/\bdebug\b|\btrace\b/.test(sourceText)) return 'DEBUG';
  return 'INFO';
}
