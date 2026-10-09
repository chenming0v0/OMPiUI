#!/usr/bin/env node
/**
 * Android 开发调试入口，Windows / WSL / macOS / Linux 通用。
 *
 * 替代原来的 scripts/dev-android.sh：那是一个只能在 bash 下跑、且把某台机器
 * 的 E:\app\... 路径写死的私人脚本，换台机器就失效。这里改成：环境变量已经
 * 设好就尊重你的设置，没设才按平台推一个常见位置；推不出来就原样交给 tauri，
 * 由它给出自己的报错，脚本不替它猜。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Windows 上 npm 与 adb 都可能是 .cmd/.exe 包装，交给 cmd 按 PATHEXT 解析
const usingShell = process.platform === 'win32'

function guessAndroidSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Android', 'sdk')
        : join(homedir(), 'Android', 'Sdk'),
  ]
  return candidates.find(candidate => typeof candidate === 'string' && candidate.trim() && existsSync(candidate))
}

if (!process.env.ANDROID_HOME?.trim()) {
  const guessed = guessAndroidSdk()
  if (guessed) {
    process.env.ANDROID_HOME = guessed
    console.info(`[android:dev] ANDROID_HOME=${guessed}`)
  } else {
    console.warn('[android:dev] 未能定位 Android SDK，沿用当前环境变量')
  }
}

function probe(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8', shell: usingShell })
  if (result.error) return null
  return (
    String(result.stdout ?? '')
      .split(/\r?\n/)[0]
      ?.trim() ?? ''
  )
}

// --check：只报告解析到的环境与工具是否就位，不启动构建。跨机器、跨 Windows
// 与 WSL 排查 Android 配置时先用它，别拿一次完整构建去试。
if (process.argv.slice(2).includes('--check')) {
  console.info(`[android:dev] platform=${process.platform} shell=${usingShell}`)
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'NDK_HOME', 'JAVA_HOME']) {
    console.info(`[android:dev] ${name}=${process.env[name] ?? '(未设置)'}`)
  }
  console.info(`[android:dev] adb=${probe('adb', ['version']) ?? '(不可用)'}`)
  console.info(`[android:dev] npm=${probe('npm', ['--version']) ?? '(不可用)'}`)
  process.exit(0)
}

// 设备列表只是开发期的便利信息：没有 adb（例如在 WSL 里而 SDK 装在 Windows）
// 不应该挡住启动，tauri 自己会报告没有可用设备。
const devices = spawnSync('adb', ['devices'], { stdio: 'inherit', shell: usingShell })
if (devices.error) console.warn('[android:dev] 找不到 adb，跳过设备列表')

console.info('[android:dev] npm run tauri android dev')
const child = spawnSync('npm', ['run', 'tauri', 'android', 'dev'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: usingShell,
})
process.exit(child.status ?? 1)
