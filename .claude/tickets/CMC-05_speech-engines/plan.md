# CMC-05: More speech engines (F5, IndexTTS-2, Qwen3-TTS, Higgs Audio v3)

Branch: `CMC-03_roadmap-items` (shared by CMC-03..CMC-06, one commit per ticket).

## Goal

`generate_speech` can use TTS Audio Suite engines besides `chatterbox-multilingual`, each as an API-format workflow plus a `.map.yaml` in `workflows/`. Croatian works through Higgs Audio v3.

## Findings (2026-10-22, live ComfyUI 0.42.0 with TTS-Audio-Suite)

- Language support (`custom_nodes/TTS-Audio-Suite/docs/LANGUAGE_SUPPORT.md`): **only Higgs Audio v3 speaks Croatian**. The roadmap's "IndexTTS-2 (Croatian-capable)" is wrong; IndexTTS 2 is en/zh (2.5 adds es/ja/ar).
- Installed models (`models/tts`): `F5-TTS/F5TTS_v1_Base`, `IndexTTS/IndexTTS-2`, `qwen3_tts/Qwen3-TTS-12Hz-1.7B-Base`. Higgs Audio v3 (`higgs-audio-v3-tts-4b`, ~8 GB, research/non-commercial licence) is **not** downloaded; the user approved letting the first run download it.
- TTS Audio Suite chain: `<X>EngineNode` (output `TTS_ENGINE`) → `UnifiedTTSTextNode` (`TTS_engine`, `text`, `narrator_voice`, `seed`, optional `opt_narrator`, chunking options) → `AUDIO`.
- Voice: `CharacterVoicesNode` (`voice_name` combo of library voices such as `voices_examples/female/female_01.wav`, `reference_text`, `trim_start`, `trim_end`, `customized`, optional `opt_audio_input: AUDIO`) → output 0 `opt_narrator` → `UnifiedTTSTextNode.opt_narrator`. Its code (`nodes/shared/character_voices_node.py`) uses `opt_audio_input` first, else `voice_name` with the library voice's own transcript (`.reference.txt`); with `customized: false` a library voice's transcript replaces `reference_text`.
- F5-TTS refuses an empty reference text (`engines/f5tts/f5tts.py`: "F5-TTS requires reference text"), so a cloned voice needs its transcript.
- Engine node inputs (see `/object_info`, cached at `.claude/temp/object_info.json`): `F5TTSEngineNode.language` is the model (`local:F5TTS_v1_Base` installed; other languages are separate downloads), `IndexTTSEngineNode.model_path` (`local:IndexTTS-2`), `Qwen3TTSEngineNode.model_variant` (`local:Qwen3-TTS-12Hz-1.7B-Base`) + `language` (Auto, Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian), `HiggsAudioV3EngineNode.model` (`higgs-audio-v3-tts-4b`).

## Design

Each workflow `workflows/<name>.json` (API format) has the same shape and node ids:

| id | class | notes |
|---|---|---|
| 1 | `<X>EngineNode` | every required input as a literal (object_info defaults), the local model variant |
| 2 | `LoadAudio` | `audio: "comfy-mcp/voice_ref.wav"` placeholder; dropped by `generate_speech` when no `voice_ref` is given (existing logic: the file is not in ComfyUI's input list) |
| 3 | `CharacterVoicesNode` | `voice_name: <default library voice>`, `reference_text: ""`, `trim_start 0`, `trim_end 0`, `customized: false`, `opt_audio_input ← 2` |
| 4 | `UnifiedTTSTextNode` | `TTS_engine ← 1`, `text`, `narrator_voice: "none"`, `seed`, `opt_narrator ← 3:0`, chunking defaults |
| 5 | `SaveAudioMP3` (or what `chatterbox-multilingual.json` uses) | `audio ← 4:0` |

Mappings (`<name>.map.yaml`): `kind: audio`, `text: 4.text`, `seed: 4.seed`, `voiceRef: 2.audio`, `voiceText: 3.reference_text`, `output: "5"`, plus per engine `language` slot and `languages` table, and `defaultVoice`.

| workflow | language slot | languages | voice text |
|---|---|---|---|
| `f5-tts` | `1.language` | `en: local:F5TTS_v1_Base` | required with `voice_ref` |
| `indextts-2` | none | `en`, `zh` (validation only) | not used |
| `qwen3-tts` | `1.language` | en, zh, ja, ko, de, fr, ru, pt, es, it → the node's names | check live whether the Base model needs it |
| `higgs-audio-v3` | none | none (100+ languages incl. `hr`; any code accepted) | optional |

Code changes:
- `src/comfy/workflows.ts` mapping schema: new optional slot `voiceText` (add to `MAPPED_FIELDS`; not a file field), `needsVoiceText: boolean` (default false), `defaultVoice: string` (what the workflow uses without `voice_ref`, for the result's `voice` field). Validation of slots covers `voiceText`.
- `src/service.ts` `generateSpeech`:
  - new arg `voiceText`; set `mapping.voiceText` when given. If `voiceRef` is given and `mapping.needsVoiceText` and no `voiceText` → error "<workflow> needs voice_text: the exact words spoken in voice_ref".
  - language: when `mapping.languages` exists, the code must be one of its keys (also when there is no language slot) else error naming the supported codes and, for `hr`, "use workflow higgs-audio-v3". Set the language slot only when mapped.
  - without `voice_ref`: keep the current behaviour (keep the LoadAudio clip if ComfyUI has it, else drop node 2). When the mapping has `defaultVoice`, report `voice: default (<defaultVoice>)` and do **not** add the chatterbox "built-in voice can run on past the text" note (that note stays for mappings without `defaultVoice`).
- `src/mcp/tools.ts` `generate_speech`: add `voice_text`; description lists the workflows and their languages (chatterbox-multilingual 23 languages no Croatian; f5-tts English, clone needs voice_text; indextts-2 en/zh; qwen3-tts 10 languages; higgs-audio-v3 100+ languages incl. Croatian, first run downloads ~8 GB). `workflow` description too.
- `workflows/chatterbox-multilingual.map.yaml`: fix the comment that points Croatian to IndexTTS-2 → higgs-audio-v3.

## Steps

- [x] Build the four workflow JSONs from `/object_info` (every required input present, combo values valid). Cross-check node wiring against the suite's example UI workflows in ComfyUI's `user/default/workflows/TTS Audio Suite/` (e.g. `🌈 IndexTTS-2 integration.json`, `F5 TTS integration + 📝 Phoneme Text Normalizer.json`, `Qwen3 integration + ASR.json`, `Higgs Audio v3 Integration.json`).
- [x] Mapping schema + service + tool changes above.
- [x] Tests (`tests/workflows.test.ts`): every bundled workflow loads and its mapping validates; `voiceText` resolves; language validation for a mapping with `languages` but no language slot; `needsVoiceText` error. A fake-ComfyUI server test for `generate_speech` with `workflow: "f5-tts"` + `voice_ref` + `voice_text` checking the posted graph (3.reference_text set, 2.audio = uploaded name), and without voice_ref (node 2 dropped, no `opt_audio_input`).
- [x] Live runs on ComfyUI `http://127.0.0.1:8188` (through a `tsx` script under `.claude/temp/` or the MCP server on a spare port), short sentences:
  - f5-tts en with the default voice, and with `voice_ref` = `custom_nodes/TTS-Audio-Suite/voices_examples/male/male_01.wav` + its `.reference.txt` as `voice_text`;
  - indextts-2 en; qwen3-tts de; higgs-audio-v3 hr ("Dobar dan, ovo je kratki test.") — the first Higgs run downloads the model, allow a long timeout (`--job-timeout`/`wait` of up to 1800 s) and run it in the background;
  - each writes an audio file of plausible length (not empty, not minutes long). Record durations/sizes in this plan.
- [x] Call `free_memory` between engines if VRAM is tight.

## Acceptance

- `yarn typecheck`, `yarn lint`, `yarn test` pass.
- `list_workflows` shows the four new workflows as mapped; `generate_speech` works live with each of them, Croatian through `higgs-audio-v3`.

## Not in scope

README / ROADMAP edits (orchestrator).

## Results (2026-10-22)

Checks: `yarn typecheck`, `yarn lint`, `yarn test` pass (38 tests; new: bundled workflows load/validate, voiceText + engine mappings, fake-ComfyUI `generate_speech` for f5-tts with/without voice_ref, missing voice_text error, language validation for mappings without a language slot, `hr` hint).

Live runs (ComfyUI 0.42.0, `generateSpeech` through `tsx`, `.claude/temp/live.mts`, outputs in `.claude/temp/speech/`):

| engine | lang | voice | elapsed | duration | result |
|---|---|---|---|---|---|
| f5-tts | en | default (female_01) | 19 s | 2.45 s | ok |
| f5-tts | en | voice_ref male_01.wav + its reference text | 5 s | 2.91 s | ok |
| indextts-2 | en | default (female_01) | 579 s (first run downloads the model) | 3.09 s | ok with `model_path: IndexTTS-2` |
| qwen3-tts | de | default (female_01) | 39 s | 2.08 s | ok |
| qwen3-tts | de | voice_ref male_01.wav, no voice_text | 20 s | 2.62 s | ok, so `needsVoiceText` stays false |
| higgs-audio-v3 | hr | default (en_woman) | 17 s | 2.32 s | ok (model was pre-downloaded; `local:higgs-audio-v3-tts-4b` is listed and used) |

Deviations / findings:
- Qwen3 engine node: `VALIDATE_INPUTS` requires `runtime_mode` even though object_info lists it as optional; the workflow sets `runtime_mode: "⚠️ Shared Runtime"` (the default).
- IndexTTS: the installed `local:IndexTTS-2` folder is incomplete (no `gpt.pth`; failed with "Failed to load IndexTTS-2 model ... gpt.pth"). The workflow uses `IndexTTS-2` (non-local), which makes the node download the missing files on the first run (~10 min); this completed the install and the engine then works.
- `languages` is now validated by code key (previously by mapped value), also for mappings without a language slot.
- A `voice_text` is applied only together with `voice_ref`; `defaultVoice` set for all four new mappings.
