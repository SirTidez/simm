/// <reference types="vite/client" />
/// <reference types="vitest/globals" />
/// <reference types="@testing-library/jest-dom" />

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '@tauri-apps/plugin-deep-link' {
  export function getCurrent(): Promise<string[] | null>;
  export function onOpenUrl(
    handler: (urls: string[]) => void
  ): Promise<() => void>;
}
