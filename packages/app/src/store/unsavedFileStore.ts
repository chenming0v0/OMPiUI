import i18n from '../i18n'

const dirtyEditors = new Set<string>()

export function setFileEditorDirty(editorId: string, dirty: boolean): void {
  if (dirty) dirtyEditors.add(editorId)
  else dirtyEditors.delete(editorId)
}

export function hasUnsavedFileChanges(editorId?: string): boolean {
  return editorId === undefined ? dirtyEditors.size > 0 : dirtyEditors.has(editorId)
}

/** editorId 形如 `${panelTabId}:${directory}:${path}`,按面板前缀判断是否有草稿。 */
export function hasUnsavedFileChangesInPanel(panelTabId: string): boolean {
  const prefix = `${panelTabId}:`
  for (const editorId of dirtyEditors) {
    if (editorId.startsWith(prefix)) return true
  }
  return false
}

/**
 * 所有会丢弃 Files 草稿的入口(跨面板 Open in Files、预览切换/关闭、标签页关闭、
 * 目录切换、hash/history 导航)都必须经过这里。返回 false 表示用户拒绝,调用方必须保持原状态。
 * panelTabId 省略时检查全部编辑器。
 */
export function confirmDiscardUnsavedFileChanges(panelTabId?: string): boolean {
  const dirty = panelTabId === undefined ? hasUnsavedFileChanges() : hasUnsavedFileChangesInPanel(panelTabId)
  return !dirty || window.confirm(i18n.t('components:fileExplorer.discardUnsaved'))
}
