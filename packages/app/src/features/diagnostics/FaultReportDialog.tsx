import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Copy, Download, FileWarning, RefreshCw, Upload } from 'lucide-react'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { faultAuditStore } from '../../omp/faultAudit/store'
import { collectFaultReport, startFaultAudit } from '../../omp/faultAudit/controller'
import { copyTextToClipboard } from '../../utils/clipboard'
import { saveData } from '../../utils/downloadUtils'
import { serverStore } from '../../store/serverStore'

export function FaultReportDialog() {
  const { t } = useTranslation('faultReport')
  const snapshot = useSyncExternalStore(faultAuditStore.subscribe, faultAuditStore.getSnapshot, faultAuditStore.getSnapshot)
  const activeServerId = useSyncExternalStore(serverStore.subscribe.bind(serverStore),
    () => serverStore.getActiveServer()?.id ?? 'default')
  const [consent, setConsent] = useState(false)
  const [copied, setCopied] = useState(false)
  const saved = snapshot.saved
  const id = saved?.notice.id
  useEffect(() => startFaultAudit(), [])
  useEffect(() => {
    const timer = setTimeout(() => { setConsent(false); setCopied(false) }, 0)
    return () => clearTimeout(timer)
  }, [id, saved?.report.content])
  if (!saved) return null
  const busy = snapshot.collecting || snapshot.uploading
  const share = saved.upload.indexUrl ?? saved.upload.links.join('\n')
  const fullReportAvailable = !saved.report.unavailable.includes('full_report_in_indexeddb')
  const download = () => saveData(new TextEncoder().encode(saved.report.content),
    `ompiui-fault-${saved.notice.time.replace(/[:.]/g, '-')}.log`, 'text/plain;charset=utf-8')
  const copy = async () => {
    try { await copyTextToClipboard(share); setCopied(true) }
    catch { faultAuditStore.setError('COPY_FAILED') }
  }
  return (
    <>
      {!saved.open && (
        <button type="button" onClick={() => faultAuditStore.reopen()}
          className="fixed bottom-4 right-4 z-[200] flex h-10 items-center gap-2 rounded-md border border-border-200 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-200 shadow-lg"
          title={t('reopen')}>
          <FileWarning size={16} aria-hidden="true" />{t('reopen')}
        </button>
      )}
      <Dialog isOpen={saved.open} onClose={() => faultAuditStore.dismiss()} title={t('title')} width={560}>
        <div className="min-w-0 space-y-4 text-[length:var(--fs-sm)]">
          <div className="flex items-start gap-3">
            <AlertTriangle size={22} className="shrink-0 text-danger-100" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-text-100">{t(`kind.${saved.notice.kind}`)}</p>
              <p className="text-text-300 leading-relaxed">{t(`description.${saved.notice.kind}`)}</p>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-text-400">
            <dt>{t('time')}</dt><dd className="break-words">{new Date(saved.notice.time).toLocaleString()}</dd>
            <dt>{t('server')}</dt><dd className="break-all font-mono">{saved.serverId}</dd>
            {saved.notice.errorCode && <><dt>{t('code')}</dt><dd className="break-all font-mono">{saved.notice.errorCode}</dd></>}
            {saved.notice.sessionId && <><dt>{t('session')}</dt><dd className="break-all font-mono">{saved.notice.sessionId}</dd></>}
          </dl>
          <p role="status" className={saved.report.complete ? 'text-text-300' : 'text-danger-100'}>
            {snapshot.collecting ? t('collecting') : saved.report.complete ? t('complete', { files: saved.report.files }) : t('incomplete')}
          </p>
          {!fullReportAvailable && <p className="text-danger-100">{t('restoreMissing')}</p>}
          <details className="border-y border-border-200 py-2">
            <summary className="cursor-pointer text-text-300">{t('preview')}</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[length:var(--fs-xs)] text-text-400">
              {saved.report.content.slice(0, 12_000)}
              {saved.report.content.length > 12_000 && `\n${t('previewLimited')}`}
            </pre>
          </details>
          {share ? (
            <div className="space-y-2">
              <p className="text-text-200">{saved.upload.indexUrl ? t('sendToMaintainer') : t('partialUpload', { count: saved.upload.links.length, total: saved.upload.total })}</p>
              <textarea readOnly value={share} rows={saved.upload.indexUrl ? 2 : Math.min(4, saved.upload.links.length + 1)}
                aria-label={t('shareLink')} className="w-full resize-none rounded-md border border-border-200 bg-bg-200 p-2 text-[length:var(--fs-sm)] text-text-100" />
              <Button type="button" variant="secondary" onClick={() => void copy()} className="h-10">
                <Copy size={16} aria-hidden="true" />{copied ? t('copied') : t('copy')}
              </Button>
            </div>
          ) : null}
          {saved.previousLinks?.length ? <details className="text-text-400">
            <summary className="cursor-pointer">{t('previousLinks')}</summary>
            <textarea readOnly value={saved.previousLinks.join('\n')} rows={2} aria-label={t('previousLinks')}
              className="mt-2 w-full resize-none rounded-md border border-border-200 bg-bg-200 p-2 text-[length:var(--fs-xs)]" />
          </details> : null}
          {!saved.upload.indexUrl && (
            <label className="flex cursor-pointer items-start gap-2 text-text-300 leading-relaxed">
              <input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} className="mt-1 shrink-0 accent-accent-main-100" />
              <span>{t('consent')}</span>
            </label>
          )}
          {snapshot.error && <p role="alert" className="break-words text-danger-100">{t(snapshot.error === 'COPY_FAILED' ? 'copyFailed' : 'uploadFailed')} <span className="font-mono">{snapshot.error}</span></p>}
          <div className="flex flex-wrap gap-2">
            {!saved.upload.indexUrl && <Button type="button" onClick={() => void faultAuditStore.upload()}
              disabled={!consent || busy || !fullReportAvailable} isLoading={snapshot.uploading} className="h-10">
              {!snapshot.uploading && <Upload size={16} aria-hidden="true" />}
              {snapshot.uploading ? t('uploading', { count: saved.upload.links.length, total: saved.upload.total || '…' }) : saved.upload.links.length ? t('retryUpload') : t('upload')}
            </Button>}
            <Button type="button" variant="secondary" onClick={download} disabled={snapshot.collecting} className="h-10">
              <Download size={16} aria-hidden="true" />{t('save')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void collectFaultReport(true)}
              disabled={busy || saved.serverId !== activeServerId} className="h-10">
              <RefreshCw size={16} aria-hidden="true" />{t('refresh')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => faultAuditStore.dismiss()} className="h-10">{t('later')}</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
