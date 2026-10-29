import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const workerOrigin = process.env.MONO_WORKER_ORIGIN || 'http://127.0.0.1:8787'
const sourceRoot = fileURLToPath(new URL('./', import.meta.url)).replaceAll('\\', '/')

// Development pages follow the Worker's access rules.
function privatePanelRoutes(): Plugin {
  return {
    name: 'private-panel-routes',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const rawPath = (request.url || '/').split(/[?#]/, 1)[0]
        if (!rawPath.startsWith('/') || /[%\\]/.test(rawPath) || /\/(?:\.|\.\.)(?:\/|$)/.test(rawPath)) {
          response.statusCode = 404; response.setHeader('Cache-Control', 'no-store'); response.end(); return
        }
        const path = new URL(request.url || '/', workerOrigin).pathname
        const publicModules = ['main', 'auth-views', 'public-sharing', 'common-components', 'public-api', 'theme', 'format', 'share-link', 'styles']
        const protectedSource = /^\/api\/panel-assets\/dev\/(src|shared)\/([a-zA-Z0-9_-]+\.(?:ts|tsx))$/.exec(path)
        if (path === '/api/panel' || path === '/api/panel-assets/console-development.js' || protectedSource) {
          try {
            const credentials = new Headers()
            if (request.headers.cookie) credentials.set('Cookie', request.headers.cookie)
            if (typeof request.headers.authorization === 'string') credentials.set('Authorization', request.headers.authorization)
            const gate = await fetch(new URL('/api/panel', workerOrigin), { headers: credentials })
            response.setHeader('Cache-Control', 'private, no-store')
            if (!gate.ok) { response.statusCode = gate.status; response.setHeader('Content-Type', 'application/json'); response.end(await gate.text()); return }
            if (path === '/api/panel') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ entry: '/api/panel-assets/console-development.js' })); return }
            const source = protectedSource ? `/${protectedSource[1]}/${protectedSource[2]}` : '/src/console-entry.tsx'
            const transformed = await server.transformRequest(source)
            if (!transformed) { response.statusCode = 404; response.end(); return }
            const code = transformed.code.replace(/(["'])\/(src|shared)\/([a-zA-Z0-9_-]+\.(?:ts|tsx))/g, (whole, quote: string, folder: string, file: string) => {
              if (folder === 'src' && publicModules.some(name => file === `${name}.ts` || file === `${name}.tsx`)) return whole
              return `${quote}/api/panel-assets/dev/${folder}/${file}`
            })
            response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
            response.end(code)
          } catch { response.statusCode = 503; response.end('Local storage service unavailable.') }
          return
        }
        if (path === '/mcp' || path.startsWith('/api/') || path.startsWith('/s/') && path.endsWith('/file')) return next()
        if (!['GET', 'HEAD'].includes(request.method || '')) { response.statusCode = 404; response.end(); return }
        if (path.toLowerCase().startsWith('/src/') && !path.startsWith('/src/') || path.toLowerCase().startsWith('/shared/')) { response.statusCode = 404; response.end(); return }
        if (path.startsWith('/@fs/')) { response.statusCode = 404; response.end(); return }
        if (path.startsWith('/src/') && !publicModules.some(name => path === `/src/${name}.tsx` || path === `/src/${name}.ts` || path === `/src/${name}.css`)) {
          response.statusCode = 404; response.end(); return
        }
        if (['/@vite/', '/@react-refresh', '/src/', '/node_modules/', '/@fs/'].some(prefix => path.startsWith(prefix)) || path === '/favicon.svg' || path.startsWith('/assets/')) return next()
        if (!['GET', 'HEAD'].includes(request.method || '')) return next()
        try {
          const gate = await fetch(new URL(path, workerOrigin), { method: 'HEAD', redirect: 'manual' })
          if (gate.status === 200) {
            request.url = `/index.html${new URL(request.url || '/', workerOrigin).search}`
            return next()
          }
          const result = await fetch(new URL(path, workerOrigin), { redirect: 'manual' })
          response.statusCode = result.status
          response.setHeader('Content-Type', result.headers.get('Content-Type') || 'text/plain; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          response.end(request.method === 'HEAD' ? undefined : await result.text())
        } catch {
          response.statusCode = 503
          response.end('Local storage service unavailable.')
        }
      })
    },
  }
}

export default defineConfig({
  appType: 'mpa',
  plugins: [privatePanelRoutes(), react(), {
    name: 'private-panel-manifest',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry && item.name === 'console')
      if (!entry || entry.type !== 'chunk') throw new Error('Missing console entry')
      this.emitFile({ type: 'asset', fileName: 'api/panel-assets/manifest.json', source: JSON.stringify({ entry: `/${entry.fileName}` }) })
    },
  }],
  build: {
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), console: fileURLToPath(new URL('./src/console-entry.tsx', import.meta.url)) },
      output: {
        onlyExplicitManualChunks: true,
        entryFileNames: chunk => chunk.name === 'console' ? 'api/panel-assets/console-[hash].js' : 'assets/[name]-[hash].js',
        chunkFileNames: chunk => chunk.name === 'console-private' ? 'api/panel-assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/')
          if (normalized.includes('/node_modules/')) return 'vendor'
          if (!normalized.startsWith(sourceRoot) || !/\/(?:src|shared)\//.test(normalized)) return
          const publicModules = ['main', 'auth-views', 'public-sharing', 'common-components', 'public-api', 'theme', 'format', 'share-link', 'styles']
          if (!publicModules.some(name => normalized.endsWith(`/src/${name}.tsx`) || normalized.endsWith(`/src/${name}.ts`) || normalized.endsWith(`/src/${name}.css`)) && !normalized.endsWith('/src/console-entry.tsx')) return 'console-private'
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': workerOrigin, '^/mcp$': workerOrigin, '^/s/[^/]+/file': workerOrigin },
  },
})
