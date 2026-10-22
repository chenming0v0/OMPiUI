import type { JsonObject, JsonValue } from "@ompiui/protocol"
import type { PackagesGateway } from "../command-table.js"
import { runOmpNativeScript } from "./omp-native-script.js"

export type OmpPackageAction = "install" | "link" | "remove" | "update" | "enable" | "disable"

// The SDK is loaded only in a short-lived Bun process. All mutations belong to
// the official managers; this adapter only translates their native metadata.
// Native modules are runtime-selected from the installed CLI, not bundled with
// the worker. The child wrapper cannot use top-level static Node imports.
const PACKAGE_SCRIPT = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const { PluginManager } = await nativeModule("src/extensibility/plugins/manager.ts");
const loader = await nativeModule("src/extensibility/plugins/loader.ts");
const marketplace = await nativeModule("src/extensibility/plugins/marketplace/index.ts");
const helpers = await nativeModule("src/discovery/helpers.ts");
const { classifyInstallTarget } = await nativeModule("src/cli/classify-install-target.ts");
const { parseGitUrl } = await nativeModule("src/extensibility/plugins/git-url.ts");
const { formatPluginSpec } = await nativeModule("src/extensibility/plugins/parser.ts");
const { parsePluginId } = await nativeModule("src/extensibility/plugins/marketplace/types.ts");
const { classifyAgentPluginRoot, parseAgentPluginMcp } = await nativeModule("src/discovery/agent-plugin-format.ts");
const { resolveContainedPath } = await nativeModule("src/discovery/contained-path.ts");
const { getConfigDirPaths } = await nativeModule("src/config.ts");
const { normalizePluginRuntimeConfig } = await nativeModule("src/extensibility/plugins/runtime-config.ts");
const manager = new PluginManager(cwd);
const projectRegistry = await helpers.resolveActiveProjectRegistryPath(cwd);
const marketManager = new marketplace.MarketplaceManager({
  marketplacesRegistryPath: marketplace.getMarketplacesRegistryPath(),
  installedRegistryPath: marketplace.getInstalledPluginsRegistryPath(),
  projectInstalledRegistryPath: projectRegistry ?? await helpers.resolveOrDefaultProjectRegistryPath(cwd),
  marketplacesCacheDir: marketplace.getMarketplacesCacheDir(),
  pluginsCacheDir: marketplace.getPluginsCacheDir(),
});
const scope = input.local ? "project" : "user";
const readJson = async file => {
  try { return await Bun.file(file).json(); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};
const real = async directory => {
  try { return await fs.realpath(directory); }
  catch (error) { if (error.code === "ENOENT") return path.resolve(directory); throw error; }
};
const expand = value => value.replace(/^~(?=[\\/]|$)/, os.homedir());
const userRoot = path.dirname(marketplace.getInstalledPluginsRegistryPath());
const userConfig = normalizePluginRuntimeConfig(await readJson(path.join(userRoot, "omp-plugins.lock.json")));
const projectConfig = projectRegistry ? normalizePluginRuntimeConfig(await readJson(path.join(path.dirname(projectRegistry), "omp-plugins.lock.json"))) : undefined;
let overrides = {};
for (const file of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
  try { overrides = await Bun.file(file).json(); break; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const runtimeFor = (plugin, state) => ({ ...plugin,
  enabled: (state?.enabled ?? true) && !overrides.disabled?.includes(plugin.name),
  enabledFeatures: overrides.features?.[plugin.name] ?? state?.enabledFeatures ?? null,
});
const installed = [];
const marketPlugins = await marketManager.listInstalledPlugins();
for (const plugin of marketPlugins) {
  for (const entry of plugin.entries) {
    const runtime = await manager.getPlugin(plugin.id.split("@")[0], { path: entry.installPath });
    const config = plugin.scope === "project" ? projectConfig : userConfig;
    const state = runtime ? config?.plugins[runtime.name] : undefined;
    const native = runtime ? runtimeFor(runtime, state) : undefined;
    installed.push({ source: plugin.id, scope: plugin.scope, type: "marketplace",
      enabled: entry.enabled !== false && state?.enabled !== false, version: entry.version,
      installedPath: entry.installPath, native,
      runtimeEnabled: entry.enabled !== false && (native?.enabled ?? !overrides.disabled?.includes(plugin.id.split("@")[0])), });
  }
}
const addNpm = async (plugin, pluginScope, deps, state) => {
  const canonical = await real(plugin.path);
  if (await Promise.all(installed.filter(p => p.scope === pluginScope).map(async p => await real(p.installedPath) === canonical)).then(matches => matches.some(Boolean))) return;
  const dependency = deps[plugin.name];
  const linked = await fs.lstat(plugin.path).then(stat => stat.isSymbolicLink());
  installed.push({ source: plugin.name, scope: pluginScope,
    type: dependency && parseGitUrl(dependency) ? "git" : linked && !dependency ? "link" : "npm",
    version: plugin.version, enabled: state?.enabled !== false,
    installedPath: plugin.path, native: runtimeFor(plugin, state),
    runtimeEnabled: (state?.enabled ?? true) && !overrides.disabled?.includes(plugin.name), dependency });
};
for (const plugin of await manager.list()) {
  // Scoped package paths have an extra @scope segment.
  const root = plugin.name.startsWith("@") ? path.dirname(path.dirname(path.dirname(plugin.path))) : path.dirname(path.dirname(plugin.path));
  const deps = (await readJson(path.join(root, "package.json"))).dependencies ?? {};
  await addNpm(plugin, "user", deps, userConfig.plugins[plugin.name]);
}
if (projectRegistry) {
  const root = path.dirname(projectRegistry);
  const config = projectConfig;
  const deps = (await readJson(path.join(root, "package.json"))).dependencies ?? {};
  for (const name of new Set([...Object.keys(deps), ...Object.keys(config.plugins ?? {})])) {
    const plugin = await manager.getPlugin(name, { path: path.join(root, "node_modules", name) });
    if (plugin) await addNpm(plugin, "project", deps, config.plugins?.[name]);
  }
}
for (const item of installed.filter(p => p.scope === "user")) {
  if (installed.some(p => p.scope === "project" && p.runtimeEnabled && (p.source === item.source || p.native?.name && p.native.name === item.native?.name))) item.shadowedBy = "project";
}
const snapshot = async () => ({
  packages: installed.map(({ native, dependency, runtimeEnabled, ...item }) => item),
  marketplaces: (await marketManager.listMarketplaces()).map(({ name, sourceUri, sourceType, catalogPath }) => ({ name, source: sourceUri, sourceType, catalogPath })),
});
const find = (source, requestedScope) => {
  const exact = installed.filter(p => p.source === source && (!requestedScope || p.scope === requestedScope));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error("Plugin is installed in multiple scopes; specify user or project: " + source);
  throw new Error("Plugin is not installed" + (requestedScope ? " in " + requestedScope + " scope" : "") + ": " + source);
};
const requireUser = item => {
  if (item.scope !== "user") throw new Error("Native npm/link plugin management supports user scope only. Project scope is supported for marketplace plugins.");
};
if (input.operation === "list") return await snapshot();
if (input.operation === "installedPath") {
  const item = find(input.source, input.scope);
  if (!(await fs.stat(item.installedPath)).isDirectory()) throw new Error("Installed plugin path is not a directory: " + item.installedPath);
  return item.installedPath;
}
if (input.operation === "changeSource") {
  if (input.local) throw new Error("Native marketplace sources are profile-wide, not project-local.");
  if (input.change === "add") {
    const target = classifyInstallTarget(input.source, new Set());
    await marketManager.addMarketplace(target.type === "local" ? path.resolve(cwd, expand(input.source)) : input.source);
  }
  else await marketManager.removeMarketplace(input.source);
  return { changed: true };
}
if (input.operation === "checkUpdates") {
  await marketManager.updateAllMarketplaces();
  return (await marketManager.checkForUpdates()).map(update => ({ source: update.pluginId,
    displayName: update.pluginId, type: "marketplace", scope: update.scope, from: update.from, to: update.to }));
}
if (input.operation === "manage") {
  const install = async (source, force = false) => {
    const known = new Set((await marketManager.listMarketplaces()).map(m => m.name));
    const target = classifyInstallTarget(source, known);
    if (target.type === "marketplace") return marketManager.installPlugin(target.name, target.marketplace, { scope, force });
    requireUser({ scope });
    if (target.type === "local") return manager.link(path.resolve(cwd, expand(target.path)));
    return manager.install(target.spec, { force });
  };
  if (input.action === "install") await install(input.source);
  else if (input.action === "link") {
    requireUser({ scope });
    await manager.link(path.resolve(cwd, expand(input.source)));
  } else {
    const targets = input.source ? [find(input.source, scope)] : installed.filter(p => p.scope === scope && (p.type === "marketplace" || p.scope === "user"));
    if (!targets.length) throw new Error("No managed plugins are installed in " + scope + " scope.");
    if (input.action === "update") for (const item of targets) if (item.type !== "marketplace") requireUser(item);
    if (input.action === "update") {
      const catalogs = new Set(targets.filter(p => p.type === "marketplace").map(p => parsePluginId(p.source).marketplace));
      for (const catalog of catalogs) await marketManager.updateMarketplace(catalog);
      for (const item of targets) {
        if (item.type === "marketplace") await marketManager.upgradePlugin(item.source, item.scope);
        else {
          requireUser(item);
          const state = userConfig.plugins[item.native.name];
          if (item.type === "link") await manager.link(await real(item.installedPath));
          else await manager.install(formatPluginSpec({ packageName: item.type === "git" ? item.dependency : item.source,
            features: state?.enabledFeatures ?? null }), { force: true });
          if (state) {
            await manager.setEnabledFeatures(item.source, state.enabledFeatures ?? null);
            await manager.setEnabled(item.source, state.enabled !== false);
          }
        }
      }
    } else {
      const item = targets[0];
      if (input.action === "remove") {
        if (item.type === "marketplace") await marketManager.uninstallPlugin(item.source, item.scope);
        else { requireUser(item); await manager.uninstall(item.source); }
      } else {
        const enabled = input.action === "enable";
        if (item.type === "marketplace") await marketManager.setPluginEnabled(item.source, enabled, item.scope);
        else { requireUser(item); await manager.setEnabled(item.source, enabled); }
      }
    }
  }
  return true;
}
const selected = [];
const localDirs = [];
if (input.operation === "resolveSources") {
  for (const source of input.sources) {
    const existing = installed.filter(p => p.source === source && (!input.local || p.scope === "project"));
    const item = existing.find(p => p.scope === "project" && p.runtimeEnabled) ?? existing.find(p => p.scope === "user") ?? existing[0];
    if (item) { selected.push(item); if (!item.runtimeEnabled || item.shadowedBy) localDirs.push(item.installedPath); continue; }
    const target = classifyInstallTarget(source, new Set());
    if (target.type !== "local") throw new Error("Plugin is not installed: " + source + ". Install it explicitly before resolving.");
    const directory = path.resolve(cwd, expand(target.path));
    if (!(await fs.stat(directory)).isDirectory()) throw new Error("Plugin source is not a directory: " + source);
    const pkg = await readJson(path.join(directory, "package.json"));
    selected.push({ source, scope, enabled: true, installedPath: directory,
      native: pkg.omp || pkg.pi ? { name: pkg.name ?? source, path: directory, manifest: pkg.omp ?? pkg.pi, enabledFeatures: null, enabled: true } : undefined });
    localDirs.push(directory);
  }
} else selected.push(...installed.filter(p => p.runtimeEnabled && !p.shadowedBy));
const resources = { extensions: [], tools: [], hooks: [], commands: [], skills: [], prompts: [], rules: [], mcpServers: [], warnings: [] };
for (const item of selected) {
  const status = await classifyAgentPluginRoot(item.installedPath);
  if (status.kind === "invalid") { resources.warnings.push(item.source + ": " + status.reason); continue; }
  if (!item.native) continue;
  for (const [kind, key] of [["extensions", "extensions"], ["tools", "tools"], ["hooks", "hooks"], ["commands", "commands"]]) {
    for (const entry of loader.resolvePluginManifestEntries(item.native, key)) {
      if (entry.resolvedPath) resources[kind].push({ path: entry.resolvedPath, enabled: item.runtimeEnabled ?? item.enabled, scope: item.scope, source: item.source });
      else resources.warnings.push("Missing " + key + " manifest entry in " + item.source + ": " + entry.entry);
    }
  }
}
await nativeModule("src/discovery/index.ts");
const discovery = await nativeModule("src/capability/index.ts");
const { Settings } = await nativeModule("src/config/settings.ts");
const { cfgDisabledExtensions } = await nativeModule("src/extensibility/settings.ts");
const settings = await Settings.loadReadOnly({ cwd });
const release = discovery.initializeWithSettings(settings);
const disabledExtensions = new Set(cfgDisabledExtensions.get(settings));
if (localDirs.length) await helpers.injectPluginDirRoots(os.homedir(), localDirs, cwd);
const roots = await Promise.all(selected.map(async item => {
  const canonical = await real(item.installedPath);
  const runtimeRoot = item.scope === "project" && projectRegistry ? path.dirname(projectRegistry) : userRoot;
  const aliases = [path.resolve(item.installedPath), canonical];
  if (item.native?.name) aliases.push(path.join(runtimeRoot, "node_modules", item.native.name));
  return { item, path: canonical, aliases };
}));
const owner = async file => {
  const resolved = await real(file);
  return roots.find(root => { const relative = path.relative(root.path, resolved); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); })?.item;
};
try {
  for (const [kind, capability] of [["tools", "tools"], ["hooks", "hooks"], ["commands", "slash-commands"], ["skills", "skills"], ["prompts", "prompts"], ["rules", "rules"], ["mcpServers", "mcps"]]) {
    const loaded = await discovery.loadCapability(capability, {
      cwd, providers: capability === "mcps" ? ["omp-plugins", "claude-plugins"] : ["omp-plugins", "claude-plugins", "agent-plugins"], includeDisabled: true,
      extensionRoots: { explicit: selected.map(item => item.installedPath), configured: [], configuredLevel: scope, mode: "explicit-only" },
      filter: item => roots.some(root => root.aliases.some(directory => {
        const relative = path.relative(directory, item.path ?? item._source.path);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      })),
    });
    resources.warnings.push(...loaded.warnings);
    const resourceCapability = discovery.getCapability(capability);
    for (const item of loaded.items) {
      const file = item.path ?? item._source.path;
      const plugin = await owner(file);
      if (!plugin) continue;
      const extensionId = resourceCapability?.toExtensionId?.(item);
      const row = { path: file, name: item.name, enabled: (plugin.runtimeEnabled ?? plugin.enabled) && item.enabled !== false && !item._shadowed && !disabledExtensions.has(extensionId),
        scope: plugin.scope, source: plugin.source };
      const previous = resources[kind].find(previous => previous.path === row.path && (!previous.name || previous.name === row.name));
      if (previous) Object.assign(previous, row);
      else resources[kind].push(row);
    }
  }
  // The native Agent Plugins MCP provider creates its launch-time data directory.
  // Inspection uses its public contained-path parser instead, so resolve stays read-only.
  for (const plugin of selected) {
    const status = await classifyAgentPluginRoot(plugin.installedPath);
    if (status.kind !== "standard") continue;
    const contained = await resolveContainedPath(status.realRoot, path.join(status.realRoot, "mcp.json"));
    if (contained.status === "missing") continue;
    if (contained.status !== "ok") { resources.warnings.push(plugin.source + ": mcp.json resolves outside the plugin root"); continue; }
    const instanceKey = plugin.type === "marketplace" ? plugin.source + "#" + plugin.scope : "ext:" + plugin.installedPath;
    const digest = new Bun.CryptoHasher("sha256").update(instanceKey).digest("hex").slice(0, 16);
    const parsed = await parseAgentPluginMcp(await fs.readFile(contained.realPath, "utf8"), {
      pluginRoot: status.realRoot, pluginData: path.join(userRoot, "data", status.manifest.name + "-" + digest),
    });
    if (parsed.status !== "ok") { resources.warnings.push(plugin.source + ": MCP disabled: " + parsed.reason); continue; }
    resources.warnings.push(...parsed.warnings.map(warning => plugin.source + ": " + warning));
    for (const server of parsed.servers) resources.mcpServers.push({ path: contained.realPath, name: status.manifest.name + ":" + server.name,
      enabled: (plugin.runtimeEnabled ?? plugin.enabled) && discovery.isProviderEnabled("agent-plugins") && !disabledExtensions.has("mcp:" + status.manifest.name + ":" + server.name), scope: plugin.scope, source: plugin.source });
  }
} finally { release(); settings.cancelPendingSaves(); }
return resources;
`

export class OmpPackages implements PackagesGateway {
  private call(cwd: string, input: JsonObject): Promise<JsonValue> {
    return runOmpNativeScript<JsonValue>(cwd, PACKAGE_SCRIPT, input)
  }

  list(cwd: string): Promise<JsonValue> {
    return this.call(cwd, { operation: "list" })
  }

  async manage(cwd: string, commandId: string, action: OmpPackageAction, source?: string, local = false,
    onProgress?: (event: JsonObject) => void): Promise<JsonValue> {
    if (action !== "update" && !source?.trim()) throw new Error(`Plugin source is required for ${action}`)
    onProgress?.({ commandId, action, phase: "started", ...(source ? { source } : {}) })
    try {
      await this.call(cwd, { operation: "manage", action, local, ...(source ? { source: source.trim() } : {}) })
      const result = await this.list(cwd)
      onProgress?.({ commandId, action, phase: "completed" })
      return result
    } catch (error) {
      onProgress?.({ commandId, action, phase: "failed", message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  resolve(cwd: string): Promise<JsonValue> {
    return this.call(cwd, { operation: "resolve" })
  }

  resolveSources(cwd: string, sources: string[], local = false): Promise<JsonValue> {
    if (!sources.length || sources.some(source => !source.trim())) throw new Error("At least one plugin source is required")
    return this.call(cwd, { operation: "resolveSources", sources, local })
  }

  async changeSource(cwd: string, source: string, operation: "add" | "remove", local = false): Promise<JsonValue> {
    await this.call(cwd, { operation: "changeSource", source, change: operation, local })
    return { ...(await this.list(cwd) as JsonObject), changed: true }
  }

  installedPath(cwd: string, source: string, scope: "user" | "project"): Promise<JsonValue> {
    return this.call(cwd, { operation: "installedPath", source, scope })
  }

  checkUpdates(cwd: string): Promise<JsonValue> {
    return this.call(cwd, { operation: "checkUpdates" })
  }
}
