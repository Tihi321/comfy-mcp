import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { callTool, toolList, type Tool } from './tools'

/**
 * The MCP server object: `initialize`, `tools/list` and `tools/call` on the SDK's `Server`. `http.ts` makes one per HTTP session.
 *
 *   claude mcp add --transport http comfy-mcp http://127.0.0.1:7460/mcp
 */

export const SERVER_INFO = { name: 'comfy-mcp', version: '0.1.0' }

/** The short workflow every client gets in `initialize`. */
export const INSTRUCTIONS = `ComfyUI on this machine, over MCP. Tools: generate_image (z-image-turbo, qwen-image-2.1[-turbo], krea2-turbo, moss-image), edit_image (Qwen-Image 2.1 edit from reference images), remove_background (BiRefNet, alpha PNG), generate_music (ace-step-v1[-instrumental], yue2, minimax-music-3), generate_speech (Chatterbox multilingual or another mapped TTS workflow), run_workflow / list_workflows / describe_workflow (saved workflows with a parameter map), status, free_memory. All inputs and outputs are absolute file paths; results are paths, never image bytes. Each generation is a job: the call waits up to "wait" seconds (default 45) and returns the paths, or a job id; then call wait (and cancel to stop it). ComfyUI runs one prompt at a time, so jobs queue.`

export interface McpHost {
  tools: readonly Tool[]
  instructions?: string
}

export function createMcpServer(host: McpHost): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: host.instructions ?? INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(host.tools) }))
  // each call is its own async handler, so a long `wait` never holds back the other calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(host.tools, request.params.name, request.params.arguments))
  return server
}
