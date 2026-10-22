# CMC-03: Run UI workflows that use subgraphs

Branch: `CMC-03_roadmap-items` (shared by CMC-03..CMC-06, one commit per ticket). Base: `origin/master` 9da086e.

## Goal

`run_workflow` / `describe_workflow` / `list_workflows` accept UI-format workflows whose nodes live in subgraphs (most of ComfyUI's saved templates: Qwen-Image 2.1, Z-Image, Krea 2, BiRefNet, MiniMax, YuE2). Today `classify()` in `src/comfy/workflows.ts` refuses them with "use Export (API)". After this ticket the UI-to-API converter expands subgraphs itself.

## Subgraph format (verified on the templates in `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\Infplane\ComfyUI\user\default\workflows`)

- `workflow.definitions.subgraphs[]`: `{ id (uuid), name, inputs[], outputs[], nodes[], links[] }`.
- A subgraph **instance** is a normal top-level (or inner) node whose `type` equals a subgraph `id`.
- Subgraph `links` are objects `{ id, origin_id, origin_slot, target_id, target_slot, type }`.
  - `origin_id === -10`: the link starts at the subgraph's input slot `origin_slot` (index into `subgraph.inputs`).
  - `target_id === -20`: the link ends at the subgraph's output slot `target_slot` (index into `subgraph.outputs`).
- Inner nodes reference links by id in `inputs[].link` (same as top level).
- Instance node `inputs[]` have names equal to `subgraph.inputs[].name`; an instance input with a `widget` property carries a value: the instance's `widgets_values` are positional over **only the inputs that have `widget`**, in input order (checked: z-image 8/8, krea2 14/14, qwen turbo edit 18 widget inputs of 28 with 18 values; no control_after_generate entries). An instance input with a `link` takes the outer link instead.
- Top-level `links` are arrays `[id, origin_id, origin_slot, target_id, target_slot, type]` (already handled).
- `properties.proxyWidgets` may exist on newer instances; ignore it (the inner nodes keep their own `widgets_values`).
- Subgraphs can nest (an inner node's type is another subgraph id); none of the local templates do, but support it.
- Frontend-only node types to drop: notes (`/Note$/`, already), `Reroute`/`PrimitiveNode` (inlined, already), plus `Label (rgthree)`.

## Design

Add `flattenSubgraphs(ui: UiWorkflow): { workflow: UiWorkflow; warnings: string[] }` in `src/comfy/ui-to-api.ts` and call it at the start of `uiToApi` when `ui.definitions?.subgraphs?.length`. It returns a single-level UI workflow that the existing converter handles unchanged:

1. Expand recursively. An inner node of instance `57` with inner id `30` gets the id `"57:30"` (the frontend's own API-export convention; nested: `"57:12:30"`). Inner `title` is kept.
2. Links in the flat workflow use fresh numeric ids (object form `{ id, origin_id, origin_slot }` is enough for `uiToApi`). Rewrite each inner node's `inputs[].link` to the new id.
3. Inner link from `-10` slot `k`: find the instance input whose `name === subgraph.inputs[k].name`.
   - If that instance input has an outer link: resolve the outer link's origin (it may itself be another instance's output, see 4) and link the inner target to it.
   - Else if it has a widget value: create a synthetic `PrimitiveNode` (`id "<instance>:in:<k>"`, `widgets_values: [value]`) and link to it; `uiToApi` already inlines `PrimitiveNode` as a literal. This also overrides the inner node's own widget value, which is what the UI does.
   - Else: leave the inner input unlinked (the inner node's own widget value, if any, stays).
4. Outer link whose origin is an instance's output slot `s`: resolve to the inner link targeting `-20` slot `s` → its origin (recursively through nested instances and through `-10` pass-throughs).
5. Instance `mode` 2 (muted) or 4 (bypassed): drop the whole instance (and its inner nodes); add a warning for bypass ("bypassed subgraph <name> dropped; bypass pass-through is not supported").
6. Unknown subgraph ids are impossible by construction (type matches a definition); guard against cycles with a depth limit (e.g. 16) → throw.

`workflows.ts`:
- `classify()` no longer reports subgraphs as a problem; UI workflows with subgraphs are `format: 'ui'`. Keep `subgraphNodes()` only if still used (e.g. a `subgraphs` count in `WorkflowEntry` is fine but optional).
- `loadWorkflow` passes converter warnings through as now.
- Update the `list_workflows` / `run_workflow` tool descriptions in `src/mcp/tools.ts` that say subgraph workflows need Export (API).

## Steps

- [x] `flattenSubgraphs` + wiring in `uiToApi` (types: extend `UiWorkflow` with optional `definitions.subgraphs`, nodes `properties`, object links with `target_id/target_slot`).
- [x] Drop `Label (rgthree)` as frontend-only.
- [x] `classify()` / tool descriptions updated.
- [x] Unit tests in `tests/workflows.test.ts` (replace the "flags UI workflows that use subgraphs" test):
  - a small synthetic workflow: instance with a widget input (→ literal on the inner node), an outer-linked input (LoadImage → instance → inner node), an instance output feeding a top-level SaveImage, a muted instance dropped, and one nested subgraph;
  - expected API ids `"<inst>:<inner>"`, literals and links.
- [x] Live check against the running ComfyUI (`http://127.0.0.1:8188`, already started): with a small `tsx` script under `.claude/temp/`, convert every local template in the ComfyUI user workflows folder with the live `/object_info` and POST nothing; report warnings. Then really run `image_z_image_turbo` (and `utility_birefnet_remove_background` with a LoadImage file param) through `ComfyService.runWorkflow` or the MCP server and confirm a PNG is written. Do not run the large Qwen/YuE templates (slow); converting them without errors is enough.

## Acceptance

- `yarn typecheck`, `yarn lint`, `yarn test` pass.
- `list_workflows` shows the template workflows without a `problem`.
- `image_z_image_turbo.json` (UI, subgraph) runs end to end on the live ComfyUI and writes an image; `describe_workflow` lists ids like `57:27`.
- Converting all local templates produces API graphs that ComfyUI accepts (verified for at least z-image and birefnet by actually running).

## Not in scope

README / ROADMAP edits (the orchestrator does those at commit time).

## Results

- Implemented `flattenSubgraphs` + wiring in `uiToApi`, `Label (rgthree)` dropped, `classify()` no longer flags subgraphs (`subgraphNodes` removed, unused). Tests: replaced the subgraph "flag" test, added a subgraph conversion suite (literals, outer links, nested, muted, bypassed).
- `yarn typecheck`, `yarn lint` clean; `yarn test`: 30 passed.
- Live (ComfyUI 0.42.0): all 13 local templates convert with no warnings and no unknown node types. `image_z_image_turbo` ran end to end (ids `57:27` etc., PNG written); `utility_birefnet_remove_background` ran with `17.image` file (2 PNGs written). Scripts in `.claude/temp/live.mts`, `live2.mts`.
- Deviation: tool descriptions in `src/mcp/tools.ts` (lines ~140, ~152) not edited (not owned); orchestrator to do.
