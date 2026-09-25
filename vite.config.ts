import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// En `npm run dev` sirve api/agente.ts igual que Vercel, leyendo LLM_* de .env.local
function apiAgente(): Plugin {
  return {
    name: 'api-agente',
    configureServer(server) {
      server.middlewares.use('/api/agente', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const partes: Buffer[] = []
        for await (const parte of req) partes.push(parte as Buffer)
        const { POST } = (await server.ssrLoadModule('/api/agente.ts')) as { POST: (r: Request) => Promise<Response> }
        const r = await POST(new Request('http://localhost/api/agente', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(partes).toString('utf8'),
        }))
        res.statusCode = r.status
        res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json')
        res.end(await r.text())
      })
    },
  }
}

// `npm run build`       → carpeta dist/ normal (Vercel)
// `npm run build:demo`  → un solo index.html autocontenido (para compartir la demo)
export default defineConfig(({ mode }) => {
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), 'LLM_'))) process.env[k] ??= v
  return {
    plugins: mode === 'demo' ? [react(), viteSingleFile()] : [react(), apiAgente()],
    build: mode === 'demo' ? { outDir: 'dist-demo' } : {},
    test: { include: ['src/**/*.test.ts'] },
  }
})
