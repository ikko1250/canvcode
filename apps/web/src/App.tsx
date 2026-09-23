import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Camera, NodeRecord } from '@canvcode/core'
import {
  CanvasView,
  Editor,
  FileManager,
  SyncClient,
  Workspace,
  isEditableKeyboardTarget,
  isImeEvent,
  type InitialRecords,
  type ConflictChoice,
  type ArrowStyle,
  type OwnerPortalDeletion,
  type QuoteDraft,
  type QuoteRequest,
  type StatsSummary,
  type SyncStatus,
} from '@canvcode/canvas'
import {
  ARROW_COLORS,
  ARROW_SIZES,
  builtinNodeTypes,
  createCodeCardType,
  stepFontSize,
  textAlignOf,
  type ArrowProps,
  type FileContentSource,
  type NoteProps,
  type PortalProps,
  type QuoteCardProps,
  type TextAlign,
  type TextProps,
} from '@canvcode/nodes'
import type { MarkdownCardProps } from '@canvcode/nodes/markdown'
import { clearNodes, generateNodes, runBenchmark, type PhaseResult } from './benchmark.ts'
import { CARD_COUNT, generateMarkdownCards, runCardBenchmark, type CardBenchmarkResult } from './cardBenchmark.ts'
import { createAppMarkdownCardType } from './markdown/markdownCard.ts'
import { pdfService } from './pdf.ts'
import { buildPieMenus } from './pie/menus.ts'
import { PieMenus } from './pie/PieMenu.tsx'
import { DrawPalette } from './palette/DrawPalette.tsx'
import { Breadcrumb } from './workspace/Breadcrumb.tsx'
import { ConfirmDialog, type DialogChoice } from './workspace/ConfirmDialog.tsx'
import { ContextMenu, type MenuItem } from './workspace/ContextMenu.tsx'
import { FileEditor } from './workspace/FileEditor.tsx'
import { PortalRename, type PortalRenameTarget } from './workspace/PortalRename.tsx'
import { isParentCanvasKey } from './workspace/shortcuts.ts'
import { Sidebar } from './workspace/Sidebar.tsx'
import { useSelectionVersion, useWorkspaceVersion } from './workspace/useWorkspace.ts'

// 画面（MAI-29 から、サイドバーとパンくずリストを持つ）。ツールなどは、キーで出すパイメニューから選ぶ（MAI-39）。
// Canvas を移るときは、その Canvas の Editor に切り替える。Editor は Canvas ごとに作って取っておく（カメラや選択を覚えておくため）。

// Markdown カードの名前の帯の寸法（ワールド座標。cardHtml.ts の .md-card-header に合わせる）
const CARD_HEADER = { height: 36, padding: 12, fontSize: 13 }

const SIZE_LABELS = ['細', '中', '太']
const ARROWHEADS: { label: string; title: string; start: ArrowStyle['arrowheadStart']; end: ArrowStyle['arrowheadEnd'] }[] = [
  { label: '—', title: '矢じりなし', start: 'none', end: 'none' },
  { label: '→', title: '終点に矢じり', start: 'none', end: 'arrow' },
  { label: '↔', title: '両端に矢じり', start: 'arrow', end: 'arrow' },
]

// テキストと付箋の揃え（MAI-50）。アイコンは 3 本の横線で、揃えの側をそろえる
const TEXT_ALIGNS: { align: TextAlign; title: string; lines: [number, number][] }[] = [
  { align: 'left', title: '左揃え', lines: [[2, 14], [2, 10], [2, 14]] },
  { align: 'center', title: '中央揃え', lines: [[2, 14], [4, 12], [2, 14]] },
  { align: 'right', title: '右揃え', lines: [[2, 14], [6, 14], [2, 14]] },
]

function AlignIcon(props: { lines: [number, number][] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {props.lines.map(([x1, x2], i) => (
        <line key={i} x1={x1} x2={x2} y1={4 + i * 4} y2={4 + i * 4} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ))}
    </svg>
  )
}

const BENCH_NODE_COUNT = 10_000

// URL の /c/<id> から Canvas の id を読む（MAI-8）
function canvasIdFromUrl(): string | null {
  const match = /^\/c\/([^/]+)/.exec(location.pathname)
  return match ? decodeURIComponent(match[1]) : null
}

// URL の /f/<id> から、全画面のエディタで開いている File の id を読む（MAI-8）
function fileIdFromUrl(): string | null {
  const match = /^\/f\/([^/]+)/.exec(location.pathname)
  return match ? decodeURIComponent(match[1]) : null
}

// ワークスペースと File の本文の読み書き。Markdown カードの型は本文を引く先を必要とし、
// 本文を引く先（FileManager）はワークスペースを必要とするので、間に引く先を 1 つ挟んで作る
// 保存されていたレコード（initial）を当ててから、サーバーとの同期を始める（MAI-11、MAI-13）
function createWorkspace(initial: InitialRecords) {
  let manager: FileManager | null = null
  const content: FileContentSource = { get: (fileId) => manager?.get(fileId) ?? null }
  const workspace = new Workspace({
    rootCanvasId: initial.rootCanvasId,
    types: [...builtinNodeTypes, createAppMarkdownCardType(content), createCodeCardType({ files: content })],
  })
  const sync = new SyncClient(workspace, initial)
  manager = new FileManager({ workspace })
  return { workspace, files: manager, sync }
}

// Canvas ごとの最後のカメラ（端末ごとに、ブラウザに覚える）
const CAMERA_KEY = 'canvcode.camera.'

function savedCamera(canvasId: string): Camera | null {
  try {
    const value = JSON.parse(localStorage.getItem(CAMERA_KEY + canvasId) ?? 'null') as Camera | null
    return value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.zoom > 0 ? value : null
  } catch {
    return null
  }
}

function saveCamera(canvasId: string, camera: Camera): void {
  try {
    localStorage.setItem(CAMERA_KEY + canvasId, JSON.stringify(camera))
  } catch {
    // 覚えられなくても困らない
  }
}

// 旧データの取り込みの結果（サーバーの describeReport と同じ内容。MAI-36）
interface ImportReport {
  canvases: number
  markdown: number
  code: number
  pdf: number
  nodes: number
  quotes: number
  images: number
  unplaced: number
  skippedTrashed: number
  skippedLinks: number
  unsupported: Record<string, number>
  lostFormatting: number
  lostPortalLabels: number
}

// ファイルを選ぶダイアログを出す（パイメニューの Portal › PDF）。選ばずに閉じたら空
function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve([])
      input.remove()
    })
    document.body.append(input)
    input.click()
  })
}

function describeImport(report: ImportReport): string[] {
  const lines = [
    `キャンバス ${report.canvases} 個、Markdown ${report.markdown} 個、Python ${report.code} 個、PDF ${report.pdf} 個、ノード ${report.nodes} 個（画像 ${report.images}、引用ノート ${report.quotes}）を取り込みました。`,
  ]
  if (report.unplaced > 0) lines.push(`どこからもたどれなかった ${report.unplaced} 個は「未配置」に入れました。`)
  if (report.skippedTrashed > 0) lines.push(`ゴミ箱の中の ${report.skippedTrashed} 個は取り込みませんでした。`)
  if (report.skippedLinks > 0) lines.push(`ゴミ箱の中のものを指していた Portal・カード・引用 ${report.skippedLinks} 個は取り込みませんでした。`)
  if (report.lostFormatting > 0) lines.push(`テキスト ${report.lostFormatting} 個の書式（太字・リンク・箇条書きなど）は失われ、プレーンテキストになりました。`)
  if (report.lostPortalLabels > 0) lines.push(`Portal ${report.lostPortalLabels} 個の独自の名前は失われ、参照先の名前になりました。`)
  for (const [what, count] of Object.entries(report.unsupported)) lines.push(`${what} ${count} 個は変換できませんでした。`)
  return lines
}

const SYNC_LABELS: Record<SyncStatus, string> = { saved: '保存済み', saving: '保存中…', offline: 'サーバーにつながっていません（つながったら送ります）' }

type Dialog = { title: string; message: string; choices: DialogChoice<string>[]; resolve(value: string | null): void }

export function App(props: { initial: InitialRecords }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [{ workspace, files, sync }] = useState(() => createWorkspace(props.initial))
  const syncStatus = useSyncExternalStore(sync.subscribeStatus, sync.getStatus)
  // 旧データを送っている途中なら、その割合（0〜1）。送り終えて取り込んでいる間は 1
  const [importProgress, setImportProgress] = useState<number | null>(null)
  // 全画面のエディタで開いている File（MAI-30）と、開いたときに選んで見せる引用（「出典へ」。MAI-33）
  const [openFileId, setOpenFileId] = useState<string | null>(null)
  const [fileFocus, setFileFocus] = useState<{ quote: string; line: number } | null>(null)
  // Canvas ごとの Editor（一度開いたら取っておく）と、開いたことのある Canvas（初めてなら全体を表示する）
  const [editors] = useState(() => new Map<string, Editor>())
  const [visited] = useState(() => new Set<string>())
  const getEditor = useCallback(
    (canvasId: string) => {
      let editor = editors.get(canvasId)
      if (!editor) {
        editor = new Editor({ workspace, canvasId })
        editors.set(canvasId, editor)
        // 前に開いたときのカメラに戻す（全体表示はしない）
        const camera = savedCamera(canvasId)
        if (camera) {
          editor.session.set({ camera })
          visited.add(canvasId)
        }
        // カメラが止まったら覚える
        let timer: number | null = null
        const target = editor
        editor.session.subscribe((state, prev) => {
          if (state.camera === prev.camera) return
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(() => saveCamera(canvasId, target.session.get().camera), 500)
        })
      }
      return editor
    },
    [workspace, editors, visited],
  )
  const [canvasId, setCanvasId] = useState(workspace.rootCanvasId)
  const editor = getEditor(canvasId)
  const [view, setView] = useState<CanvasView | null>(null)
  const session = useSyncExternalStore(editor.session.subscribe, editor.session.getSnapshot)
  useWorkspaceVersion(workspace)
  // 選んでいるノードが変わったら描き直す（パレットに出す文字の大きさなど。MAI-52）
  useSelectionVersion(editor)
  const [stats, setStats] = useState<StatsSummary | null>(null)
  // 描画の計測（FPS など）は最初は隠しておき、パイメニューの「計測を表示」で出す（MAI-48）
  const [showStats, setShowStats] = useState(false)
  const [bench, setBench] = useState<'idle' | 'running' | PhaseResult[]>('idle')
  const [cardBench, setCardBench] = useState<'idle' | 'running' | CardBenchmarkResult>('idle')
  // 画面の下に短く出す知らせ（受け付けないファイルをドロップしたときなど）
  const [notices, setNotices] = useState<{ id: number; message: string }[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | 'separator')[]; onClose?: () => void } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  // Portal の名前を、その場で変えているとき（右クリックメニューの「名前を変更」）
  const [renaming, setRenaming] = useState<(PortalRenameTarget & { canvasOfPortal: string }) | null>(null)
  const navigating = useRef(false)
  // 移っている途中（アニメーション中）に頼まれた移動。今の移動が終わったら、最後に頼まれたものを行う
  const pendingNavigation = useRef<{ targetId: string; options: { portalId?: string; push?: boolean } } | null>(null)
  const viewRef = useRef<CanvasView | null>(null)

  const notify = useCallback((message: string) => {
    const id = Date.now() + Math.random()
    setNotices((list) => [...list, { id, message }])
    window.setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), 6000)
  }, [])

  const ask = useCallback(
    (title: string, message: string, choices: DialogChoice<string>[]) =>
      new Promise<string | null>((resolve) => setDialog({ title, message, choices, resolve })),
    [setDialog],
  )
  useEffect(() => {
    sync.setHandlers({
      notify,
      // どこかのタブ（やコマンド）が旧データを取り込んだ：画像・PDF の一覧を読み直す
      onImported: () => {
        const view = viewRef.current
        void view?.assets.loadList().then(() => view.invalidate('scene'))
        if (view && view.editor.canvasId === workspace.rootCanvasId) view.zoomToFit()
      },
    })
    files.setHandlers({
      notify,
      // 保存していない編集があるときに、外で本文が変わった（MAI-10）。やめた場合は、どちらも失わないよう別名で保存する
      onConflict: async (file) => {
        const choice = await ask(
          `「${file.title}」が外で変更されました`,
        'このタブにはまだ保存していない編集があります。どちらを使いますか？（やめると、自分の編集を別名で保存します）',
          [
            { label: '外の内容を使う', value: 'theirs' },
            { label: '自分の編集を使う', value: 'mine', danger: true },
            { label: '自分の編集を別名で保存する', value: 'saveAs' },
          ],
        )
        return (choice as ConflictChoice | null) ?? 'saveAs'
      },
    })
  }, [files, sync, workspace, notify, ask])

  // 旧データ（.ricbackup）をサーバーに送って取り込む。数百 MB あるので、送った割合を出す
  const importBackup = useCallback(
    (file: File) => {
      if (importProgress !== null) return notify('ほかの取り込みの途中です')
      setImportProgress(0)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/import')
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setImportProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        setImportProgress(null)
        let body: { report?: ImportReport; error?: string } = {}
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          // 下で知らせる
        }
        if (xhr.status === 200 && body.report) void ask('旧データを取り込みました', describeImport(body.report).join('\n'), [{ label: '閉じる', value: 'ok' }])
        else void ask('旧データを取り込めませんでした', body.error ?? `サーバーの応答：${xhr.status}`, [{ label: '閉じる', value: 'ok' }])
      }
      xhr.onerror = () => {
        setImportProgress(null)
        notify('旧データを送れませんでした（サーバーとの接続が切れました）')
      }
      xhr.send(file)
    },
    [importProgress, notify, ask],
  )
  const importBackupRef = useRef(importBackup)
  useEffect(() => {
    importBackupRef.current = importBackup
  }, [importBackup])

  // 全画面のエディタを開く・閉じる（URL は /f/<id>。ブラウザの「戻る」で閉じる）
  const openFile = useCallback(
    (fileId: string, options: { push?: boolean; focus?: { quote: string; line: number } } = {}) => {
      if (!workspace.getFile(fileId)) return
      if (workspace.targetStatus(fileId) !== 'ok') {
        notify('この File は開けません（ゴミ箱の中か、ファイルが見つかりません）')
        return
      }
      setOpenFileId(fileId)
      setFileFocus(options.focus ?? null)
      if (options.push !== false) history.pushState({ fileId }, '', `/f/${encodeURIComponent(fileId)}`)
    },
    [workspace, notify],
  )
  const closeFile = useCallback(() => {
    setOpenFileId(null)
    setFileFocus(null)
    if (fileIdFromUrl()) history.back()
    viewRef.current?.root.focus({ preventScroll: true })
  }, [])

  // Canvas を移る（MAI-8、MAI-29）。
  // - Portal から入るときは、Portal に向かってズームインしてから切り替える（MAI-6）
  // - 親に戻るときは、子の Portal にズームインした状態から、覚えておいたカメラまでズームアウトする
  // 離れる Canvas のサムネイルを作り、親の Portal に見せる
  const navigate = useCallback(
    async function go(targetId: string, options: { portalId?: string; push?: boolean } = {}): Promise<void> {
      const view = viewRef.current
      if (!view) return
      if (navigating.current) {
        pendingNavigation.current = { targetId, options }
        return
      }
      const from = view.editor
      if (targetId === from.canvasId) return
      const target = workspace.getCanvas(targetId)
      if (!target) return notify('このキャンバスは削除されています')
      if (target.deletedAt !== null) return notify('このキャンバスはゴミ箱の中にあります。サイドバーから元に戻せます')
      navigating.current = true
      try {
        await view.captureThumbnail()
        const portal = options.portalId ? from.index.get(options.portalId) : undefined
        // 入るときのズームインは見せるためだけのもの。戻ってきたときは、その前のカメラに戻す
        const fromCamera = from.session.get().camera
        if (portal) await view.animateCamera(view.cameraFor(portal.worldBounds))
        const next = getEditor(targetId)
        view.setEditor(next)
        // 画面の状態も、ここで切り替える（このあとのアニメーションの間の操作も、移った先の Canvas に入るように）
        setCanvasId(targetId)
        if (options.push !== false) history.pushState({ canvasId: targetId }, '', `/c/${encodeURIComponent(targetId)}`)
        from.session.set({ camera: fromCamera })
        if (!visited.has(targetId)) {
          visited.add(targetId)
          view.zoomToFit()
        }
        // 祖先に戻るなら、今までいた枝の Portal からズームアウトする
        const branch = workspace.canvasPath(from.canvasId).find((c) => c.parentCanvasId === targetId)
        const branchPortal = !portal && branch?.ownerNodeId ? next.index.get(branch.ownerNodeId) : undefined
        if (branchPortal) {
          const saved = next.session.get().camera
          view.setCamera(view.cameraFor(branchPortal.worldBounds))
          await view.animateCamera(saved)
        }
      } finally {
        navigating.current = false
        const pending = pendingNavigation.current
        pendingNavigation.current = null
        if (pending) void go(pending.targetId, pending.options)
      }
    },
    [workspace, visited, getEditor, notify],
  )
  const openPortal = useCallback(
    (portalId: string) => {
      const view = viewRef.current
      const portal = view?.editor.getNode(portalId)
      if (!view || portal?.type !== 'portal') return
      const targetId = (portal.props as PortalProps).targetId
      const status = workspace.targetStatus(targetId)
      if (status === 'missing') return notify('参照先のキャンバスは完全に削除されています（リンク切れ）')
      if (status === 'trashed') return notify('参照先のキャンバスはゴミ箱の中にあります。サイドバーから元に戻せます')
      void navigate(targetId, { portalId })
    },
    [workspace, navigate, notify],
  )

  // ---- 引用（MAI-33） ----

  // 引用ノートへ移る（逆リンク）。別の Canvas にあれば、そこへ移ってから見せる
  const goToNote = useCallback(
    async (noteId: string) => {
      const canvas = workspace.canvasOf(noteId)
      if (!canvas) return
      await navigate(canvas)
      const view = viewRef.current
      if (view && view.editor.canvasId === canvas) await view.focusNode(noteId)
    },
    [workspace, navigate],
  )

  // 引用しているノートの一覧（右クリックメニューと同じ形で出す）
  const citationItems = useCallback(
    (anchorIds: string[]): MenuItem[] =>
      anchorIds.flatMap((anchorId) =>
        workspace.notesOfAnchor(anchorId).map((note) => {
          const props = note.props as QuoteCardProps
          const canvasTitle = workspace.getCanvas(workspace.canvasOf(note.id) ?? '')?.title ?? ''
          const head = (props.memo.trim() || props.quote.trim() || '（図）').split('\n')[0]
          const label = `${head.length > 24 ? `${head.slice(0, 24)}…` : head} — ${canvasTitle}`
          return { label, onSelect: () => void goToNote(note.id) }
        }),
      ),
    [workspace, goToNote],
  )

  // 引用ノートの出典へ移る。PDF はそのページの範囲、Markdown は全画面のエディタのその行
  const openSource = useCallback(
    async (anchorId: string) => {
      const anchor = workspace.getAnchor(anchorId)
      const file = anchor && workspace.getFile(anchor.fileId)
      if (!anchor || !file) return notify('出典の資料は削除されています')
      if (workspace.targetStatus(file.id) === 'trashed') return notify('出典の資料はゴミ箱の中にあります。サイドバーから元に戻せます')
      if (anchor.locator.kind === 'markdown') {
        openFile(file.id, { focus: { quote: anchor.quote, line: anchor.locator.line } })
        return
      }
      if (anchor.locator.kind !== 'pdf' || !file.pagesCanvasId) return
      const pages = workspace.getCanvas(file.pagesCanvasId)
      if (!pages || pages.deletedAt !== null) return notify('出典の PDF はゴミ箱の中にあります。サイドバーから元に戻せます')
      await navigate(pages.id)
      const view = viewRef.current
      if (view && view.editor.canvasId === pages.id) await view.showCitation(anchorId)
    },
    [workspace, navigate, openFile, notify],
  )

  // 引用する範囲を決めた・文字を選んで「引用」を押した：ノートを横に置くか、コピーするかを選ばせる
  const onQuote = useCallback(
    async (request: QuoteRequest) => {
      const view = viewRef.current
      if (!view) return
      const editor = view.editor
      let draft: QuoteDraft | null
      let place: () => void
      if (request.kind === 'pdf') {
        draft = await view.quoteFromPdf(request.pageId, request.rect)
        const page = editor.index.get(request.pageId)?.worldBounds
        const d = draft
        place = () => {
          if (d && page) view.placeQuote(d, request.pageId, page.y + request.rect.y * page.h)
        }
      } else {
        draft = request.draft
        const card = editor.index.get(request.nodeId)?.worldBounds
        const d = draft
        place = () => {
          if (card) view.placeQuote(d, request.nodeId, card.y)
        }
      }
      if (!draft || view.editor !== editor) {
        view.clearQuoteRegion()
        return
      }
      const d = draft
      setMenu({
        x: request.clientX,
        y: request.clientY,
        items: [
          { label: request.kind === 'pdf' ? 'このページの横に引用ノート' : 'カードの横に引用ノート', onSelect: place },
          { label: '引用をコピー', onSelect: () => void view.copyQuote(d) },
        ],
        onClose: () => view.clearQuoteRegion(),
      })
    },
    [setMenu],
  )

  // 右クリックメニューの項目（MAI-29）。右クリックしたときの選択に合わせる
  const buildMenu = useCallback(
    (at: { x: number; y: number }): (MenuItem | 'separator')[] => {
      const view = viewRef.current
      if (!view) return []
      const editor = view.editor
      const selected = [...editor.session.get().selectedIds].flatMap((id) => editor.getNode(id) ?? [])
      const single = selected.length === 1 ? selected[0] : null
      const items: (MenuItem | 'separator')[] = []
      if (single?.type === 'portal') {
        items.push({ label: '開く', shortcut: 'Enter', onSelect: () => openPortal(single.id) })
        const target = workspace.getCanvas((single.props as PortalProps).targetId)
        if (target) {
          items.push({
            label: '名前を変更',
            onSelect: () => {
              const entry = editor.index.get(single.id)
              if (!entry) return
              // 名前の帯の位置（画面の座標）。Portal は回転させないので、箱の左上がそのまま帯の左上になる
              const camera = editor.session.get().camera
              setRenaming({
                documentId: target.id,
                title: target.title,
                x: (entry.worldBounds.x - camera.x) * camera.zoom,
                y: (entry.worldBounds.y - camera.y) * camera.zoom,
                width: entry.worldBounds.w * camera.zoom,
                zoom: camera.zoom,
                canvasOfPortal: editor.canvasId,
              })
            },
          })
        }
      }
      // 引用ノート（MAI-33）
      if (single?.type === 'quote-card') {
        const props = single.props as QuoteCardProps
        items.push({ label: '出典へ', shortcut: 'Ctrl+クリック', onSelect: () => void openSource(props.anchorId) })
        items.push({ label: 'メモを編集', shortcut: 'Enter', onSelect: () => view.textEditor.start(single.id) })
        items.push('separator')
      }
      // File のカード（Markdown・Python）
      if (single?.type === 'markdown-card' || single?.type === 'code-card') {
        const props = single.props as MarkdownCardProps
        const file = workspace.getFile(props.fileId)
        if (file) {
          items.push({ label: '編集', shortcut: 'Enter', onSelect: () => view.editDocument(single.id) })
          items.push({ label: '全画面で開く', shortcut: 'Ctrl+Enter', onSelect: () => openFile(file.id) })
          // このファイルを引用しているノート（逆リンク。MAI-33）
          const cited = citationItems(workspace.anchorsOfFile(file.id).map((a) => a.id))
          if (cited.length > 0) {
            items.push({ label: `引用しているノート（${cited.length}）`, onSelect: () => setMenu({ x: at.x, y: at.y, items: cited }) })
          }
          items.push({
            label: props.sizing === 'auto' ? '大きさを固定' : '高さを中身に合わせる',
            onSelect: () => {
              const node = editor.getNode(single.id)
              const entry = editor.index.get(single.id)
              if (!node || !entry) return
              const current = node.props as MarkdownCardProps
              // 固定にするときは、今の高さのまま固定する（見た目が変わらないように）
              const next = current.sizing === 'auto' ? { ...current, sizing: 'fixed', h: entry.localBounds.h } : { ...current, sizing: 'auto' }
              editor.transact('card sizing', (tx) => tx.put({ ...node, props: next }))
            },
          })
          items.push({
            label: '名前を変更',
            onSelect: () => {
              const entry = editor.index.get(single.id)
              if (!entry) return
              const camera = editor.session.get().camera
              setRenaming({
                documentId: file.id,
                title: file.title,
                header: CARD_HEADER,
                x: (entry.worldBounds.x - camera.x) * camera.zoom,
                y: (entry.worldBounds.y - camera.y) * camera.zoom,
                width: entry.worldBounds.w * camera.zoom,
                zoom: camera.zoom,
                canvasOfPortal: editor.canvasId,
              })
            },
          })
          items.push('separator')
        }
      }
      if (selected.length > 0) {
        items.push({ label: 'キャンバスに昇格', shortcut: 'Ctrl+Alt+P', onSelect: () => view.promoteSelection() })
        // 子キャンバスに移動（MAI-38）：この Canvas の子の Canvas から、移す先を選ばせる
        items.push({
          label: '子キャンバスに移動',
          onSelect: () => {
            const ids = selected.map((n) => n.id)
            const targets = workspace.childCanvases(editor.canvasId).filter((c) => editor.canMoveToCanvas(ids, c.id))
            if (targets.length === 0) return notify('移動できる子キャンバスがありません')
            setMenu({
              x: at.x,
              y: at.y,
              items: targets.map((c) => ({ label: c.title || '無題', onSelect: () => void view.moveToCanvas(ids, c.id) })),
            })
          },
        })
        items.push({ label: '複製', shortcut: 'Ctrl+D', onSelect: () => view.duplicateSelection() })
        if (selected.length > 1) items.push({ label: 'グループにする', shortcut: 'Ctrl+G', onSelect: () => editor.groupSelected() })
        if (selected.some((n) => n.type === 'group')) {
          items.push({ label: 'グループを解除', shortcut: 'Ctrl+Shift+G', onSelect: () => editor.ungroupSelected() })
        }
        items.push({ label: '固定する', onSelect: () => editor.setLocked(selected.map((n) => n.id), true) })
        items.push('separator')
        items.push({ label: '削除', shortcut: 'Delete', danger: true, onSelect: () => void view.deleteSelection() })
      } else {
        // 固定したノード（PDF のページなど）の上なら、固定を外せる（MAI-32）
        const rect = view.root.getBoundingClientRect()
        const camera = editor.session.get().camera
        const point = { x: camera.x + (at.x - rect.left) / camera.zoom, y: camera.y + (at.y - rect.top) / camera.zoom }
        const locked = editor.hitTest(point, 4 / camera.zoom, { includeLocked: true })
        // PDF のページなら、範囲を選んで引用できる。引用した範囲の上なら、引用しているノートを出せる（MAI-33）
        if (locked?.type === 'pdf-page') {
          items.push({
            label: '範囲を選んで引用',
            shortcut: 'Alt+ドラッグ',
            onSelect: () => {
              view.armQuoteRegion()
              notify('引用する範囲をドラッグで囲んでください（Esc でやめる）')
            },
          })
          const cited = citationItems(editor.citationsAt(point))
          if (cited.length > 0) {
            items.push({ label: `この範囲を引用しているノート（${cited.length}）`, onSelect: () => setMenu({ x: at.x, y: at.y, items: cited }) })
          }
        }
        if (locked?.locked) {
          items.push({ label: '固定を外す', onSelect: () => editor.setLocked([locked.id], false) })
          items.push('separator')
        }
        items.push({
          label: 'ここに新しいキャンバス',
          onSelect: () => {
            // 右クリックした位置（ワールド座標）に作って、そのまま中に入る
            const rect = view.root.getBoundingClientRect()
            const camera = editor.session.get().camera
            const world = { x: camera.x + (at.x - rect.left) / camera.zoom, y: camera.y + (at.y - rect.top) / camera.zoom }
            openPortal(editor.createPortal(world).portalId)
          },
        })
        items.push({
          label: 'ここに Markdown',
          onSelect: () => {
            const rect = view.root.getBoundingClientRect()
            const camera = editor.session.get().camera
            const world = { x: camera.x + (at.x - rect.left) / camera.zoom, y: camera.y + (at.y - rect.top) / camera.zoom }
            void view.createDocumentAt('markdown', world)
          },
        })
        items.push({
          label: 'ここに Python',
          onSelect: () => {
            const rect = view.root.getBoundingClientRect()
            const camera = editor.session.get().camera
            const world = { x: camera.x + (at.x - rect.left) / camera.zoom, y: camera.y + (at.y - rect.top) / camera.zoom }
            void view.createDocumentAt('code', world)
          },
        })
        items.push({ label: 'すべて選択', shortcut: 'Ctrl+A', onSelect: () => editor.selectAll() })
        // 親キャンバスに戻る（MAI-47）。ルートや未配置のキャンバスでは出さない
        const parentId = workspace.getCanvas(editor.canvasId)?.parentCanvasId
        if (parentId) items.push({ label: '親キャンバスに戻る', shortcut: 'U', onSelect: () => void navigate(parentId) })
      }
      return items
    },
    [openPortal, openFile, workspace, setRenaming, setMenu, openSource, citationItems, notify, navigate],
  )


  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const created = new CanvasView(getEditor(workspace.rootCanvasId), container, {
      notify,
      files,
      pdf: pdfService,
      onOpenFile: (fileId) => openFile(fileId),
      onOpenPortal: (portalId) => openPortal(portalId),
      onQuote: (request) => void onQuote(request),
      onOpenCitations: (anchorIds, { clientX, clientY }) => {
        const items = citationItems(anchorIds)
        if (items.length > 0) setMenu({ x: clientX, y: clientY, items })
      },
      onOpenSource: (anchorId) => void openSource(anchorId),
      onImportBackup: (file) => importBackupRef.current(file),
      onContextMenu: ({ clientX, clientY }) => {
        const at = { x: clientX, y: clientY }
        setMenu({ ...at, items: buildMenu(at) })
      },
      confirmOwnerPortalDeletion: async (portals) => {
        const names = portals.map((p) => `「${p.title}」`).join('、')
        const inner = portals.reduce((n, p) => n + p.descendants, 0)
        const choice = await ask(
          'キャンバスを消しますか？',
          `${names}${inner > 0 ? ` と、その中のキャンバス ${inner} 個` : ''}をゴミ箱に送ります。` +
            '「未配置にする」を選ぶと、ゴミ箱には送らず、サイドバーの「未配置」から置き直せるようにします。',
          [
            { label: 'ゴミ箱に送る', value: 'trash', danger: true },
            { label: '未配置にする', value: 'unplace' },
          ],
        )
        return choice as OwnerPortalDeletion | null
      },
      // ノードを Portal の上に落とした（MAI-38）
      confirmMoveToCanvas: async ({ title, count }) => {
        const choice = await ask('キャンバスに移動しますか？', `選んだ ${count} 個を「${title}」の中に移動します。`, [
          { label: 'OK', value: 'ok' },
        ])
        return choice === 'ok'
      },
    })
    viewRef.current = created
    visited.add(workspace.rootCanvasId)
    setView(created)
    // 開発者ツールや自動テストから状態を調べるための入口
    ;(window as unknown as { canvcode: unknown }).canvcode = {
      workspace,
      view: created,
      get editor() {
        return created.editor
      },
    }
    // ワークスペースの File の一覧を読み、外からの変更の知らせを受け始める（MAI-30）
    void files.start().catch((error: unknown) => {
      console.error('Failed to load files', error)
      notify('ファイルの一覧を読み込めませんでした')
    })
    // 保存されている Asset（画像・PDF）の一覧を読む
    void created.assets.loadList().catch((error: unknown) => console.error('Failed to load assets', error))
    // 開いた URL の Canvas に入る
    const initial = canvasIdFromUrl()
    if (initial && initial !== workspace.rootCanvasId && workspace.getCanvas(initial)) void navigate(initial, { push: false })
    else history.replaceState({ canvasId: workspace.rootCanvasId }, '', `/c/${encodeURIComponent(workspace.rootCanvasId)}`)
    // ページを閉じる・隠すときは、保存していない編集をすぐ保存する
    const onHide = () => {
      void files.flush()
      sync.flush()
    }
    window.addEventListener('pagehide', onHide)
    const onPop = (e: PopStateEvent) => {
      // 全画面のエディタの開け閉め
      const state = e.state as { canvasId?: string; fileId?: string } | null
      if (state?.fileId) {
        openFile(state.fileId, { push: false })
        return
      }
      setOpenFileId(null)
      const id = state?.canvasId ?? viewRef.current?.editor.canvasId ?? workspace.rootCanvasId
      void navigate(workspace.getCanvas(id) ? id : workspace.rootCanvasId, { push: false })
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('pagehide', onHide)
      created.dispose()
      files.dispose()
    }
    // どれも useCallback で固定してあるので、この処理は最初に 1 回だけ走る
  }, [workspace, files, sync, visited, notify, ask, getEditor, navigate, openPortal, openFile, buildMenu, onQuote, citationItems, openSource])

  // Ctrl+\ でサイドバーを開け閉めする
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        setSidebarOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // U で親キャンバスに戻る（MAI-47）。パンくずリストの 1 つ左を押したのと同じ。ルートや未配置のキャンバスでは何もしない。
  // 全画面のエディタ・ダイアログ・名前の変更の間と、文字の入力中（パイメニューと同じ条件）は、ただの文字として扱う
  useEffect(() => {
    if (openFileId || dialog || renaming) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isParentCanvasKey(e)) return
      if (isImeEvent(e) || isEditableKeyboardTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      const current = viewRef.current?.editor.canvasId ?? canvasId
      const parentId = workspace.getCanvas(current)?.parentCanvasId
      if (!parentId) return
      e.preventDefault()
      void navigate(parentId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspace, canvasId, openFileId, dialog, renaming, navigate])

  // サイドバーからの操作は、今の Canvas の履歴に入る（MAI-11）
  const sidebarActions = {
    onOpen: (id: string) => void navigate(id),
    onRename: (id: string, title: string) => editor.transact('rename canvas', (tx) => workspace.renameCanvas(tx, id, title)),
    onPlace: (id: string) => {
      if (!view) return
      const { width, height } = view.size
      const camera = editor.session.get().camera
      const center = { x: camera.x + width / 2 / camera.zoom, y: camera.y + height / 2 / camera.zoom }
      if (!editor.placeCanvas(id, center)) notify('キャンバスを、それ自身やその中には置けません')
    },
    onOpenFile: (id: string) => openFile(id),
    onRestore: (id: string) => editor.transact('restore canvas', (tx) => workspace.restoreCanvas(tx, id)),
    onDeleteForever: async (id: string) => {
      const title = workspace.getDocument(id)?.title ?? ''
      const choice = await ask(
        '完全に削除しますか？',
        `「${title}」とその中身を完全に削除します。これを指すショートカットは「リンク切れ」になります。` +
          'Markdown などのファイルは消さずに、ワークスペースの .canvcode/deleted/ に移します。この操作は取り消せません。',
        [{ label: '完全に削除する', value: 'delete', danger: true }],
      )
      if (!choice) return
      // 実ファイルを移すので、取り消せない操作にする（履歴に残さない）
      let fileIds: string[] = []
      workspace.store.transact('delete forever', (tx) => (fileIds = workspace.deleteCanvasForever(tx, id)), { history: 'ignore' })
      for (const fileId of fileIds) void files.deleteForever(fileId)
    },
  }

  useEffect(() => {
    if (!view || !showStats) return
    const timer = window.setInterval(() => setStats(view.getStats()), 500)
    return () => window.clearInterval(timer)
  }, [view, showStats])

  // 矢印のパレット（MAI-28）。矢印のツールのとき、または矢印だけを選んでいるときに出し、選んでいる矢印にも当てる
  const selectedArrows = [...session.selectedIds].flatMap((id) => {
    const node = editor.getNode(id)
    return node?.type === 'arrow' ? [node] : []
  })
  const arrowPalette =
    session.toolId === 'arrow' || (selectedArrows.length > 0 && selectedArrows.length === session.selectedIds.size)
  const arrowStyle: ArrowStyle = selectedArrows.length > 0 ? (selectedArrows[0].props as ArrowProps) : session.arrowStyle
  const setArrowStyle = (patch: Partial<ArrowStyle>) => {
    const pick = (props: ArrowStyle): ArrowStyle => ({
      color: props.color,
      size: props.size,
      arrowheadStart: props.arrowheadStart,
      arrowheadEnd: props.arrowheadEnd,
    })
    if (selectedArrows.length > 0) {
      editor.transact('arrow style', (tx) => {
        // 画面を描いたあとで矢印が変わっている（曲げたなど）ことがあるので、今の値を読み直す
        for (const { id } of selectedArrows) {
          const node = editor.getNode(id)
          if (node) tx.put({ ...node, props: { ...node.props, ...patch } })
        }
      })
    }
    editor.session.set({ arrowStyle: { ...pick(arrowStyle), ...patch } })
  }

  // テキストと付箋のパレット（MAI-50）。テキストか付箋だけを選んでいるときに出し、文字の大きさと揃えを変える。
  // 編集中も出しっぱなしにし、押しても textarea からフォーカスを奪わない（編集を続けられる）
  const selectedTextNodes = [...session.selectedIds].flatMap((id) => {
    const node = editor.getNode(id)
    return node?.type === 'text' || node?.type === 'note' ? [node] : []
  })
  const textPalette = selectedTextNodes.length > 0 && selectedTextNodes.length === session.selectedIds.size
  const textStyleProps = selectedTextNodes[0]?.props as TextProps | NoteProps | undefined
  const setTextStyle = (patch: Partial<{ fontSize: number; align: TextAlign }> | ((props: TextProps | NoteProps) => Partial<TextProps | NoteProps>)) => {
    // 画面を描いたあとで変わっている（編集中の文字など）ことがあるので、今の値を読み直す
    const apply = (node: NodeRecord): NodeRecord => {
      const props = node.props as TextProps | NoteProps
      return { ...node, props: { ...props, ...(typeof patch === 'function' ? patch(props) : patch) } }
    }
    // 編集中は編集のトランザクションが開いたままで、新しいトランザクションを開けない（MAI-52）。
    // 編集中のノード（編集中は、選んでいるのはそのノードだけ）は、編集の中で変える
    if (view?.textEditor.editingId && view.textEditor.updateNode(apply)) return
    editor.transact('text style', (tx) => {
      for (const { id } of selectedTextNodes) {
        const node = editor.getNode(id)
        if (node) tx.put(apply(node))
      }
    })
  }

  const startBenchmark = () => {
    if (!view) return
    if (editor.index.size < BENCH_NODE_COUNT) {
      clearNodes(editor)
      generateNodes(editor, BENCH_NODE_COUNT)
    }
    setBench('running')
    runBenchmark(view, (results) => setBench(results))
  }

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar {...sidebarActions} workspace={workspace} currentId={canvasId} onClose={() => setSidebarOpen(false)} />
      )}
      <div className="main">
        <div className="canvas-container" ref={containerRef} />

        <div className="topbar">
          {!sidebarOpen && (
            <button className="sidebar-open" onClick={() => setSidebarOpen(true)} title="サイドバーを開く（Ctrl+\）">
              ☰
            </button>
          )}
          <Breadcrumb workspace={workspace} currentId={canvasId} onOpen={(id) => void navigate(id)} onRename={sidebarActions.onRename} />
        </div>

        <PieMenus
          enabled={!openFileId && !dialog && !renaming}
          menus={buildPieMenus({
            toolId: session.toolId,
            setTool: (toolId) => editor.session.set({ toolId }),
            importPdf: () => {
              if (!view) return
              void pickFiles('.pdf,application/pdf').then(async (files) => {
                if (!view) return
                const center = view.viewportCenter()
                for (const [i, file] of files.entries()) await view.importPdf(file, { x: center.x + i * 40, y: center.y + i * 40 })
              })
            },
            createFileCanvas: (kind) => void view?.createFileCanvas(kind),
            undo: () => view?.undo(),
            redo: () => view?.redo(),
            showStats,
            toggleStats: () => setShowStats((v) => !v),
            benchRunning: bench === 'running',
            cardBenchRunning: cardBench === 'running',
            addBenchNodes: () => {
              generateNodes(editor, BENCH_NODE_COUNT)
              view?.zoomToFit()
            },
            clearNodes: () => clearNodes(editor),
            runBenchmark: startBenchmark,
            addMarkdownCards: () => {
              generateMarkdownCards(editor)
              view?.zoomToFit()
            },
            runCardBenchmark: async () => {
              if (!view) return
              setCardBench('running')
              setCardBench(await runCardBenchmark(view))
            },
            markdownCardCount: CARD_COUNT,
          })}
        />

        {session.toolId === 'draw' && (
          <DrawPalette
            style={session.drawStyle}
            onChange={(patch) => editor.session.set({ drawStyle: { ...editor.session.get().drawStyle, ...patch } })}
          />
        )}

        {arrowPalette && (
          <div className="style-palette">
            {ARROW_COLORS.map((color) => (
              <button
                key={color}
                className={arrowStyle.color === color ? 'swatch active' : 'swatch'}
                style={{ background: color }}
                title={color}
                onClick={() => setArrowStyle({ color })}
              />
            ))}
            <span className="separator" />
            {ARROW_SIZES.map((size, i) => (
              <button key={size} className={arrowStyle.size === size ? 'active' : ''} onClick={() => setArrowStyle({ size })}>
                {SIZE_LABELS[i]}
              </button>
            ))}
            <span className="separator" />
            {ARROWHEADS.map((head) => (
              <button
                key={head.title}
                title={head.title}
                className={arrowStyle.arrowheadStart === head.start && arrowStyle.arrowheadEnd === head.end ? 'active' : ''}
                onClick={() => setArrowStyle({ arrowheadStart: head.start, arrowheadEnd: head.end })}
              >
                {head.label}
              </button>
            ))}
          </div>
        )}

        {textPalette && textStyleProps && (
          <div className="style-palette" onPointerDown={(e) => e.preventDefault()}>
            <button title="文字を大きく" onClick={() => setTextStyle((props) => ({ fontSize: stepFontSize(props.fontSize, 1) }))}>
              A+
            </button>
            <span className="value" title="文字の大きさ">
              {textStyleProps.fontSize}
            </span>
            <button title="文字を小さく" onClick={() => setTextStyle((props) => ({ fontSize: stepFontSize(props.fontSize, -1) }))}>
              A−
            </button>
            <span className="separator" />
            {TEXT_ALIGNS.map((item) => (
              <button
                key={item.align}
                title={item.title}
                className={textAlignOf(textStyleProps.align) === item.align ? 'active' : ''}
                onClick={() => setTextStyle({ align: item.align })}
              >
                <AlignIcon lines={item.lines} />
              </button>
            ))}
          </div>
        )}

        {showStats && stats && (
          <div className="stats">
            <div>FPS {stats.fps.toFixed(0)}</div>
            <div>
              フレーム間隔 中央値 {stats.intervalP50.toFixed(1)} ms / 95% {stats.intervalP95.toFixed(1)} ms
            </div>
            <div>
              描画時間 中央値 {stats.drawP50.toFixed(2)} ms / 95% {stats.drawP95.toFixed(2)} ms
            </div>
            <div>
              描画ノード {stats.drawnNodes.toLocaleString()} / 全 {stats.totalNodes.toLocaleString()}
            </div>
            <div>倍率 {(session.camera.zoom * 100).toFixed(0)}%</div>
          </div>
        )}

        {Array.isArray(bench) && (
          <div className="bench-result">
            <div className="bench-header">
              <strong>ベンチマーク結果（{editor.index.size.toLocaleString()} ノード）</strong>
              <button onClick={() => setBench('idle')}>閉じる</button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>段階</th>
                  <th>FPS</th>
                  <th>間隔 中央値</th>
                  <th>間隔 95%</th>
                  <th>描画 中央値</th>
                  <th>描画 95%</th>
                  <th>描画ノード</th>
                </tr>
              </thead>
              <tbody>
                {bench.map((result) => (
                  <tr key={result.name}>
                    <td>{result.name}</td>
                    <td>{result.stats.fps.toFixed(0)}</td>
                    <td>{result.stats.intervalP50.toFixed(1)} ms</td>
                    <td>{result.stats.intervalP95.toFixed(1)} ms</td>
                    <td>{result.stats.drawP50.toFixed(2)} ms</td>
                    <td>{result.stats.drawP95.toFixed(2)} ms</td>
                    <td>{result.stats.drawnNodes.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              目標は 60FPS（フレーム間隔 16.7 ms）。描画時間はシーンとオーバーレイの描画にかかった CPU 時間。
            </p>
          </div>
        )}

        {typeof cardBench === 'object' && (
          <div className="bench-result card-bench-result">
            <div className="bench-header">
              <strong>
                カードのズームのベンチマーク（Markdown カード {CARD_COUNT} 枚、devicePixelRatio {cardBench.dpr}）
              </strong>
              <button onClick={() => setCardBench('idle')}>閉じる</button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>段階</th>
                  <th>FPS</th>
                  <th>間隔 中央値</th>
                  <th>間隔 95%</th>
                  <th>間隔 最大</th>
                  <th>落ちたフレーム</th>
                  <th>作った画像</th>
                  <th>くっきりするまで</th>
                </tr>
              </thead>
              <tbody>
                {cardBench.phases.map((phase) => (
                  <tr key={phase.name}>
                    <td>{phase.name}</td>
                    <td>{phase.fps.toFixed(0)}</td>
                    <td>{phase.p50.toFixed(1)} ms</td>
                    <td>{phase.p95.toFixed(1)} ms</td>
                    <td>{phase.max.toFixed(1)} ms</td>
                    <td>
                      {phase.dropped} / {phase.frames}
                    </td>
                    <td>{phase.produced}</td>
                    <td>{phase.sharpMs !== undefined ? `${(phase.sharpMs / 1000).toFixed(2)} 秒` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              画像の作り方：createImageBitmap {cardBench.raster.bitmap} 回 ／ Canvas {cardBench.raster.canvas} 回（うち
              createImageBitmap から戻したもの {cardBench.raster.bitmapFallback} 回）。
              最初の画像を作り終えるまで {(cardBench.warmupMs / 1000).toFixed(2)} 秒。「落ちたフレーム」は、間隔が 25 ms
              を超えたフレームの数。
            </p>
          </div>
        )}

        {importProgress !== null && (
          <div className="import-progress">
            {importProgress < 1 ? `旧データを送っています… ${Math.round(importProgress * 100)}%` : '旧データを取り込んでいます…'}
          </div>
        )}

        <div className={`sync-status ${syncStatus}`} title={SYNC_LABELS[syncStatus]}>
          {syncStatus === 'offline' ? '未接続' : SYNC_LABELS[syncStatus]}
        </div>

        {notices.length > 0 && (
          <div className="notices">
            {notices.map((notice) => (
              <div key={notice.id} className="notice">
                {notice.message}
              </div>
            ))}
          </div>
        )}

        {renaming && renaming.canvasOfPortal === canvasId && (
          <PortalRename
            target={renaming}
            onCommit={(title) => {
              setRenaming(null)
              // Canvas の名前は今の Canvas の履歴に入る（Ctrl+Z で戻せる）。File の名前はファイル名なので、サーバーで変える
              if (workspace.getFile(renaming.documentId)) void files.rename(renaming.documentId, title)
              else editor.transact('rename canvas', (tx) => workspace.renameCanvas(tx, renaming.documentId, title))
              view?.root.focus({ preventScroll: true })
            }}
            onCancel={() => {
              setRenaming(null)
              view?.root.focus({ preventScroll: true })
            }}
          />
        )}

        {openFileId && (
          <FileEditor
            workspace={workspace}
            files={files}
            fileId={openFileId}
            focus={fileFocus}
            onQuote={(draft) => void view?.copyQuote(draft)}
            onLost={() => notify('引用した文字列が見つかりません（位置不明）。覚えていた行を開きました')}
            onClose={closeFile}
          />
        )}

        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menu.items}
            onClose={() => {
              menu.onClose?.()
              setMenu(null)
            }}
          />
        )}
        {dialog && (
          <ConfirmDialog
            title={dialog.title}
            message={dialog.message}
            choices={dialog.choices}
            onChoose={(value) => {
              setDialog(null)
              dialog.resolve(value)
            }}
          />
        )}
      </div>
    </div>
  )
}
