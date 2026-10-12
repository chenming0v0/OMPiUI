import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { managedSessionsRoot } from "./managed-sessions.js";

export type PreviewSettings = { subagentThinking: boolean; revision: string };
let loadedPath = "";
let settings: PreviewSettings = {
  subagentThinking: false,
  revision: "default",
};

export function getPreviewSettings(): PreviewSettings {
  const file = path.join(
    path.dirname(managedSessionsRoot()),
    "preview-settings.json",
  );
  if (file !== loadedPath) {
    loadedPath = file;
    settings = { subagentThinking: false, revision: "default" };
    try {
      const saved = JSON.parse(
        readFileSync(file, "utf8"),
      ) as Partial<PreviewSettings>;
      if (typeof saved.subagentThinking === "boolean")
        settings = {
          subagentThinking: saved.subagentThinking,
          revision: saved.revision ?? "saved",
        };
    } catch {
      /* 新安装默认不传输子代理思考。 */
    }
  }
  return { ...settings };
}

export async function setPreviewSettings(
  subagentThinking: boolean,
): Promise<PreviewSettings> {
  getPreviewSettings();
  const next = { subagentThinking, revision: randomUUID() };
  const file = loadedPath;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, JSON.stringify(next) + "\n", "utf8");
  await rename(temporary, file);
  if (loadedPath === file) settings = next;
  return next;
}
