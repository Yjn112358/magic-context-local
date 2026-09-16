import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const hooks = new Set([
	"input",
	"before_agent_start",
	"context",
	"tool_call",
	"tool_result",
	"before_provider_headers",
	"before_provider_request",
	"session_before_compact",
	"session_before_tree",
]);
const secretKey = /authorization|api[-_]?key|token|cookie|secret|password/i;

export function serializeMutationValue(value: unknown, redact = true): string {
	const ancestors: object[] = [];
	return JSON.stringify(value, function (key, child: unknown) {
		if (redact && secretKey.test(key) && !/tokens$/i.test(key))
			return "[REDACTED]";
		if (typeof child === "bigint") return String(child);
		if (
			child === undefined ||
			typeof child === "function" ||
			typeof child === "symbol"
		)
			return null;
		if (child instanceof Error)
			return { name: child.name, message: child.message };
		if (child && typeof child === "object") {
			while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
			if (ancestors.includes(child)) return "[CIRCULAR]";
			ancestors.push(child);
		}
		return child;
	});
}

export class MagicMutationWriter {
	private queue: Promise<void> = Promise.resolve();
	private readonly sourceVersion = readFile(
		new URL("../package.json", import.meta.url),
		"utf8",
	)
		.then((raw) => (JSON.parse(raw) as { version: string }).version)
		.catch(() => "unknown");
	constructor(private readonly directory: string) {}

	flush(): Promise<void> {
		return this.queue;
	}

	write(
		sessionId: string,
		hook: string,
		before: string,
		after: string,
		outcome: string,
		startedAt: string,
		durationMs: number,
		handlerIndex = 0,
	): Promise<void> {
		if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
			return Promise.reject(new Error("Invalid audit session ID"));
		const save = async () => {
			const blobs = join(this.directory, "mutations", "blobs");
			await mkdir(blobs, { recursive: true });
			const snapshot = async (content: string) => {
				const hash = createHash("sha256").update(content).digest("hex");
				await writeFile(join(blobs, `${hash}.json`), content, {
					encoding: "utf8",
					flag: "wx",
				}).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				});
				return { hash, bytes: Buffer.byteLength(content) };
			};
			const beforeRef = await snapshot(before);
			const afterRef = await snapshot(after);
			await appendFile(
				join(this.directory, "mutations", `${sessionId}.jsonl`),
				`${JSON.stringify({
					auditVersion: 1,
					event: "extension_mutation",
					sessionId,
					source: "magic-context",
					sourceVersion: await this.sourceVersion,
					sourceEntry: import.meta.url,
					invocationId: randomUUID(),
					hook,
					handlerIndex,
					startedAt,
					timestamp: new Date().toISOString(),
					durationMs,
					outcome,
					changed: beforeRef.hash !== afterRef.hash,
					beforeRef,
					afterRef,
				})}\n`,
				"utf8",
			);
		};
		const task = this.queue.then(save);
		this.queue = task.catch(() => undefined);
		return task;
	}
}

// This facade wraps only handlers registered by this Magic Context instance.
export function withMagicMutationAudit(pi: ExtensionAPI): ExtensionAPI {
	if (process.env.MAGIC_CONTEXT_MUTATION_AUDIT !== "1") return pi;
	const directory = resolve(
		process.env.PI_SESSION_AUDIT_DIR?.trim() ||
			join(homedir(), ".pi", "agent", "session-audit"),
	);
	const writer = new MagicMutationWriter(directory);
	const contexts = new AsyncLocalStorage<ExtensionContext>();
	const handlerCounts = new Map<string, number>();
	const redact = process.env.PI_SESSION_AUDIT_REDACT !== "0";
	const warn = (error: unknown) =>
		console.warn("[magic-context] mutation audit failed:", error);
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "sendMessage" || property === "sendUserMessage") {
				return (...args: unknown[]) => {
					const ctx = contexts.getStore();
					const startedAt = new Date().toISOString();
					let captured: { sessionId: string; after: string } | undefined;
					if (ctx) {
						try {
							captured = {
								sessionId: ctx.sessionManager.getSessionId(),
								after: serializeMutationValue(
									{
										event: { api: property, args },
										returned: null,
										error: null,
									},
									redact,
								),
							};
						} catch (error) {
							warn(error);
						}
					}
					const result = Reflect.apply(target[property], target, args);
					if (!ctx)
						warn(
							new Error(
								`Cannot attribute ${String(property)} without an active extension context`,
							),
						);
					if (captured) {
						try {
							const before = serializeMutationValue(
								{ event: {}, returned: null, error: null },
								redact,
							);
							void writer
								.write(
									captured.sessionId,
									String(property),
									before,
									captured.after,
									"success",
									startedAt,
									0,
								)
								.catch(warn);
						} catch (error) {
							warn(error);
						}
					}
					return result;
				};
			}
			if (property === "registerCommand") {
				return (
					name: string,
					options: {
						handler: (args: string, ctx: ExtensionContext) => unknown;
					},
				) => {
					return Reflect.apply(target.registerCommand, target, [
						name,
						{
							...options,
							handler: (args: string, ctx: ExtensionContext) =>
								contexts.run(ctx, () => options.handler(args, ctx)),
						},
					]);
				};
			}
			if (property !== "on") return Reflect.get(target, property, receiver);
			return (
				hook: string,
				handler: (event: unknown, ctx: ExtensionContext) => unknown,
			) => {
				const handlerIndex = handlerCounts.get(hook) ?? 0;
				handlerCounts.set(hook, handlerIndex + 1);
				if (hook === "session_shutdown")
					return Reflect.apply(target.on, target, [
						hook,
						async (event: unknown, ctx: ExtensionContext) => {
							try {
								return await contexts.run(ctx, () => handler(event, ctx));
							} finally {
								await writer.flush();
							}
						},
					]);
				if (!hooks.has(hook))
					return Reflect.apply(target.on, target, [
						hook,
						(event: unknown, ctx: ExtensionContext) =>
							contexts.run(ctx, () => handler(event, ctx)),
					]);
				return Reflect.apply(target.on, target, [
					hook,
					async (event: unknown, ctx: ExtensionContext) => {
						let before: string;
						let sessionId: string;
						try {
							sessionId = ctx.sessionManager.getSessionId();
							before = serializeMutationValue(
								{ event, returned: null, error: null },
								redact,
							);
						} catch (error) {
							warn(error);
							return handler(event, ctx);
						}
						const start = Date.now();
						const startedAt = new Date(start).toISOString();
						let result: unknown;
						let failure: unknown;
						let failed = false;
						try {
							result = await contexts.run(ctx, () => handler(event, ctx));
						} catch (error) {
							failed = true;
							failure = error;
						}
						try {
							const after = serializeMutationValue(
								{
									event,
									returned: result ?? null,
									error: failed ? failure : null,
								},
								redact,
							);
							await writer.write(
								sessionId,
								hook,
								before,
								after,
								failed ? "error" : "success",
								startedAt,
								Date.now() - start,
								handlerIndex,
							);
						} catch (error) {
							warn(error);
						}
						if (failed) throw failure;
						return result;
					},
				]);
			};
		},
	});
}
