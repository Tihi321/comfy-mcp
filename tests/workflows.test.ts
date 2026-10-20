import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

  it('flags UI workflows that use subgraphs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'))
    writeFileSync(path.join(dir, 'sub.json'), JSON.stringify({ nodes: [{ id: 1, type: 'abc-123' }], links: [], definitions: { subgraphs: [{ id: 'abc-123', name: 'Inner' }] } }))
    writeFileSync(path.join(dir, 'flat.json'), JSON.stringify({ nodes: [{ id: 1, type: 'SaveImage', inputs: [] }], links: [] }))
    const list = await listWorkflows([dir])
    expect(list.find((w) => w.name === 'sub')?.problem).toMatch(/subgraphs/)
    expect(list.find((w) => w.name === 'flat')).toMatchObject({ format: 'ui', mapped: false })
    expect(list.find((w) => w.name === 'flat')?.problem).toBeUndefined()
  })
})
