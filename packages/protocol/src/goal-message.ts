/** 历史会话保留完整旧指令；展示层只提取历史目标与续跑标记。 */
export type GoalMessage = {
  kind: "set" | "continuation"
  objective: string
  round: number
  limit: number
}

const GOAL_INSTRUCTION = "Continue working toward it. If it is already fully achieved, end your reply with the exact marker GOAL_COMPLETE and do nothing else."

export function parseGoalMessage(text: string): GoalMessage | null {
  // 完整匹配历史内部消息；当前 Goal 生命周期不再生成这些文本标记。
  if (!text.endsWith(`". ${GOAL_INSTRUCTION}`)) return null
  const match = /^\[(?:(ompiui) goal (set|continuation)|goal (continuation)) (\d+)\/(\d+)\] Session goal: "([\s\S]*)$/.exec(text.slice(0, -(`". ${GOAL_INSTRUCTION}`.length)))
  if (!match) return null
  const round = Number(match[4])
  return {
    kind: match[1] ? match[2] as GoalMessage["kind"] : round === 1 ? "set" : "continuation",
    objective: match[6]!,
    round,
    limit: Number(match[5]),
  }
}

export function goalMessagePreview(text: string): string {
  return parseGoalMessage(text)?.objective ?? text
}
