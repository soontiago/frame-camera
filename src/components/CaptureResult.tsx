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

  const btnBase = 'inline-flex items-center justify-center gap-2 rounded-xl px-5 h-12 min-w-32 text-base font-medium transition-colors select-none'

  return (
    <div className="relative w-screen h-screen bg-black text-white">
      <img src={imageUrl} alt="Capture" className="absolute inset-0 w-full h-full object-contain" />

      <div className="absolute bottom-10 left-0 right-0 flex justify-center gap-3">
        <button
          className={`${btnBase} bg-blue-500 text-white shadow-md hover:bg-blue-600 active:bg-blue-700`}
          onClick={handleSave}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path d="M19.5 2.25h-15A2.25 2.25 0 002.25 4.5v15A2.25 2.25 0 004.5 21.75h15a2.25 2.25 0 002.25-2.25v-15A2.25 2.25 0 0019.5 2.25zm-3 12a.75.75 0 01.75.75v3.75a.75.75 0 01-.75.75h-9a.75.75 0 01-.75-.75v-3.75a.75.75 0 01.75-.75h9zM12 3.75a3 3 0 110 6 3 3 0 010-6z" />
          </svg>
          Save
        </button>
        <button
          className={`${btnBase} bg-neutral-800 text-white border border-neutral-700 hover:bg-neutral-700 active:bg-neutral-600`}
          onClick={onRetake}
        >
          Retake
        </button>
      </div>
    </div>
  )
}
