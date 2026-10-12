import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { OmpCatalog } from "../packages/omp-worker/dist/omp/omp-catalog.js"
import { resolveOmpConfigCommand } from "../packages/omp-worker/dist/omp/omp-config-command.js"

// 真实 OMP 配置读写验收：只使用隔离目录，不访问模型服务或用户配置。
const root = mkdtempSync(path.join(tmpdir(), "ompiui-model-roles space-"))
const keys = ["OMP_AGENT_DIR", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "OMPI_OMP_BIN"]
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const roles = {
  smol: "provider/model-small:max",
  slow: "provider/model-large:max",
  plan: "provider/model-large:xhigh",
  vision: "provider/model-vision:max",
  designer: "provider/model-design:max",
  commit: "provider/model-small:max",
  tiny: "provider/model-small:max",
  advisor: "provider/model-advisor:max",
  task: "provider/model-task:high",
  web: "provider/model-web:xhigh",
  memory: "provider/model-memory:max",
  default: "provider/model-default:high",
  judge: "provider/model-judge",
}

try {
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  const bins = process.argv.slice(2)
  if (!bins.length) bins.push(process.env.OMPI_OMP_BIN || "omp")
  for (const [index, bin] of bins.entries()) {
    process.env.OMP_AGENT_DIR = path.join(root, "must-not-use")
    process.env.PI_CODING_AGENT_DIR = path.join(root, `agent-${index}`)
    process.env.OMPI_OMP_BIN = bin
    const catalog = new OmpCatalog()
    try {
      assert.deepEqual(await catalog.getModelRoles(), {})
      assert.deepEqual(await catalog.setModelRoles(roles), roles)
      assert.deepEqual(await catalog.getModelRoles(), roles)
      const updated = { default: "provider/model-updated:high" }
      await catalog.setModelRoles(updated)
      assert.deepEqual(await catalog.getModelRoles(), updated)
      await catalog.setModelRoles({})
      assert.deepEqual(await catalog.getModelRoles(), {})
      console.info(`PASS: 13 roles saved/read/updated/cleared via ${bin}`)
      console.info(`Direct argv command: ${JSON.stringify(resolveOmpConfigCommand())}`)
    } finally {
      await catalog.dispose()
    }
  }
} finally {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(root, { recursive: true, force: true })
}
