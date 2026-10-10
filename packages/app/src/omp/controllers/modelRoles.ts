import { serverStore } from '../../store/serverStore'
import { piModelRolesStore } from '../state/piModelRolesStore'
import { getPiModelRoles, setPiModelRoles } from '../transport/index.js'

const roleFlights = new Map<string, Promise<Record<string, string>>>()

export function loadPiModelRoles(force = false): Promise<Record<string, string>> {
  const snapshot = piModelRolesStore.getSnapshot()
  if (!force && snapshot.syncStatus === 'synced' && snapshot.roles) {
    return Promise.resolve(snapshot.roles)
  }
  const generation = serverStore.getActiveServerGeneration()
  const version = piModelRolesStore.beginRead()
  const key = `${generation}:${version}`
  const existing = roleFlights.get(key)
  if (existing) return existing

  const flight = getPiModelRoles().then(roles => {
    if (isCurrent(generation, version)) piModelRolesStore.setRoles(roles)
    return roles
  }).catch(error => {
    if (isCurrent(generation, version)) piModelRolesStore.setError(error as Error)
    throw error
  })
  roleFlights.set(key, flight)
  void flight.finally(() => {
    if (roleFlights.get(key) === flight) roleFlights.delete(key)
  }).catch(() => undefined)
  return flight
}

export async function savePiModelRoles(roles: Record<string, string>): Promise<Record<string, string>> {
  const generation = serverStore.getActiveServerGeneration()
  const version = piModelRolesStore.beginWrite()
  try {
    const next = await setPiModelRoles(roles)
    if (isCurrent(generation, version)) {
      // 保存完成后，丢弃保存期间发出的旧配置读取。
      piModelRolesStore.beginWrite()
      piModelRolesStore.setRoles(next)
    }
    return next
  } catch (error) {
    if (isCurrent(generation, version)) piModelRolesStore.setError(error as Error)
    throw error
  }
}

function isCurrent(generation: number, version: number): boolean {
  return serverStore.getActiveServerGeneration() === generation && piModelRolesStore.getVersion() === version
}
