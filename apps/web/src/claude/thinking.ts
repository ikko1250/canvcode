// Claude の考えている中身（付箋で聞いた答えを作っている間に流れてくるもの）の見せ方

// 考えている中身を、段落（空の行で区切る）と、続けて並んだ調べている行（「― 」で始まる行）のまとまりに分ける
export function thinkingBlocks(text: string): ({ kind: 'text'; text: string } | { kind: 'tool'; lines: string[] })[] {
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tool'; lines: string[] })[] = []
  let paragraph: string[] = []
  const endParagraph = () => {
    const joined = paragraph.join('\n').trim()
    if (joined) blocks.push({ kind: 'text', text: joined })
    paragraph = []
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('― ')) {
      endParagraph()
      const last = blocks.at(-1)
      if (last?.kind === 'tool') last.lines.push(line.slice(2).trim())
      else blocks.push({ kind: 'tool', lines: [line.slice(2).trim()] })
    } else if (line.trim() === '') endParagraph()
    else paragraph.push(line)
  }
  endParagraph()
  return blocks
}
