import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { AssetStore } from './assets.ts'
import { FileStore } from './files.ts'
import { describeReport, importBackup, keepBackup, type ImportResult } from './import/import.ts'
import { RecordStore } from './records.ts'
import { ThumbnailStore } from './thumbnails.ts'

// 旧データ（.ricbackup）を取り込む（MAI-36）。VPS の上にあるファイルを、アップロードせずに取り込むとき。
// npm run import -- --workspace <フォルダ> <ファイル>
// サーバーが動いていれば、サーバーに頼む（開いているブラウザにもすぐ届く）。動いていなければ、ここで取り込む
const { values: args, positionals } = parseArgs({ options: { workspace: { type: 'string' } }, allowPositionals: true, strict: false })
const file = positionals[0]
if (!file) {
  console.error('使い方：npm run import -- --workspace <フォルダ> <.ricbackup のファイル>')
  process.exit(1)
}
const workspace = resolve((typeof args.workspace === 'string' ? args.workspace : undefined) ?? process.env.CANVCODE_WORKSPACE ?? 'workspace')
const dataDir = join(workspace, '.canvcode')
const port = Number(process.env.CANVCODE_PORT ?? 8787)

async function viaServer(): Promise<ImportResult | null> {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    if (!health.ok) return null
  } catch {
    return null
  }
  console.log(`動いているサーバー（ポート ${port}）に取り込みを頼みます…`)
  const response = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: resolve(file) }),
  })
  const body = (await response.json()) as ImportResult & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

try {
  let result = await viaServer()
  if (!result) {
    console.log('サーバーは動いていないので、ここで取り込みます…')
    const assets = new AssetStore(dataDir)
    await assets.init()
    const thumbnails = new ThumbnailStore(dataDir)
    await thumbnails.init()
    const records = new RecordStore(dataDir)
    const files = new FileStore(workspace, dataDir, () => {})
    await files.init()
    try {
      result = await importBackup(await keepBackup(dataDir, resolve(file)), { dataDir, records, files, assets, thumbnails })
    } finally {
      records.close()
      await files.close()
    }
  }
  for (const line of describeReport(result.report)) console.log(`・${line}`)
} catch (error) {
  console.error(`取り込めませんでした：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
