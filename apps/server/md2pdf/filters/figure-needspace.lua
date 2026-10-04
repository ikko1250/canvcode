-- Keep figures from being placed too close to the page bottom.
-- LaTeX/PDF output only: if there is not enough vertical space left for an
-- image plus its caption, start a new page before the figure.

local figure_needspace = pandoc.RawBlock('latex', '\\Needspace{0.50\\textheight}')

function Figure(el)
  if FORMAT:match('latex') then
    return { figure_needspace, el }
  end
  return nil
end

function Para(el)
  if FORMAT:match('latex') and #el.content == 1 and el.content[1].t == 'Image' then
    return { figure_needspace, el }
  end
  return nil
end
