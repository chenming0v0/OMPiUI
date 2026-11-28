/** 只保存稳定的电脑选择；租约地址、授权和 Cookie 始终留在内存。 */
export interface DshServerSelection {
  id: string
  name: string
  previousServerId: string
}

const KEY = 'ompiui-dsh-server-selection'
export const DSH_PENDING_URL = 'dsh://pending'

export function loadDshServerSelection(): DshServerSelection | null {
  try {
    const raw = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY)
    const value = raw ? JSON.parse(raw) : null
    return value && typeof value.id === 'string' && value.id.startsWith('dsh:') &&
      typeof value.name === 'string' && typeof value.previousServerId === 'string' ? value : null
  } catch { return null }
}

export function saveDshServerSelection(value: DshServerSelection | null, scope: 'window' | 'default'): void {
  try {
    const raw = JSON.stringify(value)
    sessionStorage.setItem(KEY, raw)
    if (scope === 'default') localStorage.setItem(KEY, raw)
  } catch { /* 存储不可用时仍允许本次连接。 */ }
}
