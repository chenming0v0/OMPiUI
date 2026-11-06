export const contextBooleanKeys = [
  'compaction.midTurnEnabled', 'compaction.asyncEnabled', 'compaction.supersedeReads', 'compaction.dropUseless',
] as const
export const contextNumberKeys = ['compaction.thresholdTokens', 'compaction.thresholdPercent', 'compaction.keepRecentTokens'] as const
export const contextSettingKeys = [...contextBooleanKeys, ...contextNumberKeys]

export function contextSettingValue(key: string, text: string): boolean | number | null {
  if (!text) return null
  if (contextBooleanKeys.includes(key as typeof contextBooleanKeys[number])) return text === 'true'
  const number = Number(text)
  if (!Number.isSafeInteger(number) || (number <= 0 && number !== -1) ||
    (key === 'compaction.thresholdPercent' && number > 99) ||
    (key === 'compaction.keepRecentTokens' && number <= 0)) throw new Error(`Invalid value for ${key}`)
  return number
}
