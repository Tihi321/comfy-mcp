import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { jobView, JobManager, JobStore, type Job } from '../src/jobs'
import { ComfyService } from '../src/service'

/** A fake ComfyUI that already knows prompts p1 (an image) and p2 (audio) in its history. */
function fakeComfy() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] })
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/')[2]!
      if (id === 'p1') return json({ p1: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'p1.png', subfolder: 'comfy-mcp', type: 'output' }] } } } })
      if (id === 'p2') return json({ p2: { status: { status_str: 'success', completed: true }, outputs: { 9: { audio: [{ filename: 'p2.mp3', subfolder: 'comfy-mcp', type: 'output' }] } } } })
      return json({})
    }
    if (url.pathname === '/view') {
      res.writeHead(200)
      return res.end(`bytes of ${url.searchParams.get('filename')}`)
    }
    res.writeHead(404).end()
  })
  return server
}

function job(over: Partial<Job>): Job {
  return { id: 'job_aaaa0001', tool: 'generate_image', summary: 's', state: 'running', progress: 'queued', createdAt: Date.now(), promptIds: [], outputs: [], seeds: [], info: {}, ...over }
}

describe('job persistence', () => {
  const comfy = fakeComfy()
  let comfyUrl: string
  const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-jobs-'))
  let n = 0

  beforeAll(async () => {
    await new Promise<void>((r) => comfy.listen(0, '127.0.0.1', r))
    comfyUrl = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`
  })
  afterAll(() => {
    comfy.close()
  })

  /** A service on its own state file; `jobs` are written to that file first. */
  function serviceWith(jobs: Job[]) {
    const state = path.join(dir, `state-${++n}.json`)
    if (jobs.length > 0) writeFileSync(state, JSON.stringify({ version: 1, jobs }))
    const out = path.join(dir, `out-${n}`)
    return { state, out, service: new ComfyService(loadConfig(['--port', '0', '--comfy', comfyUrl, '--out', out, '--state', state], {})) }
  }

  it('saves a finished job and a new manager loads it unchanged', () => {
    const state = path.join(dir, 'plain.json')
    const first = new JobManager(undefined, undefined, new JobStore(state))
    const j = first.start('generate_image', 'a castle', async (jb) => {
      jb.outputs.push('C:/x/castle.png')
      jb.seeds = [7]
      jb.info.engine = 'z-image-turbo'
    })
    return first.wait([j.id], 2000).then(() => {
      first.flush()
      const second = new JobManager(undefined, undefined, new JobStore(state))
      second.load()
      const loaded = second.get(j.id)!
      expect(loaded.state).toBe('done')
      expect(jobView(loaded)).toEqual(jobView(j))
    })
  })

  it('starts empty on a corrupt state file and keeps a copy', () => {
    const state = path.join(dir, 'corrupt.json')
    writeFileSync(state, '{not json')
    const warnings: string[] = []
    const manager = new JobManager(undefined, undefined, new JobStore(state, (m) => warnings.push(m)))
    expect(manager.load()).toEqual([])
    expect(warnings.join('\n')).toMatch(/corrupt/)
    expect(existsSync(`${state}.bad`)).toBe(true)
  })

  it('resumes a running job: re-attaches to its prompt and writes the file', async () => {
    const { state, out, service } = serviceWith([
      job({ promptIds: ['p1'], seeds: [42], save: { target: { dir: path.join(dir, 'resumed') }, prefix: 'image', pick: 'first', prompts: 1, total: 1, seeds: [42], saved: 0 } })
    ])
    await service.restoreJobs()
    expect(service.jobs.get('job_aaaa0001')!.state).toBe('running')
    await service.jobs.wait(['job_aaaa0001'], 10_000)
    const done = service.jobs.get('job_aaaa0001')!
    expect(done.state).toBe('done')
    expect(done.outputs).toHaveLength(1)
    expect(path.basename(done.outputs[0]!)).toMatch(/^image_\d{8}-\d{6}_42\.png$/)
    expect(readFileSync(done.outputs[0]!, 'utf8')).toBe('bytes of p1.png')
    service.jobs.flush()
    const saved = JSON.parse(readFileSync(state, 'utf8')) as { jobs: Job[] }
    expect(saved.jobs[0]!.state).toBe('done')
    expect(saved.jobs[0]!.save!.saved).toBe(1)
    expect(existsSync(out)).toBe(false)
  })

  it('skips prompts that were already saved', async () => {
    const skip = path.join(dir, 'skip')
    const { service } = serviceWith([
      job({ tool: 'generate_music', promptIds: ['gone', 'p2'], outputs: ['C:/x/song_1.mp3'], save: { target: { dir: skip, stem: 'song', ext: 'mp3' }, prefix: 'music', pick: 'audio', prompts: 2, total: 2, saved: 1 } })
    ])
    await service.restoreJobs()
    await service.jobs.wait(['job_aaaa0001'], 5000)
    const done = service.jobs.get('job_aaaa0001')!
    expect(done.state).toBe('done')
    expect(done.outputs).toEqual(['C:/x/song_1.mp3', path.join(skip, 'song_2.mp3')])
    expect(readFileSync(path.join(skip, 'song_2.mp3'), 'utf8')).toBe('bytes of p2.mp3')
  })

  it('ends a resumed job as an error when ComfyUI no longer has the prompt', async () => {
    const { service } = serviceWith([job({ promptIds: ['p-lost'], save: { target: { dir: path.join(dir, 'lost') }, prefix: 'image', pick: 'first', prompts: 1, total: 1, saved: 0 } })])
    await service.restoreJobs()
    await service.jobs.wait(['job_aaaa0001'], 5000)
    const lost = service.jobs.get('job_aaaa0001')!
    expect(lost.state).toBe('error')
    expect(lost.error).toBe('ComfyUI no longer has prompt p-lost (it was restarted?)')
  })

  it('ends a running job that had not queued all its prompts, or has no save spec', async () => {
    const { service } = serviceWith([
      job({ id: 'job_aaaa0002', promptIds: ['p1'], save: { target: { dir: path.join(dir, 'partial') }, prefix: 'image', pick: 'first', prompts: 2, total: 2, saved: 0 } }),
      job({ id: 'job_aaaa0003' }),
      job({ id: 'job_aaaa0004', state: 'done', outputs: ['C:/x/a.png'] })
    ])
    await service.restoreJobs()
    for (const id of ['job_aaaa0002', 'job_aaaa0003']) {
      const j = service.jobs.get(id)!
      expect(j.state).toBe('error')
      expect(j.error).toBe('the server restarted before this job was queued on ComfyUI; run it again')
    }
    expect(service.jobs.get('job_aaaa0004')!.state).toBe('done')
    expect(service.jobs.get('job_aaaa0004')!.outputs).toEqual(['C:/x/a.png'])
  })
})
