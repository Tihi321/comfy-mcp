import { existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import {
  collectOutputs,
  deleteFromQueue,
  downloadOutput,
  freeMemory,
  interrupt,
  listModelFiles,
  objectInfo,
  postPrompt,
  queueState,
  removalModelsOf,
  systemStats,
  uploadFile,
  waitForOutputs,
  type CollectedItem,
  type ObjectInfo
} from './comfy/client'
import { buildRemoveBackground, ENGINES, enginesOfKind, mergeFiles, randomSeed, snap16, type Graph } from './comfy/graphs'
import type { SchemaMap } from './comfy/ui-to-api'
import {
  describeGraph,
  dropNode,
  FILE_FIELDS,
  listWorkflows,
  loadWorkflow,
  mappedValue,
  randomizeSeeds,
  resolveSlot,
  resolveWorkflowFile,
  setInput,
  type LoadedWorkflow,
  type Slot
} from './comfy/workflows'
import type { Config } from './config'
import { JobManager, type Job } from './jobs'

/**
 * What the MCP tools drive: builds graphs, queues them on ComfyUI as background jobs, downloads the results and writes them to the
 * caller's path. Every start method validates its arguments first (so a bad path fails the call itself, not a job) and returns
 * the job.
 */

export const AUDIO_FORMATS = ['flac', 'mp3', 'opus', 'wav'] as const
export type AudioFormat = (typeof AUDIO_FORMATS)[number]
const MODEL_FOLDERS = ['diffusion_models', 'text_encoders', 'vae', 'checkpoints', 'loras', 'background_removal'] as const

export interface ImageArgs {
  prompt: string
  engine?: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  count?: number
  steps?: number
  cfg?: number
  out?: string
}

export interface EditArgs {
  prompt: string
  images: string[]
  engine?: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  count?: number
  steps?: number
  out?: string
}

export interface MusicArgs {
  tags: string
  engine?: string
  lyrics?: string
  seconds?: number
  seed?: number
  steps?: number
  format?: AudioFormat
  out?: string
}

export interface SpeechArgs {
  text: string
  language?: string
  voiceRef?: string
  seed?: number
  workflow?: string
  out?: string
}

export interface WorkflowArgs {
  workflow: string
  params?: Record<string, unknown>
  files?: Record<string, string>
  outputNode?: string
  randomizeSeeds?: boolean
  out?: string
}

/** Where outputs go: a folder (names are made up) or one file path (numbered when a job writes several). */
interface OutTarget {
  dir: string
  /** File stem when the caller named a file. */
  stem?: string
  /** The extension the caller asked for, without the dot. */
  ext?: string
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function requireAbsoluteFile(p: string, what: string): string {
  if (!path.isAbsolute(p)) throw new Error(`${what} must be an absolute path, not "${p}"`)
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`${what} not found: ${p}`)
  return p
}

export class ComfyService {
  readonly jobs: JobManager
  private info: ObjectInfo | null = null
  private readonly files

  constructor(readonly config: Config, private readonly log: (msg: string) => void = () => undefined) {
    this.files = mergeFiles(config.files as never)
    this.jobs = new JobManager((job) => this.cancelPrompts(job), log)
  }

  get base(): string {
    return this.config.comfyUrl
  }

  // ---- shared plumbing ----

  /** ComfyUI's node catalog, cached; refreshed when `fresh` (after installing nodes or models). */
  async objectInfo(fresh = false): Promise<ObjectInfo> {
    if (!this.info || fresh) this.info = await objectInfo(this.base)
    return this.info
  }

  /** Parses `out`: absolute folder, or absolute file path (has an extension and is not an existing folder). */
  resolveOut(out: string | undefined): OutTarget {
    if (out === undefined || out.trim() === '') return { dir: this.config.outDir }
    const target = out.trim()
    if (!path.isAbsolute(target)) throw new Error(`out must be an absolute path (a folder or a file), not "${target}"`)
    const ext = path.extname(target)
    const isDir = existsSync(target) && statSync(target).isDirectory()
    if (!ext || isDir) return { dir: target }
    return { dir: path.dirname(target), stem: path.basename(target, ext), ext: ext.slice(1).toLowerCase() }
  }

  private async save(job: Job, item: CollectedItem, target: OutTarget, prefix: string, index: number, total: number, seed?: number): Promise<string> {
    const bytes = await downloadOutput(this.base, item)
    const ext = path.extname(item.filename).slice(1).toLowerCase() || 'bin'
    const suffix = total > 1 ? `_${index + 1}` : ''
    const name = target.stem ? `${target.stem}${suffix}.${ext}` : `${prefix}_${stamp()}_${seed ?? randomSeed()}${suffix}.${ext}`
    await fs.mkdir(target.dir, { recursive: true })
    const file = path.join(target.dir, name)
    await fs.writeFile(file, bytes)
    job.outputs.push(file)
    if (target.ext && target.ext !== ext) job.info.note = `ComfyUI produced .${ext}, so the file was written as ${name}`
    return file
  }

  /** Queues one graph and waits for its outputs. */
  private async runGraph(job: Job, graph: Graph, signal: AbortSignal, onlyNode?: string): Promise<CollectedItem[]> {
    const promptId = await postPrompt(this.base, graph)
    job.promptIds.push(promptId)
    return this.collect(job, promptId, signal, onlyNode)
  }

  private async collect(job: Job, promptId: string, signal: AbortSignal, onlyNode?: string): Promise<CollectedItem[]> {
    job.progress = 'queued'
    const outputs = await waitForOutputs(this.base, promptId, {
      timeoutMs: this.config.jobTimeoutMs,
      signal,
      onPoll: (p) => {
        job.progress = `${p.status} ${Math.round(p.elapsedMs / 1000)}s`
      }
    })
    const items = collectOutputs(outputs, onlyNode)
    if (items.length === 0) throw new Error(`ComfyUI job ${promptId} finished without a file output`)
    job.progress = 'download'
    return items
  }

  private async cancelPrompts(job: Job): Promise<void> {
    if (job.promptIds.length === 0) return
    const q = await queueState(this.base)
    const pending = job.promptIds.filter((id) => q.pendingIds.includes(id))
    if (pending.length > 0) await deleteFromQueue(this.base, pending)
    for (const id of job.promptIds.filter((i) => q.runningIds.includes(i))) await interrupt(this.base, id)
  }

  private seedsFor(seed: number | undefined, count: number): number[] {
    return Array.from({ length: count }, (_, i) => (seed === undefined ? randomSeed() : seed + i))
  }

  // ---- images ----

  generateImage(a: ImageArgs): Job {
    const engineId = a.engine ?? 'z-image-turbo'
    const engine = ENGINES[engineId]
    if (!engine || engine.kind !== 'image' || engine.acceptsReferences) {
      throw new Error(`engine must be one of ${enginesOfKind('image').filter((id) => !ENGINES[id]!.acceptsReferences).join(', ')}`)
    }
    const prompt = a.prompt.trim()
    if (!prompt) throw new Error('prompt is empty')
    const target = this.resolveOut(a.out)
    const count = a.count ?? 1
    const width = snap16(a.width ?? engine.size?.width ?? 1024)
    const height = snap16(a.height ?? engine.size?.height ?? 1024)
    const seeds = this.seedsFor(a.seed, count)
    const graphs = seeds.map((seed) =>
      engine.build({
        ...engine.defaults,
        ...(a.steps !== undefined ? { steps: a.steps } : {}),
        ...(a.cfg !== undefined ? { cfg: a.cfg } : {}),
        files: this.files[engine.fileGroup],
        filenamePrefix: 'comfy-mcp/image',
        seed,
        prompt,
        negativePrompt: a.negative ?? '',
        width,
        height
      } as never)
    )
    const info: Record<string, unknown> = { engine: engineId, width, height }
    if (a.negative && !engine.usesNegative) info.note = `${engineId} ignores the negative prompt (its template zeroes it)`
    return this.jobs.start('generate_image', `${engineId} ${width}x${height}${count > 1 ? ` x${count}` : ''}: ${prompt.slice(0, 80)}`, async (job, signal) => {
      job.seeds = seeds
      // queue every image first, so ComfyUI works through them without waiting on our downloads
      for (const graph of graphs) job.promptIds.push(await postPrompt(this.base, graph))
      for (const [i, promptId] of job.promptIds.entries()) {
        const items = await this.collect(job, promptId, signal)
        await this.save(job, items[0]!, target, 'image', i, count, seeds[i])
      }
    }, info)
  }

  editImage(a: EditArgs): Job {
    const engineId = a.engine ?? 'qwen-image-2.1-edit'
    const engine = ENGINES[engineId]
    if (!engine || engine.kind !== 'image' || !engine.acceptsReferences) {
      throw new Error(`engine must be one of ${enginesOfKind('image').filter((id) => ENGINES[id]!.acceptsReferences).join(', ')}`)
    }
    const prompt = a.prompt.trim()
    if (!prompt) throw new Error('prompt is empty')
    if (a.images.length === 0 || a.images.length > 16) throw new Error('images must list 1 to 16 image paths')
    const images = a.images.map((p, i) => requireAbsoluteFile(p, `images[${i}]`))
    const target = this.resolveOut(a.out)
    const count = a.count ?? 1
    const explicitSize = a.width !== undefined && a.height !== undefined
    if ((a.width === undefined) !== (a.height === undefined)) throw new Error('give both width and height, or neither (then the first image sets the size)')
    const seeds = this.seedsFor(a.seed, count)
    const info: Record<string, unknown> = { engine: engineId, ...(explicitSize ? { width: snap16(a.width!), height: snap16(a.height!) } : { size: 'from the first image' }) }
    if (a.steps !== undefined && engine.defaults.sigmas !== undefined) info.note = `${engineId} uses its fixed ${engine.defaults.steps}-step schedule and ignores steps`
    return this.jobs.start('edit_image', `${engineId} from ${images.length} image(s): ${prompt.slice(0, 80)}`, async (job, signal) => {
      job.seeds = seeds
      job.progress = 'upload'
      const references: string[] = []
      for (const file of images) references.push((await uploadFile(this.base, file)).filename)
      for (const seed of seeds) {
        const graph = engine.build({
          ...engine.defaults,
          ...(a.steps !== undefined ? { steps: a.steps } : {}),
          files: this.files[engine.fileGroup],
          filenamePrefix: 'comfy-mcp/edit',
          seed,
          prompt,
          negativePrompt: a.negative ?? '',
          references,
          autoLatent: !explicitSize,
          ...(explicitSize ? { width: snap16(a.width!), height: snap16(a.height!) } : {})
        } as never)
        job.promptIds.push(await postPrompt(this.base, graph))
      }
      for (const [i, promptId] of job.promptIds.entries()) {
        const items = await this.collect(job, promptId, signal)
        await this.save(job, items[0]!, target, 'edit', i, count, seeds[i])
      }
    }, info)
  }

  async removeBackground(a: { image: string; model?: string; out?: string }): Promise<Job> {
    const image = requireAbsoluteFile(a.image, 'image')
    const target = this.resolveOut(a.out)
    const info = await this.objectInfo()
    if (!info.RemoveBackground || !info.LoadBackgroundRemovalModel) throw new Error('this ComfyUI has no RemoveBackground / LoadBackgroundRemovalModel nodes (core nodes of ComfyUI 0.40+)')
    const listed = removalModelsOf(info)
    if (listed.length === 0) throw new Error('no background-removal model in ComfyUI models/background_removal (e.g. birefnet.safetensors)')
    if (a.model && !listed.includes(a.model)) throw new Error(`model "${a.model}" is not installed; ComfyUI has: ${listed.join(', ')}`)
    const model = a.model ?? listed[0]!
    return this.jobs.start('remove_background', `${model}: ${path.basename(image)}`, async (job, signal) => {
      job.progress = 'upload'
      const uploaded = await uploadFile(this.base, image)
      const items = await this.runGraph(job, buildRemoveBackground({ image: uploaded.filename, model, filenamePrefix: 'comfy-mcp/cutout' }), signal)
      await this.save(job, items[0]!, target, 'cutout', 0, 1)
    }, { model })
  }

  // ---- audio ----

  generateMusic(a: MusicArgs): Job {
    const engineId = a.engine ?? 'ace-step-v1'
    const engine = ENGINES[engineId]
    if (!engine || engine.kind !== 'audio') throw new Error(`engine must be one of ${enginesOfKind('audio').join(', ')}`)
    const tags = a.tags.trim()
    if (!tags) throw new Error('tags is empty')
    const target = this.resolveOut(a.out)
    const format: AudioFormat = a.format ?? ((AUDIO_FORMATS as readonly string[]).includes(target.ext ?? '') ? (target.ext as AudioFormat) : 'mp3')
    const seconds = a.seconds ?? Number(engine.defaults.seconds ?? 60)
    const seed = a.seed ?? randomSeed()
    const graph = engine.build({
      ...engine.defaults,
      ...(a.steps !== undefined ? { steps: a.steps } : {}),
      files: this.files[engine.fileGroup],
      filenamePrefix: 'comfy-mcp/music',
      seed,
      prompt: tags,
      tags,
      style: tags,
      caption: tags,
      lyrics: engineId === 'ace-step-v1-instrumental' ? '' : (a.lyrics ?? ''),
      seconds,
      format
    } as never)
    const info: Record<string, unknown> = { engine: engineId, seconds, format }
    if (engineId === 'yue2' || engineId === 'minimax-music-3') info.note = `${engineId} treats seconds as a maximum; the song may end earlier`
    return this.jobs.start('generate_music', `${engineId} ${seconds}s ${format}: ${tags.slice(0, 80)}`, async (job, signal) => {
      job.seeds = [seed]
      const items = await this.runGraph(job, graph, signal)
      const audio = items.find((i) => i.list === 'audio') ?? items[0]!
      await this.save(job, audio, target, 'music', 0, 1, seed)
    }, info)
  }

  async generateSpeech(a: SpeechArgs): Promise<Job> {
    const text = a.text.trim()
    if (!text) throw new Error('text is empty')
    const voiceRef = a.voiceRef ? requireAbsoluteFile(a.voiceRef, 'voice_ref') : undefined
    const target = this.resolveOut(a.out)
    const wf = await this.workflow(a.workflow ?? 'chatterbox-multilingual')
    const mapping = wf.mapping
    if (!mapping?.text) throw new Error(`workflow ${wf.name} has no "text" in its .map.yaml, so it is not a speech workflow`)
    const graph = structuredClone(wf.graph)
    const language = a.language ?? 'en'
    if (mapping.language) {
      const value = mappedValue(mapping, 'language', language)
      if (mapping.languages && !Object.values(mapping.languages).includes(String(value))) {
        throw new Error(`language "${language}" is not supported by ${wf.name}; use one of ${Object.keys(mapping.languages).join(', ')}`)
      }
      setInput(graph, mapping.language, value)
    }
    setInput(graph, mapping.text, text)
    const seed = a.seed ?? randomSeed()
    if (mapping.seed) setInput(graph, mapping.seed, seed)
    let voice = voiceRef ?? 'built-in'
    const info: Record<string, unknown> = { workflow: wf.name, language }
    if (!voiceRef && mapping.voiceRef) {
      // Keep the workflow's own reference clip when ComfyUI has it: Chatterbox without any reference tends to run on far past
      // the text (a 3 s line came back 35 s long). Only without that clip does the model use its built-in voice.
      const current = graph[mapping.voiceRef.node]?.inputs[mapping.voiceRef.input]
      const loader = graph[mapping.voiceRef.node]?.class_type ?? ''
      const choices = comboOptions((await this.objectInfo())[loader]?.input?.required?.[mapping.voiceRef.input])
      if (typeof current === 'string' && choices.includes(current)) {
        voice = `workflow default (${current})`
      } else {
        dropNode(graph, mapping.voiceRef.node)
        info.note = 'no voice reference: the built-in voice can run on past the text; pass voice_ref for reliable length'
      }
    }
    info.voice = voice
    tidyPrefixes(graph, 'speech')
    return this.jobs.start('generate_speech', `${wf.name} ${language}: ${text.slice(0, 80)}`, async (job, signal) => {
      job.seeds = [seed]
      if (voiceRef && mapping.voiceRef) {
        job.progress = 'upload'
        setInput(graph, mapping.voiceRef, (await uploadFile(this.base, voiceRef)).filename)
      }
      const items = await this.runGraph(job, graph, signal, mapping.output.node)
      await this.save(job, items.find((i) => i.list === 'audio') ?? items[0]!, target, 'speech', 0, 1, seed)
    }, info)
  }

  // ---- saved workflows ----

  async workflow(ref: string): Promise<LoadedWorkflow> {
    const file = await resolveWorkflowFile(this.config.workflowDirs, ref)
    return loadWorkflow(file, async () => (await this.objectInfo()) as SchemaMap)
  }

  listWorkflows() {
    return listWorkflows(this.config.workflowDirs)
  }

  async describeWorkflow(ref: string) {
    const wf = await this.workflow(ref)
    const outputs = Object.entries(wf.graph)
      .filter(([, n]) => /^(Save|Preview)/.test(n.class_type))
      .map(([id, n]) => `${id} (${n.class_type})`)
    return {
      name: wf.name,
      file: wf.file,
      format: wf.format,
      mapping: wf.mapping,
      output_nodes: outputs,
      warnings: wf.warnings,
      nodes: describeGraph(wf.graph),
      how: 'run_workflow params: {"<node id or title>.<input>": value} for literal inputs (not links), or the mapped names; files: {"<node>.<input>": "C:\\\\abs\\\\path.png"} uploads the file first.'
    }
  }

  async runWorkflow(a: WorkflowArgs): Promise<Job> {
    const wf = await this.workflow(a.workflow)
    const graph = structuredClone(wf.graph)
    const keep = new Set<string>()
    const explicitSeeds: number[] = []
    for (const [key, value] of Object.entries(a.params ?? {})) {
      const slot = resolveSlot(graph, wf.mapping, key)
      if (slot.field && FILE_FIELDS.includes(slot.field)) throw new Error(`${key} takes a file: pass it in files, not params`)
      const v = mappedValue(wf.mapping, slot.field, value)
      setInput(graph, slot, v)
      keep.add(`${slot.node}.${slot.input}`)
      if (/^(noise_)?seed$/.test(slot.input) && typeof v === 'number') explicitSeeds.push(v)
    }
    const uploads: Array<{ slot: Slot; file: string }> = []
    for (const [key, file] of Object.entries(a.files ?? {})) {
      const slot = resolveSlot(graph, wf.mapping, key)
      if (!graph[slot.node]) throw new Error(`no node "${slot.node}" for files.${key}`)
      uploads.push({ slot, file: requireAbsoluteFile(file, `files.${key}`) })
    }
    const randomized = a.randomizeSeeds === false ? {} : randomizeSeeds(graph, keep)
    const outputNode = a.outputNode ?? wf.mapping?.output.node
    if (outputNode && !graph[outputNode]) throw new Error(`output_node "${outputNode}" is not in the workflow`)
    if (!Object.values(graph).some((n) => /^(Save|Preview)/.test(n.class_type)) && !outputNode) {
      throw new Error(`workflow ${wf.name} has no Save*/Preview* node; nothing would come back`)
    }
    tidyPrefixes(graph, wf.name.replace(/[^\w.-]+/g, '_'))
    const target = this.resolveOut(a.out)
    const info: Record<string, unknown> = { workflow: wf.name, format: wf.format, ...(Object.keys(randomized).length ? { randomized_seeds: randomized } : {}) }
    if (wf.warnings.length > 0) info.warnings = wf.warnings
    return this.jobs.start('run_workflow', `${wf.name}${a.params ? ` (${Object.keys(a.params).join(', ')})` : ''}`, async (job, signal) => {
      job.seeds = [...explicitSeeds, ...Object.values(randomized)]
      for (const u of uploads) {
        job.progress = 'upload'
        setInput(graph, u.slot, (await uploadFile(this.base, u.file)).filename)
      }
      const items = await this.runGraph(job, graph, signal, outputNode)
      const prefix = wf.name.replace(/[^\w.-]+/g, '_').slice(0, 40)
      for (const [i, item] of items.entries()) await this.save(job, item, target, prefix, i, items.length)
    }, info)
  }

  // ---- status ----

  async status(): Promise<Record<string, unknown>> {
    const comfy: Record<string, unknown> = { url: this.base }
    let models: Record<string, string[]> = {}
    let info: ObjectInfo | null = null
    try {
      const [stats, queue] = await Promise.all([systemStats(this.base), queueState(this.base)])
      const gb = (n: number | undefined) => (n === undefined ? undefined : Math.round((n / 1024 ** 3) * 10) / 10)
      comfy.reachable = true
      comfy.version = stats.system?.comfyui_version
      comfy.ram_gb = { total: gb(stats.system?.ram_total), free: gb(stats.system?.ram_free) }
      comfy.devices = (stats.devices ?? []).map((d) => ({ name: d.name, vram_total_gb: gb(d.vram_total), vram_free_gb: gb(d.vram_free), torch_vram_gb: gb(d.torch_vram_total) }))
      comfy.queue = { running: queue.running, pending: queue.pending }
      const lists = await Promise.all(MODEL_FOLDERS.map((f) => listModelFiles(this.base, f).catch(() => [] as string[])))
      models = Object.fromEntries(MODEL_FOLDERS.map((f, i) => [f, lists[i]!]))
      info = await this.objectInfo(true).catch(() => null)
    } catch (e) {
      comfy.reachable = false
      comfy.error = (e as Error).message
    }
    const engines = Object.entries(ENGINES).map(([id, e]) => {
      const group = this.files[e.fileGroup] as Record<string, string>
      const missing = e.requires.filter(([key, folder]) => models[folder] && !models[folder]!.includes(group[key] ?? '')).map(([key, folder]) => `${folder}/${group[key]}`)
      return { id, kind: e.kind, ready: comfy.reachable === true && missing.length === 0, ...(missing.length ? { missing } : {}) }
    })
    const removal = info ? removalModelsOf(info) : []
    return {
      comfy,
      engines,
      background_removal: { ready: removal.length > 0 && !!info?.RemoveBackground, models: removal },
      models,
      jobs: this.jobs.active().map((j) => ({ job_id: j.id, tool: j.tool, summary: j.summary, progress: j.progress })),
      out_dir: this.config.outDir,
      workflow_dirs: this.config.workflowDirs
    }
  }

  async freeMemory(): Promise<Record<string, unknown>> {
    await freeMemory(this.base)
    const stats = await systemStats(this.base).catch(() => null)
    const gb = (n: number | undefined) => (n === undefined ? undefined : Math.round((n / 1024 ** 3) * 10) / 10)
    return { freed: true, devices: (stats?.devices ?? []).map((d) => ({ name: d.name, vram_free_gb: gb(d.vram_free), torch_vram_gb: gb(d.torch_vram_total) })) }
  }
}

/** The choices of a COMBO input spec from /object_info (old `[[...]]` or new `["COMBO", {options}]` shape). */
function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) return []
  if (Array.isArray(spec[0])) return (spec[0] as unknown[]).map(String)
  const options = (spec[1] as { options?: unknown[] } | undefined)?.options
  return Array.isArray(options) ? options.map(String) : []
}

/** Points literal `filename_prefix` inputs at `comfy-mcp/<name>` so ComfyUI's own output folder stays tidy. */
function tidyPrefixes(graph: Graph, name: string): void {
  for (const node of Object.values(graph)) {
    if (typeof node.inputs.filename_prefix === 'string') node.inputs.filename_prefix = `comfy-mcp/${name}`
  }
}
