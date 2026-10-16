import { jsonByteSize } from "@ompiui/protocol"

/**
 * 不可分页的破坏性操作必须在修改原数据前确认回执可交付。
 * 调用方 worker-command-scheduler 总是注入 maxResultBytes（预留响应字节 − 信封开销），
 * 因此不存在"调用方不传就没有预算"的线上路径（#262）。
 */
export function assertResultBudget(value: unknown, maxBytes?: number): void {
  if (maxBytes !== undefined && jsonByteSize(value, maxBytes) > maxBytes) {
    throw Object.assign(new Error("Queue result exceeds available response capacity; the queue was not modified"), {
      code: "FILE_TOO_LARGE",
    })
  }
}
