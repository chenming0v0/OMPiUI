import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { runOmpNativeScript } from "./omp-native-script.js"

// All setting membership, normalization and validation remain owned by the installed registry.
const settingsScript = `
  // This source is embedded in a subprocess function, so static imports cannot appear here.
  const fs = await import("node:fs/promises");
  const crypto = await import("node:crypto");
  const { Settings } = await nativeModule("src/config/settings.ts");
  const registry = await nativeModule("src/config/registry.ts");
  const { replaceFileAtomically } = await nativeModule("src/utils/atomic-file.ts");
  const { loadCapability } = await nativeModule("src/discovery/index.ts");
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const safeSegments = id => {
    const segments = id.split(".");
    if (segments.some(key => !key || ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Invalid settings path: " + id);
    return segments;
  };
  const get = (object, segments) => segments.reduce((value, key) => record(value) ? value[key] : undefined, object);
  const put = (object, segments, value) => {
    let target = object;
    for (const key of segments.slice(0, -1)) target = target[key] ??= {};
    target[segments.at(-1)] = value;
  };
  const snapshot = settings => {
    const effective = {};
    for (const setting of registry.all()) {
      const value = setting.get(settings);
      if (value !== undefined) put(effective, safeSegments(setting.id), structuredClone(value));
    }
    const definitions = registry.all().map(setting => ({ id: setting.id, type: setting.type, ...(setting.enumValues ? { values: [...setting.enumValues] } : {}) }));
    return { workspacePath: settings.getCwd(), global: settings.getGlobalSettings(), project: settings.getProjectSettings(), effective, definitions, errors: [] };
  };
  const discovered = await loadCapability("settings", { cwd });
  if (discovered.warnings?.length) throw new Error("OMP settings discovery failed: " + discovered.warnings.join("; "));
  const settings = await Settings.loadReadOnly({ cwd });
  try {
    // The registry normally warns and falls back for stale typed values; this editing surface must not hide them.
    for (const layer of [settings.getGlobalSettings(), settings.getProjectSettings()]) {
      for (const setting of registry.all()) {
        for (let length = 1; length < setting.segments.length; length++) {
          const parent = get(layer, setting.segments.slice(0, length));
          if (parent !== undefined && parent !== null && !record(parent)) throw new Error("Invalid OMP settings group: " + setting.segments.slice(0, length).join("."));
        }
        const value = get(layer, setting.segments);
        if (value !== undefined && value !== null && !setting.definition.pathScoped) setting.assertWritable(value);
      }
    }
    if (input.operation === "get") return snapshot(settings);
    if (!record(input.patch)) throw new Error("Settings patch must be a JSON object");
    const operations = new Map();
    const mergeRecord = (base, patch) => {
      const next = record(base) ? structuredClone(base) : {};
      for (const [key, value] of Object.entries(patch)) {
        safeSegments(key);
        if (value === null) delete next[key];
        else next[key] = record(value) ? mergeRecord(next[key], value) : value;
      }
      return next;
    };
    const add = (id, value, role) => {
      if (operations.has(id)) throw new Error("Duplicate settings patch path: " + id);
      operations.set(id, { id, value, role });
    };
    const visit = (patch, prefix = "") => {
      for (const [key, value] of Object.entries(patch)) {
        const id = prefix ? prefix + "." + key : key;
        safeSegments(id);
        if (id === "modelRoles" && record(value)) {
          for (const [role, model] of Object.entries(value)) {
            if (!role || role.includes(".") || ["__proto__", "prototype", "constructor"].includes(role)) throw new Error("Invalid model role: " + role);
            if (model !== null && (typeof model !== "string" || !model.trim())) throw new Error("Model role " + role + " must be a non-empty model selector or null");
            add("modelRoles." + role, model, role);
          }
        } else if (id.startsWith("modelRoles.")) {
          const role = id.slice("modelRoles.".length);
          if (!role || role.includes(".")) throw new Error("Invalid model role: " + role);
          if (value !== null && (typeof value !== "string" || !value.trim())) throw new Error("Model role " + role + " must be a non-empty model selector or null");
          add(id, value, role);
        } else {
          const setting = registry.lookup(id);
          if (setting) {
            // Some official normalizers coerce malformed shapes; JSON patches must still fit the declared type.
            if (value !== null && !setting.accepts(value)) setting.assertWritable(value);
            add(id, value);
          } else if (record(value) && registry.all().some(setting => setting.id.startsWith(id + "."))) visit(value, id);
          else throw new Error("Unknown OMP setting: " + id);
        }
      }
    };
    visit(input.patch);
    if (operations.has("modelRoles") && [...operations.values()].some(operation => operation.role)) throw new Error("Cannot reset modelRoles and patch individual roles together");
    const preview = settings.overlay();
    for (const operation of operations.values()) {
      if (operation.role) preview.setModelRole(operation.role, operation.value ?? undefined);
      else {
        const setting = registry.lookup(operation.id);
        if (operation.value === null) setting.unset(preview);
        else setting.set(preview, setting.type === "record" && record(operation.value) ? mergeRecord(get(settings.getGlobalSettings(), setting.segments), operation.value) : operation.value);
      }
    }
    // Match models.yml.bak: retain exact pre-write bytes in one backup before the official flush.
    if (operations.size) {
      const agentDir = settings.getAgentDir();
      for (const filename of ["config.yml", "config.yaml"]) {
        const file = path.join(agentDir, filename);
        let bytes;
        try { bytes = await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const backup = file + ".bak";
        // The official Windows replacement helper moves any existing target aside; a directory is not a backup file.
        try {
          if (!(await fs.stat(backup)).isFile()) throw new Error("OMP settings backup path is not a file: " + backup);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        const temp = backup + "." + crypto.randomUUID() + ".tmp";
        try {
          const handle = await fs.open(temp, "wx", 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await replaceFileAtomically(temp, backup);
        } finally { await fs.rm(temp, { force: true }); }
        break;
      }
    }
    if (!operations.size) return snapshot(settings);
    const writable = await Settings.loadIsolated({ cwd, agentDir: settings.getAgentDir() });
    try {
      const expected = new Map();
      for (const operation of operations.values()) {
        if (operation.role) writable.setModelRole(operation.role, operation.value ?? undefined);
        else {
          const setting = registry.lookup(operation.id);
          if (operation.value === null) setting.unset(writable);
          else setting.set(writable, setting.type === "record" && record(operation.value) ? mergeRecord(get(writable.getGlobalSettings(), setting.segments), operation.value) : operation.value);
        }
        expected.set(operation.id, get(writable.getGlobalSettings(), safeSegments(operation.id)));
      }
      await writable.flush();
      const saved = await Settings.loadReadOnly({ cwd, agentDir: settings.getAgentDir() });
      try {
        const global = saved.getGlobalSettings();
        for (const [id, value] of expected) {
          if (!Bun.deepEquals(get(global, safeSegments(id)), value)) throw new Error("OMP settings write was not persisted (external edit conflict): " + id);
        }
        return snapshot(saved);
      } finally { saved.cancelPendingSaves(); }
    } finally { writable.cancelPendingSaves(); }
  } finally { settings.cancelPendingSaves(); }
`

/** Official raw global/project scopes and registry-resolved effective settings for cwd. */
export function getOmpSettings(cwd: string): Promise<JsonValue> {
  return runOmpNativeScript(cwd, settingsScript, { operation: "get" })
}

/** Persist a global partial patch of official nested/dotted keys; null removes a global override. */
export function patchOmpSettings(cwd: string, patch: JsonObject): Promise<JsonValue> {
  return runOmpNativeScript(cwd, settingsScript, { operation: "patch", patch })
}
