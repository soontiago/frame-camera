import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const wasmSrcDir = path.join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmDstDir = path.join(projectRoot, 'public', 'mediapipe', 'wasm')
const modelDstDir = path.join(projectRoot, 'public', 'mediapipe', 'models')

const WASM_FILES = [
  'vision_wasm_internal.wasm',
  'vision_wasm_internal.js',
  'vision_wasm_internal.worker.js',
]

const MODEL_FILENAME = 'hand_landmarker.task'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function fileExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyWasmFiles() {
  await ensureDir(wasmDstDir)
  for (const file of WASM_FILES) {
    const src = path.join(wasmSrcDir, file)
    const dst = path.join(wasmDstDir, file)
    if (!(await fileExists(src))) continue
    try {
      await fs.copyFile(src, dst)
      // eslint-disable-next-line no-empty
    } catch {}
  }
}

async function ensureModel() {
  await ensureDir(modelDstDir)
  const dst = path.join(modelDstDir, MODEL_FILENAME)
  if (await fileExists(dst)) return
  try {
    const res = await fetch(MODEL_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(dst, buf)
    // eslint-disable-next-line no-empty
  } catch {}
}

async function main() {
  await copyWasmFiles()
  await ensureModel()
}

main().catch(() => {
  // non-fatal in dev/build environments
})
