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

// Twitch detection thresholds (normalized coordinates)
const TWITCH_WINDOW_MS = 350
const DOWN_AMP = 0.02
const UP_AMP = 0.02
const INST_DOWN_VEL = 0.01
// Delay after two hands are first detected before shutter twitch can fire
const SHUTTER_ARM_DELAY_MS = 600


type Point = { x: number; y: number }
interface Corners {
  topLeft: Point
  topRight: Point
  bottomRight: Point
  bottomLeft: Point
}

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

function computeDirectorFrame(leftHandInput: HandKeypoints, rightHandInput: HandKeypoints): { valid: boolean; corners?: Corners } {
  // Determine visual left/right by index fingertip x position
  const candidates = [leftHandInput, rightHandInput]
    .map((h) => ({
      hand: h,
      i: h.landmarks[8], // index fingertip
      t: h.landmarks[4], // thumb tip
    }))
    .filter((x) => x.i && x.t)
  if (candidates.length !== 2) return { valid: false }

  const sorted = candidates.sort((a, b) => a.i!.x - b.i!.x)
  const L = sorted[0]
  const R = sorted[1]

  const Li = L.i as Point
  const Lt = L.t as Point
  const Ri = R.i as Point
  const Rt = R.t as Point

  // Build frame by directly connecting tracked dots:
  // left index -> right index -> right thumb -> left thumb
  const minSize = 0.025
  const width = Math.abs(Ri.x - Li.x)
  const topY = Math.min(Li.y, Ri.y)
  const bottomY = Math.max(Lt.y, Rt.y)
  const height = Math.max(0, bottomY - topY)

  const corners: Corners = {
    topLeft: Li,
    topRight: Ri,
    bottomRight: Rt,
    bottomLeft: Lt,
  }
  return { valid: width > minSize && height > minSize, corners }
}

function averageCorners(history: Corners[]): Corners {
  const n = history.length
  const sum = history.reduce((acc, c) => ({
    topLeft: { x: acc.topLeft.x + c.topLeft.x, y: acc.topLeft.y + c.topLeft.y },
    topRight: { x: acc.topRight.x + c.topRight.x, y: acc.topRight.y + c.topRight.y },
    bottomRight: { x: acc.bottomRight.x + c.bottomRight.x, y: acc.bottomRight.y + c.bottomRight.y },
    bottomLeft: { x: acc.bottomLeft.x + c.bottomLeft.x, y: acc.bottomLeft.y + c.bottomLeft.y },
  }), { topLeft: { x: 0, y: 0 }, topRight: { x: 0, y: 0 }, bottomRight: { x: 0, y: 0 }, bottomLeft: { x: 0, y: 0 } })
  return {
    topLeft: { x: sum.topLeft.x / n, y: sum.topLeft.y / n },
    topRight: { x: sum.topRight.x / n, y: sum.topRight.y / n },
    bottomRight: { x: sum.bottomRight.x / n, y: sum.bottomRight.y / n },
    bottomLeft: { x: sum.bottomLeft.x / n, y: sum.bottomLeft.y / n },
  }
}

export default function CameraViewV2({ onCapture }: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState('Initializing camera...')
  const trackerRef = useRef<HandTracker | null>(null)
  const rafRef = useRef<number | null>(null)
  const shutterAudioRef = useRef<HTMLAudioElement | null>(null)

  const cornersHistoryRef = useRef<Corners[]>([])
  const [currentCorners, setCurrentCorners] = useState<Corners | null>(null)
  const [gestureValid, setGestureValid] = useState(false)
  const [gestureStable, setGestureStable] = useState(false)

  // Capture control and twitch detection state
  const capturingRef = useRef(false)
  type TwitchState = { phase: 'idle' | 'down'; startY: number; downY: number; hasDown: boolean; startTime: number }
  const twitchRef = useRef<{ left: TwitchState; right: TwitchState }>({
    left: { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 },
    right: { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 },
  })
  const prevIndexYRef = useRef<{ left: number; right: number }>({ left: 0, right: 0 })
  const twoHandsSinceRef = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)

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
      setStatus('Hand up like you\'re holding a camera')
      loop()
    } catch (err) {
      console.error(err)
      setStatus('Camera permission denied or unavailable')
    }
  }, [])

  const drawOverlay = useCallback((hands: HandKeypoints[], overrideCorners?: Corners | null, isValid?: boolean) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const dpr = 1 // lock DPR for stability/perf
    canvas.width = Math.floor(video.clientWidth * dpr)
    canvas.height = Math.floor(video.clientHeight * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // fingertips for debugging
    ctx.fillStyle = '#00ff88'
    hands.forEach((hand) => {
      const index = hand.landmarks[8]
      const thumb = hand.landmarks[4]
      if (!index || !thumb) return
      const w = canvas.width
      const h = canvas.height
      const r = 6 * dpr
      ctx.beginPath()
      ctx.arc(index.x * w, index.y * h, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(thumb.x * w, thumb.y * h, r, 0, Math.PI * 2)
      ctx.fill()
    })

    // Rectangle overlay (connect dots-based frame)
    const useCorners = overrideCorners ?? currentCorners
    if (useCorners) {
      const w = canvas.width
      const h = canvas.height
      const c = useCorners

      ctx.lineWidth = 3 * dpr
      ctx.strokeStyle = isValid ? '#22c55e' : '#facc15'
      ctx.setLineDash([])

      ctx.beginPath()
      ctx.moveTo(c.topLeft.x * w, c.topLeft.y * h) // left index
      ctx.lineTo(c.topRight.x * w, c.topRight.y * h) // right index
      ctx.lineTo(c.bottomRight.x * w, c.bottomRight.y * h) // right thumb
      ctx.lineTo(c.bottomLeft.x * w, c.bottomLeft.y * h) // left thumb
      ctx.closePath()
      ctx.stroke()
    }
  }, [currentCorners, gestureValid, gestureStable])

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

  const captureInternal = useCallback(async (corners: Corners | null) => {
    const video = videoRef.current
    if (!video) return

    // Use video frame to guarantee coordinate alignment with overlay
    const sourceW = video.videoWidth
    const sourceH = video.videoHeight

    // If we have corners, crop to that rectangle; else full frame
    let sx = 0, sy = 0, sw = sourceW, sh = sourceH
    if (corners) {
      const leftX = Math.min(corners.topLeft.x, corners.bottomLeft.x)
      const rightX = Math.max(corners.topRight.x, corners.bottomRight.x)
      const topY = Math.min(corners.topLeft.y, corners.topRight.y)
      const bottomY = Math.max(corners.bottomLeft.y, corners.bottomRight.y)
      sx = Math.max(0, Math.floor(leftX * sourceW))
      sy = Math.max(0, Math.floor(topY * sourceH))
      sw = Math.min(sourceW - sx, Math.floor((rightX - leftX) * sourceW))
      sh = Math.min(sourceH - sy, Math.floor((bottomY - topY) * sourceH))
      if (sw <= 0 || sh <= 0) {
        sx = 0; sy = 0; sw = sourceW; sh = sourceH
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)

    await new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) return resolve()
        const url = URL.createObjectURL(blob)
        onCapture(url)
        resolve()
      }, 'image/png')
    })
  }, [onCapture])

  const capturePolygon = useCallback(async (corners: Corners) => {
    const video = videoRef.current
    if (!video) return

    const sourceW = video.videoWidth
    const sourceH = video.videoHeight

    // Bounding box of polygon in source pixels
    const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x]
    const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y]
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

    // Clip to polygon
    const p = [
      { x: corners.topLeft.x * sourceW - left, y: corners.topLeft.y * sourceH - top },
      { x: corners.topRight.x * sourceW - left, y: corners.topRight.y * sourceH - top },
      { x: corners.bottomRight.x * sourceW - left, y: corners.bottomRight.y * sourceH - top },
      { x: corners.bottomLeft.x * sourceW - left, y: corners.bottomLeft.y * sourceH - top },
    ]
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(p[0].x, p[0].y)
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y)
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

          let valid = false
          let corners: Corners | null = null
          let statusMsg = ''

          if (hands.length === 0) {
            statusMsg = 'Hands up like you\'re holding a camera'
            twoHandsSinceRef.current = null
            // reset twitch states when hands lost
            twitchRef.current.left = { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 }
            twitchRef.current.right = { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 }
          } else if (hands.length === 1) {
            statusMsg = 'Other hand up as well'
            twoHandsSinceRef.current = null
          } else if (hands.length >= 2) {
            const res = computeDirectorFrame(hands[0], hands[1])
            valid = res.valid
            if (res.corners) {
              const hist = cornersHistoryRef.current
              hist.push(res.corners)
              if (hist.length > 2) hist.shift()
              const smoothed = averageCorners(hist)

              let localStable = false
              if (hist.length >= 2 && canvasRef.current) {
                const w = canvasRef.current.width
                const h = canvasRef.current.height
                const prev = averageCorners(hist.slice(0, 1))
                const cur = smoothed
                const delta =
                  distance({ x: prev.topLeft.x * w, y: prev.topLeft.y * h }, { x: cur.topLeft.x * w, y: cur.topLeft.y * h }) +
                  distance({ x: prev.topRight.x * w, y: prev.topRight.y * h }, { x: cur.topRight.x * w, y: cur.topRight.y * h }) +
                  distance({ x: prev.bottomRight.x * w, y: prev.bottomRight.y * h }, { x: cur.bottomRight.x * w, y: cur.bottomRight.y * h }) +
                  distance({ x: prev.bottomLeft.x * w, y: prev.bottomLeft.y * h }, { x: cur.bottomLeft.x * w, y: cur.bottomLeft.y * h })
              const avgDelta = delta / 4
              localStable = avgDelta < 8
              }
              setGestureStable(localStable)

              corners = smoothed

              // v2: only draw frame now; capture by twitch to be implemented
              statusMsg = res.valid ? 'Now "click"' : 'Widen your frame'
              // draw immediately even before state updates to ensure visibility
              drawOverlay(hands, corners, res.valid)

              // Detect index-finger shutter twitch (either side)
              const now = performance.now()
              const leftY = corners.topLeft.y
              const rightY = corners.topRight.y

              // Initialize arming window on first two-hands tick
              if (twoHandsSinceRef.current == null) {
                twoHandsSinceRef.current = now
                prevIndexYRef.current.left = leftY
                prevIndexYRef.current.right = rightY
                twitchRef.current.left = { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 }
                twitchRef.current.right = { phase: 'idle', startY: 0, downY: 0, hasDown: false, startTime: 0 }
              }

              const armed = twoHandsSinceRef.current != null && (now - twoHandsSinceRef.current) >= SHUTTER_ARM_DELAY_MS

              if (!armed) {
                statusMsg = 'Ready…'
                // keep updating baselines during arm delay to avoid false triggers
                prevIndexYRef.current.left = leftY
                prevIndexYRef.current.right = rightY
              } else {
                const prevLeft = prevIndexYRef.current.left
                const prevRight = prevIndexYRef.current.right

                const processSide = (side: 'left' | 'right', y: number, prevY: number) => {
                  const state = twitchRef.current[side]
                  if (state.phase === 'idle') {
                    if ((y - prevY) >= INST_DOWN_VEL) {
                      state.phase = 'down'
                      state.startY = prevY
                      state.downY = y
                      state.hasDown = (y - prevY) >= DOWN_AMP
                      state.startTime = now
                    }
                  } else {
                    // phase: down
                    if (now - state.startTime > TWITCH_WINDOW_MS) {
                      state.phase = 'idle'
                      return false
                    }
                    if (y > state.downY) state.downY = y
                    if (!state.hasDown && (state.downY - state.startY) >= DOWN_AMP) state.hasDown = true
                    const upDisp = state.downY - y
                    if (state.hasDown && upDisp >= UP_AMP) {
                      state.phase = 'idle'
                      return true
                    }
                  }
                  return false
                }

              let leftClick = false
              let rightClick = false
              // Only run twitch detection calculations if valid frame to reduce noise
              if (res.valid) {
                leftClick = processSide('left', leftY, prevLeft)
                rightClick = processSide('right', rightY, prevRight)
              }
                prevIndexYRef.current.left = leftY
                prevIndexYRef.current.right = rightY

                if (!capturingRef.current && (leftClick || rightClick)) {
                  capturingRef.current = true
                  triggerFlashAndHaptic()
                  await capturePolygon(corners)
                  capturingRef.current = false
                }
              }
            } else {
              statusMsg = 'Align index fingertips (top) and thumbs (bottom)'
            }
          }

          setGestureValid(valid)
          setCurrentCorners(corners)
          drawOverlay(hands, corners, valid)
          if (statusMsg) setStatus(statusMsg)
        }
      } catch (e) {
        // Avoid crashing the loop
      } finally {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [drawOverlay, triggerFlashAndHaptic, captureInternal])

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


