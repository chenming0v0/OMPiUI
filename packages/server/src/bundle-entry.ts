/**
 * Public executable entry for the web server and its worker subprocesses.
 */
const { dirname, join } = await import("node:path")
const { existsSync } = await import("node:fs")
// 原生模块（PTY）从 exe 旁的 node_modules 按绝对路径加载；
// 旁边没有（安装目录里只有 zip）时退回 Tauri 壳解压到应用数据目录的位置
const execDir = dirname(process.execPath)
const launchDir = process.cwd()
const isWorker = process.argv[2] === "--omp-worker"
const isWatcher = process.argv[2] === "--workspace-watcher"
const isWeb = process.argv[2] === "web"

if (isWeb && !process.env.OMPIUI_NATIVE_MODULES) {
  let nativeDir = [execDir, launchDir]
    .map(dir => join(dir, "node_modules"))
    .find(dir => existsSync(dir))
  if (!nativeDir) {
    const home = process.platform === "win32" ? process.env.APPDATA : process.env.HOME
    if (home) {
      // 末位的 com.piui.app 是改名前的应用标识，只读兼容一次
      for (const id of ["com.ompiui.app", "com.piui.app"]) {
        const appDataNative = process.platform === "win32"
          ? join(home, id, "node_modules")
          : process.platform === "darwin"
            ? join(home, "Library", "Application Support", id, "node_modules")
            : join(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), id, "node_modules")
        if (existsSync(appDataNative)) {
          nativeDir = appDataNative
          break
        }
      }
    }
  }
  if (nativeDir) process.env.OMPIUI_NATIVE_MODULES = nativeDir
}

if (isWatcher) {
  await import("./workspace-watch-process.ts")
} else if (isWorker) {
  // workspace entry 导出指向 dist，避免 server 编译时将 worker 源码拉入 rootDir。
  await import("@ompiui/omp-worker/entry")
} else if (isWeb) {
  // Bun builds cannot fork a TypeScript entry, so the server respawns this
  // executable with --omp-worker. Node development keeps using child_process.fork.
  // 用显式参数传递 self-spawn 意图，而不是写环境变量——环境变量会顺着
  // 子进程树泄漏到业务 bash/agent 命令，污染 node 开发模式（spawnSelfWorker
  // 误判成 node.exe --omp-worker）。
  process.env.OMPIUI_DRIVER ??= "omp"
  const { parseWebArgs, printWebHelp, startOmpiUiServer } = await import("./start.ts")
  const { help, ...options } = parseWebArgs(process.argv.slice(3))
  if (help) {
    printWebHelp()
  } else {
    await startOmpiUiServer({
      ...options,
      // 只有 bun 打包的单文件 exe 需要 self-spawn；node 开发模式永远 fork
      selfSpawnWorker: Boolean(process.versions.bun),
    })
  }
} else {
  console.error("OMPiUI drives the OMP CLI (omp). Install it first: bun install -g @oh-my-pi/pi-coding-agent")
  process.exit(1)
}
