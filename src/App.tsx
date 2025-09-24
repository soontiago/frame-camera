import { useState } from 'react'
import CameraView from './components/CameraView'
import CaptureResult from './components/CaptureResult'
import './index.css'

function App() {
  const [mode, setMode] = useState<'camera' | 'result'>('camera')
  const [imageUrl, setImageUrl] = useState<string | null>(null)

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
      {mode === 'camera' && <CameraView onCapture={handleCapture} />}
      {mode === 'result' && imageUrl && (
        <CaptureResult imageUrl={imageUrl} onRetake={handleRetake} />
      )}
      <a
        href="https://soon.work/"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-2 left-2 text-md font-semibold text-gray-800 opacity-30 hover:opacity-80 transition-opacity"
      >
        @soontiago
      </a>
    </div>
  )
}

export default App
