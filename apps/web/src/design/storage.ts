// デザインパネル（MAI-73）を開いているか。ブラウザ（端末ごと）に覚える。読めない・書けないときは開いているものとする

const OPEN_KEY = 'canvcode.designPanel.open'

export function loadDesignPanelOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveDesignPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open))
  } catch {
    // 覚えられなくても困らない
  }
}
