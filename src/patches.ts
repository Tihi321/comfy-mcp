import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Local fixes to third-party ComfyUI code that the hub's engines need on this kind of machine (Windows, no Triton). A node update
 * overwrites them, so they live here as text patches: `check` says which are in place, `apply` puts them back, `revert` takes them out
 * (before a node update that refuses to overwrite a changed file). The third-party repos are never forked.
 */
export interface LocalPatch {
  id: string
  /** The file, relative to the ComfyUI folder (the one with main.py and custom_nodes). */
  file: string
  why: string
  /** The upstream text the patch replaces (LF line ends; the file's own line ends are kept). */
  find: string
  replace: string
}

export const PATCHES: LocalPatch[] = [
  {
    id: 'chatterbox-torch-load',
    file: 'custom_nodes/comfyui_fill-chatterbox/chatterbox_node.py',
    why: 'the node wraps torch.load and adds map_location even when a caller passed it positionally, so MOSS-SoundEffect failed with "load() got multiple values for argument \'map_location\'"',
    find: "def patched_torch_load(*args, **kwargs):\n    if 'map_location' not in kwargs:\n",
    replace:
      "def patched_torch_load(*args, **kwargs):\n" +
      '    # Local fix (creative hub, 2026-11-09): a caller may pass map_location positionally (torch.load(f, "cpu")).\n' +
      "    if 'map_location' not in kwargs and len(args) < 2:\n"
  },
  {
    id: 'moss-sfx-compile-without-triton',
    file: 'custom_nodes/TTS-Audio-Suite/engines/moss_soundeffect_v2/impl/moss_soundeffect_v2/diffsynth/pipelines/wan_audio.py',
    why: 'torch.compile needs Triton, which this machine lacks, so the MOSS-SoundEffect v2 pipeline failed with TritonMissing',
    find: '@torch.compile(options={"triton.cudagraphs": True}, fullgraph=True)\ndef model_fn_wan_video(\n',
    replace:
      'def _compile_if_triton(fn):\n' +
      '    # Local fix (creative hub, 2026-11-09): torch.compile needs Triton, which this machine (AMD GPU, Windows) lacks;\n' +
      '    # without it the sound-effect pipeline failed with TritonMissing. Compile only when Triton imports.\n' +
      '    try:\n' +
      '        import triton  # noqa: F401\n' +
      '    except Exception:\n' +
      '        return fn\n' +
      '    return torch.compile(options={"triton.cudagraphs": True}, fullgraph=True)(fn)\n' +
      '\n' +
      '\n' +
      '@_compile_if_triton\n' +
      'def model_fn_wan_video(\n'
  }
]

/** `applied`: the fix is in; `needed`: the upstream text is there and the fix is not; `unknown`: neither (the code changed upstream: look by hand). */
export type PatchState = 'applied' | 'needed' | 'unknown' | 'missing-file'

export function patchState(text: string, p: LocalPatch): Exclude<PatchState, 'missing-file'> {
  const t = text.replace(/\r\n/g, '\n')
  if (t.includes(p.replace)) return 'applied'
  if (t.includes(p.find)) return 'needed'
  return 'unknown'
}

/** The text with the patch applied (`apply`) or taken out (`revert`), keeping the file's line ends; unchanged when there is nothing to do. */
export function patchText(text: string, p: LocalPatch, mode: 'apply' | 'revert'): string {
  const crlf = text.includes('\r\n')
  const t = text.replace(/\r\n/g, '\n')
  const [from, to] = mode === 'apply' ? [p.find, p.replace] : [p.replace, p.find]
  if (mode === 'apply' && t.includes(p.replace)) return text
  if (!t.includes(from)) return text
  const out = t.replace(from, to)
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

export interface PatchReport {
  id: string
  file: string
  state: PatchState
  /** What `apply` or `revert` did: changed the file, or not. */
  changed?: boolean
}

export function runPatches(comfyDir: string, mode: 'check' | 'apply' | 'revert', patches: LocalPatch[] = PATCHES): PatchReport[] {
  return patches.map((p) => {
    const file = path.join(comfyDir, p.file)
    if (!existsSync(file)) return { id: p.id, file, state: 'missing-file' as const }
    const text = readFileSync(file, 'utf8')
    if (mode === 'check') return { id: p.id, file, state: patchState(text, p) }
    const out = patchText(text, p, mode)
    if (out !== text) writeFileSync(file, out, 'utf8')
    return { id: p.id, file, state: patchState(out, p), changed: out !== text }
  })
}

const USAGE = 'usage: node out/patches.js check|apply|revert --comfy-dir <ComfyUI folder> [--json]   (or set COMFYUI_DIR)'

/** The CLI (`out/patches.js`). Exit 0 when every patch ends applied (check, apply) or out (revert); 1 otherwise; 2 on bad arguments. */
export function main(argv: string[]): number {
  const mode = argv[0]
  const at = argv.indexOf('--comfy-dir')
  const dir = at >= 0 ? argv[at + 1] : process.env.COMFYUI_DIR
  if ((mode !== 'check' && mode !== 'apply' && mode !== 'revert') || !dir) {
    console.error(USAGE)
    return 2
  }
  const reports = runPatches(dir, mode)
  if (argv.includes('--json')) console.log(JSON.stringify(reports))
  else for (const r of reports) console.log(`${r.id}: ${r.state}${r.changed ? ' (file changed)' : ''}  ${r.file}`)
  const ok = reports.every((r) => (mode === 'revert' ? r.state === 'needed' : r.state === 'applied'))
  return ok ? 0 : 1
}
