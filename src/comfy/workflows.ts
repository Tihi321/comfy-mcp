import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { randomSeed, snap16, type Graph } from './graphs'
import { uiToApi, type SchemaMap, type UiWorkflow } from './ui-to-api'

/**
 * Saved workflows: an API-format graph (`<name>.json`, ComfyUI "Export (API)"), or a UI-format workflow the editor saved, converted
 * with the live node catalog. An optional `<name>.map.yaml` next to it names the inputs that take the prompt, seed, text, language,
 * reference image and so on (the format VN Studio uses for `custom:<name>` engines), so callers can pass `{ text: "..." }` instead of
 * `{ "1.text": "..." }`.
 */

const slotSchema = z.object({ node: z.coerce.string(), input: z.string() })
export type Slot = z.infer<typeof slotSchema>
const outputSchema = z.union([z.coerce.string(), z.object({ node: z.coerce.string() })]).transform((v) => (typeof v === 'string' ? { node: v } : v))

export const mappingSchema = z.object({
  prompt: slotSchema.optional(),
  negative: slotSchema.optional(),
  width: slotSchema.optional(),
  height: slotSchema.optional(),
  seed: slotSchema.optional(),
  steps: slotSchema.optional(),
  /** A LoadImage input: the reference image (uploaded to ComfyUI first). */
  reference: slotSchema.optional(),
  /** Text to speak (TTS). */
  text: slotSchema.optional(),
  language: slotSchema.optional(),
  /** A LoadAudio input: the voice reference clip (uploaded first). */
  voiceRef: slotSchema.optional(),
  /** The node whose output is returned. */
  output: outputSchema,
  /** Language code (`en`, `de`) -> the value the language input expects, e.g. `English (en)`. */
  languages: z.record(z.string(), z.string()).optional(),
  kind: z.enum(['image', 'audio']).optional()
})
export type Mapping = z.output<typeof mappingSchema>
export const MAPPED_FIELDS = ['prompt', 'negative', 'width', 'height', 'seed', 'steps', 'reference', 'text', 'language', 'voiceRef'] as const
export type MappedField = (typeof MAPPED_FIELDS)[number]
/** Mapped fields that take a file path (uploaded to ComfyUI's input folder). */
export const FILE_FIELDS: readonly MappedField[] = ['reference', 'voiceRef']

export interface LoadedWorkflow {
  name: string
  file: string
  format: 'api' | 'ui'
  graph: Graph
  mapping: Mapping | null
  warnings: string[]
}

export interface WorkflowEntry {
  name: string
  file: string
  format: 'api' | 'ui' | 'unknown'
  mapped: boolean
  /** Why it cannot run as is (not a workflow). */
  problem?: string
}

function isGraph(value: unknown): value is Graph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value as Record<string, unknown>)
  return entries.length > 0 && entries.every((n) => !!n && typeof n === 'object' && typeof (n as { class_type?: unknown }).class_type === 'string')
}

function isUi(value: unknown): value is UiWorkflow {
  return !!value && typeof value === 'object' && Array.isArray((value as { nodes?: unknown }).nodes)
}

function classify(raw: unknown): { format: WorkflowEntry['format']; problem?: string } {
  if (isGraph(raw)) return { format: 'api' }
  if (isUi(raw)) return { format: 'ui' }
  return { format: 'unknown', problem: 'not a ComfyUI workflow' }
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) await walk(full, depth - 1, out)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) out.push(full)
  }
}

/** Every workflow file in the folders, first folder wins on equal names. */
export async function listWorkflows(dirs: string[]): Promise<WorkflowEntry[]> {
  const seen = new Set<string>()
  const result: WorkflowEntry[] = []
  for (const dir of dirs) {
    const files: string[] = []
    await walk(dir, 2, files)
    for (const file of files.sort()) {
      const name = path.relative(dir, file).replace(/\\/g, '/').replace(/\.json$/i, '')
      if (seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        result.push({ name, file, format: 'unknown', mapped: false, problem: 'not valid JSON' })
        continue
      }
      result.push({ name, file, ...classify(raw), mapped: existsSync(mapFileOf(file)) })
    }
  }
  return result
}

function mapFileOf(file: string): string {
  return file.replace(/\.json$/i, '.map.yaml')
}

/** An absolute path, or a name (with or without `.json`, may include a subfolder) looked up in the workflow folders. */
export async function resolveWorkflowFile(dirs: string[], ref: string): Promise<string> {
  const wanted = ref.trim()
  if (!wanted) throw new Error('workflow is empty')
  if (path.isAbsolute(wanted)) {
    if (!existsSync(wanted)) throw new Error(`workflow file not found: ${wanted}`)
    return wanted
  }
  const name = wanted.replace(/\\/g, '/').replace(/\.json$/i, '')
  for (const dir of dirs) {
    const direct = path.join(dir, `${name}.json`)
    if (existsSync(direct)) return direct
  }
  const all = await listWorkflows(dirs)
  const hit = all.find((w) => w.name.toLowerCase() === name.toLowerCase()) ?? all.find((w) => path.basename(w.name).toLowerCase() === path.basename(name).toLowerCase())
  if (hit) return hit.file
  throw new Error(`workflow "${ref}" not found in ${dirs.join(', ')}. Call list_workflows for the names.`)
}

export function parseMapping(text: string, source = 'mapping'): Mapping {
  const parsed = mappingSchema.safeParse(parseYaml(text))
  if (!parsed.success) throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return parsed.data
}

/** Checks the mapping against the graph: every node exists and no mapped input is a link. */
export function validateMapping(graph: Graph, mapping: Mapping): string[] {
  const problems: string[] = []
  for (const field of MAPPED_FIELDS) {
    const slot = mapping[field]
    if (!slot) continue
    const node = graph[slot.node]
    if (!node) problems.push(`${field}: node "${slot.node}" is not in the workflow`)
    else if (Array.isArray(node.inputs[slot.input])) problems.push(`${field}: ${slot.node}.${slot.input} is linked to another node, not a value`)
  }
  if (!graph[mapping.output.node]) problems.push(`output: node "${mapping.output.node}" is not in the workflow`)
  return problems
}

/** Loads a workflow as an API graph. `schemas` (ComfyUI's /object_info) is fetched only for UI-format files. */
export async function loadWorkflow(file: string, schemas: () => Promise<SchemaMap>): Promise<LoadedWorkflow> {
  const name = path.basename(file).replace(/\.json$/i, '')
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`, { cause: e })
  }
  const kind = classify(raw)
  if (kind.problem) throw new Error(`${file}: ${kind.problem}`)
  let graph: Graph
  const warnings: string[] = []
  if (kind.format === 'api') {
    graph = raw as Graph
  } else {
    const converted = uiToApi(raw as UiWorkflow, await schemas())
    graph = converted.prompt
    warnings.push(...converted.warnings)
  }
  let mapping: Mapping | null = null
  const mapFile = mapFileOf(file)
  if (existsSync(mapFile)) {
    mapping = parseMapping(await fs.readFile(mapFile, 'utf8'), mapFile)
    const problems = validateMapping(graph, mapping)
    if (problems.length > 0) throw new Error(`${mapFile}: ${problems.join('; ')}`)
  }
  return { name, file, format: kind.format as 'api' | 'ui', graph, mapping, warnings }
}

/** The node a key names: its id, else a unique `_meta.title`. */
function findNode(graph: Graph, ref: string): string {
  if (graph[ref]) return ref
  const byTitle = Object.entries(graph).filter(([, n]) => n._meta?.title === ref)
  if (byTitle.length === 1) return byTitle[0]![0]
  if (byTitle.length > 1) throw new Error(`node title "${ref}" is not unique (${byTitle.map(([id]) => id).join(', ')}); use the node id`)
  throw new Error(`no node "${ref}" in the workflow (use a node id or title; describe_workflow lists them)`)
}

/** Splits `node.input` at the first dot (input names may contain dots, node ids do not). */
export function splitKey(key: string): { node: string; input: string } {
  const i = key.indexOf('.')
  if (i <= 0 || i === key.length - 1) throw new Error(`"${key}" is not "<node>.<input>" or a mapped name`)
  return { node: key.slice(0, i), input: key.slice(i + 1) }
}

/** Where a parameter goes: a mapped field name, or `node.input`. */
export function resolveSlot(graph: Graph, mapping: Mapping | null, key: string): Slot & { field?: MappedField } {
  if ((MAPPED_FIELDS as readonly string[]).includes(key)) {
    const slot = mapping?.[key as MappedField]
    if (!slot) throw new Error(`"${key}" is not mapped for this workflow; use "<node>.<input>"`)
    return { ...slot, field: key as MappedField }
  }
  const { node, input } = splitKey(key)
  return { node: findNode(graph, node), input }
}

/** Sets one input. Refuses to replace a link with a value, which would cut the graph. */
export function setInput(graph: Graph, slot: Slot, value: unknown): void {
  const node = graph[slot.node]
  if (!node) throw new Error(`no node "${slot.node}" in the workflow`)
  if (Array.isArray(node.inputs[slot.input]) && !Array.isArray(value)) {
    throw new Error(`${slot.node}.${slot.input} is linked to node ${String((node.inputs[slot.input] as unknown[])[0])}; set that node's input instead`)
  }
  node.inputs[slot.input] = value
}

/** Removes a node and every input that links to it (for an optional input such as a voice reference that was not given). */
export function dropNode(graph: Graph, id: string): void {
  delete graph[id]
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && String(v[0]) === id) delete node.inputs[k]
  }
}

const SEED_INPUTS = new Set(['seed', 'noise_seed'])

/** Gives every literal seed input a fresh value, except the slots in `keep`; returns `node.input -> seed`. */
export function randomizeSeeds(graph: Graph, keep: Set<string>): Record<string, number> {
  const seeds: Record<string, number> = {}
  for (const [id, node] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (!SEED_INPUTS.has(k) || typeof v !== 'number' || keep.has(`${id}.${k}`)) continue
      const seed = randomSeed()
      node.inputs[k] = seed
      seeds[`${id}.${k}`] = seed
    }
  }
  return seeds
}

/** A value for a mapped field: sizes snapped to 16, a language code through the mapping's table. */
export function mappedValue(mapping: Mapping | null, field: MappedField | undefined, value: unknown): unknown {
  if (field === 'width' || field === 'height') return snap16(Number(value))
  if (field === 'language' && typeof value === 'string') return mapping?.languages?.[value] ?? value
  return value
}

/** The nodes, their literal inputs (long strings cut) and links, for `describe_workflow`. */
export function describeGraph(graph: Graph): Array<{ id: string; class_type: string; title?: string; inputs: Record<string, unknown>; links: Record<string, string> }> {
  return Object.entries(graph).map(([id, node]) => {
    const inputs: Record<string, unknown> = {}
    const links: Record<string, string> = {}
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')) links[k] = `${v[0]}:${v[1]}`
      else inputs[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}… (${v.length} chars)` : v
    }
    const title = node._meta?.title && node._meta.title !== node.class_type ? node._meta.title : undefined
    return { id, class_type: node.class_type, ...(title ? { title } : {}), inputs, links }
  })
}
