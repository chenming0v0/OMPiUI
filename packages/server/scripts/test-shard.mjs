#!/usr/bin/env node
/**
 * 按文件把 server 测试套件轮转分组后交给 node:test（CI 分片并发用）。
 *
 * 用法：node scripts/test-shard.mjs <shard> <total>
 * 例如 4 片中的第 2 片：node scripts/test-shard.mjs 2 4
 *
 * 轮转（i % total === shard-1）而不是连续切片：server 套件的耗时集中在
 * terminal-manager、tunnel 等按字母相邻的 PTY/子进程套件上，轮转能把它们
 * 摊到不同分片，避免某个 runner 独吞全部慢文件。
 */
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const [shardArg, totalArg] = process.argv.slice(2)
const shard = Number.parseInt(shardArg ?? "", 10)
const total = Number.parseInt(totalArg ?? "", 10)
if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || total < 1 || shard > total) {
  throw new Error("usage: node scripts/test-shard.mjs <shard> <total>")
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const srcRoot = join(packageRoot, "src")

function collect(dir, into = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, into)
    else if (entry.name.endsWith(".test.ts")) into.push(path)
  }
  return into
}

const files = collect(srcRoot).sort()
const selected = files.filter((_, index) => index % total === shard - 1)
if (selected.length === 0) {
  console.info(`[test-shard] shard ${shard}/${total} has no files; nothing to run`)
  process.exit(0)
}
console.info(`[test-shard] shard ${shard}/${total} runs ${selected.length}/${files.length} files`)

// Windows 上并行测试进程同时起 ConPTY 会触发 @lydell/node-pty 的原生不稳定
// （堆损坏 0xC0000374、spawn 挂起、进程被句柄钉住不退出）；串行执行避开。
const concurrency = process.platform === "win32" ? 1 : 2

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...selected],
  { cwd: packageRoot, stdio: "inherit", shell: false, env: { ...process.env, OMPIUI_DRIVER: "mock" } },
)
process.exit(result.status ?? 1)
