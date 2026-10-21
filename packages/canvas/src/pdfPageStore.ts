// 最後に見た PDF のページの画像を、ブラウザ（IndexedDB）に置いておく（Issue #26、docs/pdf-page-images-plan.md の「3」）。
// - 拡大して読んでいたページに戻ってきたとき（タブを開き直したあとでも）、PDF を受け取らずに、くっきりした画像をすぐ出すため
// - 置くのは PDF.js で描いた level 1 以上の画像だけ（View が、カメラが止まって画像を作り終えたあとに、読んでいるページの分を頼む）
// - 端末ごとに持つ（カメラの位置と同じ）。上限（MAX_ENTRIES 枚・MAX_BYTES）を超えたら、使っていないものから消す
// - IndexedDB は、プライベートウィンドウなどで使えないことがある。読み書きに失敗したら、置いていないものとして続ける
// - 中身の置き場所は PdfPageBackend にまとめる（テストではメモリーに置く）

export interface StoredPdfPage {
  // `${hash}#${pageIndex}@${level}`
  key: string
  hash: string
  pageIndex: number
  level: number
  width: number
  height: number
  // WebP（品質 0.92）。WebP にできないブラウザ（Safari）では PNG
  blob: Blob
  bytes: number
  // 最後に使った時刻。上限を超えたら古いものから消す
  usedAt: number
}

export interface PdfPageBackend {
  get(key: string): Promise<StoredPdfPage | undefined>
  put(page: StoredPdfPage): Promise<void>
  delete(keys: string[]): Promise<void>
  // 中身（blob）を除いた一覧（消すものを選ぶのに使う）
  list(): Promise<Omit<StoredPdfPage, 'blob'>[]>
}

export interface PdfPageStoreOptions {
  maxEntries?: number
  maxBytes?: number
  now?: () => number
}

const MAX_ENTRIES = 24
const MAX_BYTES = 48 * 1024 * 1024
const DB_NAME = 'canvcode-pdf-pages'
const STORE = 'pages'

export function pdfPageKey(hash: string, pageIndex: number, level: number): string {
  return `${hash}#${pageIndex}@${level}`
}

export class PdfPageStore {
  private readonly backend: PdfPageBackend
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(backend: PdfPageBackend, options: PdfPageStoreOptions = {}) {
    this.backend = backend
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.now = options.now ?? Date.now
  }

  // 置いてある画像を返す（level がぴったり同じものだけ）。使った時刻を新しくする
  async load(hash: string, pageIndex: number, level: number): Promise<StoredPdfPage | null> {
    try {
      const page = await this.backend.get(pdfPageKey(hash, pageIndex, level))
      if (!page) return null
      void this.backend.put({ ...page, usedAt: this.now() }).catch(() => {})
      return page
    } catch {
      return null
    }
  }

  async save(page: Omit<StoredPdfPage, 'key' | 'bytes' | 'usedAt'>): Promise<void> {
    const key = pdfPageKey(page.hash, page.pageIndex, page.level)
    try {
      await this.backend.put({ ...page, key, bytes: page.blob.size, usedAt: this.now() })
      // 上限を超えた分を、使っていないものから消す（いま置いたものは最後に残す）
      const pages = (await this.backend.list()).sort((a, b) => a.usedAt - b.usedAt || (a.key === key ? 1 : b.key === key ? -1 : 0))
      let count = pages.length
      let bytes = pages.reduce((sum, item) => sum + item.bytes, 0)
      const removed: string[] = []
      for (const item of pages) {
        if (count <= this.maxEntries && bytes <= this.maxBytes) break
        if (item.key === key) continue
        removed.push(item.key)
        count--
        bytes -= item.bytes
      }
      if (removed.length > 0) await this.backend.delete(removed)
    } catch (error) {
      console.warn('Failed to keep a PDF page image', key, error)
    }
  }
}

// メモリーに置く（テスト用）
export class MemoryPdfPageBackend implements PdfPageBackend {
  readonly pages = new Map<string, StoredPdfPage>()

  async get(key: string): Promise<StoredPdfPage | undefined> {
    return this.pages.get(key)
  }

  async put(page: StoredPdfPage): Promise<void> {
    this.pages.set(page.key, page)
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.pages.delete(key)
  }

  async list(): Promise<Omit<StoredPdfPage, 'blob'>[]> {
    return [...this.pages.values()].map(({ blob: _blob, ...rest }) => rest)
  }
}

// IndexedDB に置く。使えない環境（indexedDB がない）なら null
export function indexedDbPdfPageBackend(): PdfPageBackend | null {
  if (typeof indexedDB === 'undefined') return null
  let opened: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB is blocked'))
    })
    // 開けなかったら、次に使うときに開き直す
    opened.catch(() => {
      opened = null
    })
    return opened
  }
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const transaction = (await db()).transaction(STORE, mode)
    const request = action(transaction.objectStore(STORE))
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(request ? request.result : undefined)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }
  return {
    get: (key) => run<StoredPdfPage | undefined>('readonly', (store) => store.get(key) as IDBRequest<StoredPdfPage | undefined>),
    put: async (page) => {
      await run('readwrite', (store) => {
        store.put(page)
      })
    },
    delete: async (keys) => {
      await run('readwrite', (store) => {
        for (const key of keys) store.delete(key)
      })
    },
    list: async () => {
      const pages: Omit<StoredPdfPage, 'blob'>[] = []
      await run('readonly', (store) => {
        // 消すものを選ぶのに Blob は要らないので、一覧には入れない
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const current = cursor.result
          if (!current) return
          const { blob: _blob, ...rest } = current.value as StoredPdfPage
          pages.push(rest)
          current.continue()
        }
      })
      return pages
    },
  }
}
