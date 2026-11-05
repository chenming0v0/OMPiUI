import './runtime-panel-preview-mock'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import { themeStore } from './store/themeStore'
import { serviceStore } from './store/serviceStore'
import { desktopRuntimeStore } from './store/desktopRuntimeStore'
import { DesktopServiceStatus } from './components/DesktopServiceStatus'
import { DesktopRuntimePanel } from './components/DesktopRuntimePanel'
import { previewState } from './runtime-panel-preview-mock'
import { restartDesktopService } from './services/desktopService'

themeStore.init()
themeStore.setColorMode(new URLSearchParams(location.search).get('mode') === 'light' ? 'light' : 'dark')
serviceStore.setStartedByUs(true)
if (new URLSearchParams(location.search).has('fresh')) {
  desktopRuntimeStore.reset()
  serviceStore.setEnvVars([{ key: 'OMPI_OMP_BIN', value: 'C:\\Users\\HEI\\.bun\\bin\\omp.exe' }])
}

function Preview() {
  const [, force] = useState(0)
  const set = (patch: Partial<typeof previewState>) => {
    Object.assign(previewState, patch)
    force(value => value + 1)
  }
  return (
    <div className="min-h-screen bg-bg-000 text-text-100">
      <div className="flex h-10 items-center justify-end border-b border-border-200/60 px-2">
        <DesktopServiceStatus />
      </div>
      <div className="flex flex-wrap gap-2 p-4 text-xs">
        <span className="text-text-300">模拟场景：</span>
        <button className="rounded border border-border-200 px-2 py-1" onClick={() => set({ running: true, phase: 'running', ompMissing: false })}>
          运行中
        </button>
        <button className="rounded border border-border-200 px-2 py-1" onClick={() => set({ running: false, phase: 'stopped' })}>
          已停止
        </button>
        <button className="rounded border border-border-200 px-2 py-1" onClick={() => set({ ompMissing: true })}>
          OMP 缺失
        </button>
        <button className="rounded border border-border-200 px-2 py-1" onClick={() => serviceStore.setStartedByUs(!serviceStore.getSnapshot().startedByUs)}>
          切换外部后端
        </button>
        <button className="rounded border border-border-200 px-2 py-1" onClick={() => set({ inspectDelay: previewState.inspectDelay ? 0 : 1200 })}>
          检测延迟 {previewState.inspectDelay}ms
        </button>
      </div>
      <div className="mx-auto max-w-2xl p-4">
        <h2 className="mb-3 text-sm font-semibold">设置页嵌入版</h2>
        <DesktopRuntimePanel onRestart={() => restartDesktopService()} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
