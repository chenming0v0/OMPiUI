import type { ImageContent, TextContent, ToolResultMessage } from '../../../omp/vendor/pi-ai'

/**
 * 工具结果内容块的统一取法。
 *
 * registry 和各 renderer 原先各自写一份 filter/map/join 解析 content，四份副本
 * 已经开始漂移（有的只要 text、有的还要 flatMap image）。收成一个入口：数组就
 * 过滤出带 type 的块，形状不符时给空集合而不是抛出，让单个工具块的渲染异常
 * 不至于升级成整条消息列表报错。
 */
export function toolResultBlocks(
  result: Pick<ToolResultMessage, 'content'> | undefined,
): (TextContent | ImageContent)[] {
  const content = result?.content as unknown
  if (Array.isArray(content)) {
    return content.filter(
      block => !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string',
    ) as (TextContent | ImageContent)[]
  }
  // 字符串 content：按单个文本块处理，错误信息仍然可见
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return []
}

/** 工具结果的纯文本；内容缺失或形状异常时返回空串而不是抛出。 */
export function toolResultText(result: Pick<ToolResultMessage, 'content'> | undefined): string {
  return toolResultBlocks(result)
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}