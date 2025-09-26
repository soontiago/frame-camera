export interface HandKeypoints {
  landmarks: Array<{ x: number; y: number; z: number }>
  handedness: 'Left' | 'Right'
  confidence: number
}

export class HandTracker {
  private detector: any | null = null
  private ready = false

  async initialize(): Promise<void> {
    if (this.ready) return
    const vision = await import('@mediapipe/tasks-vision')
    const { FilesetResolver, HandLandmarker } = vision

    // Prefer locally hosted assets under /public for fast reloads; fall back to CDN if unavailable
    const LOCAL_WASM_BASE = '/mediapipe/wasm'
    const CDN_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    const LOCAL_MODEL = '/mediapipe/models/hand_landmarker.task'
    const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

    let filesetResolver: any
    try {
      filesetResolver = await FilesetResolver.forVisionTasks(LOCAL_WASM_BASE)
    } catch {
      filesetResolver = await FilesetResolver.forVisionTasks(CDN_WASM_BASE)
    }

    // Try local model first, then CDN model
    const tryCreate = async (modelPath: string) => {
      return await HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: modelPath },
        numHands: 2,
        runningMode: 'VIDEO',
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
    }

    try {
      this.detector = await tryCreate(LOCAL_MODEL)
    } catch {
      this.detector = await tryCreate(CDN_MODEL)
    }
    this.ready = true
  }

  isReady(): boolean {
    return this.ready && !!this.detector
  }

  async detectHands(videoElement: HTMLVideoElement): Promise<HandKeypoints[]> {
    if (!this.detector) return []
    const now = performance.now()
    const result = await this.detector.detectForVideo(videoElement, now)
    if (!result) return []

    const hands: HandKeypoints[] = []
    for (let i = 0; i < result.handedness.length; i++) {
      const handed = result.handedness[i]
      const landmarks = result.landmarks[i] ?? []
      const handednessCategory = handed[0]
      hands.push({
        handedness: (handednessCategory?.categoryName === 'Right' ? 'Right' : 'Left') as 'Left' | 'Right',
        confidence: handednessCategory?.score ?? 0,
        landmarks: landmarks.map((p: any) => ({ x: p.x, y: p.y, z: p.z })),
      })
    }

    return hands
  }

  /**
   * Release native/wasm resources held by the underlying detector.
   */
  close(): void {
    try {
      // Some implementations expose close(); guard in case of API changes
      if (this.detector && typeof this.detector.close === 'function') {
        this.detector.close()
      }
    } catch {}
    this.detector = null
    this.ready = false
  }
}
