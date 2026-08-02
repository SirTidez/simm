/**
 * Compile-time flags shared by the desktop shell. The telemetry flag is
 * deliberately off unless the Tauri process is launched with
 * `SIMM_ENABLE_TELEMETRY=1` (or `true`).
 */
export const telemetryFeatureEnabled =
  typeof __SIMM_TELEMETRY_ENABLED__ !== 'undefined' && __SIMM_TELEMETRY_ENABLED__;
