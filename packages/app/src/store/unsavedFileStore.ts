const dirtyEditors = new Set<string>()

export function setFileEditorDirty(editorId: string, dirty: boolean): void {
  if (dirty) dirtyEditors.add(editorId)
  else dirtyEditors.delete(editorId)
}

export function hasUnsavedFileChanges(editorId?: string): boolean {
  return editorId === undefined ? dirtyEditors.size > 0 : dirtyEditors.has(editorId)
}
