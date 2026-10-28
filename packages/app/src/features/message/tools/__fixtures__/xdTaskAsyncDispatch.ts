import type { PiToolExecution } from '../../../../omp/domain/index.js'

/** 真实 OMP 18.12.6 会话里的异步 write xd://task 派发与随后的 async-result 投递（已脱敏）。 */
const fixture = {
  "_source": "OMP 18.12.6 real session 2026-10-25T16-32-46-019Z, sanitized: async write xd://task dispatch and its later async-result delivery",
  "call": {
    "type": "toolCall",
    "id": "call_UfhLkrrpIwzKBHOAK94lXDZq|fc_04b42e2e4d9e6be6006ade5738820081908a3135532874bc9f",
    "name": "write",
    "arguments": {
      "path": "xd://task",
      "i": "Dispatching independent integration reviews using task",
      "content": "{\"context\":\"# Goal\\n[sanitized]\",\"tasks\":[{\"name\":\"ReviewNativeIntegration\",\"agent\":\"reviewer\",\"task\":\"# Target\\n# Scope\\n[sanitized]\",\"solutionSpace\":\"[sanitized]\"},{\"name\":\"ReviewGuiGitIntegration\",\"agent\":\"reviewer\",\"task\":\"# Target\\n# Scope\\n[sanitized]\",\"solutionSpace\":\"[sanitized]\"}]}"
    }
  },
  "result": {
    "role": "toolResult",
    "toolCallId": "call_UfhLkrrpIwzKBHOAK94lXDZq|fc_04b42e2e4d9e6be6006ade5738820081908a3135532874bc9f",
    "toolName": "write",
    "isError": false,
    "timestamp": 1792956230228,
    "content": [
      {
        "type": "text",
        "text": "Spawned 2 background agents using reviewer.\n- `ReviewNativeIntegration` (job `ReviewNativeIntegration`)\n- `ReviewGuiGitIntegration` (job `ReviewGuiGitIntegration`)"
      }
    ],
    "details": {
      "xdev": {
        "tool": "task",
        "mode": "execute",
        "tier": "exec",
        "args": {
          "context": "# Goal\n[sanitized]",
          "tasks": [
            {
              "name": "ReviewNativeIntegration",
              "agent": "reviewer",
              "task": "# Target\n# Scope\n[sanitized]",
              "solutionSpace": "[sanitized]"
            },
            {
              "name": "ReviewGuiGitIntegration",
              "agent": "reviewer",
              "task": "# Target\n# Scope\n[sanitized]",
              "solutionSpace": "[sanitized]"
            }
          ]
        },
        "inner": {
          "projectAgentsDir": null,
          "results": [],
          "totalDurationMs": 1,
          "progress": [
            {
              "index": 0,
              "id": "ReviewNativeIntegration",
              "agent": "reviewer",
              "agentSource": "bundled",
              "modelRole": "slow",
              "status": "pending",
              "task": "Complete assignment thoroughly:\n# Scope\n[sanitized]",
              "assignment": "# Target\n[sanitized]",
              "recentTools": [],
              "recentOutput": [],
              "toolCount": 0,
              "requests": 0,
              "tokens": 0,
              "cost": 0,
              "durationMs": 0
            },
            {
              "index": 1,
              "id": "ReviewGuiGitIntegration",
              "agent": "reviewer",
              "agentSource": "bundled",
              "modelRole": "slow",
              "status": "pending",
              "task": "Complete assignment thoroughly:\n# Scope\n[sanitized]",
              "assignment": "# Target\n[sanitized]",
              "recentTools": [],
              "recentOutput": [],
              "toolCount": 0,
              "requests": 0,
              "tokens": 0,
              "cost": 0,
              "durationMs": 0
            }
          ],
          "async": {
            "state": "running",
            "jobId": "ReviewNativeIntegration",
            "type": "task"
          }
        }
      }
    }
  },
  "asyncResult": {
    "type": "custom_message",
    "customType": "async-result",
    "id": "c126c027",
    "parentId": "3db0e6b5",
    "timestamp": "2026-10-25T19:34:17.053Z",
    "display": true,
    "details": {
      "meta": {
        "source": {
          "type": "report",
          "value": "background job delivery"
        }
      },
      "jobs": [
        {
          "jobId": "Retry345Review",
          "type": "task",
          "status": "completed",
          "agentId": "Retry345Review",
          "label": "Retry345Review",
          "durationMs": 406379
        },
        {
          "jobId": "ReviewGuiGitIntegration",
          "type": "task",
          "status": "completed",
          "agentId": "ReviewGuiGitIntegration",
          "label": "ReviewGuiGitIntegration",
          "durationMs": 432244
        }
      ]
    },
    "content": "<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job Retry345Review (Retry345Review) ──\n<task-result id=\"Retry345Review\" agent=\"task\" status=\"completed\" duration=\"6m46s\">\n\n<output>\n[sanitized]\n</output>\n</task-result>\n\n── Job ReviewGuiGitIntegration (ReviewGuiGitIntegration) ──\n<task-result id=\"ReviewGuiGitIntegration\" agent=\"reviewer\" status=\"completed\" duration=\"7m12s\">\n<meta lines=\"49\" size=\"5.4KB\" />\n<preview full-output=\"agent://ReviewGuiGitIntegration\">\n## Findings\n\n### [P1] Normalize link notifications before dispatching their severity\n[sanitized]\n</preview>\n</task-result>\n\nReviewGuiGitIntegration is now idle — message it via `write agent://ReviewGuiGitIntegration` to follow up; transcript at history://ReviewGuiGitIntegration\n</system-notice>"
  }
}

export const xdTaskAsyncCall = fixture.call as PiToolExecution['call']
export const xdTaskAsyncResult = fixture.result as unknown as NonNullable<PiToolExecution['result']>
export const xdTaskAsyncDelivery = fixture.asyncResult
