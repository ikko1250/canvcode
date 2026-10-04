-- CanvCode の画像のパスを、画面のプレビュー（resolveWorkspaceImageUrl）と同じ規則で探す。
-- - `img/a.png`・`../a.png` は Markdown ファイルの場所から、`/a.png` はワークスペースのルートから
-- - ワークスペースの外を指すもの、LaTeX に載せられない形式（gif・webp など）は、代わりの文字にする
-- ワークスペースとファイルの場所は、メタデータ canvcode-workspace・canvcode-docdir で受け取る

local LATEX_IMAGE = { png = true, jpg = true, jpeg = true, pdf = true, svg = true }

local workspace = nil
local docdir = nil

local function placeholder(img)
  local alt = pandoc.utils.stringify(img.caption)
  if alt == '' then alt = img.src end
  return pandoc.Emph({ pandoc.Str('［画像：' .. alt .. '］') })
end

local function resolve(src)
  if src:match('^[%a][%w+.-]*:') or src:sub(1, 2) == '//' then return src end
  local path = src:gsub('[?#].*$', '')
  local segments = {}
  if path:sub(1, 1) ~= '/' then
    for segment in docdir:gmatch('[^/]+') do table.insert(segments, segment) end
  end
  for segment in path:gmatch('[^/]+') do
    if segment == '..' then
      if #segments == 0 then return nil end
      table.remove(segments)
    elseif segment ~= '.' then
      table.insert(segments, segment)
    end
  end
  if #segments == 0 then return nil end
  return workspace .. '/' .. table.concat(segments, '/')
end

return {
  {
    Meta = function(meta)
      workspace = pandoc.utils.stringify(meta['canvcode-workspace'] or '')
      docdir = pandoc.utils.stringify(meta['canvcode-docdir'] or '')
    end,
  },
  {
    Image = function(img)
      if workspace == '' then return nil end
      local ok, decoded = pcall(function() return img.src:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end) end)
      local path = resolve(ok and decoded or img.src)
      if not path then return placeholder(img) end
      if path:match('^https?:') then return nil end
      local ext = (path:match('%.([%w]+)$') or ''):lower()
      if not LATEX_IMAGE[ext] then return placeholder(img) end
      img.src = path
      return img
    end,
  },
}
