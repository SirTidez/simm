import { useEffect, type RefObject } from 'react';
import { ApiService } from '../services/api';
import type { NativeConsoleViewport } from '../types';

let lastRevision = 0;
function revision() {
  lastRevision = Math.max(lastRevision + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  return lastRevision;
}

/** The native companion follows this DOM pane; it remains an independent window. */
export function useNativeConsoleViewport(environmentId: string, pane: RefObject<HTMLDivElement | null>, ready: boolean, onError: (error: unknown) => void) {
  useEffect(() => {
    if (!ready || !pane.current) return;
    const element = pane.current;
    let frame = 0;
    let previous = '';
    let disposed = false;
    const send = (viewport: Omit<NativeConsoleViewport, 'revision'>) => {
      void ApiService.updateNativeConsoleViewport(environmentId, { ...viewport, revision: revision() })
        .then(() => { if (!disposed) onError(null); })
        .catch((error: unknown) => { if (!disposed) { previous = ''; onError(error); } });
    };
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const covered = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal-overlay, dialog[open]'))
        .some((modal) => {
          const bounds = modal.getBoundingClientRect();
          return getComputedStyle(modal).visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
            && bounds.left < rect.right && bounds.right > rect.left && bounds.top < rect.bottom && bounds.bottom > rect.top;
        });
      const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
      const width = Math.max(0, Math.min(innerWidth, rect.right) - x);
      const height = Math.max(0, Math.min(innerHeight, rect.bottom) - y);
      const viewport = { x, y, width, height, visible: !document.hidden && !covered && width > 0 && height > 0 };
      const key = JSON.stringify(viewport);
      if (key !== previous) { previous = key; send(viewport); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'data-state'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    // Also follows transforms and CSS transitions which do not resize the pane.
    const timer = setInterval(schedule, 250);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearInterval(timer);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      send({ x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [environmentId, pane, ready, onError]);
}
