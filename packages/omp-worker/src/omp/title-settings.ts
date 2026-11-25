import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { managedSessionsRoot } from "./managed-sessions.js"
import { nativeTitleCardPrompt, nativeTitleForkPrompt, nativeTitleTinyPrompt } from "./native-title-prompts.js"

export type TitlePrompts = { forkPrompt: string; tinyPrompt: string; cardPrompt: string }
export type TitleSettings = TitlePrompts & { defaults: TitlePrompts }

export const defaultTitlePrompts: Readonly<TitlePrompts> = Object.freeze({
  forkPrompt: nativeTitleForkPrompt,
  tinyPrompt: nativeTitleTinyPrompt,
  cardPrompt: nativeTitleCardPrompt,
})

export function titleSettingsPath(): string {
  return path.join(path.dirname(managedSessionsRoot()), "title-settings.json")
}

function titlePrompts(value: unknown): TitlePrompts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Title settings must contain all three prompts")
  const saved = value as Partial<TitlePrompts>
  for (const key of ["forkPrompt", "tinyPrompt", "cardPrompt"] as const) {
    if (typeof saved[key] !== "string" || !saved[key].trim()) throw new Error(`${key} must be a nonempty string`)
  }
  return { forkPrompt: saved.forkPrompt!, tinyPrompt: saved.tinyPrompt!, cardPrompt: saved.cardPrompt! }
}

function snapshot(prompts: TitlePrompts): TitleSettings {
  return { ...prompts, defaults: { ...defaultTitlePrompts } }
}

// Always read this small file: worker/native hosts share it and filesystem mtimes
// may not distinguish two saves. Only a missing file means a new-install default.
export function getTitleSettings(): TitleSettings {
  const file = titleSettingsPath()
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot(defaultTitlePrompts)
    throw error
  }
  let saved: unknown
  try {
    saved = JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid title settings in ${file}`, { cause: error })
  }
  return snapshot(titlePrompts(saved))
}

export async function setTitleSettings(forkPrompt: string, tinyPrompt: string, cardPrompt: string): Promise<TitleSettings> {
  const next = titlePrompts({ forkPrompt, tinyPrompt, cardPrompt })
  const file = titleSettingsPath()
  const temporary = `${file}.${randomUUID()}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(next) + "\n", "utf8")
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return snapshot(next)
}
