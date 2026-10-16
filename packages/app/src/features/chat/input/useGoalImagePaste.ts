import { useEffect, useRef, useState, type ClipboardEvent, type Dispatch, type SetStateAction } from 'react'
import { assertAttachmentBudget } from './attachmentBudget'
import { assertGoalImageBudget, type GoalDraftImage } from './goalImages'
import { ensureFileMime, readFileAsDataUrl } from './inputUtils'

export function useGoalImagePaste(
  supportsImages: boolean,
  disabled: boolean,
  setImages: Dispatch<SetStateAction<GoalDraftImage[]>>,
) {
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])

  const onPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
      .map(ensureFileMime)
      .filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    if (disabled) return
    if (!supportsImages) {
      setError('goalBar.imagesUnsupported')
      return
    }
    const currentGeneration = generation.current
    setPending(value => value + 1)
    setError(null)
    try {
      let total = 0
      for (const file of files) {
        assertAttachmentBudget(file.size, total)
        total += file.size
      }
      const images = await Promise.all(files.map(async file => {
        const url = await readFileAsDataUrl(file)
        return { type: 'image' as const, data: url.slice(url.indexOf(',') + 1), mimeType: file.type }
      }))
      if (generation.current === currentGeneration) setImages(previous => {
        const merged = [...previous, ...images]
        try {
          assertGoalImageBudget(merged)
          return merged
        } catch {
          queueMicrotask(() => {
            if (generation.current === currentGeneration) setError('attachmentLimitBody')
          })
          return previous
        }
      })
    } catch {
      if (generation.current === currentGeneration) setError('goalBar.imageReadFailed')
    } finally {
      if (generation.current === currentGeneration) setPending(value => value - 1)
    }
  }
  return { onPaste, readingImages: pending > 0, imageError: error }
}
