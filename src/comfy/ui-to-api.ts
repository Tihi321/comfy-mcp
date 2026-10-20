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
  inputs?: Array<{ name: string; link?: number | null }>
  widgets_values?: unknown[]
  widgets_values_named?: Record<string, unknown>
}
export interface UiWorkflow {
  nodes: UiNode[]
  links?: Array<unknown[] | { id: number; origin_id: number | string; origin_slot: number }>
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

export function uiToApi(ui: UiWorkflow, schemas: SchemaMap = {}): ConvertResult {
  const nodes = new Map(ui.nodes.map((n) => [n.id, n]))
  const linkById = new Map<number, { node: number | string; slot: number }>()
  for (const link of ui.links ?? []) {
    if (Array.isArray(link)) linkById.set(Number(link[0]), { node: link[1] as number, slot: Number(link[2]) })
    else if (link && typeof link === 'object') linkById.set(link.id, { node: link.origin_id, slot: link.origin_slot })
  }

  const active = (n: UiNode) => n.mode !== 2 && n.mode !== 4
  const isNote = (n: UiNode) => /Note$/i.test(n.type)

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
  const warnings: string[] = []
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
