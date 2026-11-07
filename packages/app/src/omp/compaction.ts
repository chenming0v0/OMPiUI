/** 原生方法名与用户文案分开，未知方法保留原值。 */
export function compactionMethodKey(method?: string | null): string {
  switch (method) {
    case 'snapcompact': return 'compaction.methods.snapcompact'
    case 'soft':
    case 'context-full': return 'compaction.methods.soft'
    case 'remote': return 'compaction.methods.remote'
    case 'handoff': return 'compaction.methods.handoff'
    case 'shake': return 'compaction.methods.shake'
    default: return method ? 'compaction.methods.other' : 'compaction.methods.unknown'
  }
}
