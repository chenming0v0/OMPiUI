import { splitJsonText } from '@ompiui/protocol'
import { PI_SOCKET_OPEN, type PiSocket } from './ompSocket'

export function sendTerminalInput(socket: PiSocket, text: string): void {
  for (const data of splitJsonText(text, 64 * 1024 - 128)) {
    if (socket.readyState !== PI_SOCKET_OPEN) break
    socket.send(JSON.stringify({ type: 'input', data }))
  }
}
