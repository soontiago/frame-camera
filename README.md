## Frame Camera

![Frame Camera screenshot](/public/framecam_ss.webp)

A browser-based camera demo where you make a rectangle with your thumbs and index fingers to "frame" a shot. Hold the gesture steady and the app auto-captures, flashes, and lets you save the cropped image.

### What it does
- Detects both hands using on-device ML (MediaPipe Tasks Vision) and draws a live rectangle overlay from your fingertip contact points
- Auto-captures when the frame is held steady for a moment, with a visual flash, optional vibration, and shutter sound
- Crops the photo to the framed area and shows a simple viewer with Save and Retake

### Why it’s cool
- No buttons needed — just a natural hand gesture to frame and snap
- Runs entirely in the browser; no video leaves your device
- Works on mobile and desktop; optimized for the back camera on phones

---

## Quick start

### Prerequisites
- Node.js 18+ and npm
- A browser with camera access and WebAssembly enabled (Chrome, Edge, Safari, Firefox)

### Run locally
```bash
npm install
npm run dev
# Open the printed local URL (e.g. http://localhost:5173)
```

Grant camera permissions when prompted. On mobile, your browser should select the back camera automatically (the app requests `facingMode: environment`).

### Build and preview
```bash
npm run build
npm run preview
```

---

## How to use
1. Raise both hands so your thumbs and index fingers are visible to the camera
2. Touch thumb and index fingertips to make a rectangular "director frame"
3. Hold steady — the overlay turns green when stable and the photo auto-captures
4. Save or Retake from the results screen

Tips:
- Good lighting and a clean background improve detection
- Keep hands within the camera view; avoid extreme angles

---

## Features
- Real-time hand tracking via MediaPipe Hand Landmarker (2 hands)
- Stability-sensing auto-capture (~100 ms hold)
- On-screen overlay shows validity (red dashed), tracking (white), and ready (green)
- Visual flash, optional haptics (where supported), and shutter sound
- Cropped output PNG based on your framed area

---

## Tech stack
- React + TypeScript + Vite
- Tailwind CSS for UI styling
- MediaPipe Tasks Vision (hand landmarker) loaded via CDN

Key files:
- `src/components/CameraView.tsx` — camera stream, gesture detection, overlay, auto-capture
- `src/components/CaptureResult.tsx` — result viewer with Save/Retake
- `src/lib/handTracker.ts` — MediaPipe hand tracking wrapper

---

## Privacy
- Processing is fully on-device in your browser; no images or video are uploaded
- The ML model and WASM runtime are fetched from public CDNs at runtime

---

## Deployment
This is a static site. Any static hosting works (GitHub Pages, Netlify, Vercel, S3, etc.).

Requirements:
- Serve over HTTPS to allow camera access
- Allow loading of MediaPipe model and WASM from the configured CDNs

Build output is generated to `dist/` via `npm run build`.

---

## Troubleshooting
- Stuck on “Requesting camera” or “permission denied”: ensure HTTPS and grant camera access in browser/site settings
- Can’t detect hands: improve lighting, bring hands closer, keep thumbs/index fingertips visible
- Back camera not selected on mobile: some devices may still use the front camera; try switching in the browser UI if available
- Performance issues: close other camera tabs/apps; try a modern browser; ensure battery saver is off on mobile

---

## Acknowledgements
- Hand tracking powered by MediaPipe Tasks Vision
- Built with React, TypeScript, Vite, and Tailwind CSS
