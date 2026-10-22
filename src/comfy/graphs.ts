/**
 * ComfyUI workflow graphs (API format), ported from VN Studio `src/engine/comfy/graphs.ts` (itself from dsh-comfyui
 * `lib/graphs.js`).
 *
 * Every graph was transcribed from the first-party workflow templates that ship with ComfyUI and verified against a
 * live ComfyUI. Node ids are stable and readable.
 *
 * Engines:
 *   image  qwen-image-2.1            Qwen-Image 2.1 text-to-image
 *   image  qwen-image-2.1-turbo      the same graph on the turbo UNet
 *   image  qwen-image-2.1-edit       Qwen-Image 2.1 image edit; reference images are spliced in by the text encoder
 *   image  qwen-image-2.1-turbo-edit turbo UNet image edit (ManualSigmas + SamplerCustomAdvanced, 8 steps)
 *   image  z-image-turbo             Z-Image-Turbo
 *   image  krea2-turbo               Krea 2 Turbo
 *   audio  ace-step-v1               ACE-Step v1 song (tags + lyrics)
 *   audio  ace-step-v1-instrumental  ACE-Step v1, instrumental (tags only)
 *   audio  yue2                      YuE2 text-to-music
 *   audio  minimax-music-3           MiniMax Music 3
 *
 * Saved workflows (`workflows.ts`) are not in this registry.
 */

export interface GraphNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}
/** An API-format prompt: node id -> node. */
export type Graph = Record<string, GraphNode>

/** Model files the engines default to. Overridable with `--files <json>` (see `src/config.ts`). */
export const DEFAULT_FILES = {
  qwen: {
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    turboUnet: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_int8_convrot.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    peClipT2i: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
    peClipI2i: 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'
  },
  zImage: {
    unet: 'z_image_turbo_bf16.safetensors',
    clip: 'qwen_3_4b.safetensors',
    vae: 'ae.safetensors'
  },
  krea2: {
    unet: 'krea2_turbo_fp8_scaled.safetensors',
    clip: 'qwen3vl_4b_fp8_scaled.safetensors',
    vae: 'qwen_image_vae.safetensors'
  },
  audio: {
    aceCheckpoint: 'ace_step_v1_3.5b.safetensors',
    yue2Checkpoint: 'yue2_3b_int8_convrot.safetensors',
    minimaxUnet: 'minimax_music3_dit_fp16.safetensors',
    minimaxClip: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors',
    minimaxVae: 'minimax_music3_dav.safetensors'
  }
} as const

export type FileGroups = {
  qwen: Record<string, string>
  zImage: Record<string, string>
  krea2: Record<string, string>
  audio: Record<string, string>
}

/** Named output sizes, in pixels. */
export const DEFAULT_SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1328, height: 1328 },
  landscape: { width: 1664, height: 928 },
  portrait: { width: 928, height: 1664 }
}

/** Snaps a dimension to a multiple of 16 (minimum 64). */
export function snap16(n: number): number {
  const v = Math.round(Number(n) / 16) * 16
  return Number.isFinite(v) && v >= 64 ? v : 64
}

/** `{width,height}` for a size name, tolerating unknown names. Multiples of 16. */
export function sizeOf(name: string | undefined, sizes: Record<string, { width: number; height: number }> = DEFAULT_SIZES): { width: number; height: number } {
  const chosen = (name ? sizes[name] : undefined) ?? sizes.square ?? DEFAULT_SIZES.square!
  return { width: snap16(chosen.width || 1024), height: snap16(chosen.height || 1024) }
}

/** A fresh random 32-bit seed. */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
}

/** Everything a graph builder may read. Builders pick what they need. */
export interface BuildOpts {
  files: Record<string, string>
  filenamePrefix: string
  seed: number
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  denoise?: number
  shift?: number
  width?: number
  height?: number
  prompt?: string
  negativePrompt?: string
  /** ComfyUI input filenames for image edit, in order. */
  references?: string[]
  autoLatent?: boolean
  resolution?: number
  refinePrompt?: boolean
  thinking?: boolean
  peClipType?: string
  // audio
  tags?: string
  style?: string
  caption?: string
  lyrics?: string
  seconds?: number
  format?: string
  quality?: string
  lyricsStrength?: number
  mode?: string
  temperature?: number
  topP?: number
  topK?: number
  repetitionPenalty?: number
  abc?: string
  cfgScale?: number
}

/** The turbo edit template's 8-step sigma schedule. */
const TURBO_EDIT_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'

type Ref = [string, number]
const ref = (id: number | string, slot = 0): Ref => [String(id), slot]

/** Qwen-Image 2.1 text-to-image, and image edit when `references` are supplied. */
export function buildQwenImage(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler, denoise = 1 } = o
  const graph: Graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.unet, weight_dtype: 'default' } },
    2: { class_type: 'QwenImage21Cache', inputs: { model: ref(1), device: 'auto', dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: files.clip, type: 'qwen_image', device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: files.vae } }
  }

  let promptSource: unknown = o.prompt ?? ''
  if (o.refinePrompt && files.peClip) {
    graph[10] = { class_type: 'CLIPLoader', inputs: { clip_name: files.peClip, type: o.peClipType ?? 'stable_diffusion', device: 'default' } }
    graph[11] = {
      class_type: 'TextGenerate',
      inputs: {
        clip: ref(10),
        prompt: o.prompt ?? '',
        max_length: 4096,
        sampling_mode: 'on',
        'sampling_mode.temperature': 1,
        'sampling_mode.top_k': 20,
        'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0,
        'sampling_mode.repetition_penalty': 1,
        'sampling_mode.seed': seed,
        thinking: o.thinking ?? false,
        use_default_template: true,
        mtp: 'auto'
      }
    }
    promptSource = ref(11)
  }

  const encoderInputs: Record<string, unknown> = {
    clip: ref(3),
    vae: ref(4),
    prompt: promptSource,
    negative_prompt: o.negativePrompt ?? '',
    resolution: o.resolution ?? 1024
  }
  const references = o.references ?? []
  references.forEach((filename, index) => {
    const id = 20 + index
    graph[id] = { class_type: 'LoadImage', inputs: { image: filename } }
    encoderInputs[`images.image_${index + 1}`] = ref(id)
  })
  graph[5] = { class_type: 'TextEncodeQwenImage21', inputs: encoderInputs }

  const sampling = { model: ref(2), seed, steps, cfg, sampler_name: sampler, scheduler, denoise, positive: ref(5), negative: ref(5, 1) }
  if (o.autoLatent && references.length > 0) {
    // The encoder derives a latent matching the reference image's own resolution.
    graph[7] = { class_type: 'KSampler', inputs: { ...sampling, latent_image: ref(5, 2) } }
  } else {
    graph[6] = { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } }
    graph[7] = { class_type: 'KSampler', inputs: { ...sampling, latent_image: ref(6) } }
  }
  graph[8] = { class_type: 'VAEDecode', inputs: { samples: ref(7), vae: ref(4) } }
  graph[9] = { class_type: 'SaveImage', inputs: { images: ref(8), filename_prefix: o.filenamePrefix } }
  return graph
}

/**
 * Qwen-Image 2.1 Turbo image edit. The template samples with `ManualSigmas` + `SamplerCustomAdvanced` (no KSampler); the
 * sigma list sets the step count. Deviation: the template's resolution 0 (no resize) is 1024 here, like the other edit
 * engine, so a large input cannot produce a huge latent.
 */
export function buildQwenImageTurboEdit(o: BuildOpts & { sigmas?: string }): Graph {
  const { files, seed, sampler } = o
  const graph: Graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.turboUnet ?? files.unet, weight_dtype: 'default' } },
    2: { class_type: 'QwenImage21Cache', inputs: { model: ref(1), device: 'auto', dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: files.clip, type: 'qwen_image', device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: files.vae } }
  }
  const encoderInputs: Record<string, unknown> = {
    clip: ref(3),
    vae: ref(4),
    prompt: o.prompt ?? '',
    negative_prompt: o.negativePrompt ?? '',
    resolution: o.resolution ?? 1024
  }
  const references = o.references ?? []
  references.forEach((filename, index) => {
    const id = 20 + index
    graph[id] = { class_type: 'LoadImage', inputs: { image: filename } }
    encoderInputs[`images.image_${index + 1}`] = ref(id)
  })
  graph[5] = { class_type: 'TextEncodeQwenImage21', inputs: encoderInputs }
  graph[6] = { class_type: 'ManualSigmas', inputs: { sigmas: o.sigmas ?? TURBO_EDIT_SIGMAS } }
  graph[7] = { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler ?? 'euler' } }
  graph[8] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  graph[9] = { class_type: 'CFGGuider', inputs: { model: ref(2), positive: ref(5), negative: ref(5, 1), cfg: o.cfg ?? 1 } }
  let latent: Ref
  if (o.autoLatent && references.length > 0) {
    // The encoder derives a latent matching the reference image's own resolution.
    latent = ref(5, 2)
  } else {
    graph[10] = { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } }
    latent = ref(10)
  }
  graph[11] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ref(8), guider: ref(9), sampler: ref(7), sigmas: ref(6), latent_image: latent } }
  graph[12] = { class_type: 'VAEDecode', inputs: { samples: ref(11), vae: ref(4) } }
  graph[13] = { class_type: 'SaveImage', inputs: { images: ref(12), filename_prefix: o.filenamePrefix } }
  return graph
}

/** Z-Image-Turbo: lumina2 text encoder, AuraFlow shift, 8-step res_multistep. */
export function buildZImage(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler, denoise = 1 } = o
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.unet, weight_dtype: 'default' } },
    2: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ref(1), shift: o.shift ?? 3 } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: files.clip, type: 'lumina2', device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ref(3), text: o.prompt ?? '' } },
    // Distilled, cfg 1: the template zeroes the negative conditioning.
    6: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ref(5) } },
    7: { class_type: 'EmptySD3LatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      inputs: { model: ref(2), seed, steps, cfg, sampler_name: sampler, scheduler, denoise, positive: ref(5), negative: ref(6), latent_image: ref(7) }
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ref(8), vae: ref(4) } },
    10: { class_type: 'SaveImage', inputs: { images: ref(9), filename_prefix: o.filenamePrefix } }
  }
}

/** Krea 2 Turbo. */
export function buildKrea2(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler, denoise = 1 } = o
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: files.clip, type: 'krea2', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ref(2), text: o.prompt ?? '' } },
    5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ref(4) } },
    6: { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } },
    7: {
      class_type: 'KSampler',
      inputs: { model: ref(1), seed, steps, cfg, sampler_name: sampler, scheduler, denoise, positive: ref(4), negative: ref(5), latent_image: ref(6) }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ref(7), vae: ref(3) } },
    9: { class_type: 'SaveImage', inputs: { images: ref(8), filename_prefix: o.filenamePrefix } }
  }
}

/**
 * The audio save node. `wav` uses the plain `SaveAudio` node; the compressed formats go through `SaveAudioAdvanced`,
 * which takes a per-format quality.
 */
function saveAudioNode(format: string | undefined, quality: string | undefined, sourceId: number, filenamePrefix: string): GraphNode {
  const choice = String(format ?? 'flac').toLowerCase()
  if (choice === 'wav') return { class_type: 'SaveAudio', inputs: { audio: ref(sourceId), filename_prefix: filenamePrefix } }
  const inputs: Record<string, unknown> = { audio: ref(sourceId), filename_prefix: filenamePrefix, format: choice }
  // the format is a dynamic combo: its sub-input is named `format.quality` in the API graph (a plain `quality` is "missing")
  if (choice === 'mp3') inputs['format.quality'] = quality ?? 'V0'
  if (choice === 'opus') inputs['format.quality'] = quality ?? '128k'
  return { class_type: 'SaveAudioAdvanced', inputs }
}

/** ACE-Step v1: tags + lyrics. Keeps the template's shift and Reinhard tonemap CFG operation. */
export function buildAceStep(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler } = o
  const graph: Graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: files.aceCheckpoint } },
    2: { class_type: 'TextEncodeAceStepAudio', inputs: { clip: ref(1, 1), tags: o.tags ?? o.prompt ?? '', lyrics: o.lyrics ?? '', lyrics_strength: o.lyricsStrength ?? 0.99 } },
    3: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ref(2) } },
    4: { class_type: 'EmptyAceStepLatentAudio', inputs: { seconds: o.seconds ?? 60, batch_size: 1 } },
    5: { class_type: 'ModelSamplingSD3', inputs: { model: ref(1), shift: o.shift ?? 5 } },
    6: { class_type: 'LatentOperationTonemapReinhard', inputs: { multiplier: 1 } },
    7: { class_type: 'LatentApplyOperationCFG', inputs: { model: ref(5), operation: ref(6) } },
    8: {
      class_type: 'KSampler',
      inputs: { model: ref(7), seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, positive: ref(2), negative: ref(3), latent_image: ref(4) }
    },
    9: { class_type: 'VAEDecodeAudio', inputs: { samples: ref(8), vae: ref(1, 2) } }
  }
  graph[10] = saveAudioNode(o.format, o.quality, 9, o.filenamePrefix)
  return graph
}

/** YuE2: style + lyrics. */
export function buildYue2(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler } = o
  const graph: Graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: files.yue2Checkpoint } },
    2: {
      class_type: 'YuE2GenerateMusic',
      inputs: {
        clip: ref(1, 1), style: o.style ?? o.prompt ?? '', lyrics: o.lyrics ?? '', abc: o.abc ?? '', seed, mode: o.mode ?? 'full',
        max_duration: o.seconds ?? 60, temperature: o.temperature ?? 1, top_p: o.topP ?? 0.95, top_k: o.topK ?? 100, repetition_penalty: o.repetitionPenalty ?? 1.2
      }
    },
    3: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ref(2) } },
    4: { class_type: 'EmptyYuE2LatentAudio', inputs: { seconds: ref(2, 1), batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: { model: ref(1), seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, positive: ref(2), negative: ref(3), latent_image: ref(4) }
    },
    6: { class_type: 'VAEDecodeAudio', inputs: { samples: ref(5), vae: ref(1, 2) } }
  }
  graph[7] = saveAudioNode(o.format, o.quality, 6, o.filenamePrefix)
  return graph
}

/** MiniMax Music 3: caption + lyrics. */
export function buildMiniMaxMusic(o: BuildOpts): Graph {
  const { files, seed, steps, cfg, sampler, scheduler } = o
  const graph: Graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.minimaxUnet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: files.minimaxClip, type: 'minimax', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: files.minimaxVae } },
    4: {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: { clip: ref(2), caption: o.caption ?? o.prompt ?? '', lyrics: o.lyrics ?? '', seed, max_duration: o.seconds ?? 60, cfg_scale: o.cfgScale ?? 1.7, top_k: o.topK ?? 50 }
    },
    5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ref(4) } },
    6: { class_type: 'EmptyMiniMaxMusic3LatentAudio', inputs: { seconds: ref(4, 1), batch_size: 1 } },
    7: {
      class_type: 'KSampler',
      inputs: { model: ref(1), seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, positive: ref(4), negative: ref(5), latent_image: ref(6) }
    },
    8: { class_type: 'VAEDecodeAudio', inputs: { samples: ref(7), vae: ref(3) } }
  }
  graph[9] = saveAudioNode(o.format, o.quality, 8, o.filenamePrefix)
  return graph
}

/**
 * Background removal with ComfyUI's core nodes: `LoadBackgroundRemovalModel` + `RemoveBackground` give a mask, which
 * `JoinImageWithAlpha` (it inverts the mask it is given) turns into the image's alpha channel.
 */
export function buildRemoveBackground(o: { image: string; model: string; filenamePrefix: string; invertMask?: boolean }): Graph {
  const maskSource = o.invertMask === false ? ref(3) : ref(5)
  const graph: Graph = {
    1: { class_type: 'LoadImage', inputs: { image: o.image } },
    2: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: o.model } },
    3: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ref(2), image: ref(1) } },
    5: { class_type: 'InvertMask', inputs: { mask: ref(3) } },
    6: { class_type: 'JoinImageWithAlpha', inputs: { image: ref(1), alpha: maskSource } },
    7: { class_type: 'SaveImage', inputs: { images: ref(6), filename_prefix: o.filenamePrefix } }
  }
  if (o.invertMask === false) delete graph[5]
  return graph
}

export type EngineKind = 'image' | 'audio'

export interface EngineDef {
  kind: EngineKind
  label: string
  /** Which file group of the config this engine reads. */
  fileGroup: keyof FileGroups
  /** Files (keys of the group) that must exist for the engine to be ready, with their model folder. */
  requires: Array<[key: string, folder: string]>
  build: (opts: BuildOpts) => Graph
  defaults: { steps: number; cfg: number; sampler: string; scheduler: string; denoise?: number; shift?: number; resolution?: number; seconds?: number; [k: string]: unknown }
  /** True when the engine takes reference images (image edit). */
  acceptsReferences?: boolean
  /** Image engines: the size used when the caller gives none (the model's native square). */
  size?: { width: number; height: number }
  /** True when the graph encodes a negative prompt (the turbo templates zero it instead). */
  usesNegative?: boolean
}

const QWEN_REQ: EngineDef['requires'] = [['unet', 'diffusion_models'], ['clip', 'text_encoders'], ['vae', 'vae']]
const QWEN_SIZE = { width: 1328, height: 1328 }
const SQUARE_1K = { width: 1024, height: 1024 }
const ACE_DEFAULTS = { steps: 50, cfg: 5, sampler: 'euler', scheduler: 'simple', shift: 5, lyricsStrength: 0.99, seconds: 60 }

/** Every built-in engine, with the defaults its template shipped. */
export const ENGINES: Record<string, EngineDef> = {
  'qwen-image-2.1': {
    kind: 'image', label: 'Qwen-Image 2.1 (text to image)', fileGroup: 'qwen', requires: QWEN_REQ, size: QWEN_SIZE, usesNegative: true,
    build: (o) => buildQwenImage({ ...o, files: { ...o.files, peClip: o.files.peClipT2i ?? '' } }),
    defaults: { steps: 25, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1, resolution: 1024 }
  },
  'qwen-image-2.1-turbo': {
    kind: 'image', label: 'Qwen-Image 2.1 Turbo (text to image)', fileGroup: 'qwen', requires: [['turboUnet', 'diffusion_models'], ['clip', 'text_encoders'], ['vae', 'vae']], size: QWEN_SIZE, usesNegative: true,
    build: (o) => buildQwenImage({ ...o, files: { ...o.files, unet: o.files.turboUnet ?? o.files.unet!, peClip: o.files.peClipT2i ?? '' } }),
    defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1, resolution: 1024 }
  },
  'qwen-image-2.1-edit': {
    kind: 'image', label: 'Qwen-Image 2.1 (image edit)', fileGroup: 'qwen', requires: QWEN_REQ, acceptsReferences: true, size: QWEN_SIZE, usesNegative: true,
    build: (o) => buildQwenImage({ ...o, peClipType: 'qwen_image', files: { ...o.files, peClip: o.files.peClipI2i ?? '' } }),
    defaults: { steps: 25, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1, resolution: 1024 }
  },
  'qwen-image-2.1-turbo-edit': {
    kind: 'image', label: 'Qwen-Image 2.1 Turbo (image edit)', fileGroup: 'qwen', requires: [['turboUnet', 'diffusion_models'], ['clip', 'text_encoders'], ['vae', 'vae']], acceptsReferences: true, size: QWEN_SIZE,
    build: buildQwenImageTurboEdit,
    defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', resolution: 1024, sigmas: TURBO_EDIT_SIGMAS }
  },
  'z-image-turbo': {
    kind: 'image', label: 'Z-Image Turbo (text to image)', fileGroup: 'zImage', requires: [['unet', 'diffusion_models'], ['clip', 'text_encoders'], ['vae', 'vae']], size: SQUARE_1K,
    build: buildZImage,
    defaults: { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple', denoise: 1, shift: 3 }
  },
  'krea2-turbo': {
    kind: 'image', label: 'Krea 2 Turbo (text to image)', fileGroup: 'krea2', requires: [['unet', 'diffusion_models'], ['clip', 'text_encoders'], ['vae', 'vae']], size: SQUARE_1K,
    build: buildKrea2,
    defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1, shift: 1.15 }
  },
  'ace-step-v1': {
    kind: 'audio', label: 'ACE-Step v1 (song: tags + lyrics)', fileGroup: 'audio', requires: [['aceCheckpoint', 'checkpoints']],
    build: buildAceStep, defaults: { ...ACE_DEFAULTS }
  },
  'ace-step-v1-instrumental': {
    kind: 'audio', label: 'ACE-Step v1 (instrumental)', fileGroup: 'audio', requires: [['aceCheckpoint', 'checkpoints']],
    build: (o) => buildAceStep({ ...o, lyrics: '' }), defaults: { ...ACE_DEFAULTS }
  },
  yue2: {
    kind: 'audio', label: 'YuE2 (text to music)', fileGroup: 'audio', requires: [['yue2Checkpoint', 'checkpoints']],
    build: buildYue2,
    defaults: { steps: 32, cfg: 1, sampler: 'dpm_2', scheduler: 'sgm_uniform', seconds: 60, mode: 'full', temperature: 1, topP: 0.95, topK: 100, repetitionPenalty: 1.2 }
  },
  'minimax-music-3': {
    kind: 'audio', label: 'MiniMax Music 3 (caption + lyrics)', fileGroup: 'audio',
    requires: [['minimaxUnet', 'diffusion_models'], ['minimaxClip', 'text_encoders'], ['minimaxVae', 'vae']],
    build: buildMiniMaxMusic,
    defaults: { steps: 30, cfg: 1.7, sampler: 'euler', scheduler: 'simple', seconds: 60, cfgScale: 1.7, topK: 50 }
  }
}

/** Engine ids of one kind, in registry order. */
export function enginesOfKind(kind: EngineKind): string[] {
  return Object.entries(ENGINES).filter(([, e]) => e.kind === kind).map(([id]) => id)
}

/** Default file groups merged with the user's overrides. */
export function mergeFiles(overrides: Partial<Record<keyof FileGroups, Record<string, string>>> | undefined): FileGroups {
  return {
    qwen: { ...DEFAULT_FILES.qwen, ...overrides?.qwen },
    zImage: { ...DEFAULT_FILES.zImage, ...overrides?.zImage },
    krea2: { ...DEFAULT_FILES.krea2, ...overrides?.krea2 },
    audio: { ...DEFAULT_FILES.audio, ...overrides?.audio }
  }
}
