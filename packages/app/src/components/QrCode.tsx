import { useMemo } from 'react'
import { renderSVG } from 'uqr'

/**
 * 本地渲染的二维码（uqr 纯 JS 生成 SVG，无外部请求）。
 * 内容全部来自应用自身拼出的 URL，不存在不可信输入。
 */
export function QrCode({ text, size = 176, className = '' }: { text: string; size?: number; className?: string }) {
  const svg = useMemo(() => renderSVG(text, { border: 1 }), [text])
  return (
    <div
      className={`shrink-0 bg-white p-1.5 [&>svg]:block [&>svg]:h-full [&>svg]:w-full ${className}`}
      style={{ width: size, height: size }}
      // uqr 生成的是我们自产 URL 的静态 SVG，无脚本内容
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      aria-label="QR code"
    />
  )
}
