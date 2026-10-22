# CMC-04: Qwen-Image 2.1 Turbo edit engine

Branch: `CMC-03_roadmap-items` (shared by CMC-03..CMC-06, one commit per ticket).

## Goal

`edit_image` gets an `engine` argument: `qwen-image-2.1-edit` (default, unchanged) or the new `qwen-image-2.1-turbo-edit`. The turbo template does not use KSampler; it samples with `ManualSigmas` + `SamplerCustomAdvanced`, so it needs its own graph builder.

## The template graph (transcribed from `image_qwen_image_2_1_turbo_image_edit.json`, subgraph "Image Edit (Qwen Image 2.1 Turbo)")

| id (template) | class | inputs |
|---|---|---|
| 451 | UNETLoader | unet_name = turboUnet (`qwen_image_2.1_turbo_int8_convrot.safetensors`), weight_dtype default |
| 469 | QwenImage21Cache | model ← 451, device `auto`, dtype `default` |
| 453 | CLIPLoader | clip_name = clip (`qwen3vl_8b_int8_convrot.safetensors`), type `qwen_image`, device `default` |
| 454 | VAELoader | vae |
| 474 | TextEncodeQwenImage21 | clip ← 453, vae ← 454, prompt, negative_prompt `""`, resolution, `images.image_N` ← LoadImage |
| 456 | EmptyLatentImage | width, height, batch 1 (only when width/height are given) |
| 502 | ManualSigmas | sigmas `"1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"` (8 steps) |
| 503 | KSamplerSelect | sampler_name `euler` |
| 504 | RandomNoise | noise_seed = seed |
| 507 | CFGGuider | model ← 469, positive ← 474:0, negative ← 474:1, cfg 1 |
| 505 | SamplerCustomAdvanced | noise ← 504, guider ← 507, sampler ← 503, sigmas ← 502, latent_image ← 474:2 (auto size) or 456 |
| 457 | VAEDecode | samples ← 505:0, vae ← 454 |
| — | SaveImage | images ← 457, filename_prefix |

The template's optional prompt enhancer (TextGenerate + switch) is off by default; leave it out (the existing edit engine supports it via `refinePrompt` but the tool never sets it).

Resolution: the template sets 0 (no resize beyond a multiple of 32). Use **1024** like the existing `qwen-image-2.1-edit` engine so a large input image cannot produce a huge latent; record this deviation in the code comment.

## Steps

- [x] `src/comfy/graphs.ts`: `buildQwenImageTurboEdit(o: BuildOpts)` following the table (readable stable node ids like the other builders; reference images as `LoadImage` nodes 20+, same as `buildQwenImage`). `sigmas` and `sampler` come from engine defaults so they can be overridden. Engine entry `qwen-image-2.1-turbo-edit`: kind image, fileGroup qwen, requires `turboUnet`/`clip`/`vae`, `acceptsReferences: true`, size QWEN_SIZE, defaults `{ steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', resolution: 1024, sigmas: '<the string>' }`. Update the engine list in the file header comment.
- [x] `src/service.ts` `editImage`: take `engine?: string` (default `qwen-image-2.1-edit`); validate it is an image engine with `acceptsReferences` (error lists the choices). For the turbo engine `steps` is fixed by the sigma schedule: if the caller passes `steps`, add `info.note` that turbo edit uses its fixed 8-step schedule and ignores steps. `info.engine` and the job summary use the chosen id.
- [x] `src/mcp/tools.ts` `edit_image`: `engine: z.enum(<image engines with acceptsReferences>)`, description mentions both engines (turbo: 8 steps, much faster). `generate_image` keeps excluding reference engines.
- [x] Tests: the existing `it.each(Object.keys(ENGINES))` test covers the build; add a focused test in a **new file** `tests/graphs.test.ts` that the turbo edit graph has ManualSigmas → SamplerCustomAdvanced, no KSampler, uses the turbo UNet, links `latent_image` to the encoder's slot 2 when `autoLatent`, and to EmptyLatentImage when width/height are given. Also a server test (fake ComfyUI) is optional.
- [x] Live check against the running ComfyUI: run `editImage({ engine: 'qwen-image-2.1-turbo-edit', images: [<a local PNG>], prompt: 'make it night' })` through a small `tsx` script under `.claude/temp/` (or the MCP server on a spare port) and confirm a PNG is written. Use any PNG under `C:\projects\Personal\creative-hub\output\comfy` or ComfyUI's `input` folder.

## Acceptance

- `yarn typecheck`, `yarn lint`, `yarn test` pass.
- `edit_image` with `engine: "qwen-image-2.1-turbo-edit"` produces an edited PNG on the live ComfyUI; the default engine is unchanged.
- `status` lists the new engine with its readiness.

## Not in scope

README / ROADMAP edits (orchestrator).

## Results

- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 3 files, 30 tests passed (includes new `tests/graphs.test.ts`, 4 tests).
- Live check (ComfyUI 0.42.0): `editImage({ engine: 'qwen-image-2.1-turbo-edit', ... steps: 20 })` on `creative-hub/output/comfy/image_20261020-110939_4242.png` finished in 65.2 s; output `C:\projects\Personal\comfy-mcp\.claude\temp\cmc04-out\edit_20261022-122714_580022382.png` (1,344,733 bytes). The steps note was emitted as designed.
- Deviations: none (resolution 1024 instead of the template's 0, as planned; `sigmas` passed via `engine.defaults`, builder takes `BuildOpts & { sigmas?: string }`).
