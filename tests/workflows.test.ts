import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { uiToApi } from '../src/comfy/ui-to-api'
import { buildRemoveBackground, ENGINES, mergeFiles } from '../src/comfy/graphs'
import { dropNode, listWorkflows, loadWorkflow, mappedValue, randomizeSeeds, resolveSlot, resolveWorkflowFile, setInput, splitKey } from '../src/comfy/workflows'

const repoWorkflows = path.resolve(__dirname, '..', 'workflows')
const noSchemas = async () => ({})

describe('engine graphs', () => {
  const files = mergeFiles(undefined)
  it.each(Object.keys(ENGINES))('%s builds a graph with a save node', (id) => {
    const engine = ENGINES[id]!
    const graph = engine.build({ ...engine.defaults, files: files[engine.fileGroup], filenamePrefix: 'x', seed: 1, prompt: 'p', width: 1024, height: 1024, references: engine.acceptsReferences ? ['a.png'] : [], autoLatent: !!engine.acceptsReferences } as never)
    expect(Object.values(graph).some((n) => /^Save/.test(n.class_type))).toBe(true)
  })

  it('remove background joins the inverted mask as alpha', () => {
    const g = buildRemoveBackground({ image: 'in.png', model: 'birefnet.safetensors', filenamePrefix: 'c' })
    expect(g[6]!.inputs.alpha).toEqual(['5', 0])
    expect(g[2]!.inputs.bg_removal_name).toBe('birefnet.safetensors')
  })
})

describe('saved workflows', () => {
  it('loads the bundled chatterbox workflow with its mapping', async () => {
    const file = await resolveWorkflowFile([repoWorkflows], 'chatterbox-multilingual')
    const wf = await loadWorkflow(file, noSchemas)
    expect(wf.format).toBe('api')
    expect(wf.mapping?.text).toEqual({ node: '1', input: 'text' })
    expect(mappedValue(wf.mapping, 'language', 'de')).toBe('German (de)')
  })

  it('resolves mapped names, node ids and titles', async () => {
    const wf = await loadWorkflow(await resolveWorkflowFile([repoWorkflows], 'chatterbox-multilingual'), noSchemas)
    expect(resolveSlot(wf.graph, wf.mapping, 'text')).toMatchObject({ node: '1', input: 'text', field: 'text' })
    expect(resolveSlot(wf.graph, wf.mapping, '1.temperature')).toEqual({ node: '1', input: 'temperature' })
    expect(resolveSlot(wf.graph, wf.mapping, 'LoadAudio.audio')).toEqual({ node: '2', input: 'audio' })
    expect(() => resolveSlot(wf.graph, wf.mapping, 'prompt')).toThrow(/not mapped/)
  })

  it('splits keys at the first dot only', () => {
    expect(splitKey('11.sampling_mode.temperature')).toEqual({ node: '11', input: 'sampling_mode.temperature' })
    expect(() => splitKey('nodot')).toThrow()
  })

  it('refuses to overwrite a link and drops optional inputs with their node', async () => {
    const wf = await loadWorkflow(await resolveWorkflowFile([repoWorkflows], 'chatterbox-multilingual'), noSchemas)
    const g = structuredClone(wf.graph)
    expect(() => setInput(g, { node: '1', input: 'audio_prompt' }, 'x')).toThrow(/linked/)
    dropNode(g, '2')
    expect(g[2]).toBeUndefined()
    expect(g[1]!.inputs.audio_prompt).toBeUndefined()
  })

  it('randomizes literal seeds except the kept ones', () => {
    const g = { 1: { class_type: 'KSampler', inputs: { seed: 5, steps: 3 } }, 2: { class_type: 'RandomNoise', inputs: { noise_seed: 7 } } }
    const seeds = randomizeSeeds(g, new Set(['2.noise_seed']))
    expect(Object.keys(seeds)).toEqual(['1.seed'])
    expect(g[2].inputs.noise_seed).toBe(7)
  })

  it('lists UI workflows with subgraphs without a problem', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'))
    writeFileSync(path.join(dir, 'sub.json'), JSON.stringify({ nodes: [{ id: 1, type: 'abc-123' }], links: [], definitions: { subgraphs: [{ id: 'abc-123', name: 'Inner', nodes: [] }] } }))
    writeFileSync(path.join(dir, 'flat.json'), JSON.stringify({ nodes: [{ id: 1, type: 'SaveImage', inputs: [] }], links: [] }))
    const list = await listWorkflows([dir])
    expect(list.find((w) => w.name === 'sub')).toMatchObject({ format: 'ui' })
    expect(list.find((w) => w.name === 'sub')?.problem).toBeUndefined()
    expect(list.find((w) => w.name === 'flat')).toMatchObject({ format: 'ui', mapped: false })
  })
})

describe('subgraph conversion', () => {
  const schemas = {
    LoadImage: { input: { required: { image: [['a.png']] } } },
    Gen: { input: { required: { image: ['IMAGE'], text: ['STRING'], steps: ['INT'] } } },
    Post: { input: { required: { image: ['IMAGE'], strength: ['FLOAT'] } } },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } }
  }
  const link = (id: number, o: number, os: number, t: number, ts: number) => ({ id, origin_id: o, origin_slot: os, target_id: t, target_slot: ts, type: '*' })
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', widgets_values: ['in.png', 'image'], inputs: [] },
      { id: 2, type: 'save-sub', mode: 0, inputs: [{ name: 'image', link: 10 }], widgets_values: [] },
      { id: 3, type: 'gen-sub', inputs: [{ name: 'image', link: 1 }, { name: 'text', widget: { name: 'text' } }, { name: 'steps', widget: { name: 'steps' } }], widgets_values: ['a cat', 7] },
      { id: 4, type: 'gen-sub', mode: 2, inputs: [], widgets_values: [] },
      { id: 5, type: 'SaveImage', widgets_values: ['out'], inputs: [{ name: 'images', link: 2 }] }
    ],
    links: [[1, 1, 0, 3, 0, 'IMAGE'], [2, 3, 0, 5, 0, 'IMAGE'], [10, 4, 0, 2, 0, 'IMAGE']],
    definitions: {
      subgraphs: [
        {
          id: 'gen-sub',
          name: 'Gen',
          inputs: [{ name: 'image' }, { name: 'text' }, { name: 'steps' }],
          nodes: [
            { id: 30, type: 'Gen', widgets_values: ['own', 1], inputs: [{ name: 'image', link: 1 }, { name: 'text', link: 2 }, { name: 'steps', link: 3 }] },
            { id: 31, type: 'inner-post', inputs: [{ name: 'image', link: 4 }], widgets_values: [] }
          ],
          links: [link(1, -10, 0, 30, 0), link(2, -10, 1, 30, 1), link(3, -10, 2, 30, 2), link(4, 30, 0, 31, 0), link(5, 31, 0, -20, 0)]
        },
        {
          id: 'inner-post',
          name: 'Post',
          inputs: [{ name: 'image' }],
          nodes: [{ id: 12, type: 'Post', widgets_values: [0.5], inputs: [{ name: 'image', link: 1 }] }],
          links: [link(1, -10, 0, 12, 0), link(2, 12, 0, -20, 0)]
        },
        { id: 'save-sub', name: 'S', inputs: [{ name: 'image' }], nodes: [], links: [link(1, -10, 0, -20, 0)] }
      ]
    }
  }

  it('expands instances with literals, links, nesting and muted instances', () => {
    const { prompt, warnings } = uiToApi(workflow, schemas)
    expect(warnings).toEqual([])
    expect(Object.keys(prompt).sort()).toEqual(['1', '3:30', '3:31:12', '5'])
    expect(prompt['3:30']!.inputs).toEqual({ image: ['1', 0], text: 'a cat', steps: 7 })
    expect(prompt['3:31:12']!.inputs).toEqual({ image: ['3:30', 0], strength: 0.5 })
    expect(prompt['5']!.inputs).toMatchObject({ images: ['3:31:12', 0], filename_prefix: 'out' })
  })

  it('warns about a bypassed instance and unlinks what it fed', () => {
    const wf = structuredClone(workflow)
    wf.nodes[2]!.mode = 4
    const { prompt, warnings } = uiToApi(wf, schemas)
    expect(warnings[0]).toMatch(/bypassed subgraph Gen/)
    expect(prompt['5']!.inputs.images).toBeUndefined()
    expect(prompt['3:30']).toBeUndefined()
  })
})
