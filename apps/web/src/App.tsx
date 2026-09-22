import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  CanvasView,
  Editor,
  Workspace,
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
  type PortalProps,
} from '@canvcode/nodes'
import { clearNodes, generateNodes, runBenchmark, type PhaseResult } from './benchmark.ts'
import { CARD_COUNT, generateMarkdownCards, runCardBenchmark, type CardBenchmarkResult } from './cardBenchmark.ts'
import { markdownCardType } from './markdown/markdownCard.ts'
import { Breadcrumb } from './workspace/Breadcrumb.tsx'
import { ConfirmDialog, type DialogChoice } from './workspace/ConfirmDialog.tsx'
import { ContextMenu, type MenuItem } from './workspace/ContextMenu.tsx'
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
]

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

type Dialog = { title: string; message: string; choices: DialogChoice<string>[]; resolve(value: string | null): void }

export function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [workspace] = useState(() => new Workspace({ types: [...builtinNodeTypes, markdownCardType] }))
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
        const branchPortal = !portal && branch?.ownerPortalId ? next.index.get(branch.ownerPortalId) : undefined
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
                canvasId: target.id,
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
        items.push({ label: 'すべて選択', shortcut: 'Ctrl+A', onSelect: () => editor.selectAll() })
      }
      return items
    },
    [openPortal, workspace, setRenaming],
  )


  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const created = new CanvasView(getEditor(workspace.rootCanvasId), container, {
      notify,
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
    // 開いた URL の Canvas に入る（段階 11 まではデータを保存しないので、再読み込みするとルートだけになる）
    const initial = canvasIdFromUrl()
    if (initial && initial !== workspace.rootCanvasId && workspace.getCanvas(initial)) void navigate(initial, { push: false })
    else history.replaceState({ canvasId: workspace.rootCanvasId }, '', `/c/${encodeURIComponent(workspace.rootCanvasId)}`)
    const onPop = (e: PopStateEvent) => {
      const id = (e.state as { canvasId?: string } | null)?.canvasId ?? workspace.rootCanvasId
      void navigate(workspace.getCanvas(id) ? id : workspace.rootCanvasId, { push: false })
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      created.dispose()
    }
    // どれも useCallback で固定してあるので、この処理は最初に 1 回だけ走る
  }, [workspace, visited, notify, ask, getEditor, navigate, openPortal, buildMenu])

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
      if (!editor.placeCanvas(id, center)) notify('キャンバスを、それ自身やその中には置けません')
    },
    onRestore: (id: string) => editor.transact('restore canvas', (tx) => workspace.restoreCanvas(tx, id)),
    onDeleteForever: async (id: string) => {
      const title = workspace.getCanvas(id)?.title ?? ''
      const choice = await ask(
        '完全に削除しますか？',
        `「${title}」とその中身を完全に削除します。これを指すショートカットは「リンク切れ」になります。`,
        [{ label: '完全に削除する', value: 'delete', danger: true }],
      )
      if (choice) editor.transact('delete canvas forever', (tx) => workspace.deleteCanvasForever(tx, id))
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
              // 今の Canvas の履歴に入る（Ctrl+Z で戻せる）
              editor.transact('rename canvas', (tx) => workspace.renameCanvas(tx, renaming.canvasId, title))
              view?.root.focus({ preventScroll: true })
            }}
            onCancel={() => {
              setRenaming(null)
              view?.root.focus({ preventScroll: true })
            }}
          />
        )}

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
