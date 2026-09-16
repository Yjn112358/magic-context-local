import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	MagicMutationWriter,
	serializeMutationValue,
	withMagicMutationAudit,
} from "./mutation-audit-pi";

describe("Magic Context mutation audit", () => {
	test("deduplicates snapshots and preserves before values with redaction", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mc-mutations-"));
		try {
			const writer = new MagicMutationWriter(directory);
			const event = {
				messages: [{ text: "original" }],
				authorization: "secret",
				inputTokens: 123,
			};
			const before = serializeMutationValue({ event, returned: null });
			event.messages[0].text = "modified";
			const after = serializeMutationValue({
				event,
				returned: { messages: [] },
			});
			await writer.write(
				"session-1",
				"context",
				before,
				after,
				"success",
				new Date().toISOString(),
				1,
			);
			await writer.write(
				"session-1",
				"context",
				before,
				after,
				"success",
				new Date().toISOString(),
				1,
			);
			expect(
				(await readdir(join(directory, "mutations", "blobs"))).length,
			).toBe(2);
			const rows = (
				await readFile(join(directory, "mutations", "session-1.jsonl"), "utf8")
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(rows.length).toBe(2);
			expect(rows[0].changed).toBe(true);
			expect(rows[0].invocationId).not.toBe(rows[1].invocationId);
			const snapshot = JSON.parse(
				await readFile(
					join(
						directory,
						"mutations",
						"blobs",
						`${rows[0].beforeRef.hash}.json`,
					),
					"utf8",
				),
			);
			expect(snapshot.event.messages[0].text).toBe("original");
			expect(snapshot.event.authorization).toBe("[REDACTED]");
			expect(snapshot.event.inputTokens).toBe(123);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("wraps only this API instance and preserves returns and thrown errors", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mc-audit-hooks-"));
		const oldEnabled = process.env.MAGIC_CONTEXT_MUTATION_AUDIT;
		const oldDirectory = process.env.PI_SESSION_AUDIT_DIR;
		try {
			process.env.MAGIC_CONTEXT_MUTATION_AUDIT = "1";
			process.env.PI_SESSION_AUDIT_DIR = directory;
			const handlers = new Map<
				string,
				(event: unknown, ctx: ExtensionContext) => unknown
			>();
			const commands = new Map<
				string,
				{ handler: (args: string, ctx: ExtensionContext) => unknown }
			>();
			const sent: unknown[] = [];
			const original = {
				on: (
					hook: string,
					handler: (event: unknown, ctx: ExtensionContext) => unknown,
				) => handlers.set(hook, handler),
				registerCommand: (
					name: string,
					options: {
						handler: (args: string, ctx: ExtensionContext) => unknown;
					},
				) => commands.set(name, options),
				sendUserMessage: (message: unknown) => {
					sent.push(message);
				},
			} as unknown as ExtensionAPI;
			const audited = withMagicMutationAudit(original);
			audited.on("context", async (event) => ({ messages: event.messages }));
			const ctx = {
				sessionManager: { getSessionId: () => "session-2" },
			} as unknown as ExtensionContext;
			const messages: never[] = [];
			expect(await handlers.get("context")?.({ messages }, ctx)).toEqual({
				messages,
			});
			const failure = new Error("handler failed");
			audited.on("tool_result", async () => {
				throw failure;
			});
			await expect(handlers.get("tool_result")?.({}, ctx)).rejects.toBe(
				failure,
			);
			const rows = (
				await readFile(join(directory, "mutations", "session-2.jsonl"), "utf8")
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(rows.map((row) => row.outcome)).toEqual(["success", "error"]);
			audited.registerCommand("inject-test", {
				description: "test",
				handler: async () => {
					await Promise.resolve();
					audited.sendUserMessage("injected prompt");
				},
			});
			await commands.get("inject-test")?.handler("", ctx);
			audited.on("session_shutdown", async () => {});
			await handlers.get("session_shutdown")?.({}, ctx);
			expect(sent).toEqual(["injected prompt"]);
			const apiRows = (
				await readFile(join(directory, "mutations", "session-2.jsonl"), "utf8")
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(apiRows.at(-1).hook).toBe("sendUserMessage");
			process.env.MAGIC_CONTEXT_MUTATION_AUDIT = "0";
			expect(withMagicMutationAudit(original)).toBe(original);
		} finally {
			if (oldEnabled === undefined)
				delete process.env.MAGIC_CONTEXT_MUTATION_AUDIT;
			else process.env.MAGIC_CONTEXT_MUTATION_AUDIT = oldEnabled;
			if (oldDirectory === undefined) delete process.env.PI_SESSION_AUDIT_DIR;
			else process.env.PI_SESSION_AUDIT_DIR = oldDirectory;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
