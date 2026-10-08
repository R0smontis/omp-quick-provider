import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = new URL("../extensions/quick-provider.ts", import.meta.url).href;
const quickProvider = (await import(EXT)).default;

// ── mock endpoint ────────────────────────────────────────────────────────────

const requests = [];
let server;
let base;

before(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
		const json = (body, status = 200) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const p = url.pathname;
		if (p === "/v1/models") return json({ object: "list", data: [{ id: "b-model" }, { id: "a-model", context_length: 64000 }] });
		if (p === "/noauth/v1/models") {
			if (req.headers.authorization !== "Bearer sk-test") return json({ error: "unauthorized" }, 401);
			return json({ data: [{ id: "secured" }] });
		}
		if (p === "/empty/v1/models") return json({ data: [] });
		if (p === "/bad/v1/models") return json({ data: [{ not_an_id: true }] });
		if (p === "/flaky/v1/models") return json({ error: "boom" }, 500);
		if (p === "/notjson/v1/models") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end("<html>nope</html>");
		}
		if (p === "/nested/v1/models") return json({ result: { items: [{ id: "nested-1" }] } });
		if (p === "/anthropic/v1/models") {
			if (req.headers["anthropic-version"] !== "2023-06-01") return json({ error: "missing version" }, 400);
			if (!url.searchParams.get("after_id")) {
				return json({ data: [{ id: "claude-1", display_name: "Claude One" }], has_more: true, last_id: "claude-1" });
			}
			return json({ data: [{ id: "claude-2" }], has_more: false });
		}
		if (p === "/v1beta/models") {
			if (url.searchParams.get("key") !== "gm-key") return json({ error: "missing key" }, 401);
			if (url.searchParams.get("pageToken") === "page2") {
				return json({ models: [{ name: "models/gemini-3-pro" }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }] });
			}
			return json({
				models: [{ name: "models/gemini-2-flash", displayName: "Gemini 2 Flash", inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"] }],
				nextPageToken: "page2",
			});
		}
		json({ error: "not found" }, 404);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ── harness ──────────────────────────────────────────────────────────────────

function makeHarness({ answers = [], selects = [], confirms = [], secrets = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	const providers = new Map();
	const unregistered = [];
	const command = {};
	const notifications = [];
	let secretIndex = 0;
	let secretComponent = null;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => answers.shift(),
			select: async () => (selects.length > 0 ? selects.shift() : undefined) ?? selects.default,
			confirm: async () => confirms.shift() ?? true,
			notify: (text, type) => notifications.push({ text, type }),
			custom: (factory) =>
				new Promise((resolve) => {
					queueMicrotask(() => {
						const done = (value) => resolve(value);
						secretComponent = factory({}, { fg: (_c, text) => text }, {}, done);
						const script = secrets[secretIndex++] ?? "";
						for (const chunk of script) secretComponent.handleInput(chunk);
					});
				}),
		},
		modelRegistry: {
			getAll: () => [],
			getApiKeyForProvider: async () => undefined,
		},
	};
	const pi = {
		setLabel() {},
		registerProvider: (id, config) => providers.set(id, config),
		unregisterProvider: (id) => {
			unregistered.push(id);
			providers.delete(id);
		},
		registerCommand: (_id, def) => Object.assign(command, def),
	};
	quickProvider(pi);
	return { dir, providers, unregistered, command, notifications, ctx, getSecretComponent: () => secretComponent };
}

const storeFile = (dir) => join(dir, "quick-providers.json");
const readStore = (dir) => JSON.parse(readFileSync(storeFile(dir), "utf8")).providers;

const OPENAI = "openai-completions — /chat/completions（最常见）";
const ANTHROPIC = "anthropic-messages — /v1/messages（Claude 系）";
const GOOGLE = "google-generative-ai — Gemini 原生";

// ── tests ────────────────────────────────────────────────────────────────────

test("add flow: writes store, registers provider, discovers models, masks key", async () => {
	const h = makeHarness({
		answers: [`${base}/v1`, "smoke", "", ""],
		selects: [OPENAI],
		secrets: ["sk-test\r"],
	});
	await h.command.handler("add", h.ctx);
	assert.deepEqual(readStore(h.dir), [{ id: "smoke", baseUrl: `${base}/v1`, api: "openai-completions", key: "sk-test" }]);
	const provider = h.providers.get("smoke");
	assert.equal(provider.baseUrl, `${base}/v1`);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.oauth.name, "smoke · API Key");
	const models = await provider.fetchDynamicModels("sk-test");
	assert.deepEqual(models.map((m) => m.id), ["a-model", "b-model"]);
	assert.equal(models.find((m) => m.id === "a-model").contextWindow, 64000);
	const rendered = h.getSecretComponent().render(80).join("\n");
	assert.ok(!rendered.includes("sk-test"), "masked render must not echo the key");
	assert.ok(rendered.includes("•"), "masked render shows dots");
	assert.ok(h.notifications.some((n) => n.text.includes("已发现 2 个模型")));
});

test("add flow: Esc in key prompt aborts without writing", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "esc"], selects: [OPENAI], secrets: ["\x1b"] });
	await h.command.handler("add", h.ctx);
	assert.equal(existsSync(storeFile(h.dir)), false);
	assert.equal(h.providers.size, 0);
});

test("add flow: async factory arity — component created via ui.custom receives done", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "arity"], selects: [OPENAI], secrets: ["k\r"] });
	await h.command.handler("add", h.ctx);
	assert.ok(h.getSecretComponent(), "ui.custom component was created");
});

test("corrupt store is quarantined, not overwritten", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "after-corrupt", "", ""], selects: [OPENAI], secrets: ["\r"] });
	writeFileSync(storeFile(h.dir), "{broken-json");
	await h.command.handler("add", h.ctx);
	const backups = readdirSync(h.dir).filter((f) => f.startsWith("quick-providers.json.corrupt-"));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(h.dir, backups[0]), "utf8"), "{broken-json");
	assert.deepEqual(readStore(h.dir).map((e) => e.id), ["after-corrupt"]);
	assert.ok(h.notifications.some((n) => n.text.includes("已备份")));
});

test("unreadable store (EISDIR) refuses mutation instead of wiping", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "nope", "", ""], selects: [OPENAI], secrets: ["\r"] });
	mkdirSync(storeFile(h.dir));
	await h.command.handler("add", h.ctx);
	assert.ok(statSync(storeFile(h.dir)).isDirectory(), "store path left intact");
	assert.equal(h.providers.size, 0);
	assert.ok(h.notifications.some((n) => n.type === "error"));
});

test("peer writes during dialogs are preserved (re-read before write)", async () => {
	const h = makeHarness({
		answers: [`${base}/v1`, "mine", "", ""],
		selects: [OPENAI],
		secrets: ["\r"],
	});
	// simulate another omp instance writing between dialogs
	process.env.PI_CODING_AGENT_DIR = h.dir;
	const origSelect = h.ctx.ui.select;
	h.ctx.ui.select = async (...args) => {
		writeFileSync(storeFile(h.dir), JSON.stringify({ version: 2, providers: [{ id: "peer", baseUrl: "https://peer.example/v1", api: "openai-completions" }] }));
		return origSelect(...args);
	};
	await h.command.handler("add", h.ctx);
	assert.deepEqual(readStore(h.dir).map((e) => e.id), ["mine", "peer"]);
});

test("overwrite unregisters first so stale key/models cannot linger", async () => {
	const h = makeHarness({
		answers: [`${base}/v1`, "dup", `${base}/v1`, "dup"],
		selects: [OPENAI, OPENAI],
		secrets: ["first\r", "second\r"],
	});
	await h.command.handler("add", h.ctx);
	await h.command.handler("add", h.ctx);
	assert.deepEqual(h.unregistered, ["dup"]);
	assert.equal(h.providers.get("dup").apiKey, "second");
	assert.deepEqual(readStore(h.dir).map((e) => e.id), ["dup"]);
});

test("ID owned by another source requires confirmation", async () => {
	const h = makeHarness({
		answers: [`${base}/v1`, "anthropic", "", ""],
		selects: [OPENAI],
		secrets: ["\r"],
		confirms: [false],
	});
	h.ctx.modelRegistry.getAll = () => [{ provider: "anthropic", id: "claude" }];
	await h.command.handler("add", h.ctx);
	assert.equal(existsSync(storeFile(h.dir)), false, "declined overwrite writes nothing");
});

test("delete removes provider and unregisters (remove alias)", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "gone", "", ""], selects: [OPENAI], secrets: ["\r"] });
	await h.command.handler("add", h.ctx);
	await h.command.handler("delete gone", h.ctx);
	assert.deepEqual(readStore(h.dir), []);
	assert.deepEqual(h.unregistered, ["gone"]);
	assert.ok(h.notifications.some((n) => n.text.includes("已删除 gone")));
});

test("command routing rejects unknown subcommands and lists delete", async () => {
	const h = makeHarness();
	await h.command.handler("bogus", h.ctx);
	assert.ok(h.notifications.some((n) => n.text.includes("未知子命令")));
	const completions = h.command.getArgumentCompletions("del");
	assert.deepEqual(completions, [{ value: "delete", label: "delete" }]);
});

test("discovery: non-2xx, bad JSON, all-invalid rows all throw (stale preserved)", async () => {
	const cases = [
		{ id: "flaky", path: "flaky/v1", match: /HTTP 500/ },
		{ id: "notjson", path: "notjson/v1", match: /不是 JSON/ },
		{ id: "bad", path: "bad/v1", match: /全部无效/ },
	];
	for (const c of cases) {
		const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			storeFile(dir),
			JSON.stringify({
				version: 2,
				providers: [{ id: c.id, baseUrl: `${base}/${c.path}`, api: "openai-completions" }],
			}),
		);
		const providers = new Map();
		quickProvider({
			setLabel() {},
			registerProvider: (pid, cfg) => providers.set(pid, cfg),
			unregisterProvider() {},
			registerCommand() {},
		});
		await assert.rejects(providers.get(c.id).fetchDynamicModels(undefined), c.match, c.id);
	}
	// explicit empty list stays authoritative empty
	{
		const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			storeFile(dir),
			JSON.stringify({
				version: 2,
				providers: [{ id: "empty", baseUrl: `${base}/empty/v1`, api: "openai-completions" }],
			}),
		);
		const providers = new Map();
		quickProvider({
			setLabel() {},
			registerProvider: (pid, cfg) => providers.set(pid, cfg),
			unregisterProvider() {},
			registerCommand() {},
		});
		assert.deepEqual(await providers.get("empty").fetchDynamicModels(undefined), []);
	}
	// nested envelope + bearer header
	{
		const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			storeFile(dir),
			JSON.stringify({
				version: 2,
				providers: [{ id: "nested", baseUrl: `${base}/nested/v1`, api: "openai-completions" }],
			}),
		);
		const providers = new Map();
		quickProvider({
			setLabel() {},
			registerProvider: (pid, cfg) => providers.set(pid, cfg),
			unregisterProvider() {},
			registerCommand() {},
		});
		const models = await providers.get("nested").fetchDynamicModels("sk-test");
		assert.deepEqual(models.map((m) => m.id), ["nested-1"]);
		const last = requests[requests.length - 1];
		assert.equal(last.headers.authorization, "Bearer sk-test");
	}
});

test("discovery: anthropic pagination + headers; google pagination + capability filter", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		storeFile(dir),
		JSON.stringify({
			version: 2,
			providers: [
				{ id: "anth", baseUrl: `${base}/anthropic`, api: "anthropic-messages" },
				{ id: "gem", baseUrl: `${base}/v1beta`, api: "google-generative-ai" },
			],
		}),
	);
	const providers = new Map();
	quickProvider({ setLabel() {}, registerProvider: (pid, cfg) => providers.set(pid, cfg), unregisterProvider() {}, registerCommand() {} });

	const anth = await providers.get("anth").fetchDynamicModels("ak");
	assert.deepEqual(anth.map((m) => m.id), ["claude-1", "claude-2"]);
	assert.equal(anth[0].name, "Claude One");

	const gem = await providers.get("gem").fetchDynamicModels("gm-key");
	assert.deepEqual(gem.map((m) => m.id), ["gemini-2-flash", "gemini-3-pro"]);
	assert.equal(gem.find((m) => m.id === "gemini-2-flash").contextWindow, 1048576);

	const gemReq = requests.filter((r) => r.path === "/v1beta/models");
	assert.ok(gemReq.every((r) => r.headers["x-goog-api-key"] === "gm-key"));
	assert.ok(gemReq.some((r) => r.query.pageToken === "page2"));
});

test("URL validation: protocol-aware normalization and rejection of query/hash/userinfo", async () => {
	const cases = [
		{ url: "https://gem.example.com", pick: GOOGLE, expect: "https://gem.example.com/v1beta" },
		{ url: "https://claude.example.com/v1", pick: ANTHROPIC, expect: "https://claude.example.com" },
		{ url: "https://gw.example.com", pick: OPENAI, expect: "https://gw.example.com/v1" },
	];
	for (const [i, c] of cases.entries()) {
		const hh = makeHarness({ answers: [c.url, `p${i}`, "", ""], selects: [c.pick], secrets: ["\r"] });
		await hh.command.handler("add", hh.ctx);
		const entry = readStore(hh.dir)[0];
		assert.equal(entry.baseUrl, c.expect, `${c.url} → ${entry.baseUrl}`);
	}
	for (const bad of ["https://host/v1?x=1", "https://host/v1#frag", "https://u:p@host/v1"]) {
		const hh = makeHarness({ answers: [bad, "bad", "", ""], selects: [OPENAI], secrets: ["\r"] });
		await hh.command.handler("add", hh.ctx);
		assert.equal(existsSync(storeFile(hh.dir)), false, `${bad} must be rejected`);
		assert.ok(hh.notifications.some((n) => n.type === "error"));
	}
});

test("refresh reports real discovery outcome, not just a fulfilled promise", async () => {
	const h = makeHarness({ answers: [`${base}/v1`, "smoke", "", ""], selects: [OPENAI], secrets: ["\r"] });
	await h.command.handler("add", h.ctx);
	h.notifications.length = 0;
	const provider = h.providers.get("smoke");
	const mid = {
		...h.ctx,
		modelRegistry: {
			...h.ctx.modelRegistry,
			getAll: () => [{ provider: "smoke", id: "a-model" }],
			refreshDiscoverableProviders: async () => {
				await h.providers.get("smoke").fetchDynamicModels("sk-test");
			},
		},
	};
	await h.command.handler("refresh smoke", mid);
	assert.ok(h.notifications.some((n) => n.text.includes("smoke · 模型 1")), JSON.stringify(h.notifications));
	// now break the endpoint: point it at a flaky path and refresh again
	writeFileSync(storeFile(h.dir), JSON.stringify({ version: 2, providers: [{ id: "smoke", baseUrl: `${base}/flaky`, api: "openai-completions" }] }));
	await h.command.handler("refresh smoke", mid);
	assert.ok(h.notifications.some((n) => n.text.includes("拉取失败")), JSON.stringify(h.notifications));
});
