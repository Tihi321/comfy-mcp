# Roadmap

What comfy-mcp still lacks, found while the creative hub (`C:\projects\Personal\creative-hub`) used it. Moved here from the hub's `ROADMAP.md` on 2026-10-22. Finished work is in `README.md` (CMC-01, the MCP server). Fix items on a ticket branch (`CMC-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master bde46f0)

- MCP server on `127.0.0.1:7460/mcp`, generating through ComfyUI on 8188: images, edits, cutouts, music, speech and saved workflows. Outputs go to the hub's `output/comfy` unless a tool gets an absolute `out` path.

## Workflows

- [x] **Subgraph workflows.** Most of ComfyUI's saved template workflows (Qwen-Image 2.1, Z-Image, Krea 2, BiRefNet, MiniMax, YuE2) put their nodes in a subgraph; `run_workflow` refuses them with a hint to use Export (API). Expanding subgraphs in the UI-to-API converter would make every saved workflow runnable.
  Done in CMC-03: the converter expands subgraphs (nested too). All 13 local templates convert, and Z-Image and BiRefNet ran end to end. Still open: a bypassed subgraph is dropped, not passed through.
- [x] **Qwen-Image 2.1 Turbo edit.** Not an engine: its template uses ManualSigmas + SamplerCustomAdvanced instead of KSampler, so it needs its own graph.
  Done in CMC-04: engine `qwen-image-2.1-turbo-edit`, picked with `edit_image`'s `engine`. It runs the template's 8-step sigmas at resolution 1024; a live edit took 65 s.

## Speech

- [x] **More speech engines.** Only `chatterbox-multilingual` has a mapping, and it has no Croatian. F5, IndexTTS-2 (Croatian-capable), Qwen3-TTS and the rest of the TTS Audio Suite need an API export plus a `.map.yaml` in `workflows/`.
  Done in CMC-05: new workflows `f5-tts`, `indextts-2`, `qwen3-tts` and `higgs-audio-v3`. IndexTTS-2 turned out not to speak Croatian; Higgs Audio v3 does and is the Croatian engine. All four produced speech in live runs. The rest of the suite (VibeVoice, CosyVoice, Fish, OmniVoice, ...) is not mapped.

## Robustness

- **Jobs live in memory.** A restart forgets job ids (written files stay).
