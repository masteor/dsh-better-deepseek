import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterDeepSeekBridge: BetterDeepSeekBridgeService
  }
}

export interface Config {
  enableCors?: boolean
}

export class BetterDeepSeekBridgeService extends Service {
  static inject = ['webServer', 'agents']
  static Config: z<Config> = z.object({
    enableCors: z.boolean().default(true),
  })

  private readonly sseClients = new Set<ServerResponse>()
  private readonly latestAssistantTextBySession = new Map<string, string>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'betterDeepSeekBridge')

    // Unified Better-DeepSeek Router
    this.ctx.effect(() => {
      return this.ctx.webServer.register({
        kind: 'prefix',
        path: '/api/better-deepseek',
        handler: async (req, res) => {
          if (this.handleCors(req, res)) return

          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
          const pathname = url.pathname

          // 1. Handshake Ping Endpoint
          if (pathname === '/api/better-deepseek/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              active: true,
              version: '1.6.0',
              bridge_build: '0.2.0-dshfix.1',
              capabilities: ['filtered_sse', 'approvals', 'rag_inject', 'session_result'],
            }))
            return
          }

          // 2. Live SSE Event Stream Endpoint
          if (pathname === '/api/better-deepseek/events') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            })
            res.write(': connected\n\n')
            this.sseClients.add(res)

            req.on('close', () => {
              this.sseClients.delete(res)
            })
            return
          }

          // 3. Get Session Result (Polling / Fetching Final Response)
          if (pathname === '/api/better-deepseek/session.result' && req.method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            const finalText = this.latestAssistantTextBySession.get(sessionId) ?? ''
            const agent = this.ctx.agents.get(sessionId as SessionId)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              type: 'server-response',
              result: {
                ok: true,
                value: {
                  sessionId,
                  status: agent?.status ?? 'idle',
                  finalText,
                },
              },
            }))
            return
          }

          // 4. RPC Endpoints (session.create, session.prompt, session.cancel)
          if (req.method === 'POST') {
            const body = await this.readJsonBody(req)
            const rpcId = body.rpcId ?? `bd-rpc-${Date.now()}`

            // session.create
            if (pathname === '/api/better-deepseek/session.create') {
              try {
                const cwd = body.payload?.cwd ?? process.cwd()
                const sessionId = `session-${Date.now()}` as SessionId
                this.latestAssistantTextBySession.set(sessionId, '')

                const defaultModel = this.ctx.get('agentDefaultModel') as any
                const selection = defaultModel
                  ? defaultModel.currentSelection()
                  : { provider: 'deepseek-official', model: 'deepseek-chat' }

                const presets = this.ctx.get('agentPresets') as any
                let presetId: string | undefined
                if (presets) {
                  try {
                    const resolved = await presets.resolve(undefined)
                    presetId = resolved?.id
                  } catch {
                    // Ignore preset resolve failure
                  }
                }

                await this.ctx.agents.create({
                  sessionId,
                  meta: {
                    cwd,
                    ...(presetId !== undefined ? { agentPreset: presetId } : {}),
                  },
                  agentOptions: {
                    provider: selection.provider,
                    model: selection.model,
                  },
                  setup: async (agentCtx) => {
                    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
                    installModelSelection(agentCtx, selected)
                    if (presets && presetId) {
                      await presets.mount(agentCtx, presetId)
                    }
                  },
                })

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: {
                    ok: true,
                    value: { sessionId },
                  },
                }))
              } catch (err: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: {
                    ok: false,
                    error: { message: err?.message ?? 'Failed to create session' },
                  },
                }))
              }
              return
            }

            // session.prompt
            if (pathname === '/api/better-deepseek/session.prompt') {
              const sessionId = (body.payload?.sessionId ?? '') as SessionId
              const text = body.payload?.text ?? ''
              const agent = this.ctx.agents.get(sessionId)

              if (agent) {
                const userMsg = {
                  id: crypto.randomUUID(),
                  role: 'user',
                  source: { kind: 'user' },
                  content: [{ type: 'text', text }],
                } as unknown as UserMessage

                agent.followup(userMsg)

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: { ok: true, value: {} },
                }))
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: {
                    ok: false,
                    error: { message: `Session "${sessionId}" not found` },
                  },
                }))
              }
              return
            }

            // session.cancel
            if (pathname === '/api/better-deepseek/session.cancel') {
              const sessionId = (body.payload?.sessionId ?? '') as SessionId
              const agent = this.ctx.agents.get(sessionId)

              if (agent) {
                agent.cancel({ kind: 'user' })
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: { ok: true, value: { canceled: true } },
                }))
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result: {
                    ok: false,
                    error: { message: `Session "${sessionId}" not found` },
                  },
                }))
              }
              return
            }
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
        },
      })
    }, 'better-deepseek: gateway router')

    // 5. Event Listener Registrations
    this.setupEventListeners()
  }

  private handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.config.enableCors !== false) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return true
    }
    return false
  }

  private async readJsonBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  private setupEventListeners(): void {
    // Durable session event stream (committed assistant messages)
    this.ctx.effect(() => {
      return this.ctx.on('session/event', (session, event) => {
        if (event.type === 'assistant/message') {
          const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
          const text = data.message?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? ''
          if (text) {
            this.latestAssistantTextBySession.set(session.id, text)
            this.broadcast('assistant/message', {
              sessionId: session.id,
              text,
            })
          }
        }
      })
    }, 'better-deepseek: session event listener')

    // Live assistant token stream.
    // DSH >= 0.2.0 replaced the durable `assistant/chunk` session event with
    // transient `agent/assistant-stream` frames. The outward SSE contract
    // (`assistant/chunk` carrying { sessionId, delta }) is deliberately kept
    // unchanged, so the Better-DeepSeek extension needs no update.
    this.ctx.effect(() => {
      return this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
        const delta = frame.chunk.text
        if (!delta) return
        const sessionId = agent.id
        const current = this.latestAssistantTextBySession.get(sessionId) ?? ''
        this.latestAssistantTextBySession.set(sessionId, current + delta)
        this.broadcast('assistant/chunk', {
          sessionId,
          delta,
        })
      })
    }, 'better-deepseek: assistant stream listener')

    // Tool execution waterfalls (must call next() to delegate!)
    this.ctx.effect(() => {
      return this.ctx.on('tools/pre-execute', (exec, next) => {
        const sessionId = exec.agent?.id
        if (sessionId !== undefined) {
          this.broadcast('tool/call', {
            sessionId,
            tool: exec.name,
            args: exec.arguments,
          })
        }
        return next()
      })
    }, 'better-deepseek: tool pre-execute listener')

    this.ctx.effect(() => {
      return this.ctx.on('tools/post-execute', (exec, result, next) => {
        const sessionId = exec.agent?.id
        if (sessionId !== undefined) {
          this.broadcast('tool/result', {
            sessionId,
            tool: exec.name,
            output: result,
          })
        }
        return next()
      })
    }, 'better-deepseek: tool post-execute listener')

    // Agent turn stopping (turn/stopping & turn/complete with final text)
    this.ctx.effect(() => {
      return this.ctx.on('agent/turn-stopping', (payload) => {
        const finalText = this.latestAssistantTextBySession.get(payload.agent.id) ?? ''
        this.broadcast('turn/complete', {
          sessionId: payload.agent.id,
          turn: payload.turn,
          finalText,
        })
        this.broadcast('turn/stopping', {
          sessionId: payload.agent.id,
          turn: payload.turn,
        })
      })
    }, 'better-deepseek: turn stopping listener')
  }

  private broadcast(type: string, payload: unknown): void {
    const data = `data: ${JSON.stringify({ type, timestamp: Date.now(), payload })}\n\n`
    for (const client of this.sseClients) {
      client.write(data)
    }
  }
}

export default BetterDeepSeekBridgeService
