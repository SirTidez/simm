import reactScan from '@react-scan/vite-plugin-react-scan'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Read package.json to get version
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'))
const tauriPlatform = (
  process.env.TAURI_ENV_PLATFORM ??
  process.env.TAURI_PLATFORM ??
  ''
).toLowerCase()
const isWindowsBuild =
  tauriPlatform === 'windows' || (!tauriPlatform && process.platform === 'win32')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const enableReactScan = env.VITE_REACT_SCAN === 'true' || env.REACT_SCAN === 'true'

  return {
    plugins: [
      react(),
      enableReactScan && reactScan({
        enable: true,
        autoDisplayNames: true,
        scanOptions: {
          enabled: true,
          showToolbar: true,
          trackUnnecessaryRenders: true,
          log: false,
        },
      }),
      tailwindcss(),
    ],
    // Use relative paths for Tauri (must be at root level)
    base: './',
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    // Tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: 'localhost',
      // Tauri requires watch to be set
      watch: {
        // Tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
    // to make use of `TAURI_DEBUG` and other env variables
    // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      // Tauri uses Chromium on Windows and WebKit elsewhere. Vite 8 no longer
      // supports transpiling down to the older Safari 13 target used by the
      // original template, so keep Windows on the WebView2 baseline and use a
      // modern WebKit baseline for non-Windows builds.
      target: isWindowsBuild ? 'chrome105' : 'safari16.4',
      // don't minify for debug builds
      minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
      // produce sourcemaps for debug builds
      sourcemap: !!process.env.TAURI_DEBUG,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/')

            if (!normalizedId.includes('/node_modules/')) {
              return undefined
            }

            if (
              normalizedId.includes('/@base-ui/') ||
              normalizedId.includes('/class-variance-authority/') ||
              normalizedId.includes('/clsx/') ||
              normalizedId.includes('/lucide-react/') ||
              normalizedId.includes('/tailwind-merge/')
            ) {
              return 'vendor-ui'
            }

            return undefined
          },
        },
      },
    },
  }
})
