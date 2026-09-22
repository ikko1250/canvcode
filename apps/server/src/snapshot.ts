import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { snapshotWorkspace } from './records.ts'

// workspace.db の写しを作る（MAI-13 の「8. バックアップと書き出し」）。サーバーを動かしたままでよい。
// npm run snapshot -- --workspace <フォルダ>
const { values: args } = parseArgs({ options: { workspace: { type: 'string' } }, strict: false })
const workspace = resolve((typeof args.workspace === 'string' ? args.workspace : undefined) ?? process.env.CANVCODE_WORKSPACE ?? 'workspace')
console.log(`写しを作りました：${snapshotWorkspace(join(workspace, '.canvcode'))}`)
