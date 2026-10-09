#!/usr/bin/env node

/**
 * bump-version.mjs - One-command version bump for OMPiUI (monorepo)
 *
 * Usage:
 *   node packages/app/scripts/bump-version.mjs <version>
 *
 * Examples:
 *   node packages/app/scripts/bump-version.mjs 0.2.0            # stable release
 *   node packages/app/scripts/bump-version.mjs 0.2.1-canary.1   # canary release
 *
 * What it does:
 *   1. Updates version in the root + workspace package.json files,
 *      packages/app/src-tauri/Cargo.toml, Cargo.lock, tauri.conf.json
 *   2. Prepends a new entry to the root CHANGELOG.md with git log since last tag
 *   3. Prints the git commands you need to run next (commit + tag + push)
 *
 * Run from anywhere; paths are resolved relative to the repository root.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const version = process.argv[2]

if (!version) {
  console.error('Usage: node packages/app/scripts/bump-version.mjs <version>')
  console.error('  e.g. node packages/app/scripts/bump-version.mjs 0.2.0')
  console.error('  e.g. node packages/app/scripts/bump-version.mjs 0.2.1-canary.1')
  process.exit(1)
}

// Basic semver validation (with optional prerelease)
const semverRe = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.\d+)?)?$/
if (!semverRe.test(version)) {
  console.error(`Invalid semver: "${version}"`)
  console.error('Expected format: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease.N')
  process.exit(1)
}

const tagName = `v${version}`
const today = new Date().toISOString().slice(0, 10)
const isPrerelease = version.includes('-')
const stableTagRe = /^v\d+\.\d+\.\d+$/
const existingChangelogPath = resolve(repoRoot, 'CHANGELOG.md')
const lineEnding =
  existsSync(existingChangelogPath) && /\r\n/.test(readFileSync(existingChangelogPath, 'utf-8')) ? '\r\n' : '\n'

function formatWithPrettier(relativePath) {
  execSync(`npx prettier --write "${relativePath}"`, {
    cwd: repoRoot,
    stdio: 'pipe',
  })
}

function replaceCargoPackageVersion(lockContent, packageName, nextVersion) {
  const packageBlocks = lockContent.split('[[package]]')
  const updatedBlocks = packageBlocks.map((block, index) => {
    if (index === 0) return block
    if (!block.includes(`name = "${packageName}"`)) return block
    return block.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${nextVersion}"`)
  })
  return updatedBlocks.join('[[package]]')
}

function listVersionSortedTags(extraArgs) {
  return execSync(`git tag ${extraArgs} --sort=-v:refname`, { encoding: 'utf-8', cwd: repoRoot })
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(Boolean)
}

/** stable tag（vX.Y.Z）与本次版本号比较，前者更小返回负数。 */
function compareStableTagToVersion(tag, nextVersion) {
  const left = tag.slice(1).split('.').map(Number)
  const right = nextVersion.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function getReleaseBaseTag() {
  if (isPrerelease) {
    return execSync('git describe --tags --abbrev=0 2>/dev/null', {
      encoding: 'utf-8',
      cwd: repoRoot,
    }).trim()
  }

  // 基线优先取 HEAD 可达的最近 stable tag，并且必须低于本次版本。
  const isBaseCandidate = tag => stableTagRe.test(tag) && tag !== tagName && compareStableTagToVersion(tag, version) < 0
  let lastStableTag = listVersionSortedTags('--merged HEAD').find(isBaseCandidate)
  if (!lastStableTag) {
    // 本仓库的 tag 打在 main 上，而 main 从不并回 dev：在 dev 上发版时 stable
    // tag 一律不可达，--merged HEAD 会把它整个过滤掉，旧实现在此抛错后被外层
    // catch 吞掉，于是把整仓历史当成本次条目倒进 CHANGELOG。不可达只是
    // --merged 这一层筛选失败，git log <tag>..HEAD 取的仍是「本分支自上次发版
    // 以来的提交」，正是想要的区间，因此退回按版本排序取最新的 stable tag，
    // 并响亮提示操作者把 main 并回来。
    lastStableTag = listVersionSortedTags('').find(isBaseCandidate)
    if (lastStableTag) {
      console.warn(`  CHANGELOG base tag ${lastStableTag} is not reachable from HEAD; using it by version order.`)
      console.warn('  Merge main back into this branch after each release so the range stays reachable.')
    }
  }
  if (!lastStableTag) {
    throw new Error('No previous stable tag found')
  }

  console.log(`  CHANGELOG base tag      ${lastStableTag}`)
  return lastStableTag
}

// OMPiUI 自身 workspace 包名（互依赖引用也随版本一起升）
const WORKSPACE_PACKAGE_NAMES = [
  '@ompiui/app',
  '@ompiui/server',
  '@ompiui/omp-worker',
  '@ompiui/protocol',
  '@ompiui/relay',
  '@ompiui/admin',
]

function bumpPackageJson(relativePath, oldVersion) {
  const fullPath = resolve(repoRoot, relativePath)
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'))
  if (pkg.version !== oldVersion) {
    // 某个 workspace 版本已漂移：仍按目标版本统一，但提示
    console.log(`  ${relativePath}        ${pkg.version} -> ${version} (drifted)`)
  }
  pkg.version = version
  // 同步该包对其他 @ompiui workspace 包的依赖引用：npm workspace 解析时
  // 依赖声明版本必须与目标包的实际版本一致，否则会去 registry 找旧版本
  // 导致 npm ci 404（CI 发布失败）。
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[section]
    if (!deps || typeof deps !== 'object') continue
    let changed = false
    for (const name of WORKSPACE_PACKAGE_NAMES) {
      if (typeof deps[name] === 'string' && deps[name] !== version) {
        deps[name] = version
        changed = true
      }
    }
    if (changed) console.log(`  ${relativePath}        ${section} -> ${version}`)
  }
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  ${relativePath}        ${oldVersion} -> ${version}`)
}

// ---------------------------------------------------------------------------
// 1. Update root + workspace package.json files (monorepo)
// ---------------------------------------------------------------------------
const pkgPath = resolve(repoRoot, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const oldVersion = pkg.version

const packageJsonFiles = [
  'package.json',
  'packages/app/package.json',
  'packages/server/package.json',
  'packages/omp-worker/package.json',
  'packages/protocol/package.json',
  'packages/relay/package.json',
  'packages/admin/package.json',
]
for (const relative of packageJsonFiles) {
  bumpPackageJson(relative, oldVersion)
}

// ---------------------------------------------------------------------------
// 2. Update packages/app/src-tauri/Cargo.toml
// ---------------------------------------------------------------------------
const cargoPath = resolve(repoRoot, 'packages/app/src-tauri/Cargo.toml')
let cargo = readFileSync(cargoPath, 'utf-8')
const cargoPackageNameMatch = cargo.match(/^(name\s*=\s*)"([^"]+)"/m)
const cargoPackageName = cargoPackageNameMatch?.[2]
cargo = cargo.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`)
writeFileSync(cargoPath, cargo)
console.log(`  packages/app/src-tauri/Cargo.toml  ${oldVersion} -> ${version}`)

// ---------------------------------------------------------------------------
// 3. Update packages/app/src-tauri/tauri.conf.json
// ---------------------------------------------------------------------------
const tauriConfPath = resolve(repoRoot, 'packages/app/src-tauri/tauri.conf.json')
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'))
tauriConf.version = version
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n')
formatWithPrettier('packages/app/src-tauri/tauri.conf.json')
console.log(`  packages/app/src-tauri/tauri.conf  ${oldVersion} -> ${version}`)

// ---------------------------------------------------------------------------
// 4. Update packages/app/src-tauri/Cargo.lock (workspace package entry)
// ---------------------------------------------------------------------------
const cargoLockPath = resolve(repoRoot, 'packages/app/src-tauri/Cargo.lock')
if (cargoPackageName && existsSync(cargoLockPath)) {
  const cargoLock = readFileSync(cargoLockPath, 'utf-8')
  const updatedCargoLock = replaceCargoPackageVersion(cargoLock, cargoPackageName, version)
  if (updatedCargoLock !== cargoLock) {
    writeFileSync(cargoLockPath, updatedCargoLock)
    console.log(`  packages/app/src-tauri/Cargo.lock  ${oldVersion} -> ${version}`)
  }
}

// ---------------------------------------------------------------------------
// 4b. Update npm package-lock.json (workspace package version + cross refs)
// ---------------------------------------------------------------------------
// npm ci 严格按 lockfile 解析：package.json 的 version 和互依赖引用变了，
// lockfile 里的对应字段必须同步，否则 CI 会按旧版本去 registry 拉 404。
const npmLockPath = resolve(repoRoot, 'package-lock.json')
if (existsSync(npmLockPath)) {
  const npmLock = JSON.parse(readFileSync(npmLockPath, 'utf-8'))
  let lockChanged = false
  if (npmLock.version !== version) {
    npmLock.version = version
    lockChanged = true
  }
  const packageEntries = npmLock.packages ?? {}
  for (const [pathKey, entry] of Object.entries(packageEntries)) {
    if (!entry || typeof entry !== 'object') continue
    // 根包和 workspace 自身的版本都必须同步。
    if ((pathKey === '' || (entry.name && WORKSPACE_PACKAGE_NAMES.includes(entry.name))) && entry.version !== version) {
      entry.version = version
      lockChanged = true
    }
    // 对其他 @ompiui workspace 包的依赖引用
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = entry[section]
      if (!deps || typeof deps !== 'object') continue
      for (const name of WORKSPACE_PACKAGE_NAMES) {
        if (typeof deps[name] === 'string' && deps[name] !== version) {
          deps[name] = version
          lockChanged = true
        }
      }
    }
  }
  if (lockChanged) {
    writeFileSync(npmLockPath, JSON.stringify(npmLock, null, 2) + '\n')
    console.log(`  package-lock.json      ${oldVersion} -> ${version}`)
  }
}

// ---------------------------------------------------------------------------
// 5. Generate changelog entry from git log
// ---------------------------------------------------------------------------
let commits = ''
try {
  // Stable release: compare from previous stable tag.
  // Pre-release: compare from the latest reachable tag.
  const lastTag = getReleaseBaseTag()

  commits = execSync(`git log ${lastTag}..HEAD --pretty=format:"- %s (%h)" --no-merges`, {
    encoding: 'utf-8',
    cwd: repoRoot,
  }).trim()
} catch {
  // No previous tag — include all commits
  try {
    commits = execSync('git log --pretty=format:"- %s (%h)" --no-merges', {
      encoding: 'utf-8',
      cwd: repoRoot,
    }).trim()
  } catch {
    commits = '- Initial release'
  }
}

if (!commits) {
  commits = '- No changes since last tag'
}

const releaseType = isPrerelease ? ' (Pre-release)' : ''
// 条目用不带 v 的版本号（CHANGELOG 格式与 release 工作流的 sed 提取模式
// /^## \[${TAG}\]/ 对齐，TAG = github.ref_name = v0.2.0，sed 里用的是 [v0.2.0]）。
const changelogEntry = `## [${tagName}] - ${today}${releaseType}${lineEnding}${lineEnding}${commits.replace(/\n/g, lineEnding)}${lineEnding}`

const changelogPath = resolve(repoRoot, 'CHANGELOG.md')
if (existsSync(changelogPath)) {
  const existing = readFileSync(changelogPath, 'utf-8')
  // 保持文件头（标题 + 说明）在顶部，新条目插在第一个 "## [" 之前
  const firstSection = existing.search(/^## \[/m)
  if (firstSection > 0) {
    const header = existing.slice(0, firstSection)
    const body = existing.slice(firstSection)
    writeFileSync(changelogPath, header + changelogEntry + lineEnding + body)
  } else if (firstSection === 0) {
    // 没有头部说明，直接插在最前
    writeFileSync(changelogPath, changelogEntry + lineEnding + existing)
  } else {
    writeFileSync(changelogPath, existing + lineEnding + changelogEntry)
  }
} else {
  writeFileSync(changelogPath, `# Changelog${lineEnding}${lineEnding}${changelogEntry}`)
}
// CHANGELOG 也必须过一遍 prettier：否则发版提交带着格式问题进仓库，
// 下一次 `prettier --check` 直接失败（条目里的长中文行尤其容易被判定需要重排）。
formatWithPrettier('CHANGELOG.md')
console.log(`  CHANGELOG.md          added entry for ${tagName}`)

// ---------------------------------------------------------------------------
// 6. Print next steps
// ---------------------------------------------------------------------------
console.log(`
Done. Version files are updated locally. Do not tag from a feature branch.

  git add -A
  git commit -m "chore: release ${version}"
  git push origin HEAD:dev

Open or update the pull request from dev into main, and merge it there.
After origin/main contains this commit:

  git fetch origin main
  git tag ${tagName} origin/main
  git push origin ${tagName}
`)
