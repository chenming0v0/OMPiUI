/**
 * CI 规划：决定本次运行要跑全部检查、复用同一源码的已验证运行，还是只改文档。
 *
 * 源码身份来自实际检出的提交树（忽略根目录文档与 docs/），不看提交 ID：
 * PR merge 提交与它对应的分支提交树相同，就应该复用同一份证明。
 * 证明以 ci.yml 运行产物为准：ci-source-<fingerprint> 在 full 运行开始时写入，
 * ci-verified-<fingerprint> 只在该运行的完整检查全部通过后写入。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const CI_WORKFLOW = "ci.yml"
export const OMP_REPOSITORY = "can1357/oh-my-pi"
export const OMP_CONSTANTS_FILE = "packages/omp-worker/src/omp/constants.ts"
// 只有根目录的这三份文档和 docs/ 下的内容不影响产物；其余 Markdown（技能、夹具）参与源码身份。
export const DOCUMENTATION_FILES = ["AGENTS.md", "README.md", "CHANGELOG.md"]
export const DOCUMENTATION_PREFIXES = ["docs/"]
export const RUN_SCAN_LIMIT = 30
export const WAIT_TIMEOUT_MS = 12 * 60_000
export const WAIT_POLL_MS = 10_000

const FINGERPRINT_SCHEMA = "ompiui-ci-source-v1"
const STABLE_VERSION = /^\d+\.\d+\.\d+$/
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"])
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

/** 同一源码存在真实失败：不能拿更早的绿色证明顶替。 */
export class CiVerificationError extends Error {
  constructor(message, { runId = "", runUrl = "" } = {}) {
    super(message)
    this.name = "CiVerificationError"
    this.code = "CI_MATCHING_FAILURE"
    this.runId = runId
    this.runUrl = runUrl
  }
}

export function defaultGit(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "")
}

export function isDocumentationPath(path) {
  const normalized = normalizePath(path)
  return DOCUMENTATION_FILES.includes(normalized) || DOCUMENTATION_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

/**
 * 对实际检出的提交树取指纹：git ls-tree -r -z 的路径、模式与 blob ID 按路径排序后哈希。
 * 文档白名单之外的所有跟踪文件都参与，包括工作流、脚本、锁文件、版本文件与原生源码。
 */
export function sourceFingerprint(commit = "HEAD", runGit = defaultGit) {
  const listing = String(runGit("ls-tree", "-r", "-z", "--full-tree", commit))
  const entries = []
  for (const record of listing.split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    if (tab < 0) throw new Error(`Unexpected git ls-tree entry for ${commit}`)
    const [mode, type, object] = record.slice(0, tab).split(/\s+/)
    if (!mode || !type || !object) throw new Error(`Unexpected git ls-tree entry for ${commit}`)
    if (type === "tree") continue
    const path = normalizePath(record.slice(tab + 1))
    if (!path) throw new Error(`Unexpected git ls-tree entry for ${commit}`)
    if (isDocumentationPath(path)) continue
    entries.push({ path, mode, object })
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const hash = createHash("sha256")
  hash.update(`${FINGERPRINT_SCHEMA}\0${entries.length}\0`)
  for (const entry of entries) hash.update(`${entry.path}\0${entry.mode}\0${entry.object}\n`)
  return hash.digest("hex")
}

/**
 * 仅当本地存在该提交对象时给出它的实际源码指纹；PR head 不是被测 merge 提交，不能替代。
 */
export function commitFingerprint(commit, runGit = defaultGit) {
  const sha = String(commit ?? "").trim()
  if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) return null
  try {
    runGit("cat-file", "-e", `${sha}^{commit}`)
  } catch {
    return null
  }
  try {
    return sourceFingerprint(sha, runGit)
  } catch {
    return null
  }
}

/**
 * 变更范围：PR 用 base.sha..HEAD，push 用 before..HEAD。
 * 基线未知（首次推送、对象缺失、事件不可读）时返回 null，由调用方保守跑全量。
 */
export function readChangedPaths({ eventName, event = {}, runGit = defaultGit } = {}) {
  if (eventName === "workflow_dispatch") return null
  let base = ""
  if (eventName === "pull_request" || eventName === "pull_request_target") base = event?.pull_request?.base?.sha ?? ""
  else if (eventName === "push") base = event?.before ?? ""
  base = String(base).trim()
  if (!base || /^0+$/.test(base)) return null
  try {
    runGit("rev-parse", "--verify", "--quiet", `${base}^{commit}`)
  } catch {
    return null
  }
  return String(runGit("diff", "--name-only", "-z", "--no-renames", base, "HEAD"))
    .split("\0")
    .map(normalizePath)
    .filter(Boolean)
}

/**
 * 返回 full / docs / reuse：
 * - full：显式手动触发或变更范围未知；
 * - docs：空变更或只改了文档白名单；
 * - reuse：源码有变更，先找同一源码的已验证 full 运行，找不到再退回 full。
 */
export function routePlan({ eventName, changedPaths } = {}) {
  if (eventName === "workflow_dispatch") {
    return { mode: "full", reason: "workflow_dispatch 强制运行全部检查" }
  }
  if (changedPaths === null || changedPaths === undefined) {
    return { mode: "full", reason: "无法确定变更范围，保守运行全部检查" }
  }
  const paths = changedPaths.map(normalizePath).filter(Boolean)
  if (paths.length === 0) {
    return { mode: "docs", reason: "相对基线没有变更文件，只做文档级检查" }
  }
  if (paths.every(isDocumentationPath)) {
    return { mode: "docs", reason: `只有文档变更（${paths.length} 个文件），跳过重型检查` }
  }
  return { mode: "reuse", reason: "源码有变更，查找同一源码的已验证 full CI" }
}

export function sourceArtifactName(fingerprint) {
  return `ci-source-${fingerprint}`
}

export function verifiedArtifactName(fingerprint) {
  return `ci-verified-${fingerprint}`
}

/** 从 worker 常量源码读取受支持的精确版本，不依赖编译产物。 */
export function readSupportedOmpVersion(readFile = readFileSync, file = join(repositoryRoot, OMP_CONSTANTS_FILE)) {
  const source = String(readFile(file, "utf8"))
  const version = /export\s+const\s+OMP_SDK_VERSION\s*=\s*["']([^"']+)["']/.exec(source)?.[1]?.trim() ?? ""
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`Cannot read an exact supported OMP version from ${OMP_CONSTANTS_FILE}: ${version || "<missing>"}`)
  }
  return version
}

/** 只读 GitHub API 请求；令牌只放在请求头，绝不写进日志或错误信息。 */
export function createRequest({
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const repo = String(repository ?? "").trim()
  if (!repo) throw new Error("GITHUB_REPOSITORY is required to query GitHub")
  if (!token) throw new Error("A read-only GH_TOKEN is required to query GitHub")
  return async path => {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${path}`)
    return response.json()
  }
}

/** latest 通道取官方 OMP 的最新正式发布；无效或请求失败直接报错，不做假回退。 */
export async function resolveLatestOmpVersion({ request, token, apiUrl, fetchImpl } = {}) {
  const send = request ?? createRequest({
    repository: OMP_REPOSITORY,
    token: token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    apiUrl: apiUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com",
    fetchImpl,
  })
  const release = await send("/releases/latest")
  if (!release || typeof release !== "object" || release.draft === true || release.prerelease === true) {
    throw new Error("The latest OMP release is not a published stable release")
  }
  const tag = String(release.tag_name ?? "").trim()
  const version = tag.replace(/^v(?=\d)/, "")
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`The latest OMP release has no exact stable version: ${tag || "<missing>"}`)
  }
  return version
}

/**
 * 跳过模式只产出受支持版本；full 模式再补 latest 通道，版本完全相同时折叠成单一通道。
 */
export async function resolveOmpMatrix({ mode, supportedVersion, ...latestOptions } = {}) {
  if (!STABLE_VERSION.test(String(supportedVersion ?? ""))) {
    throw new Error(`Invalid supported OMP version: ${supportedVersion}`)
  }
  const matrix = [{ channel: "supported", version: supportedVersion }]
  if (mode !== "full") return matrix
  const latest = await resolveLatestOmpVersion(latestOptions)
  if (latest !== supportedVersion) matrix.push({ channel: "latest", version: latest })
  return matrix
}

function sameRepository(run, repository) {
  const expected = String(repository ?? "").toLowerCase()
  if (!expected) return false
  const head = String(run?.head_repository?.full_name ?? "").toLowerCase()
  if (head !== expected) return false
  const owner = String(run?.repository?.full_name ?? "").toLowerCase()
  return owner === "" || owner === expected
}

/** 同一并发组：push/手动触发按分支，PR 按 PR 号。组内新运行会取消旧运行。 */
function sameConcurrencyGroup(left, right) {
  if (left.event === "pull_request" || right.event === "pull_request") {
    const leftNumber = left.pull_requests?.[0]?.number
    return leftNumber !== undefined && leftNumber === right.pull_requests?.[0]?.number
  }
  return Boolean(left.head_branch) && left.head_branch === right.head_branch
}

/** 运行列表按时间倒序：同一并发组里被更新运行取代的排队运行注定被取消，不能等它。 */
function supersededRunIds(runs, repository) {
  const superseded = new Set()
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (!run || run.status === "completed") continue
    if (!sameRepository(run, repository)) continue
    for (let newer = 0; newer < index; newer += 1) {
      const candidate = runs[newer]
      if (!candidate || String(candidate.id) === String(run.id)) continue
      if (!sameRepository(candidate, repository)) continue
      if (!sameConcurrencyGroup(run, candidate)) continue
      superseded.add(String(run.id))
      break
    }
  }
  return superseded
}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/**
 * 查找同一源码的已验证 full CI。返回 { runId } 或 null（没有相关运行），
 * 同一源码最新的真实失败抛 CiVerificationError，HTTP 错误一律抛出让调用方失败关闭。
 * 只有匹配的运行仍在排队/运行时才有限等待，已完成运行的产物查询会缓存。
 */
export async function waitForVerifiedCi({
  fingerprint,
  repository,
  token,
  excludeRunId,
  request,
  sleep = defaultSleep,
  now = () => Date.now(),
  timeoutMs = WAIT_TIMEOUT_MS,
  pollMs = WAIT_POLL_MS,
  workflow = CI_WORKFLOW,
  runLimit = RUN_SCAN_LIMIT,
  fingerprintCommit = commitFingerprint,
  log = () => {},
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint ?? ""))) {
    throw new Error("waitForVerifiedCi requires a SHA256 source fingerprint")
  }
  const repo = String(repository ?? process.env.GITHUB_REPOSITORY ?? "").trim()
  if (!repo) throw new Error("GITHUB_REPOSITORY is required to query full CI runs")
  const send = request ?? createRequest({
    repository: repo,
    token: token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  })
  const excluded = new Set(
    [excludeRunId, process.env.GITHUB_RUN_ID, process.env.RUN_ID].filter(value => value !== undefined && value !== null && String(value) !== "").map(String),
  )
  const sourceName = sourceArtifactName(fingerprint)
  const verifiedName = verifiedArtifactName(fingerprint)
  const terminalRuns = new Map()
  const headFingerprints = new Map()
  const started = now()
  const pollLimit = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.ceil(timeoutMs / pollMs)
    : 0

  async function listRuns() {
    const data = await send(`/actions/workflows/${workflow}/runs?per_page=${runLimit}`)
    if (!data || !Array.isArray(data.workflow_runs)) {
      throw new Error(`The ${workflow} run list is malformed`)
    }
    return data.workflow_runs
  }

  async function availableArtifacts(runId) {
    const data = await send(`/actions/runs/${runId}/artifacts?per_page=100`)
    if (!data || !Array.isArray(data.artifacts)) {
      throw new Error(`The artifact list for CI run ${runId} is malformed`)
    }
    return new Set(data.artifacts
      .filter(artifact => Boolean(artifact) && !artifact.expired && Number(artifact.size_in_bytes) > 0)
      .map(artifact => String(artifact.name)))
  }

  async function headFingerprint(run) {
    const sha = String(run.head_sha ?? "").trim()
    if (!sha) return null
    if (!headFingerprints.has(sha)) {
      let value = null
      try {
        value = fingerprintCommit(sha)
      } catch {
        value = null
      }
      headFingerprints.set(sha, value ?? null)
    }
    return headFingerprints.get(sha)
  }

  async function inspect(run) {
    const id = String(run?.id ?? "")
    if (!id || excluded.has(id)) return null
    if (!sameRepository(run, repo)) return null
    const cached = terminalRuns.get(id)
    if (cached) return cached.ignored ? null : cached

    const terminal = run.status === "completed"
    const artifacts = await availableArtifacts(id)
    let attributed = artifacts.has(sourceName)
    if (!attributed) {
      // 排队中的 dev/main push 还没有 source 产物时，可以用它的实际 head 源码确认身份；
      // PR 的 head SHA 不是被测 merge 提交，永不这样推断。
      if (!terminal && run.event === "push" && (run.head_branch === "dev" || run.head_branch === "main")) {
        attributed = (await headFingerprint(run)) === fingerprint
      }
      if (!attributed) {
        if (terminal) terminalRuns.set(id, { ignored: true })
        return null
      }
    }

    const state = {
      id,
      run,
      pending: !terminal,
      verified: terminal && run.conclusion === "success" && artifacts.has(verifiedName),
      failure: terminal && FAILURE_CONCLUSIONS.has(String(run.conclusion)),
    }
    if (terminal) terminalRuns.set(id, state)
    return state
  }

  let waits = 0
  while (true) {
    const runs = await listRuns()
    const superseded = supersededRunIds(runs, repo)
    const currentIndex = runs.findIndex(run => excluded.has(String(run?.id ?? "")))
    let pending = null
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]
      // 只等待自己之前创建的运行，防止不同 ref 的两个 plan 相互等待。
      // 已完成的同源结果仍可复用，不受创建顺序影响。
      if (currentIndex >= 0 && index < currentIndex && run.status !== "completed") continue
      if (superseded.has(String(run?.id ?? ""))) continue
      const state = await inspect(run)
      if (!state) continue
      if (state.failure) {
        const link = run.html_url ? ` (${run.html_url})` : ""
        throw new CiVerificationError(
          `Full CI run ${state.id} for this source concluded ${run.conclusion}${link}; the source is not verified`,
          { runId: state.id, runUrl: run.html_url ?? "" },
        )
      }
      if (state.verified) return { runId: state.id }
      if (state.pending) {
        pending = state
        break
      }
    }
    if (!pending) return null

    const elapsed = now() - started
    if (elapsed >= timeoutMs || waits >= pollLimit) {
      throw Object.assign(new Error(`Timed out waiting for full CI run ${pending.id} after ${Math.round(elapsed / 1000)}s; duplicate checks were not started`), {
        code: "CI_WAIT_TIMEOUT", runId: pending.id,
      })
    }
    waits += 1
    log(`Waiting for matching full CI run ${pending.id} to finish`)
    await sleep(pollMs)
  }
}

function readEventFile(path, readFile, warn) {
  if (!path) return {}
  try {
    const parsed = JSON.parse(String(readFile(path, "utf8")))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch (error) {
    warn(`::warning::Cannot read the GitHub event payload: ${error.message}`)
    return {}
  }
}

function formatSummary({ mode, fingerprint, verifiedRun, message, matrix, repository }) {
  const lines = [
    "### CI 规划",
    "",
    `- 路由：\`${mode}\`（${message}）`,
    `- 源码指纹：\`${fingerprint}\``,
  ]
  if (verifiedRun) lines.push(`- 复用运行：https://github.com/${repository}/actions/runs/${verifiedRun}`)
  lines.push(`- OMP 矩阵：${matrix.map(entry => `${entry.channel}=${entry.version}`).join("，")}`)
  return `${lines.join("\n")}\n`
}

/**
 * plan 入口：算出路由、受支持的 OMP 矩阵，写 GITHUB_OUTPUT / step summary，
 * full 模式再写 RUNNER_TEMP/ci-source.json 供父流程上传。
 */
export async function planCi({
  env = process.env,
  runGit = defaultGit,
  request,
  latestRequest,
  sleep,
  now,
  timeoutMs,
  pollMs,
  readFile = readFileSync,
  writeFile = writeFileSync,
  appendFile = appendFileSync,
  out = message => console.info(message),
} = {}) {
  const eventName = String(env.GITHUB_EVENT_NAME ?? "").trim()
  const event = readEventFile(env.GITHUB_EVENT_PATH, readFile, out)
  const fingerprint = sourceFingerprint("HEAD", runGit)
  const commit = runGit("rev-parse", "--verify", "HEAD")
  const route = routePlan({ eventName, changedPaths: readChangedPaths({ eventName, event, runGit }) })
  const repository = String(env.GITHUB_REPOSITORY ?? "")

  let mode = route.mode
  let verifiedRun = ""
  let message = route.reason
  if (mode === "reuse") {
    const proof = await waitForVerifiedCi({
      fingerprint,
      repository,
      token: env.GH_TOKEN ?? env.GITHUB_TOKEN,
      excludeRunId: env.GITHUB_RUN_ID ?? env.RUN_ID,
      request,
      sleep,
      now,
      timeoutMs,
      pollMs,
      fingerprintCommit: sha => commitFingerprint(sha, runGit),
      log: detail => out(`[ci-plan] ${detail}`),
    })
    if (proof?.runId) {
      verifiedRun = proof.runId
      message = `${route.reason}；复用同一源码的已验证运行 ${proof.runId}`
    } else {
      mode = "full"
      message = `${route.reason}；没有同一源码的已验证运行，运行全部检查`
    }
  }

  const supportedVersion = readSupportedOmpVersion(readFile)
  const matrix = await resolveOmpMatrix({ mode, supportedVersion, request: latestRequest })

  if (mode === "full") {
    const runnerTemp = String(env.RUNNER_TEMP ?? tmpdir())
    writeFile(join(runnerTemp, "ci-source.json"), `${JSON.stringify({ commit, fingerprint }, null, 2)}\n`)
  }

  const outputs = {
    mode,
    fingerprint,
    verified_run: verifiedRun,
    supported_version: supportedVersion,
    omp_matrix: JSON.stringify(matrix),
  }
  const outputFile = String(env.GITHUB_OUTPUT ?? "")
  if (outputFile) {
    appendFile(outputFile, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""))
  }
  const summary = formatSummary({ mode, fingerprint, verifiedRun, message, matrix, repository })
  const summaryFile = String(env.GITHUB_STEP_SUMMARY ?? "")
  if (summaryFile) appendFile(summaryFile, summary)
  out(`[ci-plan] ${mode}：${message}；源码 ${fingerprint}；OMP ${matrix.map(entry => `${entry.channel}=${entry.version}`).join("，")}`)

  return {
    mode,
    fingerprint,
    verifiedRun,
    supportedVersion,
    ompMatrix: matrix,
    commit,
    message,
  }
}

/**
 * proof 入口：父流程已校验所有 full 任务成功，这里只对实际检出的源码落证明。
 * 传入 CI_EXPECTED_FINGERPRINT 时必须是同一份源码，否则拒绝写入。
 */
export function writeCiProof({ env = process.env, runGit = defaultGit, writeFile = writeFileSync, runnerTemp } = {}) {
  const fingerprint = sourceFingerprint("HEAD", runGit)
  const expected = String(env.CI_EXPECTED_FINGERPRINT ?? "").trim()
  if (expected && expected !== fingerprint) {
    throw new Error(`Checked-out source fingerprint ${fingerprint} does not match the planned ${expected}; refusing to write the CI proof`)
  }
  const commit = runGit("rev-parse", "--verify", "HEAD")
  const directory = runnerTemp ?? String(env.RUNNER_TEMP ?? tmpdir())
  const file = join(directory, "ci-proof.json")
  writeFile(file, `${JSON.stringify({ commit, fingerprint }, null, 2)}\n`)
  return { commit, fingerprint, file }
}

async function main(argv = process.argv, env = process.env) {
  const command = String(argv[2] ?? "").trim()
  if (command === "proof") {
    const proof = writeCiProof({ env })
    console.info(`已写入 full CI 证明：${proof.file}（源码 ${proof.commit}）`)
    return proof
  }
  if (command) throw new Error(`Unknown ci-plan command: ${command}`)
  return planCi({ env })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (error) {
    console.error(`::error::ci-plan: ${error.message}`)
    process.exitCode = 1
  }
}
