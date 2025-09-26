import { useCallback, useEffect, useRef, useState } from 'react'
import { HandTracker, type HandKeypoints } from '../lib/handTracker'

interface CameraViewProps {
  onCapture: (blobUrl: string) => void
}

const processingConstraints: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
}

// v3: no twitch trigger; capture occurs when opposing tips meet
// Tunables for contact sensitivity (normalized coords)
const CONTACT_SCALE = 0.18 // scales with average hand span
const CONTACT_MIN = 0.005   // lower bound on threshold (allow smaller hands)
const CONTACT_MAX = 0.05   // upper bound on threshold
const CONTACT_HOLD_MS = 150 // require sustained contact for this long
const CONTACT_RELEASE_MULT = 1.4 // hysteresis: release when > threshold * this
const MIN_TIME_BETWEEN_CAPTURES_MS = 400

// Adaptive sensitivity (device + jitter)
const CONTACT_MOBILE_BOOST = 3.5
const JITTER_EMA_ALPHA = 0.35
const JITTER_GAIN = 2


type Point = { x: number; y: number }

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

// (helpers above retained minimal for v3)

export default function CameraViewV3({ onCapture }: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState('Initializing camera...')
  const trackerRef = useRef<HandTracker | null>(null)
  const rafRef = useRef<number | null>(null)
  const shutterAudioRef = useRef<HTMLAudioElement | null>(null)

  // Capture control
  const capturingRef = useRef(false)
  const lastCaptureAtRef = useRef(0)
  const contactSinceRef = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)

  // Environment + jitter
  const coarseInputRef = useRef(false)
  const jitterEmaRef = useRef(0)
  const prevTipsRef = useRef<{ Li?: Point; Lt?: Point; Ri?: Point; Rt?: Point }>({})

  const startStream = useCallback(async () => {
    try {
      setStatus('Requesting camera...')
      const stream = await navigator.mediaDevices.getUserMedia(processingConstraints)
      const video = videoRef.current!
      video.srcObject = stream
      await video.play()
      setStatus('Camera ready')

      if (!trackerRef.current) {
        trackerRef.current = new HandTracker()
        await trackerRef.current.initialize()
      }
      setStatus('Hands up! 🙌')
      loop()
    } catch (err) {
      console.error(err)
      setStatus('Camera permission denied or unavailable')
    }
  }, [])

  const drawOverlay = useCallback((hands: HandKeypoints[], highlightPairs?: { a: Point; b: Point }[]) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const dpr = 1 // lock DPR for stability/perf
    canvas.width = Math.floor(video.clientWidth * dpr)
    canvas.height = Math.floor(video.clientHeight * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Draw per-hand smooth frame path: 8→7→6→5→2→3→4
    const w = canvas.width
    const h = canvas.height
    const tipRadius = 6 * dpr
    ctx.lineWidth = 4 * dpr
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.setLineDash([])
    ctx.strokeStyle = '#22c55e'
    ctx.fillStyle = '#22c55e'

    hands.forEach((hand) => {
      const lm = hand.landmarks
      const indices = [8, 7, 6, 5, 2, 3, 4]
      const hasAll = indices.every((i) => !!lm[i])
      if (!hasAll) return
      const pts = indices.map((i) => ({ x: lm[i]!.x * w, y: lm[i]!.y * h }))
      if (pts.length < 2) return

      // Smooth path using quadratic mid-point technique
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length - 1; i++) {
        const c = pts[i]
        const n = pts[i + 1]
        const mx = (c.x + n.x) / 2
        const my = (c.y + n.y) / 2
        ctx.quadraticCurveTo(c.x, c.y, mx, my)
      }
      // Last segment to final point
      const penultimate = pts[pts.length - 2]
      const last = pts[pts.length - 1]
      ctx.quadraticCurveTo(penultimate.x, penultimate.y, last.x, last.y)
      ctx.stroke()

      // Draw only index fingertip (8) and thumb tip (4)
      const indexTip = lm[8]
      const thumbTip = lm[4]
      if (indexTip) {
        ctx.beginPath()
        ctx.arc(indexTip.x * w, indexTip.y * h, tipRadius, 0, Math.PI * 2)
        ctx.fill()
      }
      if (thumbTip) {
        ctx.beginPath()
        ctx.arc(thumbTip.x * w, thumbTip.y * h, tipRadius, 0, Math.PI * 2)
        ctx.fill()
      }
    })

    // Optional glow on connected pairs
    if (highlightPairs && highlightPairs.length > 0) {
      ctx.save()
      ctx.shadowBlur = 14 * dpr
      ctx.shadowColor = 'rgba(255,255,255,0.9)'
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      const glowR = tipRadius * 1.35
      highlightPairs.forEach(({ a, b }) => {
        ctx.beginPath()
        ctx.arc(a.x * w, a.y * h, glowR, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(b.x * w, b.y * h, glowR, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.restore()
    }
  }, [])

  const triggerFlashAndHaptic = useCallback(() => {
    setFlash(true)
    setTimeout(() => setFlash(false), 120)
    if ('vibrate' in navigator) {
      try { navigator.vibrate(100) } catch {}
    }
    // Play shutter sound if available
    try {
      const audio = shutterAudioRef.current
      if (audio) {
        audio.currentTime = 0
        void audio.play()
      }
    } catch {}
  }, [])

  const captureArbitraryPolygon = useCallback(async (normPoints: { x: number; y: number }[]) => {
    const video = videoRef.current
    if (!video || normPoints.length < 3) return

    const sourceW = video.videoWidth
    const sourceH = video.videoHeight

    const xs = normPoints.map((p) => p.x)
    const ys = normPoints.map((p) => p.y)
    const left = Math.max(0, Math.floor(Math.min(...xs) * sourceW))
    const right = Math.min(sourceW, Math.ceil(Math.max(...xs) * sourceW))
    const top = Math.max(0, Math.floor(Math.min(...ys) * sourceH))
    const bottom = Math.min(sourceH, Math.ceil(Math.max(...ys) * sourceH))
    const sw = Math.max(1, right - left)
    const sh = Math.max(1, bottom - top)

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, sw, sh)

    const pts = normPoints.map((p) => ({ x: p.x * sourceW - left, y: p.y * sourceH - top }))
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(video, left, top, sw, sh, 0, 0, sw, sh)
    ctx.restore()

    await new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) return resolve()
        const url = URL.createObjectURL(blob)
        onCapture(url)
        resolve()
      }, 'image/png')
    })
  }, [onCapture])

  const loop = useCallback(async () => {
    const video = videoRef.current
    const tracker = trackerRef.current
    if (!video || !tracker) return

    const tick = async () => {
      try {
        if (tracker.isReady()) {
          const hands = await tracker.detectHands(video)

          // Consider only hands that have both index fingertip (8) and thumb tip (4) for geometry
          const validHands = hands.filter((h) => !!h.landmarks[8] && !!h.landmarks[4])
          const detectedCount = hands.length

          let statusMsg = ''

          // Always redraw overlay to ensure clearing when hands disappear
          drawOverlay(validHands)

          if (detectedCount === 0) {
            statusMsg = 'Hands up! 🙌'
            contactSinceRef.current = null
          } else if (detectedCount === 1) {
            statusMsg = 'Other hand up as well'
            contactSinceRef.current = null
          } else if (detectedCount >= 2) {
            // Default message for two or more hands
            statusMsg = 'Touch tips to capture 🫶'
            
            if (validHands.length >= 2) {
              // Determine visual left/right by index x
              const cands = [validHands[0], validHands[1]]
                .map((h) => ({ hand: h, i: h.landmarks[8], t: h.landmarks[4] }))
                .filter((x) => x.i && x.t)
              if (cands.length === 2) {
                const sorted = cands.sort((a, b) => a.i!.x - b.i!.x)
                const L = sorted[0].hand
                const R = sorted[1].hand
                const Li = L.landmarks[8]!
                const Lt = L.landmarks[4]!
                const Ri = R.landmarks[8]!
                const Rt = R.landmarks[4]!

                const minSpan = 0.05
                const spanL = distance(Li, Lt)
                const spanR = distance(Ri, Rt)
                const handsValid = spanL > minSpan && spanR > minSpan

                // Dynamic threshold based on hand size (+ jitter + device)
                const avgSpan = (spanL + spanR) / 2

                // Estimate per-frame landmark jitter (EMA on tip deltas)
                {
                  const prev = prevTipsRef.current
                  let sum = 0, n = 0
                  const add = (p?: Point, q?: Point) => { if (p && q) { sum += distance(p, q); n++ } }
                  add(Li, prev.Li); add(Lt, prev.Lt); add(Ri, prev.Ri); add(Rt, prev.Rt)
                  const frameJitter = n ? (sum / n) : 0
                  jitterEmaRef.current = jitterEmaRef.current + (frameJitter - jitterEmaRef.current) * JITTER_EMA_ALPHA
                  prevTipsRef.current = { Li, Lt, Ri, Rt }
                }
                const deviceBoost = coarseInputRef.current ? CONTACT_MOBILE_BOOST : 1
                const base = avgSpan * CONTACT_SCALE * deviceBoost
                const contactThresh = clamp(base + jitterEmaRef.current * JITTER_GAIN, CONTACT_MIN, CONTACT_MAX)
                const releaseThresh = contactThresh * CONTACT_RELEASE_MULT

                const dIndex_same = distance(Li, Ri)
                const dThumb_same = distance(Lt, Rt)
                const dIndex_cross = distance(Li, Rt)
                const dThumb_cross = distance(Lt, Ri)

                const indexClose = dIndex_same < contactThresh
                const thumbClose = dThumb_same < contactThresh
                const sameOk = indexClose && thumbClose
                const crossOk = dIndex_cross < contactThresh && dThumb_cross < contactThresh

                // On phones/tablets allow single-pair contact (either top or bottom)
                // Desktop keeps stricter "both pairs" requirement
                const singleOkMobile = coarseInputRef.current && (indexClose || thumbClose)

                // Build glow list for any individual connected pair(s)
                const glowPairs: { a: Point; b: Point }[] = []
                if (dIndex_same < contactThresh) glowPairs.push({ a: Li, b: Ri })
                if (dThumb_same < contactThresh) glowPairs.push({ a: Lt, b: Rt })
                if (dIndex_cross < contactThresh) glowPairs.push({ a: Li, b: Rt })
                if (dThumb_cross < contactThresh) glowPairs.push({ a: Lt, b: Ri })

                const now = performance.now()
                const touchingNow = handsValid && (sameOk || crossOk || singleOkMobile)

                // Hysteresis: if not touching within tighter threshold, reset when well apart
                if (!touchingNow) {
                  const apartEnough = dIndex_same > releaseThresh || dThumb_same > releaseThresh || dIndex_cross > releaseThresh || dThumb_cross > releaseThresh
                  if (apartEnough) contactSinceRef.current = null
                }

                if (glowPairs.length > 0) {
                  // draw with glow for any successful pair
                  drawOverlay(validHands, glowPairs)
                }

                if (touchingNow) {
                  if (contactSinceRef.current == null) contactSinceRef.current = now
                  const holdMs = coarseInputRef.current ? (CONTACT_HOLD_MS + 20) : CONTACT_HOLD_MS
                  const heldLongEnough = now - contactSinceRef.current >= holdMs
                  if (heldLongEnough) {
                    const seq = [8, 7, 6, 5, 2, 3, 4]
                    const Lpts = seq.map((i) => ({ x: L.landmarks[i]!.x, y: L.landmarks[i]!.y }))
                    const Rpts = seq.map((i) => ({ x: R.landmarks[i]!.x, y: R.landmarks[i]!.y }))
                    const polygon = sameOk ? [...Lpts, ...Rpts.slice().reverse()] : [...Lpts, ...Rpts]

                    if (!capturingRef.current && now - lastCaptureAtRef.current > MIN_TIME_BETWEEN_CAPTURES_MS) {
                      capturingRef.current = true
                      lastCaptureAtRef.current = now
                      triggerFlashAndHaptic()
                      await captureArbitraryPolygon(polygon)
                      capturingRef.current = false
                      contactSinceRef.current = null
                    }
                  }
                }
              }
            }
          }

          if (statusMsg) setStatus(statusMsg)
        }
      } catch (e) {
        // Avoid crashing the loop
      } finally {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [drawOverlay, triggerFlashAndHaptic, captureArbitraryPolygon])

  useEffect(() => {
    // Preload shutter sound
    try {
      const audio = new Audio('/shutter_snap.mp3')
      audio.preload = 'auto'
      audio.volume = 1
      shutterAudioRef.current = audio
    } catch {}

    startStream()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      const stream = videoRef.current?.srcObject as MediaStream | null
      stream?.getTracks().forEach((t) => t.stop())
      // Free mediapipe resources
      try { trackerRef.current?.close?.() } catch {}
    }
  }, [startStream])

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
        autoPlay
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />

      {flash && (
        <div className="absolute inset-0 bg-white/80 pointer-events-none" />
      )}

      <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-6">
        <div className="px-4 py-2 rounded-lg bg-black/80 text-white text-base md:text-lg shadow-lg">
          {status}
        </div>
      </div>
    </div>
  )
}



