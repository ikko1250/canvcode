// 画面のショートカットのキーの判定（MAI-47）。DOM に依らない部分をここに置く（受け取りは App.tsx）

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

// U：親キャンバスに戻る。修飾キー（Shift も）を押していれば別のキーとして扱う。
// CapsLock で 'U' になることがあるので、大文字小文字は区別しない
export function isParentCanvasKey(e: KeyLike): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  return e.key.toLowerCase() === 'u'
}

// G：PDF のページの番号を入れて移る欄を開く（MAI-92）。U と同じく、修飾キーを押していれば別のキー（Ctrl+G は group）
export function isPdfPageJumpKey(e: KeyLike): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  return e.key.toLowerCase() === 'g'
}
