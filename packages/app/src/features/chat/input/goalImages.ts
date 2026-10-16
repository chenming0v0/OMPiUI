import { base64Bytes, type GoalImageInput, type GoalImageReference } from '@ompiui/protocol'
import type { PiImageInput } from '../../../omp/transport/index.js'
import { assertAttachmentBudget, FILE_BYTE_LIMIT } from './attachmentBudget'

export type GoalDraftImage = PiImageInput & {
  dataOmitted?: boolean
  byteLength?: number
  reference?: GoalImageReference
}

export function assertGoalImageBudget(images: readonly GoalDraftImage[]): void {
  if (images.length > 16) throw new Error('At most 16 images are allowed')
  let total = 0
  for (const image of images) {
    const size = image.dataOmitted ? image.byteLength ?? FILE_BYTE_LIMIT : base64Bytes(image.data)
    assertAttachmentBudget(size, total)
    total += size
  }
}

export function goalImageInput(image: GoalDraftImage): GoalImageInput {
  if (image.dataOmitted) {
    if (!image.reference) throw new Error('Goal image reference is missing')
    return image.reference
  }
  return { type: 'image', data: image.data, mimeType: image.mimeType }
}
