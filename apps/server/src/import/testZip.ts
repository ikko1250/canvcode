import { deflateRawSync } from 'node:zlib'

// テスト用。最小限の ZIP を書く（deflate と無圧縮を混ぜる）
export function zipBytes(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [i, [name, content]] of Object.entries(entries).entries()) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const method = i % 2 === 0 ? 8 : 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x800, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(nameBuf.length, 28)
    header.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    central.push(header, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dirBuf, end])
}
