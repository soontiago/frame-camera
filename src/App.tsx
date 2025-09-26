import React, { Suspense, useEffect, useRef, useState } from 'react'
const CameraView = React.lazy(() => import('./components/CameraView'))
const CameraViewV2 = React.lazy(() => import('./components/CameraViewV2'))
const CameraViewV3 = React.lazy(() => import('./components/CameraViewV3'))
import CaptureResult from './components/CaptureResult'
import './index.css'

// Map numeric version -> component (extendable)
const VersionMap: Record<number, React.LazyExoticComponent<React.ComponentType<{ onCapture: (url: string) => void }>>> = {
  1: CameraView,
  2: CameraViewV2,
  3: CameraViewV3,
}

const SUPPORTED_VERSIONS = Object.keys(VersionMap)
  .map((k) => parseInt(k, 10))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b)

const normalizeVersion = (v: number): number =>
  SUPPORTED_VERSIONS.includes(v) ? v : SUPPORTED_VERSIONS[0]

const parseVersionFromPath = (path: string): number => {
  const m = path.match(/\/(\d+)\/?$/)
  if (!m) return 1
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

const stripVersionFromPath = (path: string): string => {
  const stripped = path.replace(/\/(\d+)\/?$/, '')
  return stripped.length === 0 ? '/' : stripped
}

const buildPath = (base: string, v: number): string => {
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base
  return v === 1 ? (cleanBase || '/') : `${cleanBase || ''}/${v}`
}

function App() {
  const [mode, setMode] = useState<'camera' | 'result'>('camera')
  const [version, setVersion] = useState<number>(1)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  // URL <-> version sync (supports adding /2 or /2/)
  const basePathRef = useRef<string>('')

  // On mount, derive base path and initial version from URL
  useEffect(() => {
    const path = window.location.pathname
    const v = parseVersionFromPath(path)
    const nv = normalizeVersion(v)
    setVersion(nv)
    const base = stripVersionFromPath(path)
    basePathRef.current = base
    const desired = buildPath(base, nv)
    if (desired !== path) {
      window.history.replaceState(null, '', desired)
    }
  }, [])

  // Keep URL updated when version changes
  useEffect(() => {
    const base = basePathRef.current || '/'
    const desired = buildPath(base, normalizeVersion(version))
    if (window.location.pathname !== desired) {
      // Push state on user change so back/forward works across versions
      window.history.pushState(null, '', desired)
    }
  }, [version])

  // React to back/forward navigation
  useEffect(() => {
    const onPop = () => {
      const path = window.location.pathname
      setVersion(normalizeVersion(parseVersionFromPath(path)))
      basePathRef.current = stripVersionFromPath(path)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const handleCapture = (url: string) => {
    setImageUrl(url)
    setMode('result')
  }

  const handleRetake = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    setImageUrl(null)
    setMode('camera')
  }

  return (
    <div className="w-screen h-screen">
      {/* Version selector */}
      <div className="fixed top-2 right-2 z-50">
        <select
          value={version}
          onChange={(e) => setVersion(parseInt(e.target.value, 10))}
          className="bg-white/5 text-gray-600 px-2 py-1 rounded-md shadow-xs focus:outline-none focus:ring-1 focus:ring-gray-300"
        >
          {SUPPORTED_VERSIONS.map((v) => (
            <option key={v} value={v}>{`v${v}`}</option>
          ))}
        </select>
      </div>

      {mode === 'camera' && (
        <Suspense fallback={null}>
          {(() => {
            const Selected = VersionMap[version] ?? VersionMap[1]
            return <Selected onCapture={handleCapture} />
          })()}
        </Suspense>
      )}
      {mode === 'result' && imageUrl && (
        <CaptureResult imageUrl={imageUrl} onRetake={handleRetake} />
      )}
      <a
        href="https://soon.work/"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed top-2 left-2 text-md font-semibold text-gray-800 opacity-30 hover:opacity-80 transition-opacity"
      >
        @soontiago
      </a>
    </div>
  )
}

export default App
