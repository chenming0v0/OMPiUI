import { useTranslation } from 'react-i18next'
import { UsersIcon } from '../../components/Icons'
import { IconButton } from '../../components/ui'
import { openSubagentPanel } from './subagentPanelSelection'

export function SubagentPanelButton({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('message')
  return <IconButton aria-label={t('task.sidebar.title')} disabled={!sessionId}
    onClick={event => { event.stopPropagation(); if (sessionId) openSubagentPanel(sessionId) }}
    className="text-text-300 hover:text-text-100 hover:bg-bg-200/50">
    <UsersIcon size={16} />
  </IconButton>
}
