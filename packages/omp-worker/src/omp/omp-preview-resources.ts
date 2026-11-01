import { isJsonObject, requireJsonValue, type JsonObject, type JsonValue } from "@ompiui/protocol"
import { getOmpSettings } from "./omp-settings.js"
import { runOmpNativeScript } from "./omp-native-script.js"

/** Configured values, not a snapshot of a running Agent. */
export async function getOmpPreviewControls(cwd: string): Promise<JsonObject> {
  const snapshot = await getOmpSettings(cwd)
  if (!isJsonObject(snapshot) || !isJsonObject(snapshot.effective)) throw new Error("Invalid OMP settings snapshot")
  const effective = snapshot.effective
  const compaction = isJsonObject(effective.compaction) ? effective.compaction : {}
  const retry = isJsonObject(effective.retry) ? effective.retry : {}
  return {
    source: "configuration",
    interruptMode: effective.interruptMode ?? null,
    compaction: { autoEnabled: compaction.enabled ?? null },
    retry: { autoEnabled: retry.enabled ?? null },
  }
}

/** Use the selected official loader without constructing a session or loading extension factories. */
export async function getOmpPreviewSkills(cwd: string): Promise<JsonValue> {
  return requireJsonValue(await runOmpNativeScript(cwd, `
    await nativeModule("src/discovery/index.ts");
    const discovery = await nativeModule("src/capability/index.ts");
    const { Settings } = await nativeModule("src/config/settings.ts");
    const { cfgSkills, cfgDisabledExtensions, cfgExtensions } = await nativeModule("src/extensibility/settings.ts");
    const { loadSkills } = await nativeModule("src/extensibility/skills.ts");
    const { expandTilde } = await nativeModule("src/tools/path-utils.ts");
    const settings = await Settings.loadReadOnly({ cwd });
    const release = discovery.initializeWithSettings(settings);
    try {
      const configured = cfgSkills.get(settings);
      const options = { ...configured, customDirectories: configured.customDirectories?.map(directory => {
        const expanded = expandTilde(directory);
        return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      }) };
      const result = await loadSkills({ ...options, cwd,
        disabledExtensions: cfgDisabledExtensions.get(settings),
        extensionRoots: { explicit: [], configured: cfgExtensions.get(settings),
          configuredLevel: settings.extensionsSourceLevel(), mode: "merge" },
      });
      return result.skills;
    } finally {
      release();
      settings.cancelPendingSaves();
    }
  `, {}))
}
