import { answerRender, type CanvasView, type Editor, type ImageTarget, type RenderAnswer, type RenderRequestMessage, type SyncClient } from '@canvcode/canvas'

// Canvas を画像にしてほしいという、サーバーからの頼み（AI の render_canvas）に答える（MAI-89。docs/canvas-image-plan.md の 4.4）。
// - 1 つずつ描く（タブの中の列）。読んでいない Canvas なら先に読み、届いている変更を当て終えてから描く
// - 描く Canvas の Editor：開いているものがあればそれを、なければ一時的に作り、描いたら必ず捨てる
// - 描くためだけに読んだ画像は、見ていない Canvas なら描いたあとで捨てる（iPad のメモリー。MAI-66）
// - PDF のページは印刷用に描く（PDF.js は画面用だと requestAnimationFrame で描き進め、裏に回ったタブで止まる）
// - 描けなければ理由を返す。ほかのタブなら描けるかもしれないもの（読めない・まだ準備ができていない）は retry にする

export interface RenderResponderDeps {
  sync: Pick<SyncClient, 'ensureCanvas' | 'afterRemote' | 'revision'>
  view(): CanvasView | null
  editorFor(canvasId: string): { editor: Editor; temporary: boolean } | null
  baseUrl?: string
  answer?: (attempt: string, answer: RenderAnswer, baseUrl?: string) => Promise<void>
  // Canvas を読むのを待つ時間
  loadTimeoutMs?: number
}

const LOAD_TIMEOUT_MS = 10_000

export function createRenderResponder(deps: RenderResponderDeps): (request: RenderRequestMessage) => void {
  let queue: Promise<void> = Promise.resolve()
  return (request) => {
    queue = queue.then(() => respond(deps, request)).catch((error: unknown) => console.error('Failed to answer a render request', error))
  }
}

async function respond(deps: RenderResponderDeps, request: RenderRequestMessage): Promise<void> {
  const answer = (value: RenderAnswer) => (deps.answer ?? answerRender)(request.attempt, value, deps.baseUrl ?? '')
  const view = deps.view()
  if (!view) return answer({ error: 'the tab is not ready', retry: true })
  try {
    await withTimeout(deps.sync.ensureCanvas(request.canvasId), deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS)
  } catch {
    return answer({ error: 'the tab could not load the canvas', retry: true })
  }
  await deps.sync.afterRemote()
  const rev = deps.sync.revision
  if (rev < request.rev) return answer({ error: 'the tab has not received the latest changes', retry: true })
  const held = deps.editorFor(request.canvasId)
  if (!held) return answer({ error: 'the tab could not open the canvas', retry: true })
  try {
    const image = await view.renderImage(held.editor, request.target, { maxEdge: request.maxEdge }, {
      complete: true,
      pdfIntent: 'print',
      release: held.editor !== view.editor,
    })
    if (!image) return answer({ error: nothingToDraw(request.target), retry: false })
    const { png, box, scale, capped, empty, incomplete, missing } = image
    return answer({ png, box, scale, rev, capped, empty, incomplete, missing })
  } catch (error) {
    console.error('Failed to render a canvas for the AI', error)
    return answer({ error: `the tab failed to render (${error instanceof Error ? error.message : String(error)})`, retry: true })
  } finally {
    if (held.temporary) held.editor.dispose()
  }
}

// 描くものがないとき（どのタブでも同じなので、ほかのタブには回さない）
function nothingToDraw(target: ImageTarget): string {
  if (target.kind === 'slide') return `${target.id} is not a slide on this canvas.`
  if (target.kind === 'nodes') return 'None of the nodes are on this canvas.'
  if (target.kind === 'canvas') return 'The canvas has no nodes.'
  return 'The rect is empty.'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
