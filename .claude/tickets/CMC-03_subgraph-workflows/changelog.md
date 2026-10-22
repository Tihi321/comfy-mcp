# Changelog

## 2026-10-22 — CMC-03: run UI workflows that use subgraphs

The UI-to-API converter now expands subgraphs. All 13 of ComfyUI's local template workflows convert, and Z-Image and BiRefNet ran end to end.

**Repo** `comfy-mcp`, branch `CMC-03_roadmap-items`, commit `94e4ea8`.

| File | Change |
|---|---|
| `src/comfy/ui-to-api.ts` | New `flattenSubgraphs()`, called by `uiToApi` when `definitions.subgraphs` is non-empty. Inner nodes get ids `<instance>:<inner>`, nested ones `57:12:30`. Instance widget values become synthetic `PrimitiveNode`s that are inlined as literals. Outer links are spliced through the subgraph input slots (-10) and output slots (-20). Muted instances are dropped; bypassed instances are dropped with a warning. Depth limit 16. `Label (rgthree)` is treated as frontend-only. |
| `src/comfy/workflows.ts` | `classify()` no longer flags subgraph workflows as unrunnable. Removed the unused `subgraphNodes`. |
| `src/mcp/tools.ts` | `list_workflows` / `run_workflow` descriptions: subgraph workflows run as they are, and inner ids look like `57:27`. |
| `tests/workflows.test.ts` | The test that flagged subgraphs now asserts no `problem`. New subgraph conversion suite: literals, an outer LoadImage link, an instance output feeding SaveImage, nesting, a muted instance, and a bypassed instance with its warning. |
| `README.md`, `ROADMAP.md` | Workflow docs updated; roadmap item ticked. |

**Deviations:** the orchestrator made the `tools.ts` description edits, not the implementer, because the file was shared with CMC-04, which ran in parallel.

**Verification**
- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 25 passed on the CMC-03-only tree; 30 passed together with CMC-04.
- Live, on ComfyUI 0.42.0:
  - All 13 templates in `user/default/workflows` convert with no warnings and no unknown node types.
  - `image_z_image_turbo` wrote a PNG.
  - `utility_birefnet_remove_background` with `files: {"17.image": …}` wrote 2 PNGs.
- Not run: the large Qwen, YuE, MiniMax and Krea templates were converted but not executed.

**Known limitations:** a bypassed subgraph is dropped rather than passed through. `properties.proxyWidgets` is ignored, because the inner nodes' own values are used.

**Commit status:** committed locally (`94e4ea8`), not pushed.
