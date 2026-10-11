import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { artifactNames, findPrebuiltRun, resolveSource } from "./resolve.mjs"

const directory = mkdtempSync(join(tmpdir(), "ompiui-release-test-"))
after(() => rmSync(directory, { recursive: true, force: true }))
const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
git("init", "-b", "dev")
writeFileSync(join(directory, "package.json"), '{"version":"1.0.0"}\n')
git("add", ".")
git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "initial")
const initial = git("rev-parse", "HEAD")
git("branch", "main")
writeFileSync(join(directory, "package.json"), '{"version":"1.0.1"}\n')
git("add", ".")
git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "version")
const dev = git("rev-parse", "HEAD")
git("checkout", "main")
git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "merge", "--no-ff", "dev", "-m", "release merge")
const main = git("rev-parse", "HEAD")
git("tag", "v1.0.1")
git("tag", "v1.0.0", initial)

const tree = git("rev-parse", `${dev}^{tree}`)
const successfulRun = { id: 42, event: "push", head_branch: "dev", head_sha: dev, conclusion: "success" }
const artifacts = (android = true) => artifactNames(tree, android).map(name => ({ name, expired: false, size_in_bytes: 100 }))

function lookup({ runs = [successfulRun], files = artifacts(), android = true, sourceTree = tree } = {}) {
  return findPrebuiltRun({
    tree: sourceTree, android,
    resolveTree: sha => git("rev-parse", `${sha}^{tree}`),
    request: async path => path.includes("/artifacts?") ? { artifacts: files } : { workflow_runs: runs },
  })
}

test("main 合并提交与 dev SHA 不同但源码树相同，可以复用整套包", async () => {
  const source = resolveSource({ event: "push", ref: "refs/tags/v1.0.1", sha: main }, git)
  assert.notEqual(main, dev)
  assert.equal(source.commit, main)
  assert.equal(source.tree, tree)
  assert.equal(source.publish, true)
  assert.equal(await lookup({ sourceTree: source.tree }), "42")
})

test("手动指定旧 tag 时构建该 tag，而非触发工作流的 dev HEAD", () => {
  const source = resolveSource({ event: "workflow_dispatch", ref: "refs/heads/dev", sha: dev, requestedTag: "v1.0.0" }, git)
  assert.equal(source.commit, initial)
  assert.equal(source.tag, "v1.0.0")
})

test("手动未指定 tag 时使用最新版本，dev push 只预构建", () => {
  const source = resolveSource({ event: "workflow_dispatch", ref: "refs/heads/dev", sha: dev }, git)
  assert.equal(source.tag, "v1.0.1")
  assert.deepEqual(resolveSource({ event: "push", ref: "refs/heads/dev", sha: dev }, git), {
    publish: false, tag: "", commit: dev, tree,
  })
})

test("指定不存在的 tag 会失败，不能静默发布当前分支", () => {
  assert.throws(() => resolveSource({ event: "workflow_dispatch", ref: "refs/heads/dev", sha: dev, requestedTag: "v9.9.9" }, git))
})

test("即使只改版本号，源码树不同也必须重建", async () => {
  assert.equal(await lookup({ sourceTree: git("rev-parse", `${initial}^{tree}`) }), "")
})

test("产物过期、为空或缺少一个平台时必须重建", async () => {
  for (const files of [artifacts().slice(1), artifacts().map((file, i) => i ? file : { ...file, expired: true }), artifacts().map((file, i) => i ? file : { ...file, size_in_bytes: 0 })]) {
    assert.equal(await lookup({ files }), "")
  }
})

test("不混用两次运行的产物，即使拼起来包含所有平台", async () => {
  const result = await findPrebuiltRun({
    tree, android: true, resolveTree: () => tree,
    request: async path => path.includes("/artifacts?")
      ? { artifacts: path.includes("/42/") ? artifacts().slice(0, 3) : artifacts().slice(3) }
      : { workflow_runs: [successfulRun, { ...successfulRun, id: 43 }] },
  })
  assert.equal(result, "")
})

test("拒绝 PR、手动运行、其他分支与未成功运行的产物", async () => {
  for (const change of [{ event: "pull_request" }, { event: "workflow_dispatch" }, { head_branch: "main" }, { conclusion: "failure" }, { conclusion: null }]) {
    assert.equal(await lookup({ runs: [{ ...successfulRun, ...change }] }), "")
  }
})

test("没有 Android 密钥时只要求桌面产物，启用后必须补齐 APK", async () => {
  assert.equal(await lookup({ files: artifacts(false), android: false }), "42")
  assert.equal(await lookup({ files: artifacts(false), android: true }), "")
})

test("没有成功预构建时走完整构建", async () => {
  assert.equal(await lookup({ runs: [] }), "")
})

test("验收模式使用所选分支，指定 tag 时使用该 tag，两者都不发布", () => {
  const options = { event: "workflow_dispatch", ref: "refs/heads/dev", sha: dev, verifyOnly: true }
  assert.equal(resolveSource(options, git).commit, dev)
  assert.equal(resolveSource(options, git).publish, false)
  assert.equal(resolveSource({ ...options, requestedTag: "v1.0.0" }, git).commit, initial)
  assert.equal(resolveSource({ ...options, requestedTag: "v1.0.0" }, git).publish, false)
})

test("通过真实 HTTP 与 CLI 入口验收复用，输出供后续 job 使用的完整信息", async t => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token")
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(request.url.includes("/artifacts?") ? { artifacts: artifacts() } : { workflow_runs: [successfulRun] }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const output = join(directory, "outputs")
  const summary = join(directory, "summary")
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./resolve.mjs", import.meta.url))], {
    cwd: directory,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev", GITHUB_SHA: dev,
      RELEASE_TAG: "", VERIFY_ONLY: "true", FORCE_REBUILD: "false", ANDROID_ENABLED: "true",
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: "owner/repo",
      GH_TOKEN: "test-token", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
    },
  })
  const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")))
  assert.deepEqual(values, { publish: "false", deliver: "true", tag: "", ref: dev, tree, android: "true", reuse_run: "42" })
  assert.match(readFileSync(summary, "utf8"), /只验收完整产物/)
})
