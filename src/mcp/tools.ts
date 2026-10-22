import { z } from 'zod'
import { enginesOfKind, ENGINES } from '../comfy/graphs'
import { jobView, type Job } from '../jobs'
import { AUDIO_FORMATS, type ComfyService } from '../service'

/**
 * The MCP tools. Generation tools start a background job, wait for it up to `wait` seconds and return the written paths, or the
 * job id while it still runs (then call `wait`). `callTool` validates the arguments and turns any error into a text result.
 */

export interface Tool {
  name: string
  description: string
  schema: z.ZodType
  run: (args: never) => Promise<unknown>
}

/** The result of a `tools/call`: a readable text item plus the same data as `structuredContent`. */
export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const DEFAULT_WAIT_S = 45
const MAX_WAIT_S = 600

const out = z
  .string()
  .optional()
  .describe('Absolute output path: a folder (file names are made up) or a file path (numbered _1, _2 when there are several; the extension follows what ComfyUI produced). Default: the server\'s output folder (see status).')
const wait = z
  .number()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(`Seconds to wait for the result before returning the job id (default ${DEFAULT_WAIT_S}, 0 = return the job id at once). Then call wait.`)
const seed = z.number().int().min(0).optional().describe('Fixed seed for reproducible output (random when omitted)')
const absPath = (what: string) => z.string().describe(`Absolute path of ${what}`)

const imageEngines = enginesOfKind('image').filter((id) => !ENGINES[id]!.acceptsReferences) as [string, ...string[]]
const audioEngines = enginesOfKind('audio') as [string, ...string[]]

export function buildTools(svc: ComfyService): Tool[] {
  const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>): Tool => ({ name, description, schema, run: run as Tool['run'] })

  /** Waits for a freshly started job up to the caller's budget and reports it. */
  const settle = async (job: Job, waitS: number | undefined) => {
    await svc.jobs.wait([job.id], (waitS ?? DEFAULT_WAIT_S) * 1000)
    const view = jobView(job)
    if (job.state === 'error' || job.state === 'cancelled') throw new Error(`${job.id} ${job.state}: ${job.error ?? ''}`)
    return view
  }

  return [
    def(
      'status',
      'ComfyUI health: version, VRAM and RAM, queue depth, which engines are ready (model files present), background-removal models, every model file per folder, running jobs, and the default output folder. Call it before saying an engine is unavailable.',
      z.object({}),
      () => svc.status()
    ),
    def(
      'generate_image',
      `Text to image with the local ComfyUI. Engines: z-image-turbo (default, 8 steps, fast, 1024x1024), qwen-image-2.1-turbo (8 steps, 1328x1328), qwen-image-2.1 (25 steps, best text rendering and prompt following, slower), krea2-turbo (8 steps). Width and height snap to multiples of 16. count queues several images with seeds seed, seed+1, ... Returns the PNG paths.`,
      z.object({
        prompt: z.string().describe('What to draw: subject, style, lighting, background'),
        engine: z.enum(imageEngines).optional(),
        negative: z.string().optional().describe('Negative prompt (qwen-image-2.1 engines only; the turbo templates ignore it)'),
        width: z.number().int().min(64).max(4096).optional(),
        height: z.number().int().min(64).max(4096).optional(),
        seed,
        count: z.number().int().min(1).max(8).optional().describe('Number of images (default 1)'),
        steps: z.number().int().min(1).max(150).optional().describe('Sampler steps (default: the engine template)'),
        cfg: z.number().min(0).max(30).optional(),
        out,
        wait
      }),
      async (a) => settle(svc.generateImage(a), a.wait)
    ),
    def(
      'edit_image',
      'Edit images with Qwen-Image 2.1 edit: pass 1-16 absolute image paths and an instruction ("give her a red coat, keep the face and pose"). The images are uploaded to ComfyUI and spliced into the model input, so the subject is kept. Without width/height the output matches the first image. Returns the PNG paths.',
      z.object({
        prompt: z.string().describe('The edit instruction'),
        image: z.string().optional().describe('Absolute path of the image to edit (or use images)'),
        images: z.array(z.string()).optional().describe('Absolute paths of the reference images, in order'),
        negative: z.string().optional(),
        width: z.number().int().min(64).max(4096).optional(),
        height: z.number().int().min(64).max(4096).optional(),
        seed,
        count: z.number().int().min(1).max(8).optional(),
        steps: z.number().int().min(1).max(150).optional().describe('Sampler steps (default 25)'),
        out,
        wait
      }),
      async (a) => {
        const images = [...(a.image ? [a.image] : []), ...(a.images ?? [])]
        return settle(svc.editImage({ ...a, images }), a.wait)
      }
    ),
    def(
      'remove_background',
      'Cut the background out of an image with BiRefNet (ComfyUI core RemoveBackground). Returns the path of a PNG with an alpha channel.',
      z.object({ image: absPath('the image'), model: z.string().optional().describe('Removal model file (default: the first in models/background_removal, birefnet.safetensors)'), out, wait }),
      async (a) => settle(await svc.removeBackground(a), a.wait)
    ),
    def(
      'generate_music',
      'Music with the local ComfyUI. Engines: ace-step-v1 (default; tags + optional lyrics with [verse]/[chorus] markers), ace-step-v1-instrumental (tags only), yue2 (style + lyrics), minimax-music-3 (caption + lyrics). For yue2 and minimax seconds is a maximum. Rendering 60 s with ACE-Step takes a minute or more, so expect a job id; then call wait. Returns the audio path.',
      z.object({
        tags: z.string().describe('Style tags or caption, e.g. "lo-fi hip hop, mellow piano, rain, 80 bpm"'),
        engine: z.enum(audioEngines).optional(),
        lyrics: z.string().optional().describe('Lyrics; omit for instrumental'),
        seconds: z.number().min(1).max(360).optional().describe('Length in seconds (default 60)'),
        seed,
        steps: z.number().int().min(1).max(200).optional(),
        format: z.enum(AUDIO_FORMATS).optional().describe('Default: the out file extension, else mp3'),
        out,
        wait
      }),
      async (a) => settle(svc.generateMusic(a), a.wait)
    ),
    def(
      'generate_speech',
      'Text to speech through a saved ComfyUI TTS workflow (default chatterbox-multilingual: 23 languages, not Croatian). Pass voice_ref (an absolute path to a short clean audio clip, 5-15 s) to clone a voice; without it the workflow\'s own reference clip is used when ComfyUI has it, else the built-in voice (which can run on past the text). Returns the audio path.',
      z.object({
        text: z.string().describe('What to say'),
        language: z.string().optional().describe('Language code: en (default), de, fr, es, it, ja, zh, ... (see the workflow mapping)'),
        voice_ref: z.string().optional().describe('Absolute path of a voice reference clip (wav/mp3/flac)'),
        seed,
        workflow: z.string().optional().describe('A mapped TTS workflow (needs a .map.yaml with text); default chatterbox-multilingual'),
        out,
        wait
      }),
      async (a) => settle(await svc.generateSpeech({ ...a, voiceRef: a.voice_ref }), a.wait)
    ),
    def(
      'list_workflows',
      'List saved workflows: this server\'s workflows folder, extra folders, and ComfyUI\'s own saved workflows. Shows the format (api or ui), whether a .map.yaml names its inputs, and why one cannot run (not valid JSON, not a ComfyUI workflow). UI workflows that use subgraphs (most ComfyUI templates) run as they are.',
      z.object({}),
      async () => ({ workflows: await svc.listWorkflows() })
    ),
    def(
      'describe_workflow',
      'Show a saved workflow as an API graph: every node id, class, title, literal inputs and links, its output nodes and its mapping. Use it to find the "<node>.<input>" keys for run_workflow.',
      z.object({ workflow: z.string().describe('A name from list_workflows or an absolute path to a .json') }),
      async (a) => svc.describeWorkflow(a.workflow)
    ),
    def(
      'run_workflow',
      'Run a saved workflow (API format, or a UI-format workflow, including ones that use subgraphs; their inner nodes get ids like "57:27") with a parameter map. params: {"<node id or title>.<input>": value} for literal inputs, or mapped names (prompt, negative, width, height, seed, steps, text, language) when the workflow has a .map.yaml. files: {"<node>.<input>": "<absolute path>"} uploads a file into ComfyUI\'s input folder and sets the input (or mapped reference / voiceRef). Seeds not set in params are randomized unless randomize_seeds is false. Every file the output nodes save is downloaded; returns the paths.',
      z.object({
        workflow: z.string().describe('A name from list_workflows or an absolute path to a .json'),
        params: z.record(z.string(), z.unknown()).optional(),
        files: z.record(z.string(), z.string()).optional(),
        output_node: z.string().optional().describe('Only return files from this node'),
        randomize_seeds: z.boolean().optional(),
        out,
        wait
      }),
      async (a) => settle(await svc.runWorkflow({ workflow: a.workflow, params: a.params, files: a.files, outputNode: a.output_node, randomizeSeeds: a.randomize_seeds, out: a.out }), a.wait)
    ),
    def(
      'wait',
      `Wait for jobs to finish (up to timeout_seconds, default 120, max ${MAX_WAIT_S}) and report them: state, output paths, seeds, error. Without job_ids it waits for every running job.`,
      z.object({
        job_ids: z.union([z.string(), z.array(z.string())]).optional(),
        timeout_seconds: z.number().min(0).max(MAX_WAIT_S).optional()
      }),
      async (a) => {
        const ids = a.job_ids === undefined ? svc.jobs.active().map((j) => j.id) : Array.isArray(a.job_ids) ? a.job_ids : [a.job_ids]
        const unknown = ids.filter((id) => !svc.jobs.get(id))
        if (unknown.length > 0) throw new Error(`unknown job id(s): ${unknown.join(', ')} (jobs are forgotten when the server restarts)`)
        const finished = await svc.jobs.wait(ids, (a.timeout_seconds ?? 120) * 1000)
        return { all_finished: finished, jobs: ids.map((id) => jobView(svc.jobs.get(id)!)) }
      }
    ),
    def('cancel', 'Cancel a job: removes its prompts from the ComfyUI queue, or interrupts the one that is running.', z.object({ job_id: z.string() }), async (a) => jobView(await svc.jobs.cancel(a.job_id))),
    def(
      'free_memory',
      'Unload ComfyUI\'s cached models and free VRAM (weights stay on disk; the next job reloads them). Use it before another GPU-heavy tool (an LLM server) needs the memory.',
      z.object({}),
      () => svc.freeMemory()
    )
  ]
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

/** Runs one tool: validates the arguments, returns JSON text plus `structuredContent`, errors as text. */
export async function callTool(tools: readonly Tool[], name: string, args: unknown): Promise<ToolResult> {
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })
  const tool = tools.find((t) => t.name === name)
  if (!tool) return fail(`unknown tool "${name}"`)
  const parsed = tool.schema.safeParse(args ?? {})
  if (!parsed.success) return fail(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  try {
    const result = await tool.run(parsed.data as never)
    const structured = (result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as Record<string, unknown>
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: JSON.parse(JSON.stringify(structured)) as Record<string, unknown> }
  } catch (e) {
    return fail((e as Error).message)
  }
}

/** The tools as `tools/list` shows them. */
export function toolList(tools: readonly Tool[]): { name: string; description: string; inputSchema: { type: 'object'; [k: string]: unknown } }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.schema) as { type: 'object'; [k: string]: unknown } }))
}
