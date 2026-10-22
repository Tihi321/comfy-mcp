# Changelog

## 2026-10-22 — CMC-05: more speech engines

Adds four TTS Audio Suite workflows for `generate_speech`. Croatian goes through `higgs-audio-v3`, and all four produced speech in live runs.

**Repo** `comfy-mcp`, branch `CMC-03_roadmap-items`, commit `dc8d5e3`.

| File | Change |
|---|---|
| `workflows/{f5-tts,indextts-2,qwen3-tts,higgs-audio-v3}.json` | New API-format workflows. All use the same ids: 1 engine node, 2 LoadAudio (placeholder; dropped without `voice_ref`), 3 CharacterVoicesNode (library voice; `opt_audio_input` ← 2), 4 UnifiedTTSTextNode, 5 SaveAudioMP3. |
| `workflows/*.map.yaml` (4 new) | Each maps `text`, `seed`, `voiceRef`, `voiceText`, `output` and `defaultVoice`. f5-tts has `needsVoiceText` and `en` only. indextts-2 accepts `en`/`zh` (validation only). qwen3-tts sets its language input for 10 languages. higgs-audio-v3 has no language table and accepts any code. |
| `workflows/chatterbox-multilingual.map.yaml` | Comment: Croatian → `higgs-audio-v3` (was IndexTTS-2). |
| `src/comfy/workflows.ts` | The mapping schema gains `voiceText` (a mapped field), `needsVoiceText` and `defaultVoice`. |
| `src/service.ts` | `generateSpeech` takes `voiceText`. The language code is checked against `languages` keys even when there is no language input, and `hr` gets a hint to use `higgs-audio-v3`. `voice_ref` without `voice_text` is refused where `needsVoiceText` is set. With `defaultVoice`, the result reports `voice: default (…)` without the Chatterbox run-on note. |
| `src/mcp/tools.ts` | `generate_speech` gets `voice_text`; the descriptions list the five workflows and their languages. |
| `tests/workflows.test.ts`, `tests/server.test.ts` | The bundled workflows load and validate. Fake-ComfyUI tests cover f5-tts with and without `voice_ref`, the `voice_text` requirement, language validation and the `hr` hint. |
| `README.md`, `ROADMAP.md` | New **Speech** section and table; roadmap item ticked, correcting the roadmap's claim that IndexTTS-2 speaks Croatian. |

**Deviations / decisions**
- The roadmap called IndexTTS-2 Croatian-capable, but the suite's language table says otherwise. The user chose to add Higgs Audio v3 and approved its ~8 GB download. The orchestrator pre-downloaded it with `hf download bosonai/higgs-audio-v3-tts-4b`.
- The Higgs workflow uses `higgs-audio-v3-tts-4b`, not `local:…`. That picks up the local copy when present and downloads it otherwise; the orchestrator switched it from `local:` and re-ran the test.
- The local IndexTTS-2 folder was incomplete (`gpt.pth` missing), so the workflow uses `model_path: "IndexTTS-2"`. The suite downloaded the missing files on the first run, which took about 10 minutes. The implementer let this run without asking the user explicitly.
- Qwen3-TTS: the node rejects the prompt unless `runtime_mode` is set, even though object_info lists it as optional. It is set to the default `⚠️ Shared Runtime`.
- Qwen3 cloned fine without a transcript, so only f5-tts has `needsVoiceText`.

**Verification**
- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 38 passed.
- Live runs on ComfyUI 0.42.0:
  - f5-tts en, default voice: 19 s, output 2.45 s.
  - f5-tts en, `voice_ref` `male_01` + transcript: 5 s, output 2.91 s.
  - indextts-2 en: 579 s including the model download, output 3.09 s.
  - qwen3-tts de, default voice: 39 s, output 2.08 s.
  - qwen3-tts de, `voice_ref`: 20 s, output 2.62 s.
  - higgs-audio-v3 hr: 17 s, output 2.32 s (implementer); after the orchestrator's switch to the non-`local:` model id it took 6 s, output 3.2 s.
- Not done: nobody listened to the outputs to judge pronunciation or quality. Durations and file sizes are plausible.

**Known limitations:** the default voices are English library clips, so Croatian without `voice_ref` may carry an English-speaking voice's timbre. The rest of the TTS Audio Suite (VibeVoice, CosyVoice, Fish, OmniVoice, …) is not mapped.

**Commit status:** committed locally (`dc8d5e3`), not pushed.
