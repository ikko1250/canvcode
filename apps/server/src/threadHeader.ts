// 画面から頼んだ Claude Code（claude/jobs.ts）が、canvcode の MCP（mcp.ts）をつなぐときに付けるヘッダー。値は会話の id（UUID）。
// MCP は、Canvas の編集の記録（agent_ops）に会話を残す（付箋の作業の「前の変更を戻す」。docs/ai-note-tasks-plan.md の B）
export const THREAD_HEADER = 'x-canvcode-thread'

// 会話の id の形（ジョブの id。randomUUID）。違う形の値は読まない
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
