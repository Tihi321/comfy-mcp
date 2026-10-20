import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Graph } from './graphs'

/**
 * Thin HTTP client for one local ComfyUI, ported from VN Studio `src/engine/comfy/client.ts` (itself from dsh-comfyui
 * `lib/comfy.js`). Everything is `fetch` + `node:fs`.
 *
 * Design rules:
 *   - a job that finishes with no outputs is a FAILURE, not an empty success;
 *   - every call has a deadline, so a wedged ComfyUI cannot hang a job forever.
 */

export const REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'

interface FetchOpts extends RequestInit {
  timeoutMs?: number
}

/** `fetch` with a deadline and a message that says what failed. */
export async function fetchWithDeadline(url: string, { timeoutMs = REQUEST_TIMEOUT_MS, ...init }: FetchOpts = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    const err = error as { name?: string; code?: string; cause?: { code?: string }; message?: string }
    if (err?.name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms: ${url}`, { cause: error })
    if (err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED') {
      throw new Error(`ComfyUI unreachable at ${url} (connection refused). Start it: pwsh -File C:\\projects\\Personal\\creative-hub\\scripts\\hub.ps1 start comfyui`, { cause: error })
    }
    throw new Error(`${url} failed: ${err?.message ?? String(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/** JSON request with a useful error body, not just an HTTP code. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const response = await fetchWithDeadline(url, opts)
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: unknown; node_errors?: unknown }
      const parts: string[] = []
      if (body?.error !== undefined) parts.push(typeof body.error === 'string' ? body.error : JSON.stringify(body.error))
      if (body?.node_errors !== undefined && Object.keys(body.node_errors as object).length > 0) parts.push(`node_errors: ${JSON.stringify(body.node_errors)}`)
      if (parts.length > 0) detail = parts.join('; ').slice(0, 3000)
    } catch {
      /* keep the status line */
    }
    throw new Error(`ComfyUI ${opts.method ?? 'GET'} ${url} failed: ${detail}`)
  }
  return (await response.json()) as T
}

export interface QueueState {
  running: number
  pending: number
  runningIds: string[]
  pendingIds: string[]
}

/** Queue depth and the prompt ids in it. Throws when ComfyUI is unreachable. */
export async function queueState(base: string, timeoutMs = 8000): Promise<QueueState> {
  const state = await fetchJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>(`${base}/queue`, { timeoutMs })
  const ids = (list: unknown[][] | undefined) => (list ?? []).map((e) => String(e?.[1] ?? ''))
  return {
    running: state?.queue_running?.length ?? 0,
    pending: state?.queue_pending?.length ?? 0,
    runningIds: ids(state?.queue_running),
    pendingIds: ids(state?.queue_pending)
  }
}

export interface SystemStats {
  system?: { comfyui_version?: string; ram_total?: number; ram_free?: number; os?: string }
  devices?: Array<{ name?: string; type?: string; vram_total?: number; vram_free?: number; torch_vram_total?: number; torch_vram_free?: number }>
}

export async function systemStats(base: string, timeoutMs = 8000): Promise<SystemStats> {
  return fetchJson<SystemStats>(`${base}/system_stats`, { timeoutMs })
}

/** Asks ComfyUI to drop cached models and free VRAM (weights stay on disk). */
export async function freeMemory(base: string, timeoutMs = 30_000): Promise<void> {
  const response = await fetchWithDeadline(`${base}/free`, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  })
  if (!response.ok) throw new Error(`ComfyUI POST ${base}/free failed: HTTP ${response.status}`)
}

/** Removes queued prompts that have not started. */
export async function deleteFromQueue(base: string, promptIds: string[]): Promise<void> {
  const response = await fetchWithDeadline(`${base}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: promptIds }) })
  if (!response.ok) throw new Error(`ComfyUI POST ${base}/queue failed: HTTP ${response.status}`)
}

/** Interrupts the running prompt (only that one when the id is given). */
export async function interrupt(base: string, promptId?: string): Promise<void> {
  const response = await fetchWithDeadline(`${base}/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(promptId ? { prompt_id: promptId } : {})
  })
  if (!response.ok) throw new Error(`ComfyUI POST ${base}/interrupt failed: HTTP ${response.status}`)
}

/** Model files ComfyUI can see in one folder. */
export async function listModelFiles(base: string, folder: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string[]> {
  const files = await fetchJson<unknown>(`${base}/models/${encodeURIComponent(folder)}`, { timeoutMs })
  return Array.isArray(files) ? (files as string[]) : []
}

export type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; output?: unknown[] }>

/** The node catalog: tells "not installed" from "wrong filename". */
export async function objectInfo(base: string, timeoutMs = 60_000): Promise<ObjectInfo> {
  return fetchJson<ObjectInfo>(`${base}/object_info`, { timeoutMs })
}

export interface Uploaded {
  /** What LoadImage / LoadAudio expect: `subfolder/name` or `name`. */
  filename: string
  name: string
  subfolder: string
}

/** Uploads one local file (image or audio) into ComfyUI's input folder. */
export async function uploadFile(base: string, filePath: string, { timeoutMs = 120_000, subfolder = 'comfy-mcp' } = {}): Promise<Uploaded> {
  const bytes = await fs.readFile(filePath)
  // a unique name, so two callers never overwrite each other's reference
  const ext = path.extname(filePath)
  const stem = path.basename(filePath, ext).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'input'
  const name = `${stem}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)]), name)
  form.append('overwrite', 'true')
  if (subfolder) form.append('subfolder', subfolder)
  const response = await fetchWithDeadline(`${base}/upload/image`, { method: 'POST', body: form, timeoutMs })
  if (!response.ok) throw new Error(`upload of ${filePath} to ComfyUI failed: HTTP ${response.status}`)
  const body = (await response.json()) as { name?: string; subfolder?: string }
  if (!body?.name) throw new Error(`upload to ComfyUI returned no filename: ${JSON.stringify(body)}`)
  return { filename: body.subfolder ? `${body.subfolder}/${body.name}` : body.name, name: body.name, subfolder: body.subfolder ?? '' }
}

/** Queues a graph; resolves with the prompt id. */
export async function postPrompt(base: string, graph: Graph, { clientId = 'comfy-mcp', timeoutMs = REQUEST_TIMEOUT_MS } = {}): Promise<string> {
  const body = await fetchJson<{ prompt_id?: string }>(`${base}/prompt`, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId })
  })
  if (!body?.prompt_id) throw new Error(`ComfyUI accepted the prompt but returned no prompt_id: ${JSON.stringify(body)}`)
  return body.prompt_id
}

export interface OutputItem {
  filename: string
  subfolder?: string
  type?: string
}
export type ComfyOutputs = Record<string, Record<string, unknown> | undefined>

export interface WaitOptions {
  timeoutMs: number
  pollMs?: number
  signal?: AbortSignal
  onPoll?: (info: { status: string; elapsedMs: number }) => void
}

/**
 * Polls `/history/<id>` until the job reports outputs. A job that errored, was interrupted, or finished with no outputs
 * throws: a silent empty result is the failure mode this client exists to avoid.
 */
export async function waitForOutputs(base: string, promptId: string, { timeoutMs, pollMs = 1500, signal, onPoll }: WaitOptions): Promise<ComfyOutputs> {
  const started = Date.now()
  const deadline = started + timeoutMs
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`ComfyUI job ${promptId} cancelled`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    let history: Record<string, { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: ComfyOutputs } | undefined>
    try {
      history = await fetchJson(`${base}/history/${promptId}`, { timeoutMs: 15000 })
    } catch {
      continue // a transient poll failure is not a job failure
    }
    const entry = history?.[promptId]
    if (!entry) {
      onPoll?.({ status: 'queued', elapsedMs: Date.now() - started })
      continue
    }
    const status = entry.status?.status_str
    if (status) lastStatus = status
    onPoll?.({ status: status ?? 'running', elapsedMs: Date.now() - started })
    if (status === 'error') {
      const messages = entry.status?.messages ?? []
      const details: string[] = []
      for (const pair of messages) {
        const [kind, payload] = (pair ?? []) as [string, Record<string, string> | undefined]
        if (kind === 'execution_error') {
          details.push(payload?.exception_message ?? payload?.exception_type ?? 'execution error')
          if (payload?.node_type) details.push(`at node ${payload.node_id} (${payload.node_type})`)
        } else if (kind === 'execution_interrupted') {
          details.push(`interrupted at node ${payload?.node_id} (${payload?.node_type}): cancelled here, or stopped with the Interrupt button in ComfyUI`)
        }
      }
      if (details.length === 0) details.push(`status "error" with no detail; messages: ${JSON.stringify(messages).slice(0, 400)}`)
      throw new Error(`ComfyUI job ${promptId} failed: ${details.join(' ')}`)
    }
    const outputs = entry.outputs
    if (outputs && Object.keys(outputs).length > 0) return outputs
    if (entry.status?.completed) throw new Error(`ComfyUI job ${promptId} finished without any output`)
  }
  throw new Error(`ComfyUI job ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s${lastStatus ? ` (last status: ${lastStatus})` : ''}`)
}

export interface CollectedItem extends OutputItem {
  node: string
  /** The output list it came from: `images`, `audio`, `gifs`, `video`, ... */
  list: string
}

/**
 * Every downloadable file in the outputs, in node order. Files of type `output` (Save* nodes) win; `temp` files (Preview* nodes) are
 * only returned when nothing was saved. `onlyNode` restricts to one node when that node has files.
 */
export function collectOutputs(outputs: ComfyOutputs | undefined, onlyNode?: string): CollectedItem[] {
  const all: CollectedItem[] = []
  for (const [node, out] of Object.entries(outputs ?? {})) {
    if (!out) continue
    for (const [list, value] of Object.entries(out)) {
      if (!Array.isArray(value)) continue
      for (const item of value as unknown[]) {
        const it = item as OutputItem | null
        if (it && typeof it === 'object' && typeof it.filename === 'string' && it.filename) all.push({ ...it, node, list })
      }
    }
  }
  const scoped = onlyNode && all.some((i) => i.node === onlyNode) ? all.filter((i) => i.node === onlyNode) : all
  const saved = scoped.filter((i) => (i.type ?? 'output') === 'output')
  return saved.length > 0 ? saved : scoped
}

/** Downloads one output file's bytes through `/view`. */
export async function downloadOutput(base: string, item: OutputItem, timeoutMs = 120_000): Promise<Buffer> {
  const params = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' })
  const response = await fetchWithDeadline(`${base}/view?${params}`, { timeoutMs })
  if (!response.ok) throw new Error(`ComfyUI /view of ${item.filename} failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Names of the background-removal models ComfyUI can load (core `LoadBackgroundRemovalModel` node). Empty when none. */
export function removalModelsOf(info: ObjectInfo | undefined): string[] {
  const spec = info?.LoadBackgroundRemovalModel?.input?.required?.bg_removal_name as unknown[] | undefined
  if (!spec) return []
  const first = spec[0]
  if (Array.isArray(first)) return first.map(String)
  const options = (spec[1] as { options?: unknown[] } | undefined)?.options
  return Array.isArray(options) ? options.map(String) : []
}
