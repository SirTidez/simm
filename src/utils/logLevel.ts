export type EffectiveLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/**
 * Level of a log line: the parsed level when MelonLoader wrote one, otherwise
 * informational. Message text is not a severity signal. Shared by the Logs
 * view and the Logs tab badge so both count the same errors.
 */
export function getEffectiveLevel(line: { level: string | null; content: string }): EffectiveLevel {
  const normalizedLevel = line.level?.toUpperCase();

  if (normalizedLevel === 'ERROR' || normalizedLevel === 'FATAL') return 'ERROR';
  if (normalizedLevel === 'WARN' || normalizedLevel === 'WARNING') return 'WARN';
  if (normalizedLevel === 'DEBUG' || normalizedLevel === 'TRACE') return 'DEBUG';
  if (normalizedLevel === 'INFO') return 'INFO';

  return 'INFO';
}
