import { loadConfig } from './config'
import { McpHttpServer } from './mcp/http'
import { buildTools } from './mcp/tools'
import { ComfyService } from './service'

/**
 * comfy-mcp: an MCP server (Streamable HTTP on 127.0.0.1) that drives the local ComfyUI. Always headless.
 *
 *   node out/index.js [--port 7460] [--comfy http://127.0.0.1:8188] [--out <dir>] [--state <file>] [--workflows <dir;dir>] [--files <json>] [--job-timeout <s>]
 *
 * Prints "MCP listening on <url>" when ready; exits 1 when the port is taken. Settings: see src/config.ts.
 */

const HELP = `comfy-mcp: MCP server for the local ComfyUI

  node out/index.js [options]

  --port <n>          MCP port on 127.0.0.1 (default 7460; COMFY_MCP_PORT)
  --comfy <url>       ComfyUI server (default http://127.0.0.1:8188; COMFY_URL)
  --out <dir>         default output folder (default ~/ComfyMCP/output; COMFY_MCP_OUT)
  --state <file>      where jobs are saved across restarts (default ~/ComfyMCP/jobs.json; COMFY_MCP_STATE)
  --workflows <dirs>  extra workflow folders, ";"-separated (COMFY_MCP_WORKFLOWS)
  --files <json>      model file overrides, e.g. {"zImage":{"unet":"x.safetensors"}} (COMFY_MCP_FILES)
  --job-timeout <s>   longest one ComfyUI prompt may run (default 1800; COMFY_MCP_JOB_TIMEOUT)
  COMFY_MCP_TOKEN     require "Authorization: Bearer <token>" when set
`

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return
  }
  const config = loadConfig(argv)
  const service = new ComfyService(config, log)
  const server = new McpHttpServer({ host: { tools: buildTools(service) }, port: config.port, token: config.token, log })
  const status = await server.start()
  if (!status.running) {
    log(status.error ?? 'could not start')
    process.exit(1)
  }
  process.stdout.write(`MCP listening on ${status.url}\n`)
  log(`ComfyUI ${config.comfyUrl}; output ${config.outDir}; state ${config.stateFile}; auth ${config.token ? 'bearer token' : 'none'}`)

  await service.restoreJobs()

  const shutdown = (signal: string) => {
    log(`${signal}: stopping`)
    service.jobs.flush()
    void server.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e: unknown) => {
  log(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
