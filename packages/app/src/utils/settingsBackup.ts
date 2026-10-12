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

function validateBackupModules(modules: Record<string, unknown>): void {
  const invalid: (id: string) => never = id => { throw new Error(`Invalid backup module: ${id}`) }
  for (const [id, module] of Object.entries(modules)) {
    if (!isJsonObject(module)) invalid(id)
  }
  const theme = modules.theme as Record<string, unknown>
  if (typeof theme.presetId !== 'string' || !['light', 'dark', 'system'].includes(String(theme.colorMode)) || typeof theme.customCSS !== 'string') invalid('theme')
  for (const [key, value] of Object.entries(theme)) {
    if (['collapseUserMessages', 'renderUserMarkdown', 'wideMode', 'descriptiveToolSteps', 'codeWordWrap', 'immersiveMode', 'glassEffect', 'queueFollowupMessages', 'manualTerminalTitles', 'outlineCurrentHighlight', 'autoExpandExtensionsOnCommand', 'actionsOnLatestAssistantOnly', 'desktopCollapsedInputDock', 'processCollapseEnabled'].includes(key) && typeof value !== 'boolean') invalid(`theme.${key}`)
    if (['uiFontScale', 'codeFontScale'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value))) invalid(`theme.${key}`)
  }
  if (theme.customCSSSnippets !== undefined && (!Array.isArray(theme.customCSSSnippets) || theme.customCSSSnippets.some(item => !isJsonObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.css !== 'string'))) invalid('theme.customCSSSnippets')

  const layout = modules.layout as Record<string, unknown>
  if (typeof layout.sidebarExpanded !== 'boolean' || typeof layout.rightPanelWidth !== 'number' || !Number.isFinite(layout.rightPanelWidth) || typeof layout.bottomPanelHeight !== 'number' || !Number.isFinite(layout.bottomPanelHeight)) invalid('layout')
  for (const key of ['sidebarFolderRecents', 'sidebarShowChildSessions', 'wakeLock']) {
    if (layout[key] !== undefined && typeof layout[key] !== 'boolean') invalid(`layout.${key}`)
  }
  if (layout.panelLayout !== undefined && (!isJsonObject(layout.panelLayout) || layout.panelLayout.version !== 1 || !Array.isArray(layout.panelLayout.panelTabs) || !isJsonObject(layout.panelLayout.activeTabId))) invalid('layout.panelLayout')
  if (layout.terminalLayout !== undefined && (!isJsonObject(layout.terminalLayout) || layout.terminalLayout.version !== 1 || !isJsonObject(layout.terminalLayout.directories))) invalid('layout.terminalLayout')

  const servers = modules.servers as Record<string, unknown>
  if (!Array.isArray(servers.servers) || servers.servers.length === 0 || servers.servers.some(server => !isJsonObject(server) || typeof server.id !== 'string' || !server.id || typeof server.name !== 'string' || typeof server.url !== 'string' || (server.token !== undefined && typeof server.token !== 'string') || (server.isDefault !== undefined && typeof server.isDefault !== 'boolean')) || (servers.activeServerId !== null && typeof servers.activeServerId !== 'string')) invalid('servers')
  const perServerStorage = modules.perServerStorage as Record<string, unknown>
  if (!isJsonObject(perServerStorage.entries) || Object.values(perServerStorage.entries).some(value => typeof value !== 'string')) invalid('perServerStorage')
  const service = modules.service as Record<string, unknown>
  if (typeof service.autoStart !== 'boolean' || !Array.isArray(service.envVars) || service.envVars.some(item => !isJsonObject(item) || typeof item.key !== 'string' || typeof item.value !== 'string')) invalid('service')
  const keybindings = modules.keybindings as Record<string, unknown>
  if (!isJsonObject(keybindings.customKeys) || Object.values(keybindings.customKeys).some(value => typeof value !== 'string')) invalid('keybindings')

  const notifications = modules.notifications as Record<string, unknown>
  if (typeof notifications.browserNotificationsEnabled !== 'boolean' || !isJsonObject(notifications.toast) || typeof notifications.toast.toastEnabled !== 'boolean' || !isJsonObject(notifications.events) || !isJsonObject(notifications.events.events)) invalid('notifications')
  const events = (notifications.events as Record<string, unknown>).events as Record<string, unknown>
  for (const type of ['completed', 'permission', 'question', 'error']) {
    if (!isJsonObject(events[type]) || typeof events[type].systemEnabled !== 'boolean') invalid(`notifications.events.${type}`)
  }
  const sound = modules.sound as Record<string, unknown>
  if (!isJsonObject(sound.settings) || typeof sound.settings.enabled !== 'boolean' || typeof sound.settings.currentSessionEnabled !== 'boolean' || typeof sound.settings.volume !== 'number' || !Number.isFinite(sound.settings.volume) || !isJsonObject(sound.settings.events) || !isJsonObject(sound.customAudio)) invalid('sound')
  const sounds = (sound.settings as Record<string, unknown>).events as Record<string, unknown>
  for (const type of ['completed', 'permission', 'question', 'error']) {
    if (!isJsonObject(sounds[type]) || typeof sounds[type].soundId !== 'string') invalid(`sound.events.${type}`)
  }
  for (const audio of Object.values(sound.customAudio as Record<string, unknown>)) {
    if (!isJsonObject(audio) || typeof audio.base64 !== 'string' || typeof audio.mimeType !== 'string' || (audio.fileName !== undefined && typeof audio.fileName !== 'string')) invalid('sound.customAudio')
    try { atob(audio.base64 as string) } catch { invalid('sound.customAudio') }
  }
  const update = modules.update as Record<string, unknown>
  if ((update.lastCheckedAt !== null && (typeof update.lastCheckedAt !== 'number' || !Number.isFinite(update.lastCheckedAt))) || (update.dismissedVersion !== null && typeof update.dismissedVersion !== 'string')) invalid('update')
  if (update.latestRelease !== null) {
    const release = update.latestRelease
    if (!isJsonObject(release) || typeof release.version !== 'string' || typeof release.tagName !== 'string' || typeof release.url !== 'string' || (release.publishedAt !== null && typeof release.publishedAt !== 'string') || (release.name !== null && typeof release.name !== 'string')) invalid('update.latestRelease')
  }
}

function normalizeBackupFile(raw: unknown): SettingsBackupFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid backup file')
  }

  const parsed = raw as Record<string, unknown>
  // 改名前导出的备份 app 字段是 'PiUI'，导入时一并接受
  if ((parsed.app !== 'OMPiUI' && parsed.app !== 'PiUI') || parsed.kind !== BACKUP_KIND || parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error('Unsupported backup format')
  }

  if (!parsed.modules || typeof parsed.modules !== 'object') {
    throw new Error('Missing backup modules')
  }

  const modules = parsed.modules as Record<string, unknown>
  const requiredModules: Array<keyof SettingsBackupModules> = [
    'theme',
    'layout',
    'servers',
    'perServerStorage',
    'service',
    'keybindings',
    'notifications',
    'sound',
    'update',
  ]

  for (const id of requiredModules) {
    if (!(id in modules)) {
      throw new Error(`Missing backup module: ${id}`)
    }
  }
  validateBackupModules(modules)

  return {
    app: 'OMPiUI',
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    modules: modules as unknown as SettingsBackupModules,
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
