import { createContext } from 'react'

/** Portal 内容提交后，通知其实际所在的虚拟行同步更新高度。 */
export const TimelineRowLayoutContext = createContext<(() => void) | undefined>(undefined)
