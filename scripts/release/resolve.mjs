import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const workflow = "desktop-release.yml"
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

export function artifactNames(tree, android) {
  const platforms = ["windows-x64", "macos-arm64", "linux-x64"]
  if (android) platforms.push("android-arm64", "android-armv7")
  return platforms.map(platform => `ompiui-release-${tree}-${platform}`)
}

export function resolveSource({ event, ref, sha, requestedTag, verifyOnly = false }, runGit = git) {
  const tagged = ref.startsWith("refs/tags/") || (event === "workflow_dispatch" && (!verifyOnly || requestedTag))
  const publish = Boolean(tagged && !verifyOnly)
  let tag = ""
  if (tagged) {
    tag = event === "workflow_dispatch"
      ? requestedTag || runGit("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0]
      : ref.slice("refs/tags/".length)
    if (!tag.startsWith("v") || /[\r\n]/.test(tag)) throw new Error("No valid v* release tag found")
  }
  const commit = runGit("rev-parse", "--verify", `${tagged ? `refs/tags/${tag}` : sha}^{commit}`)
  const tree = runGit("rev-parse", `${commit}^{tree}`)
  return { publish, tag, commit, tree }
}

export async function findPrebuiltRun({ request, tree, android, resolveTree }) {
  // 只接受本工作流在 dev 上成功完成的 push，不复用 PR 或手动构建的产物。
  const { workflow_runs: runs } = await request(
    `/actions/workflows/${workflow}/runs?branch=dev&event=push&status=success&per_page=30`,
  )
  for (const run of runs) {
    if (run.event !== "push" || run.head_branch !== "dev" || run.conclusion !== "success") continue
    if (resolveTree(run.head_sha) !== tree) continue
    const { artifacts } = await request(`/actions/runs/${run.id}/artifacts?per_page=100`)
    const available = new Set(artifacts
      .filter(artifact => !artifact.expired && artifact.size_in_bytes > 0)
      .map(artifact => artifact.name))
    // 必须整套产物来自同一次成功运行，避免混用不同版本或漏掉某个架构。
    if (artifactNames(tree, android).every(name => available.has(name))) return String(run.id)
  }
  return ""
}

async function main() {
  const verifyOnly = process.env.VERIFY_ONLY === "true"
  const source = resolveSource({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    requestedTag: process.env.RELEASE_TAG?.trim(),
    verifyOnly,
  })
  const android = process.env.ANDROID_ENABLED === "true"
  let reuseRun = ""
  if ((source.publish || verifyOnly) && process.env.FORCE_REBUILD !== "true") {
    const request = async path => {
      const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
      return response.json()
    }
    try {
      reuseRun = await findPrebuiltRun({
        request, tree: source.tree, android,
        resolveTree: sha => {
          try { return git("rev-parse", "--verify", `${sha}^{tree}`) }
          catch { return "" }
        },
      })
    } catch (error) {
      console.warn(`::warning::Prebuilt artifact lookup failed; building from source: ${error.message}`)
    }
  }
  const outputs = {
    publish: String(source.publish), tag: source.tag, ref: source.commit,
    deliver: String(source.publish || verifyOnly),
    tree: source.tree, android: String(android), reuse_run: reuseRun,
  }
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""))
  const route = reuseRun
    ? `复用 dev 预构建：运行 ${reuseRun}；跳过编译，${verifyOnly ? "只验收完整产物" : "直接发布完整产物"}。`
    : source.publish || verifyOnly
      ? "本次从源码构建。预构建尚未完成、已过期或选择了强制重建，不承诺在 5 分钟内完成。"
      : "为 dev 预构建完整产物，同时预热默认分支的编译缓存。"
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### 发布路径\n\n${route}\n\n源码提交：\`${source.commit}\`\n\n源码树：\`${source.tree}\`\n`)
  console.info(route)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
