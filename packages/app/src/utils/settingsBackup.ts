import Ajv from 'ajv'
import { isJsonObject } from '@ompiui/protocol'
import { STORAGE_KEY_NOTIFICATIONS_ENABLED } from '../constants/storage'
import {
  exportLayoutBackup,
  exportNotificationEventSettingsBackup,
  exportNotificationPreferencesBackup,
  exportServerSettingsBackup,
  exportServiceSettingsBackup,
  exportThemeBackup,
  exportUpdateSettingsBackup,
  importLayoutBackup,
  importNotificationEventSettingsBackup,
  importNotificationPreferencesBackup,
  importServerSettingsBackup,
  importServiceSettingsBackup,
  importThemeBackup,
  importUpdateSettingsBackup,
  type LayoutBackup,
  type NotificationEventSettingsBackup,
  type NotificationPreferencesBackup,
  type ServerSettingsBackup,
  type ServiceSettingsBackup,
  type ThemeBackup,
  type UpdateSettingsBackup,
} from '../store'
import { exportKeybindingBackup, importKeybindingBackup, type KeybindingBackup } from '../store/keybindingStore'
import { exportSoundBackup, importSoundBackup, type SoundBackup } from '../store/soundStore'
import {
  exportPerServerStorageBackup,
  importPerServerStorageBackup,
  type PerServerStorageBackup,
} from './perServerStorage'

const BACKUP_KIND = 'settings-backup'
const BACKUP_SCHEMA_VERSION = 4

export interface NotificationBackup {
  browserNotificationsEnabled: boolean
  toast: NotificationPreferencesBackup
  events: NotificationEventSettingsBackup
}

export interface SettingsBackupModules {
  theme: ThemeBackup
  layout: LayoutBackup
  servers: ServerSettingsBackup
  perServerStorage: PerServerStorageBackup
  service: ServiceSettingsBackup
  keybindings: KeybindingBackup
  notifications: NotificationBackup
  sound: SoundBackup
  update: UpdateSettingsBackup
}

export interface SettingsBackupFile {
  app: 'OMPiUI'
  kind: typeof BACKUP_KIND
  schemaVersion: typeof BACKUP_SCHEMA_VERSION
  createdAt: string
  modules: SettingsBackupModules
}

function exportNotificationBackup(): NotificationBackup {
  return {
    browserNotificationsEnabled: localStorage.getItem(STORAGE_KEY_NOTIFICATIONS_ENABLED) === 'true',
    toast: exportNotificationPreferencesBackup(),
    events: exportNotificationEventSettingsBackup(),
  }
}

function importNotificationBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const browserNotificationsEnabled = parsed?.browserNotificationsEnabled === true

  if (browserNotificationsEnabled) {
    localStorage.setItem(STORAGE_KEY_NOTIFICATIONS_ENABLED, 'true')
  } else {
    localStorage.removeItem(STORAGE_KEY_NOTIFICATIONS_ENABLED)
  }

  importNotificationPreferencesBackup(parsed?.toast)
  importNotificationEventSettingsBackup(parsed?.events)
}

const validateBackupModules = new Ajv({ strict: false }).compile<SettingsBackupModules>({
  type: 'object',
  required: ['theme', 'layout', 'servers', 'perServerStorage', 'service', 'keybindings', 'notifications', 'sound', 'update'],
  $defs: {
    stringMap: { type: 'object', additionalProperties: { type: 'string' } },
    nullableString: { type: ['string', 'null'] },
    panelActiveIds: {
      type: 'object', required: ['bottom', 'right'],
      properties: { bottom: { $ref: '#/$defs/nullableString' }, right: { $ref: '#/$defs/nullableString' } },
    },
    terminalDirectory: {
      type: 'object', required: ['order', 'activeTabId'],
      properties: {
        order: { type: 'object', required: ['bottom', 'right'], properties: { bottom: { type: 'array', items: { type: 'string', minLength: 1 } }, right: { type: 'array', items: { type: 'string', minLength: 1 } } } },
        activeTabId: { $ref: '#/$defs/panelActiveIds' },
        sessions: {
          type: 'object', additionalProperties: {
            type: 'object',
            properties: {
              title: { type: 'string' }, shellTitle: { type: 'string' }, customTitle: { type: 'string' }, buffer: { type: 'string' },
              scrollY: { type: 'number' }, cursor: { type: 'number' }, rows: { type: 'number' }, cols: { type: 'number' },
            },
          },
        },
      },
    },
    notificationEvents: {
      type: 'object', required: ['completed', 'permission', 'question', 'error'],
      additionalProperties: { type: 'object', required: ['systemEnabled'], properties: { systemEnabled: { type: 'boolean' } } },
    },
    soundEvents: {
      type: 'object', required: ['completed', 'permission', 'question', 'error'],
      additionalProperties: { type: 'object', required: ['soundId'], properties: { soundId: { type: 'string' }, customFileName: { type: 'string' } } },
    },
  },
  properties: {
    theme: {
      type: 'object', required: ['presetId', 'colorMode', 'customCSS'],
      properties: {
        presetId: { type: 'string' }, colorMode: { enum: ['light', 'dark', 'system'] }, customCSS: { type: 'string' },
        customCSSSnippets: { type: 'array', items: { type: 'object', required: ['id', 'name', 'css'], properties: { id: { type: 'string' }, name: { type: 'string' }, css: { type: 'string' } } } },
        activeCustomCSSSnippetId: { $ref: '#/$defs/nullableString' },
        ...Object.fromEntries(['collapseUserMessages', 'renderUserMarkdown', 'wideMode', 'descriptiveToolSteps', 'codeWordWrap', 'immersiveMode', 'glassEffect', 'queueFollowupMessages', 'manualTerminalTitles', 'outlineCurrentHighlight', 'autoExpandExtensionsOnCommand', 'actionsOnLatestAssistantOnly', 'desktopCollapsedInputDock', 'processCollapseEnabled'].map(key => [key, { type: 'boolean' }])),
        uiFontScale: { type: 'number' }, codeFontScale: { type: 'number' },
        stepFinishDisplay: { type: 'object', additionalProperties: { type: 'boolean' } },
        completedAtFormat: { enum: ['time', 'dateTime'] }, reasoningDisplayMode: { enum: ['capsule', 'italic', 'markdown'] },
        diffStyle: { enum: ['markers', 'changeBars'] }, toolCardStyle: { enum: ['classic', 'compact'] },
        externalFileDropMode: { enum: ['upload-first', 'mention'] }, codeBlockThemeLight: { type: 'string' }, codeBlockThemeDark: { type: 'string' },
      },
    },
    layout: {
      type: 'object', required: ['sidebarExpanded', 'rightPanelWidth', 'bottomPanelHeight'],
      properties: {
        sidebarExpanded: { type: 'boolean' }, sidebarFolderRecents: { type: 'boolean' }, sidebarShowChildSessions: { type: 'boolean' }, wakeLock: { type: 'boolean' },
        rightPanelWidth: { type: 'number' }, bottomPanelHeight: { type: 'number' }, sidebarWidth: { type: ['number', 'null'] },
        panelLayout: {
          type: 'object', required: ['version', 'panelTabs', 'activeTabId'],
          properties: {
            version: { const: 1 }, rightPanelOpen: { type: 'boolean' }, bottomPanelOpen: { type: 'boolean' },
            activeTabId: { $ref: '#/$defs/panelActiveIds' },
            panelTabs: { type: 'array', items: { type: 'object', required: ['id', 'type', 'position'], properties: { id: { type: 'string', minLength: 1 }, type: { enum: ['files', 'changes', 'session-tree', 'session-controls', 'skill', 'extensions'] }, position: { enum: ['bottom', 'right'] }, title: { type: 'string' } } } },
          },
        },
        terminalLayout: { type: 'object', required: ['version', 'directories'], properties: { version: { const: 1 }, directories: { type: 'object', additionalProperties: { $ref: '#/$defs/terminalDirectory' } } } },
      },
    },
    servers: {
      type: 'object', required: ['servers', 'activeServerId'],
      properties: {
        activeServerId: { $ref: '#/$defs/nullableString' },
        servers: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'name', 'url'], properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' }, url: { type: 'string' }, token: { type: 'string' }, isDefault: { type: 'boolean' } } } },
      },
    },
    perServerStorage: { type: 'object', required: ['entries'], properties: { entries: { $ref: '#/$defs/stringMap' } } },
    service: {
      type: 'object', required: ['autoStart', 'envVars'],
      properties: {
        autoStart: { type: 'boolean' },
        envVars: {
          type: 'array', items: {
            type: 'object', required: ['key', 'value'],
            properties: { key: { type: 'string' }, value: { type: 'string' } },
          },
        },
      },
    },
    keybindings: { type: 'object', required: ['customKeys'], properties: { customKeys: { $ref: '#/$defs/stringMap' } } },
    notifications: {
      type: 'object', required: ['browserNotificationsEnabled', 'toast', 'events'],
      properties: { browserNotificationsEnabled: { type: 'boolean' }, toast: { type: 'object', required: ['toastEnabled'], properties: { toastEnabled: { type: 'boolean' } } }, events: { type: 'object', required: ['events'], properties: { events: { $ref: '#/$defs/notificationEvents' } } } },
    },
    sound: {
      type: 'object', required: ['settings', 'customAudio'],
      properties: {
        settings: { type: 'object', required: ['enabled', 'currentSessionEnabled', 'volume', 'events'], properties: { enabled: { type: 'boolean' }, currentSessionEnabled: { type: 'boolean' }, volume: { type: 'number', minimum: 0, maximum: 100 }, events: { $ref: '#/$defs/soundEvents' } } },
        customAudio: { type: 'object', additionalProperties: { type: 'object', required: ['base64', 'mimeType'], properties: { base64: { type: 'string' }, mimeType: { type: 'string' }, fileName: { type: 'string' } } } },
      },
    },
    update: {
      type: 'object', required: ['latestRelease', 'lastCheckedAt', 'dismissedVersion'],
      properties: { lastCheckedAt: { type: ['number', 'null'] }, dismissedVersion: { $ref: '#/$defs/nullableString' }, latestRelease: { anyOf: [{ type: 'null' }, { type: 'object', required: ['version', 'tagName', 'url', 'publishedAt', 'name'], properties: { version: { type: 'string' }, tagName: { type: 'string' }, url: { type: 'string' }, publishedAt: { $ref: '#/$defs/nullableString' }, name: { $ref: '#/$defs/nullableString' } } }] } },
    },
  },
})

function normalizeBackupFile(raw: unknown): SettingsBackupFile {
  if (!isJsonObject(raw)) {
    throw new Error('Invalid backup file')
  }

  // 改名前导出的备份 app 字段是 'PiUI'，导入时一并接受
  if ((raw.app !== 'OMPiUI' && raw.app !== 'PiUI') || raw.kind !== BACKUP_KIND || raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error('Unsupported backup format')
  }

  if (!isJsonObject(raw.modules)) {
    throw new Error('Missing backup modules')
  }

  const modules = raw.modules
  if (!validateBackupModules(modules)) {
    const error = validateBackupModules.errors?.[0]
    throw new Error(`Invalid backup module: ${error?.instancePath || '/modules'} ${error?.message || ''}`)
  }
  for (const server of modules.servers.servers) {
    try {
      const url = new URL(server.url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported server URL')
    } catch {
      throw new Error('Invalid backup module: servers.url')
    }
  }
  // 在任何存储写入前解码，避免替换服务器配置后才发现音频损坏。
  for (const audio of Object.values(modules.sound.customAudio)) {
    if (!audio) continue
    try { atob(audio.base64) } catch { throw new Error('Invalid backup module: sound.customAudio') }
  }

  return {
    app: 'OMPiUI',
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    modules,
  }
}

function buildBackupFileName(createdAt: string): string {
  const safeTimestamp = createdAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z')
  return `ompiui-settings-backup-${safeTimestamp}.json`
}

export async function exportSettingsBackup(): Promise<{
  fileName: string
  data: Uint8Array
}> {
  const createdAt = new Date().toISOString()
  const backup: SettingsBackupFile = {
    app: 'OMPiUI',
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    modules: {
      theme: exportThemeBackup(),
      layout: exportLayoutBackup(),
      servers: exportServerSettingsBackup(),
      perServerStorage: exportPerServerStorageBackup(),
      service: exportServiceSettingsBackup(),
      keybindings: exportKeybindingBackup(),
      notifications: exportNotificationBackup(),
      sound: await exportSoundBackup(),
      update: exportUpdateSettingsBackup(),
    },
  }

  return {
    fileName: buildBackupFileName(createdAt),
    data: new TextEncoder().encode(`${JSON.stringify(backup, null, 2)}\n`),
  }
}

export async function importSettingsBackup(file: File): Promise<void> {
  const text = await file.text()
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Invalid backup file')
  }

  const backup = normalizeBackupFile(parsed)

  importThemeBackup(backup.modules.theme)
  importLayoutBackup(backup.modules.layout)
  importServerSettingsBackup(backup.modules.servers)
  importPerServerStorageBackup(backup.modules.perServerStorage)
  importServiceSettingsBackup(backup.modules.service)
  importKeybindingBackup(backup.modules.keybindings)
  importNotificationBackup(backup.modules.notifications)
  await importSoundBackup(backup.modules.sound)
  importUpdateSettingsBackup(backup.modules.update)
}

export function previewBackupMeta(file: File): Promise<{ createdAt: string | null }> {
  return file.text().then(text => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      return {
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      }
    } catch {
      return { createdAt: null }
    }
  })
}
