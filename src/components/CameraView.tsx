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
    // Use frame rate to help with focus stability
    frameRate: { ideal: 30 }
  },
  audio: false,
}

const AUTO_CAPTURE_MS = 300

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
  // Determine visual left/right by index x
  const candidates = [leftHandInput, rightHandInput]
    .map((h) => ({
      hand: h,
      i: h.landmarks[8],
      t: h.landmarks[4],
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

  // Proximity thresholds in normalized video coords
  const contactThresh = 0.08 // was 0.045; loosen proximity to ~8%
  const minSize = 0.04 // was 0.05; allow slightly smaller frames

  // Two possible matchings: same-type and criss-cross
  const d_same_ii = distance(Li, Ri)
  const d_same_tt = distance(Lt, Rt)
  const sameOk = d_same_ii < contactThresh && d_same_tt < contactThresh

  const d_cross_it = distance(Li, Rt)
  const d_cross_ti = distance(Lt, Ri)
  const crossOk = d_cross_it < contactThresh && d_cross_ti < contactThresh

  if (!sameOk && !crossOk) return { valid: false }

  // Use centers of the two contacts
  const c1 = sameOk ? { x: (Li.x + Ri.x) / 2, y: (Li.y + Ri.y) / 2 } : { x: (Li.x + Rt.x) / 2, y: (Li.y + Rt.y) / 2 }
  const c2 = sameOk ? { x: (Lt.x + Rt.x) / 2, y: (Lt.y + Rt.y) / 2 } : { x: (Lt.x + Ri.x) / 2, y: (Lt.y + Ri.y) / 2 }

  // Axis-aligned rectangle from the two centers
  const leftX = Math.min(c1.x, c2.x)
  const rightX = Math.max(c1.x, c2.x)
  const topY = Math.min(c1.y, c2.y)
  const bottomY = Math.max(c1.y, c2.y)

  const width = rightX - leftX
  const height = bottomY - topY
  const validSize = width > minSize && height > minSize
  if (!validSize) return { valid: false }

  const corners: Corners = {
    topLeft: { x: leftX, y: topY },
    topRight: { x: rightX, y: topY },
    bottomRight: { x: rightX, y: bottomY },
    bottomLeft: { x: leftX, y: bottomY },
  }
  return { valid: true, corners }
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

export default function CameraView({ onCapture }: CameraViewProps) {
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

  const stableSinceRef = useRef<number | null>(null)
  const capturingRef = useRef(false)
  const [flash, setFlash] = useState(false)

  const startStream = useCallback(async () => {
    try {
      setStatus('Requesting camera...')
      const stream = await navigator.mediaDevices.getUserMedia(processingConstraints)
      const video = videoRef.current!
      video.srcObject = stream
      await video.play()
      setStatus('Camera ready')

      // Implement focus lock mechanism for mobile browsers
      try {
        const track = stream.getVideoTracks()[0]
        const capabilities = track.getCapabilities() as any
        
        // Create a more robust focus lock mechanism
        const applyFocusLock = async () => {
          const constraints: any = {}
          
          // Try to lock focus at infinity/far distance
          if (capabilities?.focusMode) {
            // Try different focus modes in order of preference
            const focusModes = ['fixed', 'locked', 'manual'];
            let focusModeApplied = false;
            
            for (const mode of focusModes) {
              try {
                // Check if this mode is supported
                if (capabilities.focusMode.includes(mode)) {
                  constraints.focusMode = mode;
                  focusModeApplied = true;
                  console.log(`Applied focus mode: ${mode}`);
                  break;
                }
              } catch (e) {
                console.warn(`Focus mode '${mode}' not supported`);
              }
            }
            
            if (!focusModeApplied) {
              console.warn('No suitable focus mode found, camera may continue to autofocus');
            }
          }
          
          // Set focus distance to maximum to focus on background
          if (capabilities?.focusDistance) {
            try {
              // Use maximum focus distance to keep background in focus
              constraints.focusDistance = capabilities.focusDistance.max;
              console.log(`Set focus distance to max: ${capabilities.focusDistance.max}`);
            } catch (e) {
              console.warn('Could not set focus distance');
            }
          }
          
          // Apply constraints if we have any
          if (Object.keys(constraints).length > 0) {
            await track.applyConstraints({ advanced: [constraints] });
            console.log('Successfully applied focus lock constraints');
          }
        };
        
        // Apply focus lock immediately
        await applyFocusLock();
        
        // For mobile browsers, also try to lock focus by simulating a tap
        // in the center of the video element after a short delay
        setTimeout(() => {
          try {
            // Create a tap event on the video element to set focus point
            const videoElement = videoRef.current;
            if (videoElement) {
              const rect = videoElement.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              
              // Create touch events to simulate tapping on the background
              const touchStart = new TouchEvent('touchstart', {
                bubbles: true,
                cancelable: true,
                touches: [{
                  clientX: centerX,
                  clientY: centerY,
                  pageX: centerX,
                  pageY: centerY,
                  screenX: centerX,
                  screenY: centerY,
                  identifier: Date.now(),
                  target: videoElement,
                  radiusX: 2.5,
                  radiusY: 2.5,
                  rotationAngle: 0,
                  force: 1
                }]
              });
              
              const touchEnd = new TouchEvent('touchend', {
                bubbles: true,
                cancelable: true,
                touches: [],
                changedTouches: [{
                  clientX: centerX,
                  clientY: centerY,
                  pageX: centerX,
                  pageY: centerY,
                  screenX: centerX,
                  screenY: centerY,
                  identifier: Date.now(),
                  target: videoElement,
                  radiusX: 2.5,
                  radiusY: 2.5,
                  rotationAngle: 0,
                  force: 0
                }]
              });
              
              // Dispatch touch events to simulate tap
              videoElement.dispatchEvent(touchStart);
              setTimeout(() => videoElement.dispatchEvent(touchEnd), 100);
              
              console.log('Simulated tap to set focus point');
            }
          } catch (e) {
            console.warn('Could not simulate tap for focus:', e);
          }
        }, 1000);
        
      } catch (err) {
        console.warn('Could not apply focus lock:', err)
        // Continue even if focus lock can't be applied
      }

      if (!trackerRef.current) {
        trackerRef.current = new HandTracker()
        await trackerRef.current.initialize()
      }
      setStatus('Hand tracker ready')
      loop()
    } catch (err) {
      console.error(err)
      setStatus('Camera permission denied or unavailable')
    }
  }, [])

  const drawOverlay = useCallback((hands: HandKeypoints[]) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
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

    // Rectangle overlay
    if (currentCorners) {
      const w = canvas.width
      const h = canvas.height
      const c = currentCorners

      ctx.lineWidth = 2 * dpr
      if (!gestureValid) {
        ctx.strokeStyle = 'red'
        ctx.setLineDash([8 * dpr, 6 * dpr])
      } else if (gestureStable) {
        ctx.strokeStyle = '#22c55e'
        ctx.setLineDash([])
      } else {
        ctx.strokeStyle = 'white'
        ctx.setLineDash([])
      }

      ctx.beginPath()
      ctx.moveTo(c.topLeft.x * w, c.topLeft.y * h)
      ctx.lineTo(c.topRight.x * w, c.topRight.y * h)
      ctx.lineTo(c.bottomRight.x * w, c.bottomRight.y * h)
      ctx.lineTo(c.bottomLeft.x * w, c.bottomLeft.y * h)
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
            statusMsg = 'Hands up!'
          } else if (hands.length === 1) {
            statusMsg = 'Other hand up as well'
          } else if (hands.length >= 2) {
            const res = computeDirectorFrame(hands[0], hands[1])
            valid = res.valid
            if (res.corners) {
              const hist = cornersHistoryRef.current
              hist.push(res.corners)
              if (hist.length > 3) hist.shift()
              const smoothed = averageCorners(hist)

              let localStable = false
              if (hist.length >= 3 && canvasRef.current) {
                const w = canvasRef.current.width
                const h = canvasRef.current.height
                const prev = averageCorners(hist.slice(0, 2))
                const cur = smoothed
                const delta =
                  distance({ x: prev.topLeft.x * w, y: prev.topLeft.y * h }, { x: cur.topLeft.x * w, y: cur.topLeft.y * h }) +
                  distance({ x: prev.topRight.x * w, y: prev.topRight.y * h }, { x: cur.topRight.x * w, y: cur.topRight.y * h }) +
                  distance({ x: prev.bottomRight.x * w, y: prev.bottomRight.y * h }, { x: cur.bottomRight.x * w, y: cur.bottomRight.y * h }) +
                  distance({ x: prev.bottomLeft.x * w, y: prev.bottomLeft.y * h }, { x: cur.bottomLeft.x * w, y: cur.bottomLeft.y * h })
                const avgDelta = delta / 4
                localStable = avgDelta < 6
              }
              setGestureStable(localStable)

              corners = smoothed

              // Auto-capture using localStable to avoid state lag
              const now = performance.now()
              if (valid) {
                if (!stableSinceRef.current && localStable) {
                  stableSinceRef.current = now
                }
                if (!localStable) {
                  stableSinceRef.current = null
                }
                // Helper text: once contact threshold reached (valid), prompt to hold steady
                statusMsg = 'Contact your fingertips to Frame and Capture'
                if (valid) {
                  statusMsg = 'Hold steady'
                }
                if (!capturingRef.current && localStable && stableSinceRef.current && now - stableSinceRef.current >= AUTO_CAPTURE_MS) {
                  capturingRef.current = true
                  triggerFlashAndHaptic()
                  await captureInternal(corners)
                  capturingRef.current = false
                  stableSinceRef.current = null
                }
              }
            } else {
              statusMsg = 'Contact your fingertips to Frame and Capture'
            }
          }

          setGestureValid(valid)
          setCurrentCorners(corners)
          drawOverlay(hands)
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
