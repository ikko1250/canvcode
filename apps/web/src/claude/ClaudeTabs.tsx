// 右のパネルの上の「会話｜作業」のタブ（docs/canvas-answer-panel-plan.md の 6）。AI 付箋を作業の指示にしたので「作業」（docs/ai-note-tasks-plan.md）。
// 作業の横に、動いている付箋の作業と質問の数（ほかのタブ・端末で頼んだものも）を出す
export function ClaudeTabs(props: { active: 'chat' | 'questions'; running: number; onChat(): void; onQuestions(): void }) {
  const { active, running, onChat, onQuestions } = props
  return (
    <div className="claude-tabs" role="tablist" aria-label="Claude">
      <button type="button" role="tab" aria-selected={active === 'chat'} onClick={onChat} title="Claude と会話して頼む（C）">
        会話
      </button>
      <button type="button" role="tab" aria-selected={active === 'questions'} onClick={onQuestions} title="付箋で頼んだ作業と報告（許可もここで答える）">
        作業
        {running > 0 && <span className="claude-tab-count">●{running}</span>}
      </button>
    </div>
  )
}
