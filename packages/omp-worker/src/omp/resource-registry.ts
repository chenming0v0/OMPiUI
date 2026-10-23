import type { JsonObject, JsonValue, RegistrySnapshot } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"

/** Runs inside the selected official runtime; reads only public loaded metadata. */
export const nativeExtensionResourcesSource = `function extensionResources(session) {
  const runner = session.extensionRunner;
  const resourceErrors = {};
  if (!runner || typeof runner.getLoadedExtensions !== "function") {
    const message = "The selected OMP runtime cannot enumerate loaded extensions through its public API";
    return { extensions: null, eventHandlers: null, resourceErrors: { extensions: message, eventHandlers: message } };
  }
  let extensions = null;
  let eventHandlers = null;
  try {
    const loaded = runner.getLoadedExtensions();
    if (!Array.isArray(loaded)) throw new Error("Invalid loaded extension metadata");
    const activePaths = typeof runner.getExtensionPaths === "function" ? new Set(runner.getExtensionPaths()) : null;
    extensions = loaded.map(extension => {
      if (typeof extension.path !== "string" || !(extension.tools instanceof Map) || !(extension.commands instanceof Map) || !(extension.handlers instanceof Map)) throw new Error("Incomplete loaded extension metadata");
      const active = typeof runner.isExtensionActive === "function" ? runner.isExtensionActive(extension.path) : activePaths ? activePaths.has(extension.path) : undefined;
      return {
        path: extension.path,
        sourceInfo: { source: "omp-extension", path: extension.resolvedPath ?? extension.path },
        ...(active !== undefined ? { active } : {}),
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()],
        handlers: [...extension.handlers].filter(([, handlers]) => Array.isArray(handlers) && handlers.length > 0).map(([name]) => name),
      };
    });
    if (typeof runner.hasHandlers !== "function") throw new Error("The selected OMP runtime cannot inspect active event handlers through its public API");
    const names = new Set(extensions.flatMap(extension => extension.handlers));
    eventHandlers = [...names].filter(name => runner.hasHandlers(name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (extensions === null) resourceErrors.extensions = message;
    resourceErrors.eventHandlers = message;
  }
  if (Array.isArray(session.promptTemplates) && session.promptTemplates.some(prompt => typeof prompt.filePath !== "string")) resourceErrors.promptPaths = "The selected OMP public prompt metadata does not expose source file paths";
  resourceErrors.reloadScope = "Native OMP reload keeps the current extension runner and prompt templates; skill/file-command discovery can be refreshed through the public refreshSkillsAndCommands API";
  const failures = session.preparedExtensions?.filter(extension => extension.error).map(extension => ({ path: extension.path, error: extension.error }));
  if (failures?.length) resourceErrors.extensionDiscovery = failures;
  return { extensions, eventHandlers, resourceErrors };
}`

/** Missing or failed discovery is unknown, never an authoritative empty list. */
export function requireResourceList(resources: JsonObject, name: string): JsonValue[] {
  const value = resources[name]
  if (!Array.isArray(value)) {
    const detail = isJsonObject(resources.resourceErrors) ? resources.resourceErrors[name] : undefined
    throw Object.assign(new Error(typeof detail === "string" ? detail : `Runtime resource list is unavailable: ${name}`), { code: "RESOURCE_UNAVAILABLE" })
  }
  return value
}

export function registryFromResources(resources: JsonObject, sdkVersion: string): RegistrySnapshot {
  const tools = requireResourceList(resources, "tools").map(tool => {
    if (!isJsonObject(tool) || typeof tool.name !== "string") throw new Error("Invalid runtime tool metadata")
    return { ...tool, name: tool.name, parameters: isJsonObject(tool.parameters) ? tool.parameters : {} }
  })
  const activeTools = requireResourceList(resources, "activeTools").map(name => {
    if (typeof name !== "string") throw new Error("Invalid active tool metadata")
    return name
  })
  const commands = requireResourceList(resources, "commands").map(command => {
    if (!isJsonObject(command) || typeof command.name !== "string") throw new Error("Invalid runtime command metadata")
    return {
      ...command,
      name: command.name,
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : isJsonObject(command.input) && typeof command.input.hint === "string" ? command.input.hint : undefined,
    }
  })
  const resourceErrors: JsonObject = isJsonObject(resources.resourceErrors) ? { ...resources.resourceErrors } : {}
  let extensions: RegistrySnapshot["extensions"] = null
  let eventHandlers: RegistrySnapshot["eventHandlers"] = null
  try {
    extensions = requireResourceList(resources, "extensions").map(extension => {
      if (!isJsonObject(extension) || typeof extension.path !== "string") throw new Error("Invalid runtime extension metadata")
      const names = (key: string): string[] => {
        const value = extension[key]
        if (!Array.isArray(value) || !value.every(name => typeof name === "string")) throw new Error(`Invalid extension ${key} metadata`)
        return value as string[]
      }
      return {
        path: extension.path,
        ...(typeof extension.active === "boolean" ? { active: extension.active } : {}),
        ...(typeof extension.hidden === "boolean" ? { hidden: extension.hidden } : {}),
        sourceInfo: extension.sourceInfo,
        tools: names("tools"), commands: names("commands"), handlers: names("handlers"),
      }
    })
  } catch (error) { resourceErrors.extensions = error instanceof Error ? error.message : String(error) }
  try {
    const names = requireResourceList(resources, "eventHandlers")
    if (!names.every(name => typeof name === "string")) throw new Error("Invalid event handler metadata")
    eventHandlers = names as string[]
  } catch (error) { resourceErrors.eventHandlers = error instanceof Error ? error.message : String(error) }
  return {
    sdkVersion, tools, activeTools, commands, extensions, eventHandlers,
    ...(Array.isArray(resources.skillWarnings) ? { skillWarnings: resources.skillWarnings } : {}),
    ...(Object.keys(resourceErrors).length ? { resourceErrors } : {}),
  }
}
