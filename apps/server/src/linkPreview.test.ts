import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { allowedUrl, decodeHtml, fetchRemote, imageType, isBlockedAddress, LinkPreviewService, parsePreview, safeLookup, type FetchRemote } from './linkPreview.ts'

// リンクのカードのタイトル・サムネイル（リンク先のページの OGP）を取ってくる

describe('reading a page', () => {
  it('prefers Open Graph, and resolves a relative og:image against the page', () => {
    const html = `<!doctype html><html><head>
      <title>Plain &amp; title</title>
      <meta property="og:title" content="OG &quot;title&quot;">
      <meta content='About &#x3042;' property='og:description'>
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="/img/og.png?x=1&amp;y=2">
      </head><body><meta property="og:title" content="in body"></body></html>`
    expect(parsePreview(html, 'https://example.com/a/b')).toEqual({
      title: 'OG "title"',
      description: 'About あ',
      siteName: 'Example',
      image: 'https://example.com/img/og.png?x=1&y=2',
    })
  })

  it('falls back to <title> and the description meta, and ignores a non-http image', () => {
    const html = '<head><title>\n  Just a   title </title><meta name="description" content="Desc"><meta property="og:image" content="javascript:alert(1)"></head>'
    expect(parsePreview(html, 'https://example.com/')).toEqual({ title: 'Just a title', description: 'Desc', siteName: null, image: null })
  })

  it('decodes the charset given by the header or by <meta charset>', () => {
    const sjis = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0x82, 0xa0, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]) // <title>あ</title>
    expect(decodeHtml(sjis, 'text/html; charset=Shift_JIS')).toBe('<title>あ</title>')
    const withMeta = Buffer.concat([Buffer.from('<meta charset="shift_jis">'), sjis])
    expect(decodeHtml(withMeta, 'text/html')).toContain('<title>あ</title>')
    expect(decodeHtml(Buffer.from('<title>あ</title>'), '')).toBe('<title>あ</title>')
  })

  it('tells images by their type or their first bytes', () => {
    expect(imageType('image/jpeg; charset=binary', Buffer.alloc(4))).toBe('image/jpeg')
    expect(imageType('application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(imageType('text/html', Buffer.from('<html>'))).toBeNull()
    expect(imageType('image/svg+xml', Buffer.from('<svg>'))).toBeNull()
  })
})

describe('refusing local addresses', () => {
  it('blocks loopback, private, link-local and similar addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) expect(isBlockedAddress(address), address).toBe(false)
  })

  it('accepts only http(s) URLs to hosts that are not obviously local', () => {
    expect(allowedUrl('https://example.com/')?.href).toBe('https://example.com/')
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'http://127.0.0.1:8787/', 'http://[::1]/', 'http://localhost/', 'http://a.localhost/', 'https://user:pw@example.com/', 'nonsense']) {
      expect(allowedUrl(url), url).toBeNull()
    }
  })

  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  it('refuses, when connecting, a name that resolves to a local address', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', { all: true }, (e) => resolve(e)))
    expect(error?.code).toBe('EBLOCKED')
  })

  it('does not even connect to a local server', async () => {
    let requests = 0
    server = createServer((_req, res) => {
      requests++
      res.end('<title>secret</title>')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await expect(fetchRemote(`http://127.0.0.1:${port}/`, 1000, '*/*')).rejects.toThrow(/refused/)
    expect(requests).toBe(0)
  })
})

describe('the service', () => {
  it('returns the preview, caches it, and forgets failures', async () => {
    let calls = 0
    const fetch: FetchRemote = async (url) => {
      calls++
      if (url.includes('fail')) throw new Error('down')
      return { url, contentType: 'text/html; charset=utf-8', body: Buffer.from('<head><meta property="og:title" content="Hi"></head>') }
    }
    const service = new LinkPreviewService(fetch)
    expect((await service.preview('https://example.com/')).title).toBe('Hi')
    await service.preview('https://example.com/')
    expect(calls).toBe(1)
    await expect(service.preview('https://example.com/fail')).rejects.toThrow('down')
    await expect(service.preview('https://example.com/fail')).rejects.toThrow('down')
    expect(calls).toBe(3)
  })

  it('returns no preview for a page that is not HTML, and only relays images', async () => {
    const fetch: FetchRemote = async (url) =>
      url.endsWith('.pdf') ? { url, contentType: 'application/pdf', body: Buffer.from('%PDF') } : { url, contentType: 'text/html', body: Buffer.from('<html>') }
    const service = new LinkPreviewService(fetch)
    expect(await service.preview('https://example.com/a.pdf')).toEqual({ title: null, description: null, siteName: null, image: null })
    expect(await service.image('https://example.com/page')).toBeNull()
  })
})
