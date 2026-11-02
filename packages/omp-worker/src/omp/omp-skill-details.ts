import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { isJsonObject, requireJsonObject, type JsonObject, type JsonValue } from "@ompiui/protocol"
import { runOmpNativeScript } from "./omp-native-script.js"

const maxSkillBytes = 1024 * 1024
const maxMetadataBytes = 256 * 1024

function detailError(code: string): Error {
  return Object.assign(new Error(`Cannot read skill metadata (${code})`), { code })
}

export async function readDiscoveredSkill(cwd: string, skills: JsonValue, name: string, filePath: string): Promise<JsonObject> {
  const skill = Array.isArray(skills) ? skills.find(item => isJsonObject(item) && item.name === name && item.filePath === filePath) : undefined
  if (!isJsonObject(skill) || typeof skill.filePath !== "string") throw detailError("SKILL_NOT_FOUND")
  let content: string
  try {
    const discoveredPath = path.resolve(cwd, skill.filePath)
    const target = await realpath(discoveredPath)
    if (typeof skill.containRoot === "string") {
      const root = await realpath(path.resolve(cwd, skill.containRoot))
      const relative = path.relative(root, target)
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw detailError("SKILL_PATH_CHANGED")
    }
    const before = await stat(target)
    if (!before.isFile() || before.size > maxSkillBytes) throw detailError("SKILL_FILE_INVALID")
    const handle = await open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW))
    try {
      const opened = await handle.stat()
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw detailError("SKILL_PATH_CHANGED")
      const buffer = Buffer.alloc(maxSkillBytes + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
        if (!result.bytesRead) break
        bytes += result.bytesRead
      }
      const after = await handle.stat()
      const current = await stat(target)
      if (bytes > maxSkillBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.dev !== opened.dev || current.ino !== opened.ino || await realpath(discoveredPath) !== target) throw detailError("SKILL_PATH_CHANGED")
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("SKILL_")) throw error
    throw detailError("SKILL_FILE_UNAVAILABLE")
  }
  try {
    const result = await runOmpNativeScript(cwd, `
      const { pathToFileURL } = await import("node:url");
      const { YAML } = await import("bun");
      const { parseFrontmatter } = await import(pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-utils", packageRoot)).href);
      const text = input.content.replace(/\\r\\n?/g, "\\n");
      if (!/^---(?:\\n|$)/.test(text)) return { frontmatter: {} };
      const end = /\\n---(?:\\n|$)/.exec(text.slice(3));
      if (!end) throw new Error("SKILL_FRONTMATTER_INVALID");
      const header = text.slice(4, end.index + 3);
      if (Buffer.byteLength(header) > ${maxMetadataBytes}) throw new Error("SKILL_METADATA_TOO_LARGE");
      let parsed;
      try { parsed = YAML.parse(header); } catch { throw new Error("SKILL_FRONTMATTER_INVALID"); }
      if (parsed == null && header.split("\\n").every(line => !line.trim() || line.trim().startsWith("#"))) return { frontmatter: {} };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SKILL_FRONTMATTER_INVALID");
      let frontmatter;
      try { frontmatter = parseFrontmatter(text, { rawKeys: true, repair: false, level: "fatal", location: input.filePath }).frontmatter; }
      catch { throw new Error("SKILL_FRONTMATTER_INVALID"); }
      const ancestors = new Set();
      let nodes = 0;
      function validate(value, depth = 0) {
        if (++nodes > 10000 || depth > 32) throw new Error("SKILL_METADATA_TOO_LARGE");
        if (value === null || typeof value === "string" || typeof value === "boolean") return;
        if (typeof value === "number" && Number.isFinite(value) && (Number.isSafeInteger(value) || !Number.isInteger(value))) return;
        if (typeof value !== "object" || ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("SKILL_METADATA_NOT_JSON");
        ancestors.add(value);
        for (const item of Object.values(value)) validate(item, depth + 1);
        ancestors.delete(value);
      }
      validate(frontmatter);
      if (Buffer.byteLength(JSON.stringify(frontmatter)) > ${maxMetadataBytes}) throw new Error("SKILL_METADATA_TOO_LARGE");
      return { frontmatter };
    `, { content, filePath: skill.filePath })
    return requireJsonObject(result)
  } catch (error) {
    const code = error instanceof Error && /^SKILL_[A-Z_]+$/.test(error.message) ? error.message : "SKILL_METADATA_UNAVAILABLE"
    throw detailError(code)
  }
}
