import { SOURCE_LINK_PREFIX } from '@canvcode/nodes'

// カードのリンクの上にポインタを置いたときの札の文言。target は行き先、action は操作の説明
export interface LinkHintText {
  target: string
  action: string
}

export function linkHintText(href: string, mac: boolean): LinkHintText {
  const key = mac ? '⌘' : 'Ctrl'
  // 引用ノートの出典の帯（MAI-33）
  if (href.startsWith(SOURCE_LINK_PREFIX)) return { target: '出典', action: `${key}+クリックで出典へ移る` }
  // 開けるのは、外のページ（http・https・mailto）だけ（View の openLinkAt と同じ）
  let url: URL | null = null
  try {
    url = new URL(href)
  } catch {
    url = null
  }
  if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) return { target: href, action: 'このリンクは開けません' }
  const target = url.protocol === 'mailto:' ? decodeURIComponent(url.pathname) : url.href
  return { target, action: `${key}+クリックで開く` }
}

// Mac（と iPad・iPhone）では Ctrl ではなく ⌘ を使う
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /Mac|iPhone|iPad/i.test(nav.userAgentData?.platform || nav.platform || '')
}
