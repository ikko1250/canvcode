-- Wrap the "参考文献" section in a LaTeX refhang environment
-- (no first-line indent, 2zw hanging indent). LaTeX/PDF only.

local TARGET_HEADING = '参考文献'

local function isTargetHeading(el)
  return el.t == 'Header' and pandoc.utils.stringify(el) == TARGET_HEADING
end

function Pandoc(doc)
  if not FORMAT:match('latex') then
    return nil
  end

  local blocks = doc.blocks
  local newBlocks = {}
  local i = 1
  local n = #blocks

  while i <= n do
    local el = blocks[i]
    if isTargetHeading(el) then
      table.insert(newBlocks, el)
      i = i + 1
      local sectionLevel = el.level
      local refBlocks = {}
      while i <= n do
        local nxt = blocks[i]
        if nxt.t == 'Header' and nxt.level <= sectionLevel then
          break
        end
        table.insert(refBlocks, nxt)
        i = i + 1
      end
      if #refBlocks > 0 then
        table.insert(newBlocks, pandoc.RawBlock('latex', '\\begin{refhang}'))
        for _, b in ipairs(refBlocks) do
          table.insert(newBlocks, b)
        end
        table.insert(newBlocks, pandoc.RawBlock('latex', '\\end{refhang}'))
      end
    else
      table.insert(newBlocks, el)
      i = i + 1
    end
  end

  doc.blocks = newBlocks
  return doc
end
