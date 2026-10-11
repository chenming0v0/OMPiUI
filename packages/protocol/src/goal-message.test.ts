import assert from "node:assert/strict"
import { test } from "node:test"
import { formatGoalMessage, goalMessagePreview, parseGoalMessage } from "./goal-message.js"

test("goal messages round-trip multiline objectives with quotes", () => {
  const goal = { kind: "set" as const, objective: '修复 "goal"\n对照图片', round: 1, limit: 50 }
  assert.deepEqual(parseGoalMessage(formatGoalMessage(goal)), goal)
  assert.equal(goalMessagePreview(formatGoalMessage(goal)), goal.objective)
})

test("legacy history uses goal markers without changing ordinary messages", () => {
  const legacy = '[goal continuation 1/50] Session goal: "检查截图". Continue working toward it. If it is already fully achieved, end your reply with the exact marker GOAL_COMPLETE and do nothing else.'
  assert.equal(parseGoalMessage(legacy)?.kind, "set")
  assert.equal(parseGoalMessage(legacy.replace("1/50", "2/50"))?.kind, "continuation")
  for (const text of ['请解释 [goal continuation 1/50]', legacy + '\n这是示例', '/goal 修复截图']) {
    assert.equal(parseGoalMessage(text), null)
    assert.equal(goalMessagePreview(text), text)
  }
  assert.equal(parseGoalMessage(formatGoalMessage({ kind: "continuation", objective: "resume", round: 1, limit: 50 }))?.kind, "continuation")
})
