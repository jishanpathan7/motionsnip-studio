// Rebuilds the landing page's animated hero into site/hero/dist/ (committed,
// so Vercel needs no install). The scene is built with the Stageshow kit
// (MIT, github.com/benjitaylor/stageshow); this copies the kit beside the
// scene and borrows React, Vite and the React plugin from the Stageshow folder.
//   STAGESHOW=~/.claude/skills/stageshow node site/hero/build.mjs
import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SK = process.env.STAGESHOW || path.join(process.env.HOME, '.claude/skills/stageshow')
const nm = (p) => path.join(SK, 'node_modules', p)
const load = async (p) => import(pathToFileURL(nm(p)).href)

rmSync(path.join(HERE, 'src/kit'), { recursive: true, force: true })
cpSync(path.join(SK, 'kit'), path.join(HERE, 'src/kit'), { recursive: true })

const { build } = await load('vite/dist/node/index.js')
const react = (await load('@vitejs/plugin-react/dist/index.js')).default

await build({
  configFile: false,
  root: HERE,
  logLevel: 'warn',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: nm('react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: nm('react/jsx-dev-runtime.js') },
      { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
      { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
      { find: /^lucide-react$/, replacement: nm('lucide-react/dist/esm/lucide-react.js') },
    ],
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    cssMinify: true,
    outDir: path.join(HERE, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: path.join(HERE, 'src/main.tsx'), formats: ['iife'], name: 'MotionSnipHero', fileName: () => 'hero.js', cssFileName: 'hero' },
    rollupOptions: { output: { assetFileNames: 'hero[extname]', banner: '/*! MotionSnip Studio hero. Built with the stageshow kit, MIT License, Copyright (c) 2026 Benji Taylor. */' } },
  },
})
console.log('Built site/hero/dist/hero.js')
