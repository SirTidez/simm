export const lastUpdateCheckTimeRef = { current: null as number | null };
export const batchUpdateCheckRef = { current: false };
export const batchUpdateCheckEventName = 'simm:batch-update-check-started';

export function notifyBatchUpdateCheckStarted(environmentIds: string[]) {
  window.dispatchEvent(new CustomEvent(batchUpdateCheckEventName, {
    detail: { environmentIds },
  }));
}
