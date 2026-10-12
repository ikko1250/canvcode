import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULT_KEEP, DEFAULT_REMOTE, execRclone, runBackupSync } from './backupSync.ts'

// 定期バックアップと Google Drive へのアップロード（backupSync.ts）。systemd のタイマー（deploy/systemd/）から 5 分ごとに呼ぶ。
// npm run backup:sync -- [--workspace <フォルダ>] [--out <手元の置き場所>] [--remote <rclone のリモート>] [--keep <手元に残す数>] [--rclone <rclone の場所>]
//   --workspace：既定は CANVCODE_WORKSPACE、なければ ./workspace
//   --out：既定は <ワークスペース>/.canvcode/backups
//   --remote：既定は CANVCODE_BACKUP_REMOTE、なければ gdrive:CanvCode-backup（その下の archives と assets に置く）
//   --keep：既定は 96
// どこかで失敗したら（Drive につながらないときも）終了コード 1 で終える。結果は <ワークスペース>/.canvcode/backup-status.json に書く
const { values: args } = parseArgs({
  options: {
    workspace: { type: 'string' },
    out: { type: 'string' },
    remote: { type: 'string' },
    keep: { type: 'string' },
    rclone: { type: 'string' },
  },
  strict: true,
})

const keep = args.keep !== undefined ? Number(args.keep) : DEFAULT_KEEP
if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep は 1 以上の整数にしてください')
  process.exit(1)
}

try {
  const result = await runBackupSync({
    workspace: resolve(args.workspace ?? process.env.CANVCODE_WORKSPACE ?? 'workspace'),
    outDir: args.out,
    remote: args.remote ?? process.env.CANVCODE_BACKUP_REMOTE ?? DEFAULT_REMOTE,
    keep,
    rclone: execRclone(args.rclone ?? process.env.CANVCODE_RCLONE ?? 'rclone'),
    log: (message) => console.log(message),
  })
  if (result.ok) console.log('バックアップを終えました')
  else console.error(`失敗しました：${result.status.lastError?.message ?? ''}`)
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  console.error(`失敗しました：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
