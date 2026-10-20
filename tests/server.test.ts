import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { McpHttpServer } from '../src/mcp/http'
import { buildTools } from '../src/mcp/tools'
import { ComfyService } from '../src/service'

/** A fake ComfyUI: queues prompts, reports one output per prompt (image or audio by its save node), serves bytes. */
function fakeComfy() {
  const prompts = new Map<string, Record<string, { class_type: string; inputs: Record<string, unknown> }>>()
  let n = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] })
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: 'fake' }, devices: [] })
    if (url.pathname.startsWith('/models/')) return json([])
    if (url.pathname === '/object_info') return json({})
    if (url.pathname === '/upload/image') {
      req.resume()
      return req.on('end', () => json({ name: 'up.png', subfolder: 'comfy-mcp', type: 'input' }))
    }
    if (url.pathname === '/prompt') {
      let body = ''
      req.on('data', (c) => (body += c))
      return req.on('end', () => {
        const id = `p${++n}`
        prompts.set(id, JSON.parse(body).prompt)
        json({ prompt_id: id })
      })
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/')[2]!
      const graph = prompts.get(id)
      if (!graph) return json({})
      const [saveId, save] = Object.entries(graph).find(([, node]) => /^Save/.test(node.class_type))!
      const audio = /Audio/.test(save.class_type)
      const item = { filename: `${id}.${audio ? 'mp3' : 'png'}`, subfolder: 'comfy-mcp', type: 'output' }
      return json({ [id]: { status: { status_str: 'success', completed: true }, outputs: { [saveId]: audio ? { audio: [item] } : { images: [item] } } } })
    }
    if (url.pathname === '/view') {
      res.writeHead(200)
      return res.end(`bytes of ${url.searchParams.get('filename')}`)
    }
    res.writeHead(404).end()
  })
  return { server, prompts }
}

describe('MCP server against a fake ComfyUI', () => {
  const comfy = fakeComfy()
  let mcp: McpHttpServer
  let url: string
  const outDir = mkdtempSync(path.join(tmpdir(), 'cmcp-out-'))

  beforeAll(async () => {
    await new Promise<void>((r) => comfy.server.listen(0, '127.0.0.1', r))
    const comfyUrl = `http://127.0.0.1:${(comfy.server.address() as AddressInfo).port}`
    const config = loadConfig(['--port', '0', '--comfy', comfyUrl, '--out', outDir], {})
    mcp = new McpHttpServer({ host: { tools: buildTools(new ComfyService(config)) }, port: 0 })
    url = (await mcp.start()).url!
  })
  afterAll(async () => {
    await mcp.stop()
    comfy.server.close()
  })

  async function connect() {
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  }

  it('lists the tools', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['status', 'generate_image', 'edit_image', 'remove_background', 'generate_music', 'generate_speech', 'run_workflow', 'wait', 'cancel', 'free_memory']))
    await client.close()
  })

  it('generates images into the requested file path, numbered', async () => {
    const client = await connect()
    const target = path.join(outDir, 'castle.png')
    const r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a castle', count: 2, seed: 10, out: target } })
    expect(r.isError).toBeFalsy()
    const s = r.structuredContent as { state: string; outputs: string[]; seeds: number[] }
    expect(s.state).toBe('done')
    expect(s.seeds).toEqual([10, 11])
    expect(s.outputs).toEqual([path.join(outDir, 'castle_1.png'), path.join(outDir, 'castle_2.png')])
    expect(readFileSync(s.outputs[0]!, 'utf8')).toMatch(/^bytes of p\d+\.png$/)
    await client.close()
  })

  it('returns a job id at once with wait 0, and wait finishes it', async () => {
    const client = await connect()
    const r = await client.callTool({ name: 'generate_music', arguments: { tags: 'chiptune', seconds: 5, wait: 0 } })
    const started = r.structuredContent as { job_id: string; state: string }
    expect(started.state).toBe('running')
    const w = await client.callTool({ name: 'wait', arguments: { job_ids: started.job_id, timeout_seconds: 20 } })
    const done = (w.structuredContent as { jobs: Array<{ state: string; outputs: string[] }> }).jobs[0]!
    expect(done.state).toBe('done')
    expect(done.outputs[0]).toMatch(/music_.*\.mp3$/)
    expect(existsSync(done.outputs[0]!)).toBe(true)
    await client.close()
  })

  it('runs a workflow with a node.input param and a file upload', async () => {
    const client = await connect()
    const input = path.join(outDir, 'in.png')
    writeFileSync(input, 'png')
    const wfFile = path.join(outDir, 'wf.json')
    writeFileSync(wfFile, JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: 'x.png' } }, 2: { class_type: 'KSampler', inputs: { seed: 1, steps: 4 } }, 3: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'a' } } }))
    const r = await client.callTool({ name: 'run_workflow', arguments: { workflow: wfFile, params: { '2.steps': 9 }, files: { '1.image': input }, out: outDir } })
    expect(r.isError).toBeFalsy()
    const sent = [...comfy.prompts.values()].at(-1)!
    expect(sent[2]!.inputs.steps).toBe(9)
    expect(sent[2]!.inputs.seed).not.toBe(1)
    expect(sent[1]!.inputs.image).toBe('comfy-mcp/up.png')
    expect(sent[3]!.inputs.filename_prefix).toBe('comfy-mcp/wf')
    await client.close()
  })

  it('rejects relative output paths and missing inputs as tool errors', async () => {
    const client = await connect()
    const r1 = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x', out: 'relative/dir' } })
    expect(r1.isError).toBe(true)
    const r2 = await client.callTool({ name: 'remove_background', arguments: { image: path.join(outDir, 'nope.png') } })
    expect(r2.isError).toBe(true)
    await client.close()
  })

  it('refuses a foreign Host header', async () => {
    const port = new URL(url).port
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example:80', 'content-type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0))
      req.end('{}')
    })
    expect(status).toBe(403)
  })
})

describe('bearer token', () => {
  it('rejects a request without the token', async () => {
    const config = loadConfig(['--port', '0'], {})
    const server = new McpHttpServer({ host: { tools: buildTools(new ComfyService(config)) }, port: 0, token: 'secret' })
    const { url } = await server.start()
    const r = await fetch(url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(401)
    await server.stop()
  })
})
