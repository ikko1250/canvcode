import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createBackup, restoreBackup } from './backup.ts'

// ワークスペースのバックアップと復元（backup.ts）。サーバーを動かしたままバックアップできる。
// npm run backup -- [--workspace <フォルダ>] [--out <置く場所>] [--keep <残す数>] [--no-assets] [--imports]
//   置く場所を省くと <ワークスペース>/.canvcode/backups（ワークスペースと同じディスクなので、外へ写すこと）
// npm run restore -- <バックアップ.tar.gz> --workspace <復元先（ないか空のフォルダ）> [--assets <Asset のフォルダ>]
//   復元したら、サーバーの CANVCODE_WORKSPACE（または --workspace）を復元先に向けて起動する
const { values: args, positionals } = parseArgs({
  options: {
    workspace: { type: 'string' },
    out: { type: 'string' },
    keep: { type: 'string' },
    'no-assets': { type: 'boolean' },
    imports: { type: 'boolean' },
    assets: { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
})
const workspaceArg = typeof args.workspace === 'string' ? args.workspace : undefined
const [command, ...rest] = positionals

try {
  if (command === 'restore') {
    const archive = rest[0]
    if (!archive || !workspaceArg) {
      console.error('使い方：npm run restore -- <バックアップ.tar.gz> --workspace <復元先（ないか空のフォルダ）> [--assets <Asset のフォルダ>]')
      process.exit(1)
    }
    const result = await restoreBackup({ archive, workspace: workspaceArg, assetsFrom: typeof args.assets === 'string' ? args.assets : undefined })
    console.log(`復元しました：${result.workspace}（${result.files} 個のファイル、${result.manifest.createdAt} の時点、変更番号 ${result.manifest.rev}）`)
    console.log(`サーバーを止めてから、CANVCODE_WORKSPACE=${result.workspace} で起動してください`)
  } else if (command === undefined || command === 'create') {
    const workspace = resolve(workspaceArg ?? process.env.CANVCODE_WORKSPACE ?? 'workspace')
    const keep = typeof args.keep === 'string' ? Number(args.keep) : undefined
    const result = await createBackup({
      workspace,
      outDir: typeof args.out === 'string' ? args.out : join(workspace, '.canvcode', 'backups'),
      assets: args['no-assets'] !== true,
      imports: args.imports === true,
      keep,
    })
    const mb = (result.bytes / 1024 / 1024).toFixed(1)
    console.log(`バックアップを作りました：${result.path}（${result.files} 個のファイル、${mb} MB、変更番号 ${result.manifest.rev}）`)
    for (const path of result.removed) console.log(`・古いバックアップを消しました：${path}`)
  } else {
    console.error(`知らないコマンドです：${command}`)
    process.exit(1)
  }
} catch (error) {
  console.error(`失敗しました：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
