/**
 * 改名（PiUI → OMPiUI）后的一次性本地数据迁移。必须在任何 store 模块读取
 * localStorage 之前执行——作为 main.tsx 的第一个 import，依赖 ES 模块按
 * import 顺序求值的保证，先于 store 的构造函数运行。
 *
 * - localStorage：`piui:` / `piui-` 前缀键改名（含 srv:{id}:piui-* 形态）；
 *   目标键已存在时以新键为准，迁移后删除旧键。
 * - IndexedDB：自定义音频库 piui-sounds → ompiui-sounds，逐条复制后删旧库。
 */

const LEGACY_KEY_PATTERN = /(^|:)piui([:-])/

// 本模块必须作为 main.tsx 的第一个 import：迁移在模块求值时立即执行，
// 抢在任何 store 单例读取 localStorage 之前。
migrateLegacyStorageKeys()
migrateLegacySoundDatabase()

export function migrateLegacyStorageKeys(storage: Storage = localStorage): void {
  const legacyKeys: string[] = []
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key && LEGACY_KEY_PATTERN.test(key)) legacyKeys.push(key)
    }
  } catch {
    return
  }
  for (const key of legacyKeys) {
    try {
      const value = storage.getItem(key)
      const newKey = key.replace(LEGACY_KEY_PATTERN, '$1ompiui$2')
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value)
      }
      storage.removeItem(key)
    } catch {
      // 单个键失败不阻塞其余迁移
    }
  }
}

const LEGACY_SOUND_DB = 'piui-sounds'
const SOUND_DB = 'ompiui-sounds'
const SOUND_STORE = 'custom-audio'

export function migrateLegacySoundDatabase(): void {
  if (typeof indexedDB === 'undefined' || !indexedDB) return

  const openLegacy = () => {
    const request = indexedDB.open(LEGACY_SOUND_DB, 1)
    request.onsuccess = () => {
      const legacyDb = request.result
      if (!legacyDb.objectStoreNames.contains(SOUND_STORE)) {
        legacyDb.close()
        return
      }
      copyAndDrop(legacyDb)
    }
    request.onerror = () => undefined
  }

  // databases() 不可用（旧 WebView）时直接尝试打开；库不存在时 open 会新建
  // 一个空库，无副作用。
  const known = (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases
  if (typeof known === 'function') {
    known
      .call(indexedDB)
      .then(list => {
        if (list.some(entry => entry.name === LEGACY_SOUND_DB)) openLegacy()
      })
      .catch(openLegacy)
  } else {
    openLegacy()
  }
}

function copyAndDrop(legacyDb: IDBDatabase): void {
  let tx: IDBTransaction
  try {
    tx = legacyDb.transaction(SOUND_STORE, 'readonly')
  } catch {
    legacyDb.close()
    return
  }
  const store = tx.objectStore(SOUND_STORE)
  const keysReq = store.getAllKeys()
  const valuesReq = store.getAll()
  tx.oncomplete = () => {
    legacyDb.close()
    const entries = keysReq.result.map((key, index) => [String(key), valuesReq.result[index]] as const)
    if (entries.length === 0) {
      void indexedDB.deleteDatabase(LEGACY_SOUND_DB)
      return
    }
    const open = indexedDB.open(SOUND_DB, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(SOUND_STORE)) db.createObjectStore(SOUND_STORE)
    }
    open.onerror = () => undefined
    open.onsuccess = () => {
      const db = open.result
      const write = db.transaction(SOUND_STORE, 'readwrite')
      const writeStore = write.objectStore(SOUND_STORE)
      for (const [key, value] of entries) writeStore.put(value, key)
      write.oncomplete = () => {
        db.close()
        void indexedDB.deleteDatabase(LEGACY_SOUND_DB)
      }
      write.onerror = () => db.close()
    }
  }
  tx.onerror = () => legacyDb.close()
}
