import { createContext } from 'react'

// 「このキャンバスで使った色」を返す関数。DesignPanel が今の Canvas から集めて渡す（@canvcode/canvas の usedColors）
export const UsedColorsContext = createContext<() => string[]>(() => [])
