import { useEffect, useMemo, useState, type RefObject } from 'react';

type WindowedListState = {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
  isWindowed: boolean;
};

type UseWindowedListOptions<T> = {
  items: T[];
  containerRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
  estimatedRowHeight: number;
  overscan?: number;
  minimumItems?: number;
  enabled?: boolean;
};

const DEFAULT_STATE: WindowedListState = {
  startIndex: 0,
  endIndex: 0,
  paddingTop: 0,
  paddingBottom: 0,
  isWindowed: false,
};

function getOffsetTopWithinAncestor(
  element: HTMLElement,
  ancestor: HTMLElement,
): number {
  let offsetTop = 0;
  let current: HTMLElement | null = element;

  while (current && current !== ancestor) {
    offsetTop += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  return offsetTop;
}

export function useWindowedList<T>({
  items,
  containerRef,
  listRef,
  estimatedRowHeight,
  overscan = 6,
  minimumItems = 80,
  enabled = true,
}: UseWindowedListOptions<T>) {
  const [state, setState] = useState<WindowedListState>(() => ({
    ...DEFAULT_STATE,
    endIndex: items.length,
  }));

  useEffect(() => {
    const shouldWindow =
      enabled
      && estimatedRowHeight > 0
      && items.length >= minimumItems;

    const applyFullRange = () => {
      setState((previous) => {
        const nextState = {
          startIndex: 0,
          endIndex: items.length,
          paddingTop: 0,
          paddingBottom: 0,
          isWindowed: false,
        };
        return previous.startIndex === nextState.startIndex
          && previous.endIndex === nextState.endIndex
          && previous.paddingTop === nextState.paddingTop
          && previous.paddingBottom === nextState.paddingBottom
          && previous.isWindowed === nextState.isWindowed
          ? previous
          : nextState;
      });
    };

    if (!shouldWindow) {
      applyFullRange();
      return;
    }

    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list) {
      applyFullRange();
      return;
    }

    let frameId = 0;
    let resizeObserver: ResizeObserver | null = null;

    const recalculate = () => {
      frameId = 0;

      const nextContainer = containerRef.current;
      const nextList = listRef.current;
      if (!nextContainer || !nextList) {
        applyFullRange();
        return;
      }

      const listOffsetTop = getOffsetTopWithinAncestor(nextList, nextContainer);
      const viewportTop = Math.max(0, nextContainer.scrollTop - listOffsetTop);
      const viewportHeight = nextContainer.clientHeight || estimatedRowHeight;
      const visibleCount = Math.ceil(viewportHeight / estimatedRowHeight);
      const startIndex = Math.max(
        0,
        Math.floor(viewportTop / estimatedRowHeight) - overscan,
      );
      const endIndex = Math.min(
        items.length,
        startIndex + visibleCount + overscan * 2,
      );
      const nextState = {
        startIndex,
        endIndex,
        paddingTop: startIndex * estimatedRowHeight,
        paddingBottom: Math.max(0, (items.length - endIndex) * estimatedRowHeight),
        isWindowed: startIndex > 0 || endIndex < items.length,
      };

      setState((previous) => (
        previous.startIndex === nextState.startIndex
        && previous.endIndex === nextState.endIndex
        && previous.paddingTop === nextState.paddingTop
        && previous.paddingBottom === nextState.paddingBottom
        && previous.isWindowed === nextState.isWindowed
      ) ? previous : nextState);
    };

    const requestRecalculate = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(recalculate);
    };

    requestRecalculate();
    container.addEventListener('scroll', requestRecalculate, { passive: true });
    window.addEventListener('resize', requestRecalculate);

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(requestRecalculate);
      resizeObserver.observe(container);
      resizeObserver.observe(list);
    }

    return () => {
      container.removeEventListener('scroll', requestRecalculate);
      window.removeEventListener('resize', requestRecalculate);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
    };
  }, [
    containerRef,
    enabled,
    estimatedRowHeight,
    items.length,
    listRef,
    minimumItems,
    overscan,
  ]);

  const visibleItems = useMemo(
    () => items.slice(state.startIndex, state.endIndex),
    [items, state.endIndex, state.startIndex],
  );

  return {
    ...state,
    visibleItems,
  };
}
