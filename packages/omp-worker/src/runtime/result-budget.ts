import { jsonByteSize } from "@ompiui/protocol"

/** 不可分页的破坏性操作必须在修改原数据前确认回执可交付。 */
export function assertResultBudget(value: unknown, maxBytes?: number): void {
  if (maxBytes !== undefined && jsonByteSize(value, maxBytes) > maxBytes) {
    throw Object.assign(new Error("Queue result exceeds available response capacity; the queue was not modified"), {
      code: "FILE_TOO_LARGE",
    })
  }
}
