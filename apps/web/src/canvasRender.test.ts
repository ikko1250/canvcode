import { describe, expect, it, vi } from 'vitest'
import type { CanvasView, Editor, RenderAnswer, RenderRequestMessage } from '@canvcode/canvas'
import { createRenderResponder, type RenderResponderDeps } from './canvasRender.ts'

// Canvas を画像にしてほしいという、サーバーからの頼みに答える（MAI-89）

const request = (fields: Partial<RenderRequestMessage> = {}): RenderRequestMessage => ({
  attempt: 'a1',
  canvasId: 'canvas:child',
  rev: 3,
  target: { kind: 'slide', id: 'node:s' },
  maxEdge: 1568,
  ...fields,
})

const image = { png: new Blob(['png']), box: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 0.8, width: 1568, height: 882, capped: false, empty: false, incomplete: [], missing: [] }

function setup(options: { rev?: number; render?: () => Promise<unknown>; open?: boolean; loads?: () => Promise<void> } = {}) {
  const steps: string[] = []
  const answers: { attempt: string; answer: RenderAnswer }[] = []
  const shown = { canvasId: 'canvas:root', dispose: vi.fn() } as unknown as Editor
  const temporary = { canvasId: 'canvas:child', dispose: vi.fn(() => steps.push('dispose')) } as unknown as Editor
  const renderImage = vi.fn(async (...args: unknown[]) => {
    steps.push('render')
    void args
    return options.render ? options.render() : image
  })
  const view = { editor: shown, renderImage } as unknown as CanvasView
  let done: () => void = () => {}
  const finished = new Promise<void>((resolve) => (done = resolve))
  const deps: RenderResponderDeps = {
    sync: {
      ensureCanvas: async (canvasId: string) => {
        steps.push(`load ${canvasId}`)
        await options.loads?.()
      },
      afterRemote: async () => {
        steps.push('afterRemote')
      },
      revision: options.rev ?? 3,
    },
    view: () => view,
    editorFor: (canvasId) => (canvasId === 'canvas:root' ? { editor: shown, temporary: false } : options.open === false ? null : { editor: temporary, temporary: true }),
    answer: async (attempt, answer) => {
      answers.push({ attempt, answer })
      done()
    },
    loadTimeoutMs: 50,
  }
  return { respond: createRenderResponder(deps), steps, answers, finished, renderImage, shown, temporary }
}

describe('createRenderResponder', () => {
  it('loads the canvas, waits for the changes, draws with a temporary editor, answers, and disposes it', async () => {
    const t = setup()
    t.respond(request())
    await t.finished
    expect(t.steps).toEqual(['load canvas:child', 'afterRemote', 'render', 'dispose'])
    expect(t.renderImage).toHaveBeenCalledWith(t.temporary, { kind: 'slide', id: 'node:s' }, { maxEdge: 1568 }, { complete: true, pdfIntent: 'print', release: true })
    expect(t.answers).toEqual([{ attempt: 'a1', answer: { png: image.png, box: image.box, scale: 0.8, rev: 3, capped: false, empty: false, incomplete: [], missing: [] } }])
  })

  it('keeps the images of the canvas the user is viewing', async () => {
    const t = setup()
    t.respond(request({ canvasId: 'canvas:root' }))
    await t.finished
    expect(t.renderImage.mock.calls[0]![3]).toMatchObject({ release: false })
    expect(t.shown.dispose).not.toHaveBeenCalled()
  })

  it('asks the server to try another tab when it cannot load, is behind, or fails, and disposes the editor even then', async () => {
    let t = setup({ loads: () => new Promise(() => {}) })
    t.respond(request())
    await t.finished
    expect(t.answers[0]!.answer).toEqual({ error: 'the tab could not load the canvas', retry: true })

    t = setup({ rev: 2 })
    t.respond(request())
    await t.finished
    expect(t.answers[0]!.answer).toEqual({ error: 'the tab has not received the latest changes', retry: true })

    t = setup({ open: false })
    t.respond(request())
    await t.finished
    expect(t.answers[0]!.answer).toMatchObject({ retry: true })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    t = setup({ render: () => Promise.reject(new Error('boom')) })
    t.respond(request())
    await t.finished
    expect(t.answers[0]!.answer).toEqual({ error: 'the tab failed to render (boom)', retry: true })
    expect(t.temporary.dispose).toHaveBeenCalledTimes(1)
    errors.mockRestore()
  })

  it('says when there is nothing to draw, without asking another tab', async () => {
    const t = setup({ render: async () => null })
    t.respond(request())
    await t.finished
    expect(t.answers[0]!.answer).toEqual({ error: 'node:s is not a slide on this canvas.', retry: false })
  })

  it('draws one request at a time', async () => {
    const t = setup()
    let release: () => void = () => {}
    let first = true
    t.renderImage.mockImplementation(async () => {
      t.steps.push('render')
      if (first) {
        first = false
        await new Promise<void>((resolve) => (release = resolve))
      }
      return image
    })
    t.respond(request({ attempt: 'a1' }))
    t.respond(request({ attempt: 'a2' }))
    await vi.waitFor(() => expect(t.steps.filter((s) => s === 'render')).toHaveLength(1))
    expect(t.steps.filter((s) => s.startsWith('load'))).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(t.answers.map((a) => a.attempt)).toEqual(['a1', 'a2']))
  })
})
