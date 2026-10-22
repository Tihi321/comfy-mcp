import type { Graph } from './graphs'

/**
 * Converts a ComfyUI UI-format workflow (the `.json` the editor saves) into an API-format prompt, ported from
 * DSH `.tools/ui-to-api.mjs`. Reroute and PrimitiveNode are inlined, muted/bypassed nodes and notes are dropped, and
 * widget values come from the workflow's own `widgets_values_named` when present, else from the node schema's order
 * (`/object_info`).
 */

interface UiNode {
  id: number | string
  type: string
  title?: string
  mode?: number
  inputs?: Array<{ name: string; link?: number | null; widget?: unknown }>
  widgets_values?: unknown[]
  widgets_values_named?: Record<string, unknown>
}
interface UiLink {
  id: number
  origin_id: number | string
  origin_slot: number
  target_id?: number | string
  target_slot?: number
}
interface UiSubgraph {
  id: string
  name?: string
  inputs?: Array<{ name: string }>
  nodes: UiNode[]
  links?: Array<unknown[] | UiLink>
}
export interface UiWorkflow {
  nodes: UiNode[]
  links?: Array<unknown[] | UiLink>
  definitions?: { subgraphs?: UiSubgraph[] }
}

type InputSpec = unknown[]
export interface NodeSchema {
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> }
}
export type SchemaMap = Record<string, NodeSchema>

/** Connection types that can never be a widget value. */
const CONNECTION_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'CONDITIONING', 'AUDIO', 'MASK', 'CONTROL_NET', 'SIGMAS', 'GUIDER', 'SAMPLER',
  'NOISE', 'SAMPLERS', 'UPSCALE_MODEL', 'CLIP_VISION', 'STYLE_MODEL', 'GLIGEN', 'PHOTOMAKER', 'TAESD', 'LUMA_CONCEPTS',
  'COMFY_AUTOGROW_V3', 'BACKGROUND_REMOVAL', 'AUDIO_UI'
])
const PSEUDO_WIDGETS = new Set(['control_after_generate', 'control_after_generate_combo'])

interface Widget {
  name: string
  /** ComfyUI follows this widget with a "control after generate" value in the positional list. */
  controlAfter: boolean
}

/** Widget inputs of a node class in schema order. */
export function widgetsOf(schemas: SchemaMap, classType: string): Widget[] {
  const schema = schemas[classType]
  if (!schema) return []
  const out: Widget[] = []
  for (const group of ['required', 'optional'] as const) {
    for (const [key, spec] of Object.entries(schema.input?.[group] ?? {})) {
      const first = spec?.[0]
      const type = Array.isArray(first) ? 'COMBO' : String(first)
      if (CONNECTION_TYPES.has(type)) continue
      const opts = spec?.[1] as { control_after_generate?: boolean; audio_upload?: boolean; image_upload?: boolean } | undefined
      // An upload helper widget is UI-only, not an input value.
      if (type === 'AUDIOUPLOAD' || type === 'IMAGEUPLOAD') continue
      out.push({ name: key, controlAfter: opts?.control_after_generate === true || key === 'seed' || key === 'noise_seed' })
    }
  }
  return out
}

export interface ConvertResult {
  prompt: Graph
  skipped: string[]
  warnings: string[]
}

const INPUT_ID = -10
const OUTPUT_ID = -20
const MAX_DEPTH = 16

function linkMap(raw: Array<unknown[] | UiLink> | undefined): Map<number, UiLink> {
  const out = new Map<number, UiLink>()
  for (const l of raw ?? []) {
    if (Array.isArray(l)) out.set(Number(l[0]), { id: Number(l[0]), origin_id: l[1] as number, origin_slot: Number(l[2]), target_id: l[3] as number, target_slot: Number(l[4]) })
    else if (l && typeof l === 'object') out.set(l.id, l)
  }
  return out
}

/**
 * Expands subgraph instances into one flat UI workflow. Inner node `30` of instance `57` becomes `57:30` (nested: `57:12:30`).
 * Instance widget values become synthetic PrimitiveNodes (inlined as literals later), outer links are spliced through the
 * subgraph's input/output slots, muted/bypassed instances are dropped.
 */
export function flattenSubgraphs(ui: UiWorkflow): { workflow: UiWorkflow; warnings: string[] } {
  const defs = new Map((ui.definitions?.subgraphs ?? []).map((s) => [s.id, s]))
  const nodes: UiNode[] = []
  const links: UiLink[] = []
  const warnings: string[] = []
  let nextLink = 1
  type Origin = { id: number | string; slot: number }
  type Resolver = (slot: number) => Origin | undefined

  const level = (src: UiNode[], rawLinks: Array<unknown[] | UiLink> | undefined, prefix: string, input: Resolver, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error('subgraphs nested too deep (cycle?)')
    const lm = linkMap(rawLinks)
    const byId = new Map(src.map((n) => [n.id, n]))
    const fid = (id: number | string) => (prefix ? `${prefix}${id}` : id)
    const children = new Map<number | string, { emit: () => void; output: Resolver }>()

    const resolve = (l: UiLink | undefined): Origin | undefined => {
      if (!l) return undefined
      if (l.origin_id === INPUT_ID) return input(l.origin_slot)
      const node = byId.get(l.origin_id)
      if (!node) return undefined
      if (defs.has(node.type)) return children.get(node.id)?.output(l.origin_slot)
      return { id: fid(node.id), slot: l.origin_slot }
    }

    for (const inst of src) {
      const sub = defs.get(inst.type)
      if (!sub) continue
      if (inst.mode === 2 || inst.mode === 4) {
        if (inst.mode === 4) warnings.push(`bypassed subgraph ${sub.name ?? sub.id} (id ${fid(inst.id)}) dropped; bypass pass-through is not supported`)
        continue
      }
      const widgetInputs = (inst.inputs ?? []).filter((i) => i.widget !== undefined)
      const synthetic = new Map<number, Origin>()
      const innerInput: Resolver = (k) => {
        const name = sub.inputs?.[k]?.name
        const inp = (inst.inputs ?? []).find((i) => i.name === name)
        if (!inp) return undefined
        if (inp.link !== null && inp.link !== undefined) return resolve(lm.get(inp.link))
        const at = widgetInputs.indexOf(inp)
        const value = at >= 0 ? (inst.widgets_values ?? [])[at] : undefined
        if (value === undefined) return undefined
        if (!synthetic.has(k)) {
          const id = `${fid(inst.id)}:in:${k}`
          nodes.push({ id, type: 'PrimitiveNode', widgets_values: [value] })
          synthetic.set(k, { id, slot: 0 })
        }
        return synthetic.get(k)
      }
      children.set(inst.id, level(sub.nodes, sub.links, `${fid(inst.id)}:`, innerInput, depth + 1))
    }

    return {
      emit() {
        for (const node of src) {
          if (defs.has(node.type)) {
            children.get(node.id)?.emit()
            continue
          }
          const inputs = node.inputs?.map((i) => {
            const origin = i.link === null || i.link === undefined ? undefined : resolve(lm.get(i.link))
            if (!origin) return { ...i, link: null }
            const id = nextLink++
            links.push({ id, origin_id: origin.id, origin_slot: origin.slot })
            return { ...i, link: id }
          })
          nodes.push({ ...node, id: fid(node.id), ...(inputs ? { inputs } : {}) })
        }
      },
      /** Where the subgraph's output slot `slot` comes from (inside this level). */
      output(slot: number): Origin | undefined {
        for (const l of lm.values()) if (l.target_id === OUTPUT_ID && l.target_slot === slot) return resolve(l)
        return undefined
      }
    }
  }

  level(ui.nodes, ui.links, '', () => undefined, 0).emit()
  return { workflow: { nodes, links }, warnings }
}

export function uiToApi(source: UiWorkflow, schemas: SchemaMap = {}): ConvertResult {
  const flat = source.definitions?.subgraphs?.length ? flattenSubgraphs(source) : undefined
  const ui = flat?.workflow ?? source
  const nodes = new Map(ui.nodes.map((n) => [n.id, n]))
  const linkById = new Map<number, { node: number | string; slot: number }>()
  for (const link of ui.links ?? []) {
    if (Array.isArray(link)) linkById.set(Number(link[0]), { node: link[1] as number, slot: Number(link[2]) })
    else if (link && typeof link === 'object') linkById.set(link.id, { node: link.origin_id, slot: link.origin_slot })
  }

  const active = (n: UiNode) => n.mode !== 2 && n.mode !== 4
  const isNote = (n: UiNode) => /Note$/i.test(n.type) || n.type === 'Label (rgthree)'

  type Source = { literal: unknown } | { node: string } | undefined
  const resolveSource = (nodeId: number | string, depth = 0): Source => {
    if (depth > 8) throw new Error('link cycle while inlining')
    const node = nodes.get(nodeId)
    if (!node) return undefined
    if (node.type === 'Reroute') {
      const incoming = (node.inputs ?? []).find((i) => i.link !== null && i.link !== undefined)
      if (!incoming) return undefined
      const src = linkById.get(incoming.link as number)
      return src ? resolveSource(src.node, depth + 1) : undefined
    }
    if (node.type === 'PrimitiveNode') return { literal: (node.widgets_values ?? [])[0] }
    return { node: String(nodeId) }
  }

  const prompt: Graph = {}
  const skipped: string[] = []
  const warnings: string[] = [...(flat?.warnings ?? [])]
  for (const node of ui.nodes) {
    if (isNote(node) || !active(node) || node.type === 'Reroute' || node.type === 'PrimitiveNode') {
      skipped.push(`${node.id}:${node.type}`)
      continue
    }
    const known = widgetsOf(schemas, node.type)
    const schemaKnown = schemas[node.type] !== undefined
    const inputs: Record<string, unknown> = {}
    const named: Record<string, unknown> = { ...(node.widgets_values_named ?? {}) }
    for (const key of Object.keys(named)) if (PSEUDO_WIDGETS.has(key)) delete named[key]

    if (Object.keys(named).length === 0 && (node.widgets_values ?? []).length > 0) {
      const positional = node.widgets_values ?? []
      if (!schemaKnown) warnings.push(`${node.type} (id ${node.id}): not in /object_info, widget values dropped`)
      let at = 0
      for (const w of known) {
        if (at >= positional.length) break
        named[w.name] = positional[at++]
        if (w.controlAfter && (positional[at] === 'randomize' || positional[at] === 'fixed' || positional[at] === 'increment' || positional[at] === 'decrement')) at++
      }
    }
    for (const [k, v] of Object.entries(named)) {
      // Drop UI-only values (upload buttons) when the schema knows the node.
      if (schemaKnown && !known.some((w) => w.name === k)) continue
      if (v === null && /upload/i.test(k)) continue
      inputs[k] = v
    }

    // Linked inputs win over a widget value of the same name.
    for (const input of node.inputs ?? []) {
      if (input.link === null || input.link === undefined) continue
      const src = linkById.get(input.link)
      if (!src) continue
      const resolved = resolveSource(src.node)
      if (resolved === undefined) continue
      inputs[input.name] = 'literal' in resolved ? resolved.literal : [resolved.node, src.slot]
    }
    prompt[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } }
  }
  return { prompt, skipped, warnings }
}
