# comfy-mcp

An MCP server for the local ComfyUI. Claude, the creative hub (`C:\projects\Personal\creative-hub`) or any MCP client can use it to generate images, edit them, cut out backgrounds, and make music and speech. Saved workflows can be run with a parameter map. Inputs and outputs are absolute file paths, and results are paths, never image bytes.

It is plain Node 24 (no Electron). It serves Streamable HTTP on `127.0.0.1:7460/mcp` only, checks Host and Origin, and takes an optional Bearer token. It always runs headless.

## Tools

| Tool | What |
|---|---|
| `status` | ComfyUI version, VRAM/RAM, queue, which engines are ready (model files present), background-removal models, model files per folder, running jobs, the output folder |
| `generate_image` | Text to PNG. Engines `z-image-turbo` (default, 1024²), `qwen-image-2.1-turbo`, `qwen-image-2.1` (1328²), `krea2-turbo`. `prompt, negative, width, height, seed, count, steps, cfg` |
| `edit_image` | Qwen-Image 2.1 edit: `image` / `images` (1-16 absolute paths) + instruction. The size follows the first image unless `width`/`height` are given |
| `remove_background` | BiRefNet through ComfyUI's core `RemoveBackground` node; writes a PNG with alpha |
| `generate_music` | `ace-step-v1` (default), `ace-step-v1-instrumental`, `yue2`, `minimax-music-3`. `tags, lyrics, seconds, seed, steps, format` (mp3 default; flac, opus, wav) |
| `generate_speech` | A mapped TTS workflow (default `chatterbox-multilingual`, 23 languages, no Croatian). `text, language, voice_ref` |
| `list_workflows` | Saved workflows in `workflows/`, extra folders, and ComfyUI's own `user/default/workflows`, each with its format (api/ui) and whether it can run |
| `describe_workflow` | A workflow as an API graph: node ids, classes, titles, literal inputs, links, output nodes, mapping |
| `run_workflow` | Run a saved workflow. `params: {"<node id or title>.<input>": value}` (or mapped names), `files: {"<node>.<input>": "<abs path>"}` (uploaded first). Seeds are randomized unless set or `randomize_seeds: false`. Every saved file is downloaded |
| `wait` | Wait for jobs (default 120 s, max 600) and report state, paths, seeds and errors |
| `cancel` | Remove a job's prompts from the ComfyUI queue, or interrupt the running one |
| `free_memory` | Unload ComfyUI's models and free VRAM |

**Jobs.** Each generation is a background job. A call waits up to `wait` seconds (default 45, `0` returns at once) and returns the paths. If the job is still running, it returns `job_id` instead; then call `wait`. ComfyUI runs one prompt at a time, so jobs queue. Jobs are held in memory, so a restart forgets them (written files stay).

**Outputs.** `out` is an absolute folder (file names are generated: `<kind>_<date>-<time>_<seed>.<ext>`) or an absolute file path. With several files, a file path gets `_1`, `_2`. The extension is whatever ComfyUI produced. `generate_music` takes its format from the `out` extension when `format` is not given. Without `out`, files go to the default folder (`--out`). ComfyUI keeps its own copy under `output/comfy-mcp/`.

**Workflows.** A workflow is either an API-format JSON (ComfyUI: Workflow → Export (API)), or a UI-format JSON without subgraphs; the server converts UI workflows using the live `/object_info`. An optional `<name>.map.yaml` next to it names the inputs for `prompt, negative, width, height, seed, steps, reference, text, language, voiceRef` and the `output` node (the same format as VN Studio's `custom:<name>` engines). `generate_speech` needs a mapping with `text`. ComfyUI's template workflows mostly use subgraphs; export those as API first.

## Run

```powershell
yarn install
yarn build
node out/index.js                       # http://127.0.0.1:7460/mcp, outputs in ~/ComfyMCP/output
node out/index.js --port 7460 --comfy http://127.0.0.1:8188 --out C:\projects\Personal\creative-hub\output\comfy
```

| Flag | Env | Default |
|---|---|---|
| `--port` | `COMFY_MCP_PORT` | 7460 |
| `--comfy` | `COMFY_URL` | `http://127.0.0.1:8188` |
| `--out` | `COMFY_MCP_OUT` | `~/ComfyMCP/output` |
| `--workflows` (`;`-separated) | `COMFY_MCP_WORKFLOWS` | none (always searched: `workflows/`, then ComfyUI's user workflows) |
| `--files` (JSON) | `COMFY_MCP_FILES` | the file names in `src/comfy/graphs.ts`, e.g. `{"zImage":{"unet":"other.safetensors"}}` |
| `--job-timeout` (s) | `COMFY_MCP_JOB_TIMEOUT` | 1800 |
| | `COMFY_MCP_TOKEN` | no auth |

In the creative hub, `pwsh -File scripts\hub.ps1 start comfy-mcp` starts it (after `comfyui`), `hub.ps1 check comfy-mcp` handshakes, and `hub.ps1 call comfy-mcp generate_image '{"prompt":"..."}'` calls a tool. For Claude elsewhere:

```powershell
claude mcp add --transport http comfy-mcp http://127.0.0.1:7460/mcp
```

## Develop

```powershell
yarn typecheck; yarn lint; yarn test     # tests run the MCP server against a fake ComfyUI
yarn dev                                 # tsx src/index.ts
```

`src/comfy/client.ts` is the HTTP client, `graphs.ts` holds the engines, and `workflows.ts` with `ui-to-api.ts` handles saved workflows. They are ported from VN Studio (`visual-novels-orchestrator/src/engine/comfy`), which ported them from `dsh-comfyui`. `src/service.ts` runs the jobs, `src/jobs.ts` tracks them, and `src/mcp/` holds the tools and the HTTP transport (the same as VN Studio's).
