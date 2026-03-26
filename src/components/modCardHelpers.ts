import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

export function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveImageSource(pathOrUrl?: string): string | undefined {
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  if (!pathOrUrl) {
    return undefined;
  }
  if (pathOrUrl.startsWith('asset:')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('file://')) {
    try {
      const url = new URL(pathOrUrl);
      let filePath = safeDecode(url.pathname || '');
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return convertFileSrc(filePath);
    } catch {
      const fallback = pathOrUrl.replace(/^file:\/\/+/, '');
      return convertFileSrc(safeDecode(fallback));
    }
  }
  const normalized = pathOrUrl.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return convertFileSrc(pathOrUrl);
  }
  if (normalized.startsWith('/')) {
    return convertFileSrc(pathOrUrl);
  }
  return normalized;
}

export function handleCardActivationKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onActivate: () => void
): void {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (
    event.key === 'Enter'
    || event.key === ' '
    || event.key === 'Space'
    || event.key === 'Spacebar'
    || event.code === 'Space'
  ) {
    event.preventDefault();
    onActivate();
  }
}
