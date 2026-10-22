import { homedir } from 'node:os'
import path from 'node:path'
import { DEFAULT_COMFY_URL } from './comfy/client'
import type { FileGroups } from './comfy/graphs'

/**
 * Server settings from the command line, then environment variables, then defaults:
 *
 *   --port <n>            COMFY_MCP_PORT        MCP port on 127.0.0.1 (7460)
 *   --comfy <url>         COMFY_URL             the ComfyUI server (http://127.0.0.1:8188)
 *   --out <dir>           COMFY_MCP_OUT         default output folder (~/ComfyMCP/output)
 *   --state <file>        COMFY_MCP_STATE       where jobs are saved across restarts (~/ComfyMCP/jobs.json)
 *   --workflows <dirs>    COMFY_MCP_WORKFLOWS   extra workflow folders, separated by ";"
 *   --files <json>        COMFY_MCP_FILES       model file overrides, e.g. {"zImage":{"unet":"x.safetensors"}}
 *                         COMFY_MCP_TOKEN       Bearer token; unset means no auth
 *   --job-timeout <s>     COMFY_MCP_JOB_TIMEOUT longest a single ComfyUI prompt may run (1800)
 */

export interface Config {
  port: number
  comfyUrl: string
  outDir: string
  /** JSON file the jobs are saved to, so they survive a restart. */
  stateFile: string
  /** Searched in order for saved workflows: the repo's `workflows/`, the extra folders, ComfyUI's user workflows. */
  workflowDirs: string[]
  files: Partial<Record<keyof FileGroups, Record<string, string>>>
  token: string | null
  jobTimeoutMs: number
}

export const DEFAULT_PORT = 7460

/** ComfyUI Desktop's saved workflows for this machine's install (UI format; API exports also work). */
export const COMFY_USER_WORKFLOWS = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
  'Comfy-Desktop',
  'ComfyUI-Installs',
  'Infplane',
  'ComfyUI',
  'user',
  'default',
  'workflows'
)

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env, repoDir = path.resolve(__dirname, '..')): Config {
  const portText = flag(argv, '--port') ?? env.COMFY_MCP_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number, not "${portText}"`)

  const comfyUrl = (flag(argv, '--comfy') ?? env.COMFY_URL ?? DEFAULT_COMFY_URL).trim().replace(/\/+$/, '')
  const outDir = path.resolve(expandHome(flag(argv, '--out') ?? env.COMFY_MCP_OUT ?? path.join(homedir(), 'ComfyMCP', 'output')))
  const stateFile = path.resolve(expandHome(flag(argv, '--state') ?? env.COMFY_MCP_STATE ?? path.join(homedir(), 'ComfyMCP', 'jobs.json')))

  const extra = (flag(argv, '--workflows') ?? env.COMFY_MCP_WORKFLOWS ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(expandHome(d)))
  const workflowDirs = [...new Set([path.join(repoDir, 'workflows'), ...extra, COMFY_USER_WORKFLOWS])]

  const filesText = flag(argv, '--files') ?? env.COMFY_MCP_FILES
  let files: Config['files'] = {}
  if (filesText) {
    try {
      files = JSON.parse(filesText) as Config['files']
    } catch (e) {
      throw new Error(`--files is not valid JSON: ${(e as Error).message}`, { cause: e })
    }
  }

  const timeoutText = flag(argv, '--job-timeout') ?? env.COMFY_MCP_JOB_TIMEOUT ?? '1800'
  const jobTimeoutS = Number(timeoutText)
  if (!Number.isFinite(jobTimeoutS) || jobTimeoutS <= 0) throw new Error(`--job-timeout must be seconds, not "${timeoutText}"`)

  return { port, comfyUrl, outDir, stateFile, workflowDirs, files, token: env.COMFY_MCP_TOKEN?.trim() || null, jobTimeoutMs: jobTimeoutS * 1000 }
}
