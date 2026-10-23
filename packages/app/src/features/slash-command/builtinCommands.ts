// OMPiUI-only actions. Native commands and metadata come from the runtime.

export type CommandSource = 'frontend' | 'builtin' | 'api'

export interface Command {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
  subcommands?: Array<{ name: string; description?: string; usage?: string }>
  keybind?: string
  source: CommandSource
}

/** These names deliberately never shadow official slash commands. */
export function getFrontendCommands(): Command[] {
  return [
    { name: 'ui-new', description: 'Open a new OMPiUI chat', source: 'frontend' },
    { name: 'ui-model', description: 'Open the OMPiUI model selector', source: 'frontend' },
    { name: 'ui-settings', description: 'Open OMPiUI settings', source: 'frontend' },
    { name: 'ui-hotkeys', description: 'Open OMPiUI keyboard shortcuts', source: 'frontend' },
    { name: 'ui-about', description: 'Open OMPiUI About', source: 'frontend' },
    { name: 'ui-sessions', description: 'Open the OMPiUI session list', source: 'frontend' },
    { name: 'ui-tree', description: 'Open the OMPiUI session tree panel', source: 'frontend' },
    { name: 'ui-copy', description: 'Copy the last response to the browser clipboard', source: 'frontend' },
    { name: 'ui-terminal', description: 'Hand this session to the official interactive terminal', source: 'frontend' },
  ]
}
