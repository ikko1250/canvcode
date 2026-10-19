import { isNodeRecord, type NodeRecord, type StoreEvent, type WorkspaceRecord } from '@canvcode/core'
import type { LinkCardProps } from '@canvcode/nodes'
import { isSupportedImage, type AssetManager } from './assets.ts'
import type { Editor } from './editor.ts'

// リンクのカードに、リンク先のページのタイトル・説明・サムネイルを書き込む。
// ページはブラウザからは CORS で読めないので、サーバー（apps/server の linkPreview.ts）に取ってきてもらう。
// - 読み込み中（status: 'loading'）のカードが、この画面の操作（貼り付け、Redo）で現れたら取りに行く。
//   サーバーや別のタブから届いたものは、そちらが取りに行くので見ない
// - 書き込みは Undo の履歴に残さず、はじめからそうだったものとして履歴の中のレコードも差し替える
//   （Undo すると貼り付けそのものが消え、Redo するとタイトルなどの入ったカードが戻る）
// - 取れなかったら status を 'failed' にして、URL だけのカードのまま残す

export interface LinkPreview {
  title: string | null
  description: string | null
  siteName: string | null
  // サムネイルの URL（og:image）
  image: string | null
}

export class LinkPreviewer {
  private readonly assets: AssetManager
  private readonly baseUrl: string
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(assets: AssetManager, baseUrl = '/api/link-preview') {
    this.assets = assets
    this.baseUrl = baseUrl
  }

  // store の commit を見て、読み込み中のリンクのカードがあれば取りに行く
  watch(editor: Editor, event: StoreEvent<WorkspaceRecord>): void {
    if (event.phase !== 'commit' || event.options.source === 'remote') return
    for (const change of event.patch.values()) {
      const record = change.after
      if (isLinkCard(record) && record.props.status === 'loading') void this.load(editor, record.id)
    }
  }

  // すべての読み込みが終わるまで待つ（テスト用）
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()])
  }

  load(editor: Editor, id: string): Promise<void> {
    const running = this.inFlight.get(id)
    if (running) return running
    const node = editor.store.get(id)
    if (!isLinkCard(node)) return Promise.resolve()
    const url = node.props.url
    const task = this.fetchPreview(url)
      .then((result) => update(editor, id, url, result ?? { status: 'failed' }))
      .catch((error: unknown) => {
        console.warn('Failed to load link preview', url, error)
        update(editor, id, url, { status: 'failed' })
      })
      .finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, task)
    return task
  }

  private async fetchPreview(url: string): Promise<Partial<LinkCardProps> | null> {
    const response = await fetch(`${this.baseUrl}?url=${encodeURIComponent(url)}`)
    if (!response.ok) return null
    const preview = (await response.json()) as LinkPreview
    const image = preview.image ? await this.fetchImage(preview.image) : null
    return {
      title: text(preview.title),
      description: text(preview.description),
      siteName: text(preview.siteName),
      image,
      status: 'done',
    }
  }

  // サムネイルはサーバーに中継してもらい、ふつうの画像と同じく Asset に取り込む（縮小版もここで作る）
  private async fetchImage(url: string): Promise<LinkCardProps['image']> {
    try {
      const response = await fetch(`${this.baseUrl}/image?url=${encodeURIComponent(url)}`)
      if (!response.ok) return null
      const blob = await response.blob()
      if (!isSupportedImage(blob)) return null
      const asset = await this.assets.importImage(blob)
      if (asset.width <= 0 || asset.height <= 0) return null
      return { assetId: asset.id, aspect: asset.height / asset.width }
    } catch (error) {
      console.warn('Failed to load link thumbnail', url, error)
      return null
    }
  }
}

function isLinkCard(record: WorkspaceRecord | undefined): record is NodeRecord<LinkCardProps> {
  return isNodeRecord(record) && record.type === 'link-card'
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// まだ同じ URL の読み込み中のカードなら書き込む（その間に消されたり、URL が変わったりしていたら何もしない）
function update(editor: Editor, id: string, url: string, props: Partial<LinkCardProps>): void {
  const { store } = editor
  const node = store.get(id)
  if (!isLinkCard(node) || node.props.url !== url || node.props.status !== 'loading') return
  // ドラッグなどの最中なら、終わってから書く
  if (store.activeTransaction) {
    setTimeout(() => update(editor, id, url, props), 200)
    return
  }
  const next = { ...node, props: { ...node.props, ...props } }
  store.transact('link preview', (tx) => tx.put(next), { history: 'ignore' })
  editor.history.substitute(node, next)
}
