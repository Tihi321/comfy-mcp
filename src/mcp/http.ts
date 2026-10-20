import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './server'
import type { McpHost } from './server'

/**
 * The MCP server over Streamable HTTP on 127.0.0.1: stateful sessions (one SDK `Server` and transport each), a Host/Origin allow-list,
 * an optional bearer token. Copied from VN Studio `src/engine/mcp/http.ts`. Every request is its own async call: a `wait` in one
 * session does not block a `status` in another.
 */

export interface McpHttpStatus {
  running: boolean
  /** e.g. http://127.0.0.1:7460/mcp while running. */
  url: string | null
  /** Set when the server could not start (the port is in use, ...). */
  error?: string
  sessions: number
}

export interface McpHttpServerOptions {
  host: McpHost
  /** Port on 127.0.0.1; 0 picks a free one. */
  port: number
  /** Bearer token; empty or missing: no auth. */
  token?: string | null
  /** Called whenever running, error or the session count change. */
  onStatus?: (status: McpHttpStatus) => void
  log?: (msg: string) => void
}

const MAX_BODY = 64 * 1024 * 1024

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

interface Session {
  server: Server
  transport: StreamableHTTPServerTransport
}

export class McpHttpServer {
  private http: HttpServer | null = null
  private sessions = new Map<string, Session>()
  private error: string | undefined
  private port = 0

  constructor(private readonly opts: McpHttpServerOptions) {}

  // ---- lifecycle ----

  getStatus(): McpHttpStatus {
    const running = this.http !== null
    return { running, url: this.url(), ...(this.error ? { error: this.error } : {}), sessions: this.sessions.size }
  }

  url(): string | null {
    return this.http ? `http://127.0.0.1:${this.port}/mcp` : null
  }

  /** Starts listening. Never throws: a failure (the port is in use) ends up in `status.error`. */
  async start(): Promise<McpHttpStatus> {
    if (this.http) return this.getStatus()
    this.error = undefined
    const http = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.opts.log?.(`MCP request failed: ${e instanceof Error ? e.message : String(e)}`)
        if (!res.headersSent) this.rpcError(res, 500, -32603, 'Internal server error')
        else res.end()
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(this.opts.port, '127.0.0.1', () => {
          http.off('error', reject)
          resolve()
        })
      })
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      this.error = err.code === 'EADDRINUSE' ? `Port ${this.opts.port} is already in use.` : `Could not start the MCP server: ${err.message}`
      this.opts.log?.(this.error)
      http.close()
      this.emit()
      return this.getStatus()
    }
    http.on('error', (e) => this.opts.log?.(`MCP http error: ${e.message}`))
    this.port = (http.address() as AddressInfo).port
    this.http = http
    this.emit()
    return this.getStatus()
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((s) => s.transport.close().catch(() => undefined)))
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    }
    this.error = undefined
    this.emit()
  }

  private emit(): void {
    this.opts.onStatus?.(this.getStatus())
  }

  // ---- HTTP ----

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  private rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
    this.json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers)
  }

  private allowedHosts(): string[] {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
  }

  private hostAllowed(req: IncomingMessage): boolean {
    if (!this.allowedHosts().includes((req.headers.host ?? '').toLowerCase())) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      try {
        if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) return false
      } catch {
        return false
      }
    }
    return true
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.opts.token
    if (!token) return true
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
    return m !== null && safeEqual(m[1]!.trim(), token)
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const b = chunk as Buffer
      size += b.length
      if (size > MAX_BODY) throw new Error('Request body too large')
      chunks.push(b)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return this.json(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' })
    if (!this.hostAllowed(req)) return this.rpcError(res, 403, -32000, 'Forbidden: invalid Host or Origin header.')
    if (!this.authorized(req)) return this.rpcError(res, 401, -32001, 'Unauthorized: missing or invalid bearer token.', { 'WWW-Authenticate': 'Bearer' })
    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await this.readBody(req)
      } catch (e) {
        return this.rpcError(res, 400, -32700, `Parse error: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (sessionId) {
        const s = this.sessions.get(sessionId)
        if (!s) return this.rpcError(res, 404, -32001, 'Session not found. Initialize a new session.')
        return s.transport.handleRequest(req, res, body)
      }
      if (!(Array.isArray(body) ? body.some(isInitialize) : isInitialize(body))) return this.rpcError(res, 400, -32000, 'Bad Request: no session id. Send initialize first.')
      const s = this.createSession()
      await s.server.connect(s.transport)
      return s.transport.handleRequest(req, res, body)
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) return this.rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required.')
      const s = this.sessions.get(sessionId)
      if (!s) return this.rpcError(res, 404, -32001, 'Session not found.')
      return s.transport.handleRequest(req, res)
    }
    res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
  }

  // ---- sessions ----

  private createSession(): Session {
    const server = createMcpServer(this.opts.host)
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, session)
        this.emit()
      }
    })
    const session: Session = { server, transport }
    transport.onclose = () => {
      const id = transport.sessionId
      if (id && this.sessions.delete(id)) this.emit()
    }
    return session
  }
}

function isInitialize(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { method?: unknown }).method === 'initialize'
}
