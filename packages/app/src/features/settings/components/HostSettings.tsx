import { RemoteAccessSettings } from './RemoteAccessSettings'

/** 被控端：让其他设备连接这台电脑上的后端。 */
export function HostSettings({ onOpenService }: { onOpenService?: () => void }) {
  return <RemoteAccessSettings onOpenService={onOpenService} />
}
