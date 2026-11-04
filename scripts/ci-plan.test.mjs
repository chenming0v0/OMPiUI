import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import {
  CiVerificationError,
  isDocumentationPath,
  planCi,
  readChangedPaths,
  readSupportedOmpVersion,
  resolveOmpMatrix,
  routePlan,
  sourceArtifactName,
  sourceFingerprint,
  verifiedArtifactName,
  waitForVerifiedCi,
  writeCiProof,
} from "./ci-plan.mjs"

const directory = mkdtempSync(join(tmpdir(), "ompiui-ci-plan-test-"))
after(() => rmSync(directory, { recursive: true, force: true }))
const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const identity = ["-c", "user.name=CI Plan Test", "-c", "user.email=ci-plan@example.invalid"]
const write = (path, content) => {
  mkdirSync(dirname(join(directory, path)), { recursive: true })
  writeFileSync(join(directory, path), content)
}
const commit = message => {
  git("add", "-A")
  git(...identity, "commit", "-m", message)
  return git("rev-parse", "HEAD")
}
const checkout = ref => git("checkout", "-q", ref)
const fingerprintOf = ref => sourceFingerprint(ref, git)

git("init", "-b", "main")
write("README.md", "# fixture\n")
write("AGENTS.md", "# fixture agents\n")
write("CHANGELOG.md", "# fixture changelog\n")
write("docs/guide.md", "# guide\n")
write(".github/workflows/ci.yml", "name: CI\n")
write("package.json", '{"name":"fixture","version":"0.0.0"}\n')
write("packages/omp-worker/src/omp/constants.ts", 'export const OMP_SDK_VERSION = "18.12.6"\n')
write("packages/omp-worker/skills/incident/SKILL.md", "# skill fixture\n")
write("packages/app/AGENTS.md", "# app agents\n")
write("packages/app/src/main.ts", "export const value = 1\n")
const base = commit("base")

write("README.md", "# fixture readme\n")
write("AGENTS.md", "# fixture agents\n")
write("CHANGELOG.md", "# fixture changelog\n")
write("docs/guide.md", "# guide\n")
write("docs/extra/notes.md", "# notes\n")
const documentation = commit("documentation")

write("packages/omp-worker/skills/incident/SKILL.md", "# changed skill\n")
const runtimeMarkdown = commit("runtime markdown")

write("packages/app/AGENTS.md", "# app agents changed\n")
const nestedMarkdown = commit("nested markdown")

write(".github/workflows/ci.yml", "name: CI\non: push\n")
const workflow = commit("workflow")

write("scripts/ci-plan.mjs", "export const value = 1\n")
const script = commit("script")

write("packages/omp-worker/src/omp/constants.ts", 'export const OMP_SDK_VERSION = "18.12.7"\n')
const version = commit("version")

git("checkout", "-q", "-b", "feature", base)
write("packages/app/src/main.ts", "export const value = 2\n")
const featureHead = commit("feature change")

git("checkout", "-q", "-b", "integration", base)
write("packages/app/src/other.ts", "export const other = 1\n")
commit("integration change")
git(...identity, "merge", "--no-ff", "feature", "-m", "merge feature")
const merge = git("rev-parse", "HEAD")
const twin = git(...identity, "commit-tree", git("rev-parse", `${merge}^{tree}`), "-m", "same tree")
checkout("main")

const repository = "ompiui/fixture"
const fingerprint = "a".repeat(64)
const otherFingerprint = "b".repeat(64)

function ciRun(overrides = {}) {
  return {
    id: 100,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "dev",
    head_sha: "c".repeat(40),
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    html_url: `https://github.com/${repository}/actions/runs/100`,
    ...overrides,
  }
}

function artifact(name, extra = {}) {
  return { name, expired: false, size_in_bytes: 2048, ...extra }
}

function createApi({ runs = [], artifacts = {} } = {}) {
  return {
    async request(path) {
      const match = /^\/actions\/runs\/(\d+)\/artifacts\?per_page=100$/.exec(path)
      if (match) {
        if (!Object.hasOwn(artifacts, match[1])) throw new Error(`Unexpected artifact lookup for run ${match[1]}`)
        return { artifacts: artifacts[match[1]] }
      }
      if (path === "/actions/workflows/ci.yml/runs?per_page=30") return { workflow_runs: runs }
      throw new Error(`Unexpected request ${path}`)
    },
  }
}

function wait(options = {}) {
  return waitForVerifiedCi({ fingerprint, repository, ...options })
}

test("根目录文档与 docs/ 之外的 Markdown 才影响源码指纹", () => {
  assert.equal(fingerprintOf(documentation), fingerprintOf(base))
  assert.notEqual(fingerprintOf(runtimeMarkdown), fingerprintOf(documentation))
  assert.notEqual(fingerprintOf(nestedMarkdown), fingerprintOf(runtimeMarkdown))
  assert.match(fingerprintOf(base), /^[a-f0-9]{64}$/)
  assert.equal(isDocumentationPath("docs/guide.md"), true)
  assert.equal(isDocumentationPath("packages/app/README.md"), false)
  assert.equal(isDocumentationPath("docsomething/readme.md"), false)
})

test("工作流、脚本与版本文件都改变源码指纹", () => {
  assert.notEqual(fingerprintOf(workflow), fingerprintOf(nestedMarkdown))
  assert.notEqual(fingerprintOf(script), fingerprintOf(workflow))
  assert.notEqual(fingerprintOf(version), fingerprintOf(script))
})

test("相同源码树的不同提交共享指纹，PR head 提交与被测 merge 提交不同", () => {
  assert.notEqual(twin, merge)
  assert.equal(fingerprintOf(twin), fingerprintOf(merge))
  assert.notEqual(fingerprintOf(merge), fingerprintOf(featureHead))
})

test("PR 用 base.sha..HEAD，push 用 before..HEAD，基线未知时全量", () => {
  checkout("integration")
  assert.deepEqual(
    readChangedPaths({ eventName: "pull_request", event: { pull_request: { base: { sha: base } } }, runGit: git }).sort(),
    ["packages/app/src/main.ts", "packages/app/src/other.ts"],
  )
  checkout("feature")
  assert.deepEqual(
    readChangedPaths({ eventName: "push", event: { before: base }, runGit: git }),
    ["packages/app/src/main.ts"],
  )
  assert.equal(readChangedPaths({ eventName: "push", event: { before: "0".repeat(40) }, runGit: git }), null)
  assert.equal(readChangedPaths({ eventName: "push", event: { before: "9".repeat(40) }, runGit: git }), null)
  assert.equal(readChangedPaths({ eventName: "workflow_dispatch", event: {}, runGit: git }), null)
  checkout("main")
})

test("手动触发强制 full，只有文档变更走 docs，源码变更先查已验证运行", () => {
  assert.equal(routePlan({ eventName: "workflow_dispatch", changedPaths: ["README.md"] }).mode, "full")
  assert.equal(routePlan({ eventName: "workflow_dispatch", changedPaths: [] }).mode, "full")
  assert.equal(routePlan({ eventName: "push", changedPaths: [] }).mode, "docs")
  assert.equal(routePlan({ eventName: "push", changedPaths: null }).mode, "full")
  assert.equal(
    routePlan({ eventName: "pull_request", changedPaths: ["README.md", "docs/guide.md", "AGENTS.md", "CHANGELOG.md"] }).mode,
    "docs",
  )
  assert.equal(routePlan({ eventName: "pull_request", changedPaths: [".github/workflows/ci.yml"] }).mode, "reuse")
  assert.equal(
    routePlan({ eventName: "pull_request", changedPaths: ["packages/omp-worker/skills/incident/SKILL.md"] }).mode,
    "reuse",
  )
})

test("只接受同一源码的新鲜证明产物", async () => {
  const accepted = createApi({
    runs: [ciRun()],
    artifacts: { 100: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))] },
  })
  assert.deepEqual(await wait({ request: accepted.request }), { runId: "100" })

  const rejected = [
    [artifact(verifiedArtifactName(fingerprint))],
    [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint), { expired: true })],
    [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint), { size_in_bytes: 0 })],
    [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(otherFingerprint))],
    [artifact(sourceArtifactName(fingerprint))],
  ]
  for (const entries of rejected) {
    const api = createApi({ runs: [ciRun()], artifacts: { 100: entries } })
    assert.equal(await wait({ request: api.request }), null)
  }
})

test("同一源码最新失败不会被更早的绿色证明掩盖", async () => {
  const api = createApi({
    runs: [ciRun({ id: 200, conclusion: "failure" }), ciRun({ id: 100 })],
    artifacts: {
      200: [artifact(sourceArtifactName(fingerprint))],
      100: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))],
    },
  })
  await assert.rejects(
    wait({ request: api.request }),
    error => error instanceof CiVerificationError && error.runId === "200",
  )
})

test("同源 CI 失败时规划立即失败，不再启动一套完整检查", async () => {
  checkout("feature")
  const expectedFingerprint = fingerprintOf("HEAD")
  const eventPath = join(directory, "push-event.json")
  writeFileSync(eventPath, JSON.stringify({ before: base }))
  const writes = []
  const api = createApi({
    runs: [ciRun({ id: 1900, conclusion: "failure" })],
    artifacts: { 1900: [artifact(sourceArtifactName(expectedFingerprint))] },
  })
  try {
    await assert.rejects(planCi({
      env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "2000" },
      runGit: git,
      request: api.request,
      latestRequest: async () => ({ tag_name: "v18.12.6" }),
      writeFile: (...args) => writes.push(args),
      appendFile: (...args) => writes.push(args),
      out: () => {},
    }), error => error instanceof CiVerificationError && error.runId === "1900")
    assert.deepEqual(writes, [])
  } finally {
    checkout("main")
  }
})

test("更新的已验证运行可以取代更早的失败", async () => {
  const api = createApi({
    runs: [ciRun({ id: 300 }), ciRun({ id: 200, conclusion: "timed_out" })],
    artifacts: {
      300: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))],
      200: [artifact(sourceArtifactName(fingerprint))],
    },
  })
  assert.deepEqual(await wait({ request: api.request }), { runId: "300" })
})

test("取消的运行不算验证，也不冒充失败", async () => {
  const superseded = createApi({
    runs: [ciRun({ id: 400, conclusion: "cancelled" }), ciRun({ id: 300 })],
    artifacts: {
      400: [artifact(sourceArtifactName(fingerprint))],
      300: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))],
    },
  })
  assert.deepEqual(await wait({ request: superseded.request }), { runId: "300" })

  const cancelledOnly = createApi({
    runs: [ciRun({ id: 400, conclusion: "cancelled" })],
    artifacts: { 400: [artifact(sourceArtifactName(fingerprint))] },
  })
  assert.equal(await wait({ request: cancelledOnly.request }), null)
})

test("同一分支上被更新运行取代的排队运行不再等待", async () => {
  const push = createApi({
    runs: [
      ciRun({ id: 1500, status: "in_progress", conclusion: null }),
      ciRun({ id: 1400, status: "in_progress", conclusion: null }),
    ],
    artifacts: {
      1500: [],
      1400: [artifact(sourceArtifactName(fingerprint))],
    },
  })
  const sleeps = []
  assert.equal(await wait({
    request: push.request,
    excludeRunId: 1500,
    sleep: async milliseconds => {
      sleeps.push(milliseconds)
    },
  }), null)
  assert.deepEqual(sleeps, [])

  const pullRequests = createApi({
    runs: [
      ciRun({ id: 1700, status: "in_progress", conclusion: null, event: "pull_request", head_branch: "feature", pull_requests: [{ number: 7 }] }),
      ciRun({ id: 1600, status: "in_progress", conclusion: null, event: "pull_request", head_branch: "feature", pull_requests: [{ number: 7 }] }),
    ],
    artifacts: {
      1700: [],
      1600: [artifact(sourceArtifactName(fingerprint))],
    },
  })
  assert.equal(await wait({
    request: pullRequests.request,
    excludeRunId: 1700,
    sleep: async () => {
      throw new Error("a superseded run must not be awaited")
    },
  }), null)
})

test("最早的 plan 不等待后来创建的同源运行，避免跨 ref 互等", async () => {
  const api = createApi({
    runs: [
      ciRun({ id: 2000, status: "in_progress", conclusion: null, head_branch: "main" }),
      ciRun({ id: 1000, status: "in_progress", conclusion: null, head_branch: "dev" }),
    ],
    artifacts: { 2000: [artifact(sourceArtifactName(fingerprint))], 1000: [] },
  })
  assert.equal(await wait({
    request: api.request,
    excludeRunId: 1000,
    sleep: async () => { throw new Error("circular wait") },
  }), null)
})

test("当前运行与外部仓库的运行都不采用", async () => {
  const current = createApi({
    runs: [ciRun({ id: 500 })],
    artifacts: { 500: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))] },
  })
  assert.equal(await wait({ request: current.request, excludeRunId: 500 }), null)

  const foreignHead = createApi({
    runs: [ciRun({ id: 600, head_repository: { full_name: "someone/fork" } })],
    artifacts: { 600: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))] },
  })
  assert.equal(await wait({ request: foreignHead.request }), null)

  const foreignOwner = createApi({
    runs: [ciRun({ id: 700, repository: { full_name: "someone/fork" } })],
    artifacts: { 700: [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))] },
  })
  assert.equal(await wait({ request: foreignOwner.request }), null)
})

test("等待正在运行的同源检查后采用成功证明", async () => {
  let phase = "queued"
  const request = async path => {
    const match = /^\/actions\/runs\/(\d+)\/artifacts\?per_page=100$/.exec(path)
    if (match) {
      if (match[1] === "900") {
        return {
          artifacts: [
            artifact(sourceArtifactName(fingerprint)),
            ...(phase === "verified" ? [artifact(verifiedArtifactName(fingerprint))] : []),
          ],
        }
      }
      if (match[1] === "800") return { artifacts: [artifact(sourceArtifactName(otherFingerprint))] }
      throw new Error(`Unexpected artifact lookup ${path}`)
    }
    return {
      workflow_runs: phase === "queued"
        ? [ciRun({ id: 900, status: "in_progress", conclusion: null, event: "pull_request", head_branch: "feature" }), ciRun({ id: 800 })]
        : [ciRun({ id: 900, event: "pull_request", head_branch: "feature" }), ciRun({ id: 800 })],
    }
  }
  const result = await wait({
    request,
    sleep: async () => {
      phase = "verified"
    },
  })
  assert.deepEqual(result, { runId: "900" })
  assert.equal(phase, "verified")
})

test("dev push 排队中可按实际 head 源码识别，PR head 不会这样推断", async () => {
  const sha = "d".repeat(40)
  let phase = "queued"
  const request = async path => {
    if (path.endsWith("/artifacts?per_page=100")) {
      return {
        artifacts: phase === "queued"
          ? []
          : [artifact(sourceArtifactName(fingerprint)), artifact(verifiedArtifactName(fingerprint))],
      }
    }
    return {
      workflow_runs: [ciRun({
        id: 1000,
        event: "push",
        head_branch: "dev",
        head_sha: sha,
        status: phase === "queued" ? "queued" : "completed",
        conclusion: phase === "queued" ? null : "success",
      })],
    }
  }
  const seen = []
  const result = await wait({
    request,
    fingerprintCommit: value => {
      seen.push(value)
      return value === sha ? fingerprint : null
    },
    sleep: async () => {
      phase = "verified"
    },
  })
  assert.deepEqual(result, { runId: "1000" })
  assert.deepEqual(seen, [sha])

  let inferred = false
  const pullRequest = createApi({
    runs: [ciRun({ id: 1100, status: "in_progress", conclusion: null, event: "pull_request", head_branch: "feature" })],
    artifacts: { 1100: [] },
  })
  assert.equal(await wait({
    request: pullRequest.request,
    fingerprintCommit: () => {
      inferred = true
      return fingerprint
    },
  }), null)
  assert.equal(inferred, false)
})

test("同源 CI 超时会报错，而不是另起重复检查", async () => {
  let elapsed = 0
  const request = async path => (path.endsWith("/artifacts?per_page=100")
    ? { artifacts: [artifact(sourceArtifactName(fingerprint))] }
    : { workflow_runs: [ciRun({ id: 1200, status: "in_progress", conclusion: null })] })
  await assert.rejects(wait({
    request,
    now: () => elapsed,
    sleep: async milliseconds => { elapsed += milliseconds },
    pollMs: 5000,
    timeoutMs: 15_000,
  }), error => error.code === "CI_WAIT_TIMEOUT" && error.runId === "1200")
  assert.equal(elapsed, 15_000)
})

test("等待期间匹配运行失败会立即失败", async () => {
  let phase = "queued"
  const request = async path => {
    if (path.endsWith("/artifacts?per_page=100")) {
      return { artifacts: [artifact(sourceArtifactName(fingerprint))] }
    }
    return {
      workflow_runs: [ciRun({
        id: 1300,
        status: phase === "queued" ? "in_progress" : "completed",
        conclusion: phase === "queued" ? null : "failure",
      })],
    }
  }
  await assert.rejects(
    wait({
      request,
      sleep: async () => {
        phase = "failed"
      },
    }),
    error => error instanceof CiVerificationError && error.runId === "1300",
  )
})

test("更新的同源检查仍在运行时不能提前采用旧绿色证明", async () => {
  let completed = false
  const request = async path => {
    if (path.endsWith("/artifacts?per_page=100")) {
      return { artifacts: [
        artifact(sourceArtifactName(fingerprint)),
        ...(path.includes("/1800/") ? [artifact(verifiedArtifactName(fingerprint))] : []),
      ] }
    }
    return { workflow_runs: [
      ciRun({ id: 1900, status: completed ? "completed" : "in_progress", conclusion: completed ? "failure" : null }),
      ciRun({ id: 1800 }),
    ] }
  }
  await assert.rejects(wait({
    request,
    sleep: async () => { completed = true },
  }), error => error instanceof CiVerificationError && error.runId === "1900")
  assert.equal(completed, true)
})

test("缺失或畸形的 CI 元数据不能作为成功证明", async () => {
  await assert.rejects(wait({ request: async () => ({}) }))
  await assert.rejects(
    wait({ request: async path => (path.includes("/artifacts") ? { artifacts: null } : { workflow_runs: [ciRun()] }) }),
  )
})

test("proof 拒绝与规划指纹不一致的检出源码，且不写证明", () => {
  const plannedFingerprint = fingerprintOf("main")
  checkout("feature")
  const writes = []
  try {
    assert.throws(() => writeCiProof({
      env: { CI_EXPECTED_FINGERPRINT: plannedFingerprint },
      runGit: git,
      writeFile: (...args) => writes.push(args),
      runnerTemp: directory,
    }))
    assert.deepEqual(writes, [])
  } finally {
    checkout("main")
  }
})

test("跳过模式只解析受支持版本，full 模式失败不伪造 latest", async () => {
  const forbidden = async () => {
    throw new Error("latest must not be queried")
  }
  for (const mode of ["docs", "reuse"]) {
    assert.deepEqual(
      await resolveOmpMatrix({ mode, supportedVersion: "18.12.6", request: forbidden }),
      [{ channel: "supported", version: "18.12.6" }],
    )
  }
  await assert.rejects(
    resolveOmpMatrix({ mode: "full", supportedVersion: "18.12.6", request: async () => ({ tag_name: "nightly" }) }),
  )
  await assert.rejects(
    resolveOmpMatrix({ mode: "full", supportedVersion: "18.12.6", request: async () => ({ tag_name: "v18.13.0", prerelease: true }) }),
  )
  assert.throws(() => readSupportedOmpVersion(() => 'export const OMP_SDK_VERSION = "latest"\n'))
})

test("full 模式补充 latest 通道，版本相同时折叠", async () => {
  assert.deepEqual(
    await resolveOmpMatrix({ mode: "full", supportedVersion: "18.12.6", request: async () => ({ tag_name: "v18.13.0" }) }),
    [{ channel: "supported", version: "18.12.6" }, { channel: "latest", version: "18.13.0" }],
  )
  assert.deepEqual(
    await resolveOmpMatrix({ mode: "full", supportedVersion: "18.13.0", request: async () => ({ tag_name: "v18.13.0" }) }),
    [{ channel: "supported", version: "18.13.0" }],
  )
})
