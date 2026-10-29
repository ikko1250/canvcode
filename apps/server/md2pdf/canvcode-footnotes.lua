-- 同じ脚注を何度参照しても、脚注は 1 つで番号は同じにする（カードと同じ）。
-- - pandoc の Markdown の読み込みは、参照のたびに脚注の中身をその場に写す（Note にラベルは残らない）。
--   そこで中身が同じ脚注を同じものとみなし、2 回目からは \footnotemark[n] にする（番号の印だけ。カウンタは進めず、本文も出さない）
-- - ラベルが違っても中身が同じ脚注はまとまる
-- - 番号は LaTeX の footnote カウンタと同じく文書の順に数えるので、上から（topdown）たどる
-- - LaTeX 以外に出すときは、上付きの番号だけにする
-- - pandoc 2.17 以上（walk の traverse）

local seen, count = {}, 0

function Pandoc(doc)
  return doc:walk({
    traverse = 'topdown',
    Note = function(note)
      local key = pandoc.write(pandoc.Pandoc(note.content), 'native')
      local number = seen[key]
      if not number then
        count = count + 1
        seen[key] = count
        return nil
      end
      if FORMAT:match('latex') then
        return pandoc.RawInline('latex', '\\footnotemark[' .. number .. ']'), false
      end
      return pandoc.Superscript(pandoc.Str(tostring(number))), false
    end,
  })
end
