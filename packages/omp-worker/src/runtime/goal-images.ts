import { assertImageBudget, isJsonObject, type GoalImageInput, type ImageInput, type JsonValue } from "@ompiui/protocol";

/** 引用必须属于编辑时的目标；目标已被替换时拒绝保存，不能静默丢掉原图。 */
export function resolveGoalImages(images: GoalImageInput[], goal: JsonValue): ImageInput[] {
  const resolved = images.map(image => {
    if ("data" in image) return image;
    const original = isJsonObject(goal) && goal.id === image.goalId && Array.isArray(goal.images)
      ? goal.images[image.imageIndex] : undefined;
    if (!isJsonObject(original) || original.type !== "image" || typeof original.data !== "string" || typeof original.mimeType !== "string") {
      throw Object.assign(new Error("Goal image reference expired; reopen the goal editor"), { code: "INVALID_REQUEST" });
    }
    return { type: "image" as const, data: original.data, mimeType: original.mimeType };
  });
  assertImageBudget(resolved);
  return structuredClone(resolved);
}
