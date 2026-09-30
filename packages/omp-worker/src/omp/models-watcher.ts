import { createHash } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ompAgentDir } from "./omp-catalog.js"

/** models.yml 内容摘要；null = 文件不存在/不可读 */
type ModelsDigest = string | null

/**
 * `~/.omp/agent/models.yml` 变更监听。
 *
 * 长驻的 `omp --mode rpc` 只在启动时读 models.yml（config.yml 有 OMP 自己的
 * ~200ms 进程内热加载，models.yml 没有），文件改了模型列表也不会跟着变。
 * 这里监听文件变更，上层据此作废 provider auth 的 bound client（下一次
 * models.list 拉起新进程）并广播 models.updated 让前端重拉列表。
 *
 * 监听 agent 目录而不是文件本身：编辑器普遍用「写临时文件 + rename」的原子
 * 替换保存，文件 inode 会变，watch 单文件的句柄会失联。目录事件嘈杂（一次
 * 保存来多帧、无关文件也来帧），用内容哈希去重——只有内容真的变了才回调。
 */
export class OmpModelsWatcher {
  private readonly listeners = new Set<() => void>()
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private digesting = false
  private recheckAfterDigest = false
  private lastDigest: ModelsDigest | undefined
  private closed = false

  constructor(
    private readonly filePath = path.join(ompAgentDir(), "models.yml"),
    private readonly debounceMs = 200,
  ) {}

  /** 开始监听。先记一次内容基线，之后只有内容相对基线变化才触发回调。 */
  start(): void {
    if (this.closed) return
    void this.observeBaseline()
    try {
      this.watcher = watch(path.dirname(this.filePath), { persistent: false }, (_event, filename) => {
        if (this.closed) return
        // filename 为 null（部分平台/文件系统）时不过滤，交给哈希比对裁决
        if (filename && filename !== path.basename(this.filePath)) return
        this.schedule()
      })
      // agent 目录消失等错误：静默退回旧行为（列表不热更新），不影响服务
      this.watcher.on("error", () => this.stopWatching())
    } catch {
      /* 目录不存在：models.yml 也无从变更 */
    }
  }

  /** 注册变更回调；返回取消函数 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.closed = true
    this.listeners.clear()
    this.stopWatching()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private stopWatching(): void {
    const watcher = this.watcher
    this.watcher = undefined
    watcher?.close()
  }

  private async observeBaseline(): Promise<void> {
    const digest = await this.readDigest()
    if (this.lastDigest === undefined) this.lastDigest = digest
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, this.debounceMs)
  }

  private async check(): Promise<void> {
    if (this.closed || this.digesting) {
      this.recheckAfterDigest = true
      return
    }
    this.digesting = true
    try {
      const digest = await this.readDigest()
      if (digest === this.lastDigest) return
      const baseline = this.lastDigest === undefined
      this.lastDigest = digest
      if (baseline) return
      for (const listener of this.listeners) {
        try {
          listener()
        } catch {
          /* 一个回调失败不拖累其他 */
        }
      }
    } finally {
      this.digesting = false
      if (this.recheckAfterDigest && !this.closed) {
        this.recheckAfterDigest = false
        this.schedule()
      }
    }
  }

  private async readDigest(): Promise<ModelsDigest> {
    try {
      const content = await readFile(this.filePath)
      return createHash("sha256").update(content).digest("hex")
    } catch {
      return null
    }
  }
}
