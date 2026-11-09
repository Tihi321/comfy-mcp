import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PATCHES, runPatches } from '../src/patches'

/** A fake ComfyUI folder holding the upstream (unpatched) files with CRLF line ends, as on this machine. */
function fakeComfy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cmc-patches-'))
  for (const p of PATCHES) {
    const file = path.join(dir, p.file)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `import torch\n\n${p.find}    pass\n`.replace(/\n/g, '\r\n'))
  }
  return dir
}

describe('local ComfyUI patches', () => {
  it('check finds the upstream text, apply fixes it once keeping CRLF, revert restores upstream', () => {
    const dir = fakeComfy()
    const before = PATCHES.map((p) => readFileSync(path.join(dir, p.file), 'utf8'))
    expect(runPatches(dir, 'check').map((r) => r.state)).toEqual(['needed', 'needed'])

    expect(runPatches(dir, 'apply').every((r) => r.state === 'applied' && r.changed)).toBe(true)
    const patched = PATCHES.map((p) => readFileSync(path.join(dir, p.file), 'utf8'))
    expect(patched.every((t) => t.includes('Local fix (creative hub') && !/[^\r]\n/.test(t))).toBe(true)
    expect(runPatches(dir, 'apply').every((r) => r.state === 'applied' && !r.changed)).toBe(true)

    runPatches(dir, 'revert')
    expect(PATCHES.map((p) => readFileSync(path.join(dir, p.file), 'utf8'))).toEqual(before)
  })

  it('reports upstream code it does not recognise, and a missing node', () => {
    const dir = fakeComfy()
    writeFileSync(path.join(dir, PATCHES[0]!.file), 'def patched_torch_load(*args, **kw):\n    return 1\n')
    writeFileSync(path.join(dir, PATCHES[0]!.file + '.keep'), '')
    const other = path.join(dir, PATCHES[1]!.file)
    writeFileSync(other, '')
    const r = runPatches(dir, 'apply', [PATCHES[0]!, { ...PATCHES[1]!, file: 'custom_nodes/gone/x.py' }])
    expect(r.map((x) => x.state)).toEqual(['unknown', 'missing-file'])
  })
})
