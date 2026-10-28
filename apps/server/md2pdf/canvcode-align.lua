-- `<p align="center">…</p>`・`<div align="center">…</div>` の寄せを、PDF でも効かせる。
-- - pandoc は `<p align>` を開きタグ・中身・閉じタグの 3 つのブロックに分け、LaTeX に出すとき開きと閉じを捨てる。
--   そこで開きから対になる `</p>` までを center（right なら flushright）で囲む。中の **太字** などはそのまま
-- - `<div align>` は pandoc が Div にして align を属性に持つので、それを見て囲む
-- - 開きと閉じの対が見つからないときは何もしない。LaTeX 以外に出すときも何もしない

local ENV = { center = 'center', right = 'flushright' }

local function env_of(align)
  return ENV[(align or ''):lower()]
end

local function open_align(block)
  if block.t ~= 'RawBlock' or block.format ~= 'html' then return nil end
  local tag = block.text:match('^%s*<[pP]%s+([^>]*)>%s*$')
  if not tag then return nil end
  return env_of(tag:match('[aA][lL][iI][gG][nN]%s*=%s*"([^"]*)"') or tag:match("[aA][lL][iI][gG][nN]%s*=%s*'([^']*)'"))
end

local function is_close(block)
  return block.t == 'RawBlock' and block.format == 'html' and block.text:match('^%s*</[pP]%s*>%s*$') ~= nil
end

local function wrap(env, blocks)
  local out = pandoc.List({ pandoc.RawBlock('latex', '\\begin{' .. env .. '}') })
  out:extend(blocks)
  out:insert(pandoc.RawBlock('latex', '\\end{' .. env .. '}'))
  return out
end

if not FORMAT:match('latex') then return {} end

return {
  {
    Div = function(div)
      local env = env_of(div.attributes.align)
      if not env then return nil end
      div.attributes.align = nil
      div.content = wrap(env, div.content)
      return div
    end,
    Blocks = function(blocks)
      local out = pandoc.List()
      local i = 1
      while i <= #blocks do
        local env = open_align(blocks[i])
        local close = nil
        if env then
          for j = i + 1, #blocks do
            if open_align(blocks[j]) then break end
            if is_close(blocks[j]) then close = j break end
          end
        end
        if close then
          local inner = pandoc.List()
          for j = i + 1, close - 1 do inner:insert(blocks[j]) end
          out:extend(wrap(env, inner))
          i = close + 1
        else
          out:insert(blocks[i])
          i = i + 1
        end
      end
      return out
    end,
  },
}
