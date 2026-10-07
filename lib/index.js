import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
//#region lib/types/index.js
var BetterDeepSeekBridgeService = class extends Service {
	config;
	static inject = ["webServer", "agents"];
	static Config = z.object({ enableCors: z.boolean().default(true) });
	sseClients = /* @__PURE__ */ new Set();
	latestAssistantTextBySession = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, "betterDeepSeekBridge");
		this.config = config;
		this.ctx.effect(() => {
			return this.ctx.webServer.register({
				kind: "prefix",
				path: "/api/better-deepseek",
				handler: async (req, res) => {
					if (this.handleCors(req, res)) return;
					if (req.method === "POST" && !this.isJsonRequest(req)) {
						// Тело с application/json нельзя отправить межсайтово как
						// "простой запрос": браузер обязан сделать префлайт, который
						// отклоняет проверка origin выше. Без этого враждебная
						// страница дошла бы до session.create/session.prompt простым
						// POST с text/plain — обработчик парсит тело независимо от
						// объявленного типа.
						res.writeHead(415, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							type: "server-response",
							result: {
								ok: false,
								error: { message: "Content-Type must be application/json" }
							}
						}));
						return;
					}
					const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
					const pathname = url.pathname;
					if (pathname === "/api/better-deepseek/ping") {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							active: true,
							version: "1.6.0",
							bridge_build: "0.2.0-dshfix.2",
							capabilities: [
								"filtered_sse",
								"approvals",
								"rag_inject",
								"session_result"
							]
						}));
						return;
					}
					if (pathname === "/api/better-deepseek/events") {
						res.writeHead(200, {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							"Connection": "keep-alive"
						});
						res.write(": connected\n\n");
						this.sseClients.add(res);
						req.on("close", () => {
							this.sseClients.delete(res);
						});
						return;
					}
					if (pathname === "/api/better-deepseek/session.result" && req.method === "GET") {
						const sessionId = url.searchParams.get("sessionId") ?? "";
						const finalText = this.latestAssistantTextBySession.get(sessionId) ?? "";
						const agent = this.ctx.agents.get(sessionId);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							type: "server-response",
							result: {
								ok: true,
								value: {
									sessionId,
									status: agent?.status ?? "idle",
									finalText
								}
							}
						}));
						return;
					}
					if (req.method === "POST") {
						const body = await this.readJsonBody(req);
						const rpcId = body.rpcId ?? `bd-rpc-${Date.now()}`;
						if (pathname === "/api/better-deepseek/session.create") {
							try {
								const cwd = body.payload?.cwd ?? process.cwd();
								const sessionId = `session-${Date.now()}`;
								this.latestAssistantTextBySession.set(sessionId, "");
								const defaultModel = this.ctx.get("agentDefaultModel");
								const selection = defaultModel ? defaultModel.currentSelection() : {
									provider: "deepseek-official",
									model: "deepseek-chat"
								};
								const presets = this.ctx.get("agentPresets");
								let presetId;
								if (presets) try {
									presetId = (await presets.resolve(void 0))?.id;
								} catch {}
								await this.ctx.agents.create({
									sessionId,
									meta: {
										cwd,
										...presetId !== void 0 ? { agentPreset: presetId } : {}
									},
									agentOptions: {
										provider: selection.provider,
										model: selection.model
									},
									setup: async (agentCtx) => {
										installModelSelection(agentCtx, {
											current: selection,
											assembled: void 0
										});
										if (presets && presetId) await presets.mount(agentCtx, presetId);
									}
								});
								res.writeHead(200, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: true,
										value: { sessionId }
									}
								}));
							} catch (err) {
								res.writeHead(500, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: false,
										error: { message: err?.message ?? "Failed to create session" }
									}
								}));
							}
							return;
						}
						if (pathname === "/api/better-deepseek/session.prompt") {
							const sessionId = body.payload?.sessionId ?? "";
							const text = body.payload?.text ?? "";
							const agent = this.ctx.agents.get(sessionId);
							if (agent) {
								const userMsg = {
									id: crypto.randomUUID(),
									role: "user",
									source: { kind: "user" },
									content: [{
										type: "text",
										text
									}]
								};
								agent.followup(userMsg);
								res.writeHead(200, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: true,
										value: {}
									}
								}));
							} else {
								res.writeHead(404, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: false,
										error: { message: `Session "${sessionId}" not found` }
									}
								}));
							}
							return;
						}
						if (pathname === "/api/better-deepseek/session.cancel") {
							const sessionId = body.payload?.sessionId ?? "";
							const agent = this.ctx.agents.get(sessionId);
							if (agent) {
								agent.cancel({ kind: "user" });
								res.writeHead(200, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: true,
										value: { canceled: true }
									}
								}));
							} else {
								res.writeHead(404, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result: {
										ok: false,
										error: { message: `Session "${sessionId}" not found` }
									}
								}));
							}
							return;
						}
					}
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("not found");
				}
			});
		}, "better-deepseek: gateway router");
		this.setupEventListeners();
	}
	handleCors(req, res) {
		if (this.config.enableCors !== false) {
			// Только браузерным расширениям разрешено читать ответы. Веб-страница
			// не получает Access-Control-Allow-Origin вовсе, поэтому её префлайт
			// отклоняется браузером и ни читать, ни мутировать она не может.
			const origin = req.headers.origin;
			if (typeof origin === "string" && this.isExtensionOrigin(origin)) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Vary", "Origin");
			}
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return true;
		}
		return false;
	}
	isExtensionOrigin(origin) {
		return /^(chrome|moz|safari-web)-extension:\/\//i.test(origin);
	}
	isJsonRequest(req) {
		const raw = req.headers["content-type"];
		if (typeof raw !== "string") return false;
		return raw.split(";")[0].trim().toLowerCase() === "application/json";
	}
	async readJsonBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	setupEventListeners() {
		this.ctx.effect(() => {
			return this.ctx.on("session/event", (session, event) => {
				if (event.type === "assistant/message") {
					const text = event.data.message?.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
					if (text) {
						this.latestAssistantTextBySession.set(session.id, text);
						this.broadcast("assistant/message", {
							sessionId: session.id,
							text
						});
					}
				}
			});
		}, "better-deepseek: session event listener");
		// Live assistant token stream.
		// DSH >= 0.2.0 dropped the durable `assistant/chunk` session event in favour
		// of transient `agent/assistant-stream` frames. The outward SSE contract
		// (`assistant/chunk` with { sessionId, delta }) is deliberately unchanged so
		// the Better-DeepSeek extension needs no update.
		this.ctx.effect(() => {
			return this.ctx.on("agent/assistant-stream", ({ agent, frame }) => {
				if (frame.type !== "chunk" || frame.chunk.type !== "text-delta") return;
				const delta = frame.chunk.text;
				if (!delta) return;
				const sessionId = agent.id;
				const current = this.latestAssistantTextBySession.get(sessionId) ?? "";
				this.latestAssistantTextBySession.set(sessionId, current + delta);
				this.broadcast("assistant/chunk", {
					sessionId,
					delta
				});
			});
		}, "better-deepseek: assistant stream listener");
		this.ctx.effect(() => {
			return this.ctx.on("tools/pre-execute", (exec, next) => {
				const sessionId = exec.agent?.id;
				if (sessionId !== void 0) this.broadcast("tool/call", {
					sessionId,
					tool: exec.name,
					args: exec.arguments
				});
				return next();
			});
		}, "better-deepseek: tool pre-execute listener");
		this.ctx.effect(() => {
			return this.ctx.on("tools/post-execute", (exec, result, next) => {
				const sessionId = exec.agent?.id;
				if (sessionId !== void 0) this.broadcast("tool/result", {
					sessionId,
					tool: exec.name,
					output: result
				});
				return next();
			});
		}, "better-deepseek: tool post-execute listener");
		this.ctx.effect(() => {
			return this.ctx.on("agent/turn-stopping", (payload) => {
				const finalText = this.latestAssistantTextBySession.get(payload.agent.id) ?? "";
				this.broadcast("turn/complete", {
					sessionId: payload.agent.id,
					turn: payload.turn,
					finalText
				});
				this.broadcast("turn/stopping", {
					sessionId: payload.agent.id,
					turn: payload.turn
				});
			});
		}, "better-deepseek: turn stopping listener");
	}
	broadcast(type, payload) {
		const data = `data: ${JSON.stringify({
			type,
			timestamp: Date.now(),
			payload
		})}\n\n`;
		for (const client of this.sseClients) client.write(data);
	}
};
//#endregion
export { BetterDeepSeekBridgeService, BetterDeepSeekBridgeService as default };
