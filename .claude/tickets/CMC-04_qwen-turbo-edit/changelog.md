# Changelog

## 2026-10-22 — CMC-04: Qwen-Image 2.1 Turbo edit engine

New `qwen-image-2.1-turbo-edit` engine for `edit_image`; a live edit took 65 s.

**Repo** `comfy-mcp`, branch `CMC-03_roadmap-items`, commit `96fd7ee`.

| File | Change |
|---|---|
| `src/comfy/graphs.ts` | Adds `buildQwenImageTurboEdit` and `TURBO_EDIT_SIGMAS`. The builder chains UNETLoader → QwenImage21Cache, TextEncodeQwenImage21 with the reference LoadImages, ManualSigmas, KSamplerSelect, RandomNoise, CFGGuider, SamplerCustomAdvanced, VAEDecode and SaveImage. The latent comes from encoder slot 2 (auto size) or from EmptyLatentImage. Registers engine `qwen-image-2.1-turbo-edit`, which requires the turbo UNet, clip and vae. |
| `src/service.ts` | `editImage` takes `engine` (default `qwen-image-2.1-edit`) and validates it. Passing `steps` to an engine with a sigma schedule adds a note that `steps` is ignored. |
| `src/mcp/tools.ts` | `edit_image` gets the `engine` enum (image engines that accept references). Description and `steps` text updated. |
| `tests/graphs.test.ts` | New file, 4 tests. They check the turbo graph shape and both latent sources. |
| `README.md`, `ROADMAP.md` | `edit_image` row updated; roadmap item ticked. |

**Deviations:** resolution is 1024 instead of the template's 0, so a large input cannot produce a huge latent (planned and noted in a code comment). The prompt enhancer was left out because the template has it off by default.

**Verification**
- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 30 passed.
- Live, on ComfyUI 0.42.0: a turbo edit of `creative-hub/output/comfy/image_20261020-110939_4242.png` ("make it a moonlit night scene") finished in 65.2 s. The output PNG is 1.3 MB; reviewed visually, the subject and composition are kept and it is now a night scene.
- Not run: a fake-ComfyUI server test for `edit_image` with `engine`; the `status` readiness listing for the new engine was not checked live.

**Commit status:** committed locally (`96fd7ee`), not pushed.
