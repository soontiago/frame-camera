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

    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    )

    this.detector = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      },
      numHands: 2,
      runningMode: 'VIDEO',
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
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
