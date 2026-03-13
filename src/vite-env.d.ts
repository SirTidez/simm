/// <reference types="vite/client" />

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
