import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  CanvasView,
  Editor,
  FileManager,
  Workspace,
  type ConflictChoice,
  type ArrowStyle,
  type OwnerPortalDeletion,
  type StatsSummary,
  type ToolId,
} from '@canvcode/canvas'
import {
  ARROW_COLORS,
  ARROW_SIZES,
  DRAW_COLORS,
  DRAW_SIZES,
  builtinNodeTypes,
  type ArrowProps,
  type FileContentSource,
  type PortalProps,
} from '@canvcode/nodes'
import type { MarkdownCardProps } from '@canvcode/nodes/markdown'
import { clearNodes, generateNodes, runBenchmark, type PhaseResult } from './benchmark.ts'
import { CARD_COUNT, generateMarkdownCards, runCardBenchmark, type CardBenchmarkResult } from './cardBenchmark.ts'
import { createAppMarkdownCardType } from './markdown/markdownCard.ts'
import { Breadcrumb } from './workspace/Breadcrumb.tsx'
import { ConfirmDialog, type DialogChoice } from './workspace/ConfirmDialog.tsx'
import { ContextMenu, type MenuItem } from './workspace/ContextMenu.tsx'
import { FileEditor } from './workspace/FileEditor.tsx'
import { PortalRename, type PortalRenameTarget } from './workspace/PortalRename.tsx'
import { Sidebar } from './workspace/Sidebar.tsx'
import { useWorkspaceVersion } from './workspace/useWorkspace.ts'

// 画面（MAI-29 から、サイドバーとパンくずリストを持つ）。下端のツールバーは動作確認用。
// Canvas を移るときは、その Canvas の Editor に切り替える。Editor は Canvas ごとに作って取っておく（カメラや選択を覚えておくため）。

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: '選択', key: 'V' },
  { id: 'hand', label: '手のひら', key: 'H' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'ellipse', label: '楕円', key: 'O' },
  { id: 'text', label: 'テキスト', key: 'T' },
  { id: 'note', label: '付箋', key: 'N' },
  { id: 'frame', label: 'フレーム', key: 'F' },
  { id: 'draw', label: 'フリーハンド', key: 'D' },
  { id: 'eraser', label: '消しゴム', key: 'E' },
  { id: 'arrow', label: '矢印', key: 'A' },
  { id: 'portal', label: 'Portal', key: 'P' },
  { id: 'markdown', label: 'Markdown', key: 'M' },
]

// Markdown カードの名前の帯の寸法（ワールド座標。cardHtml.ts の .md-card-header に合わせる）
const CARD_HEADER = { height: 36, padding: 12, fontSize: 13 }

const SIZE_LABELS = ['細', '中', '太']
const ARROWHEADS: { label: string; title: string; start: ArrowStyle['arrowheadStart']; end: ArrowStyle['arrowheadEnd'] }[] = [
  { label: '—', title: '矢じりなし', start: 'none', end: 'none' },
  { label: '→', title: '終点に矢じり', start: 'none', end: 'arrow' },
  { label: '↔', title: '両端に矢じり', start: 'arrow', end: 'arrow' },
]

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
function createWorkspace() {
  let manager: FileManager | null = null
  const content: FileContentSource = { get: (fileId) => manager?.get(fileId) ?? null }
  const workspace = new Workspace({ types: [...builtinNodeTypes, createAppMarkdownCardType(content)] })
  manager = new FileManager({ workspace })
  return { workspace, files: manager }
}

type Dialog = { title: string; message: string; choices: DialogChoice<string>[]; resolve(value: string | null): void }

export function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [{ workspace, files }] = useState(createWorkspace)
  // 全画面のエディタで開いている File（MAI-30）
  const [openFileId, setOpenFileId] = useState<string | null>(null)
  // Canvas ごとの Editor（一度開いたら取っておく）と、開いたことのある Canvas（初めてなら全体を表示する）
  const [editors] = useState(() => new Map<string, Editor>())
  const [visited] = useState(() => new Set<string>())
  const getEditor = useCallback(
    (canvasId: string) => {
      let editor = editors.get(canvasId)
      if (!editor) {
        editor = new Editor({ workspace, canvasId })
        editors.set(canvasId, editor)
      }
      return editor
    },
    [workspace, editors],
  )
  const [canvasId, setCanvasId] = useState(workspace.rootCanvasId)
  const editor = getEditor(canvasId)
  const [view, setView] = useState<CanvasView | null>(null)
  const session = useSyncExternalStore(editor.session.subscribe, editor.session.getSnapshot)
  useWorkspaceVersion(workspace)
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [showStats, setShowStats] = useState(true)
  const [bench, setBench] = useState<'idle' | 'running' | PhaseResult[]>('idle')
  const [cardBench, setCardBench] = useState<'idle' | 'running' | CardBenchmarkResult>('idle')
  // 画面の下に短く出す知らせ（受け付けないファイルをドロップしたときなど）
  const [notices, setNotices] = useState<{ id: number; message: string }[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | 'separator')[] } | null>(null)
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
  }, [files, notify, ask])

  // 全画面のエディタを開く・閉じる（URL は /f/<id>。ブラウザの「戻る」で閉じる）
  const openFile = useCallback(
    (fileId: string, options: { push?: boolean } = {}) => {
      if (!workspace.getFile(fileId)) return
      if (workspace.targetStatus(fileId) !== 'ok') {
        notify('この File は開けません（ゴミ箱の中か、ファイルが見つかりません）')
        return
      }
      setOpenFileId(fileId)
      if (options.push !== false) history.pushState({ fileId }, '', `/f/${encodeURIComponent(fileId)}`)
    },
    [workspace, notify],
  )
  const closeFile = useCallback(() => {
    setOpenFileId(null)
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
      if (single?.type === 'markdown-card') {
        const props = single.props as MarkdownCardProps
        const file = workspace.getFile(props.fileId)
        if (file) {
          items.push({ label: '編集', shortcut: 'Enter', onSelect: () => view.editDocument(single.id) })
          items.push({ label: '全画面で開く', shortcut: 'Ctrl+Enter', onSelect: () => openFile(file.id) })
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
        items.push({ label: '複製', shortcut: 'Ctrl+D', onSelect: () => view.duplicateSelection() })
        if (selected.length > 1) items.push({ label: 'グループにする', shortcut: 'Ctrl+G', onSelect: () => editor.groupSelected() })
        if (selected.some((n) => n.type === 'group')) {
          items.push({ label: 'グループを解除', shortcut: 'Ctrl+Shift+G', onSelect: () => editor.ungroupSelected() })
        }
        items.push('separator')
        items.push({ label: '削除', shortcut: 'Delete', danger: true, onSelect: () => void view.deleteSelection() })
      } else {
        items.push({
          label: 'ここに新しいキャンバス',
          shortcut: 'P',
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
          shortcut: 'M',
          onSelect: () => {
            const rect = view.root.getBoundingClientRect()
            const camera = editor.session.get().camera
            const world = { x: camera.x + (at.x - rect.left) / camera.zoom, y: camera.y + (at.y - rect.top) / camera.zoom }
            void view.createMarkdownAt(world)
          },
        })
        items.push({ label: 'すべて選択', shortcut: 'Ctrl+A', onSelect: () => editor.selectAll() })
      }
      return items
    },
    [openPortal, openFile, workspace, setRenaming],
  )


  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const created = new CanvasView(getEditor(workspace.rootCanvasId), container, {
      notify,
      files,
      onOpenFile: (fileId) => openFile(fileId),
      onOpenPortal: (portalId) => openPortal(portalId),
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
    // 開いた URL の Canvas に入る（段階 11 まではデータを保存しないので、再読み込みするとルートだけになる）
    const initial = canvasIdFromUrl()
    if (initial && initial !== workspace.rootCanvasId && workspace.getCanvas(initial)) void navigate(initial, { push: false })
    else history.replaceState({ canvasId: workspace.rootCanvasId }, '', `/c/${encodeURIComponent(workspace.rootCanvasId)}`)
    // ページを閉じる・隠すときは、保存していない編集をすぐ保存する
    const onHide = () => void files.flush()
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
  }, [workspace, files, visited, notify, ask, getEditor, navigate, openPortal, openFile, buildMenu])

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

  // サイドバーからの操作は、今の Canvas の履歴に入る（MAI-11）
  const sidebarActions = {
    onOpen: (id: string) => void navigate(id),
    onRename: (id: string, title: string) => editor.transact('rename canvas', (tx) => workspace.renameCanvas(tx, id, title)),
    onPlace: (id: string) => {
      if (!view) return
      const { width, height } = view.size
      const camera = editor.session.get().camera
      const center = { x: camera.x + width / 2 / camera.zoom, y: camera.y + height / 2 / camera.zoom }
      if (workspace.getFile(id)?.kind === 'code') {
        notify('Python のカードは、段階 10-2 で対応します')
        return
      }
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
          <Breadcrumb workspace={workspace} currentId={canvasId} onOpen={(id) => void navigate(id)} />
        </div>

        <div className="toolbar">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              className={session.toolId === tool.id ? 'active' : ''}
              onClick={() => editor.session.set({ toolId: tool.id })}
              title={`${tool.label}（${tool.key}）`}
            >
              {tool.label}
              <kbd>{tool.key}</kbd>
            </button>
          ))}
          <span className="separator" />
          <button onClick={() => view?.undo()} title="元に戻す（Ctrl+Z）">
            元に戻す
          </button>
          <button onClick={() => view?.redo()} title="やり直す（Ctrl+Shift+Z）">
            やり直す
          </button>
          <span className="separator" />
          <button
            onClick={() => {
              generateNodes(editor, BENCH_NODE_COUNT)
              view?.zoomToFit()
            }}
          >
            1 万ノードを追加
          </button>
          <button onClick={() => clearNodes(editor)}>すべて消す</button>
          <button onClick={startBenchmark} disabled={bench === 'running'}>
            {bench === 'running' ? 'ベンチマーク実行中…' : 'ベンチマーク'}
          </button>
          <span className="separator" />
          <button
            onClick={() => {
              generateMarkdownCards(editor)
              view?.zoomToFit()
            }}
          >
            Markdown カード {CARD_COUNT} 枚を追加
          </button>
          <button
            disabled={cardBench === 'running' || !view}
            onClick={async () => {
              if (!view) return
              setCardBench('running')
              setCardBench(await runCardBenchmark(view))
            }}
          >
            {cardBench === 'running' ? 'カードのベンチマーク実行中…' : 'カードのズームのベンチマーク'}
          </button>
          <button onClick={() => setShowStats((v) => !v)}>{showStats ? '計測を隠す' : '計測を表示'}</button>
        </div>

        {session.toolId === 'draw' && (
          <div className="style-palette">
            {DRAW_COLORS.map((color) => (
              <button
                key={color}
                className={session.drawStyle.color === color ? 'swatch active' : 'swatch'}
                style={{ background: color }}
                title={color}
                onClick={() => editor.session.set({ drawStyle: { ...session.drawStyle, color } })}
              />
            ))}
            <span className="separator" />
            {DRAW_SIZES.map((size, i) => (
              <button
                key={size}
                className={session.drawStyle.size === size ? 'active' : ''}
                onClick={() => editor.session.set({ drawStyle: { ...session.drawStyle, size } })}
              >
                {SIZE_LABELS[i]}
              </button>
            ))}
          </div>
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

        {openFileId && <FileEditor workspace={workspace} files={files} fileId={openFileId} onClose={closeFile} />}

        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
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
