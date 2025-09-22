interface CaptureResultProps {
  imageUrl: string
  onRetake: () => void
}

export default function CaptureResult({ imageUrl, onRetake }: CaptureResultProps) {
  const handleSave = () => {
    const a = document.createElement('a')
    a.href = imageUrl
    a.download = 'capture.png'
    a.click()
  }

  return (
    <div className="relative w-screen h-screen bg-black text-white">
      <img src={imageUrl} alt="Capture" className="absolute inset-0 w-full h-full object-contain" />

      <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4">
        <button
          className="px-4 py-2 rounded bg-white text-black"
          onClick={handleSave}
        >
          Save
        </button>
        <button
          className="px-4 py-2 rounded bg-neutral-800 border border-neutral-600"
          onClick={onRetake}
        >
          Retake
        </button>
      </div>
    </div>
  )
}
