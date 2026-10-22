import { describe, expect, it } from 'vitest'
import { ENGINES, mergeFiles } from '../src/comfy/graphs'

describe('qwen-image-2.1-turbo-edit graph', () => {
  const engine = ENGINES['qwen-image-2.1-turbo-edit']!
  const files = mergeFiles(undefined)
  const build = (extra: Record<string, unknown>) =>
    engine.build({ ...engine.defaults, files: files.qwen, filenamePrefix: 'x', seed: 7, prompt: 'p', references: ['a.png', 'b.png'], ...extra } as never)
  const ofClass = (graph: ReturnType<typeof build>, cls: string) => Object.values(graph).filter((n) => n.class_type === cls)

  it('samples with ManualSigmas and SamplerCustomAdvanced, not KSampler', () => {
    const graph = build({ autoLatent: true })
    expect(ofClass(graph, 'KSampler')).toHaveLength(0)
    const sampler = ofClass(graph, 'SamplerCustomAdvanced')[0]!
    const sigmas = graph[(sampler.inputs.sigmas as [string, number])[0]]!
    expect(sigmas.class_type).toBe('ManualSigmas')
    expect(String(sigmas.inputs.sigmas).split(',')).toHaveLength(9)
    expect(ofClass(graph, 'RandomNoise')[0]!.inputs.noise_seed).toBe(7)
  })

  it('uses the turbo UNet and splices every reference into the encoder', () => {
    const graph = build({ autoLatent: true })
    expect(ofClass(graph, 'UNETLoader')[0]!.inputs.unet_name).toBe(files.qwen.turboUnet)
    expect(ofClass(graph, 'LoadImage')).toHaveLength(2)
    const encoder = ofClass(graph, 'TextEncodeQwenImage21')[0]!
    expect(encoder.inputs['images.image_1']).toBeDefined()
    expect(encoder.inputs['images.image_2']).toBeDefined()
  })

  it('takes the latent from the encoder (slot 2) when autoLatent', () => {
    const graph = build({ autoLatent: true })
    const encoderId = Object.keys(graph).find((id) => graph[id]!.class_type === 'TextEncodeQwenImage21')!
    expect(ofClass(graph, 'SamplerCustomAdvanced')[0]!.inputs.latent_image).toEqual([encoderId, 2])
    expect(ofClass(graph, 'EmptyLatentImage')).toHaveLength(0)
  })

  it('takes the latent from EmptyLatentImage when width and height are given', () => {
    const graph = build({ autoLatent: false, width: 1024, height: 768 })
    const emptyId = Object.keys(graph).find((id) => graph[id]!.class_type === 'EmptyLatentImage')!
    expect(graph[emptyId]!.inputs).toMatchObject({ width: 1024, height: 768 })
    expect(ofClass(graph, 'SamplerCustomAdvanced')[0]!.inputs.latent_image).toEqual([emptyId, 0])
  })
})
