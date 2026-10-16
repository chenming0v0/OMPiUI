import type { ImageInput } from "./commands.js";

export const IMAGE_BYTE_LIMIT = 5 * 1024 * 1024;
export const TOTAL_IMAGE_BYTE_LIMIT = 16 * 1024 * 1024;
export type GoalImageReference = { goalId: string; imageIndex: number };
export type GoalImageInput = ImageInput | GoalImageReference;

export function base64Bytes(data: string): number {
  return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function assertImageBudget(images: readonly { data: string }[]): void {
  let total = 0;
  for (const image of images) {
    const size = base64Bytes(image.data);
    total += size;
    if (size > IMAGE_BYTE_LIMIT || total > TOTAL_IMAGE_BYTE_LIMIT || images.length > 16) {
      throw Object.assign(new Error("Images exceed the 5 MiB per-image / 16 MiB total / 16-image limit"), { code: "INVALID_REQUEST" });
    }
  }
}
