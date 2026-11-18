// 右のパネルの上の「会話｜質問」のタブ（docs/canvas-answer-panel-plan.md の 6）。
// 質問の横に、動いている質問の数（ほかのタブ・端末で頼んだものも）を出す
export function ClaudeTabs(props: { active: 'chat' | 'questions'; running: number; onChat(): void; onQuestions(): void }) {
  const { active, running, onChat, onQuestions } = props
  return (
    <div className="claude-tabs" role="tablist" aria-label="Claude">
      <button type="button" role="tab" aria-selected={active === 'chat'} onClick={onChat} title="Claude と会話して頼む（C）">
        会話
      </button>
      <button type="button" role="tab" aria-selected={active === 'questions'} onClick={onQuestions} title="付箋で聞いた質問と答え">
        質問
        {running > 0 && <span className="claude-tab-count">●{running}</span>}
      </button>
    </div>
  )
}
