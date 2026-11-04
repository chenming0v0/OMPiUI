import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { PlugIcon, SpinnerIcon } from './Icons'

export function CloseServiceDialog({
  isOpen,
  closeToTray = false,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean
  closeToTray?: boolean
  onConfirm: (stopService: boolean) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation(['components', 'common'])
  const [closing, setClosing] = useState(false)

  const confirm = async (stopService: boolean) => {
    setClosing(true)
    try {
      await onConfirm(stopService)
    } catch {
      // 失败时保留确认框，允许重试。
    } finally {
      setClosing(false)
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={() => { if (!closing) onCancel() }} title="" width={420} showCloseButton={false}>
      <div className="flex flex-col items-center text-center py-2">
        <div className="w-12 h-12 rounded-full bg-accent-main-100/10 flex items-center justify-center mb-4">
          <PlugIcon size={24} className="text-accent-main-100" />
        </div>
        <h3 className="text-[length:var(--fs-heading-3)] font-semibold text-text-100 mb-2">
          {t('closeService.title')}
        </h3>
        <p className="text-[length:var(--fs-md)] text-text-300 leading-relaxed mb-6 max-w-[320px]">
          {t(closeToTray ? 'closeService.trayDescription' : 'closeService.description')}
        </p>
        {closing ? (
          <div className="flex items-center gap-2 text-[length:var(--fs-md)] text-text-400">
            <SpinnerIcon size={14} className="animate-spin" />
            {t('common:closing')}
          </div>
        ) : (
          <div className="flex flex-col w-full gap-2">
            <Button onClick={() => void confirm(true)} className="w-full justify-center">
              {t('closeService.closeAndStop')}
            </Button>
            <Button variant="ghost" onClick={() => void confirm(false)} className="w-full justify-center">
              {t(closeToTray ? 'closeService.hideKeepRunning' : 'closeService.closeKeepRunning')}
            </Button>
            <Button variant="ghost" onClick={onCancel} className="w-full justify-center text-text-400">
              {t('common:cancel')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
