import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// Vite 8's import-analysis incorrectly rewrites the `import(data, merge)` class
// method in graphology's Graph class as a dynamic import(), wrapping the first
// argument in __vite__injectQuery and breaking the syntax. This plugin
// intercepts the dev-server response for pre-bundled graphology and strips
// the bad transform so the browser receives valid JavaScript.
function fixGraphologyImportMethod() {
  return {
    name: "fix-graphology-import-method",
    configureServer(server: any) {
      server.middlewares.use(
        (req: any, res: any, next: any) => {
          const url: string = req.url ?? ""
          // Only intercept the exact graphology.js pre-bundle (not
          // graphology-communities-louvain, graphology-layout-forceatlas2, etc.)
          const file = url.split("/").pop()?.split("?")[0] ?? ""
          if (file !== "graphology.js") return next()
          try {
            const depsDir = path.resolve(__dirname, "node_modules/.vite/deps")
            const filePath = path.join(depsDir, file)
            const content = readFileSync(filePath, "utf-8")
            const fixed = content.replace(
              /import\(__vite__injectQuery\(data, 'import'\)/g,
              "import(data",
            )
            res.setHeader("Content-Type", "application/javascript")
            res.setHeader("Cache-Control", "no-cache")
            res.end(fixed)
          } catch {
            next()
          }
        },
      )
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), fixGraphologyImportMethod()],

  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
  },

  optimizeDeps: {
    include: [
      "graphology",
      "graphology-layout-forceatlas2",
      "graphology-communities-louvain",
      "sigma",
      "@react-sigma/core",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
  },
}))
