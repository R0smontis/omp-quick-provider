import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

/**
 * quick-provider — 弹窗式快捷添加 / 管理 API 供应商（base URL + key），无需手改 models.yml。
 *
 * 每个条目在扩展加载时注册：
 * - fetchDynamicModels：按协议拉取模型目录（宿主 SQLite 缓存 24h，/qkprovider refresh 强制刷新）。
 *   失败必须抛错 —— 宿主把「成功但空」视为权威空目录并剪掉该 provider 的全部已发现模型
 *   （表现为 /model 里突然消失）；抛错则保留上次目录（stale）。仅当端点明确返回空列表时返回 []。
 * - oauth：/login <id> 走宿主登录流，密钥存入 omp 凭据库。
 * - key：可选，存本扩展 JSON（0600）。注意宿主凭据链里「配置键」优先于 /login 存储：
 *   向导里填了 key 就用它，要换成 /login 得先删掉或覆盖该条目。
 *
 * 存储：<agentDir>/quick-providers.json（原子写；文件损坏先备份再继续，绝不静默覆盖）
 * 命令：/qkprovider [add|list|remove|delete|refresh]，delete 与 remove 等价。
 */

type ApiChoice = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

const API_CHOICES: ReadonlyArray<{ value: ApiChoice; label: string }> = [
	{ value: "openai-completions", label: "openai-completions — /chat/completions（最常见）" },
	{ value: "openai-responses", label: "openai-responses — /responses" },
	{ value: "anthropic-messages", label: "anthropic-messages — /v1/messages（Claude 系）" },
	{ value: "google-generative-ai", label: "google-generative-ai — Gemini 原生" },
];

/** 宿主对 fetchDynamicModels 的上限是 15s（RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS）。 */
const DISCOVERY_TIMEOUT_MS = 12_000;
/**
 * 目录上限：截断按 id 排序取前 N，取舍是确定性的（同一端点每次结果一致），
 * 因此不会在刷新之间反复增删模型。
 */
const MAX_DISCOVERED_MODELS = 1000;
const STORE_VERSION = 2;

interface StoredProvider {
	id: string;
	baseUrl: string;
	api: ApiChoice;
	/** 字面量 key 或环境变量名；留空则走 /login <id> */
	key?: string;
	/** 静态备用模型 id（端点不支持 /models 时的兜底） */
	models?: string[];
	/** 以下为发现模型的默认值覆盖 */
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

interface RegistryRefresh {
	refreshDiscoverableProviders?(providerIds: Iterable<string>, strategy?: "online" | "online-if-uncached"): Promise<void>;
	refreshProvider?(providerId: string, strategy?: "online" | "online-if-uncached"): Promise<void>;
}

// ── 存储 ─────────────────────────────────────────────────────────────────────

/**
 * 存储路径。对齐宿主 getAgentDir() 的策略（PI_CODING_AGENT_DIR → 配置文件根；
 * Linux/macOS 上 XDG 迁移后的 <XDG_DATA_HOME>/omp），不重复实现整个目录策略，
 * 只覆盖 omp 会用到的取值。
 */
function storePath(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) return join(override, "quick-providers.json");
	if (process.platform === "linux" || process.platform === "darwin") {
		const xdg = process.env.XDG_DATA_HOME;
		if (xdg) {
			const root = join(xdg, "omp");
			if (existsSync(root)) return join(root, "quick-providers.json");
		}
	}
	const configDir = process.env.PI_CONFIG_DIR || ".omp";
	return join(homedir(), configDir, "agent", "quick-providers.json");
}

interface StoreSnapshot {
	providers: StoredProvider[];
	/** 读取时发现的问题（损坏备份、跳过无效条目），用于向用户提示 */
	note?: string;
}

/**
 * 读取存储。关键：损坏不能被当成「没有供应商」——否则下一次写入会覆盖用户数据。
 * 解析失败时把原文件改名为 .corrupt-<ts> 备份后再退回空列表；读失败（非 ENOENT）直接报错拒绝操作。
 */
function loadStore(): StoreSnapshot {
	const path = storePath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] }; // 尚未创建
		throw new Error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return quarantine(path, "quick-providers.json 不是合法 JSON");
	}
	const list = (parsed as { providers?: unknown } | null)?.providers;
	if (!Array.isArray(list)) return quarantine(path, "quick-providers.json 缺少 providers 数组");
	const providers: StoredProvider[] = [];
	let invalid = 0;
	for (const item of list) {
		const entry = normalizeEntry(item);
		if (entry) providers.push(entry);
		else invalid += 1;
	}
	return {
		providers,
		...(invalid > 0 ? { note: `已跳过 ${invalid} 条无效条目（原文件仍保留原样）` } : {}),
	};
}

function quarantine(path: string, reason: string): StoreSnapshot {
	const backup = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, backup);
		return { providers: [], note: `${reason}，原文件已备份为 ${backup}` };
	} catch (error) {
		throw new Error(`${reason}，且备份失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 读存储；出错时提示并中止当前操作（绝不基于残缺数据写入）。 */
function readStoreOrNotify(ctx: ExtensionCommandContext): StoreSnapshot | undefined {
	try {
		return loadStore();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function normalizeEntry(value: unknown): StoredProvider | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const id = str(raw.id)?.toLowerCase();
	const baseUrl = str(raw.baseUrl);
	if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || !baseUrl || !/^https?:\/\//i.test(baseUrl)) return undefined;
	const api = API_CHOICES.some((c) => c.value === raw.api) ? (raw.api as ApiChoice) : "openai-completions";
	const models = Array.isArray(raw.models)
		? raw.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
		: [];
	const input = Array.isArray(raw.input)
		? raw.input.filter((v): v is "text" | "image" => v === "text" || v === "image")
		: [];
	const key = str(raw.key);
	return {
		id,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		api,
		...(key ? { key } : {}),
		...(models.length > 0 ? { models } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...(input.length > 0 ? { input } : {}),
		...(num(raw.contextWindow) ? { contextWindow: num(raw.contextWindow) } : {}),
		...(num(raw.maxTokens) ? { maxTokens: num(raw.maxTokens) } : {}),
	};
}

let writeSeq = 0;

/** 原子写入：唯一命名临时文件 + rename 覆盖；失败清理临时文件，避免并发写成半截文件。 */
function writeStore(providers: StoredProvider[]): void {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify({ version: STORE_VERSION, providers }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// 忽略清理失败
		}
		throw error;
	}
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mask(key: string | undefined): string {
	if (!key) return "未设置";
	if (key.length <= 8) return "*".repeat(key.length);
	return `${key.slice(0, 4)}${"•".repeat(Math.min(key.length - 8, 10))}${key.slice(-4)}`;
}

/**
 * 规范化 baseUrl（按协议，与宿主请求路径拼法一致）：
 *  - openai-*：无路径补 /v1（请求 = baseUrl + /chat/completions|/responses）
 *  - anthropic-messages：去掉结尾 /v1（请求 = baseUrl + /v1/messages）
 *  - google-generative-ai：无路径补 /v1beta（请求 = baseUrl + /models/...）
 * 查询参数、#片段、URL 内嵌账号一律拒绝（会破坏路径拼接，且可能泄漏凭据）。
 */
function normalizeBaseUrl(raw: string, api: ApiChoice): string | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password || url.search || url.hash) return undefined;
	let path = url.pathname.replace(/\/+$/, "");
	if (api === "google-generative-ai") {
		if (path === "" || path === "/") path = "/v1beta";
	} else if (api === "anthropic-messages") {
		if (path.endsWith("/v1")) path = path.slice(0, -3);
	} else if (path === "" || path === "/") {
		path = "/v1";
	}
	return `${url.origin}${path}`;
}

function suggestId(baseUrl: string): string {
	try {
		const host = new URL(baseUrl).hostname.replace(/^(api|www)\./i, "");
		const label = host.split(".")[0]?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
		return label || "provider";
	} catch {
		return "provider";
	}
}

// ── 模型发现 ─────────────────────────────────────────────────────────────────

function makeModel(entry: StoredProvider, id: string, raw: Record<string, unknown>): ProviderModelConfig {
	const rawName = str(raw.name);
	const name =
		str(raw.displayName) ??
		str(raw.display_name) ??
		(rawName && !rawName.startsWith("models/") ? rawName : undefined) ??
		id;
	return {
		id,
		name,
		api: entry.api,
		reasoning: entry.reasoning ?? false,
		input: entry.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow:
			num(raw.context_length) ??
			num(raw.context_window) ??
			num(raw.max_model_len) ??
			num(raw.inputTokenLimit) ??
			entry.contextWindow ??
			128_000,
		maxTokens:
			num(raw.max_tokens) ?? num(raw.max_output_tokens) ?? num(raw.outputTokenLimit) ?? entry.maxTokens ?? 8_192,
	};
}

function discoveryHeaders(entry: StoredProvider, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (entry.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	if (apiKey) {
		if (entry.api === "anthropic-messages") headers["x-api-key"] = apiKey;
		else if (entry.api === "google-generative-ai") headers["x-goog-api-key"] = apiKey;
		else headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

async function getJson(entry: StoredProvider, url: string, headers: Record<string, string>): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`${entry.id}: GET ${url} 失败（${error instanceof Error ? error.message : String(error)}）`);
	}
	if (!response.ok) throw new Error(`${entry.id}: GET ${url} 返回 HTTP ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new Error(`${entry.id}: GET ${url} 返回的不是 JSON`);
	}
}

const LIST_KEYS = ["data", "models", "result", "items"] as const;

/** OpenAI 兼容 /models 的宽容封套：数组本身，或 data/models/result/items 键（可嵌套）。 */
function extractRows(payload: unknown): Array<Record<string, unknown>> | undefined {
	if (Array.isArray(payload)) {
		return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
	}
	if (payload && typeof payload === "object") {
		for (const key of LIST_KEYS) {
			const candidate = (payload as Record<string, unknown>)[key];
			if (candidate === undefined) continue;
			const nested = extractRows(candidate);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/**
 * 组装模型列表。非空条目里一个有效模型都没有时抛错：那是格式不符，
 * 不能当成「端点清空了目录」去触发宿主的权威剪枝。
 */
function buildModels(
	entry: StoredProvider,
	rows: Array<Record<string, unknown>>,
	idOf: (row: Record<string, unknown>) => string | undefined,
): ProviderModelConfig[] {
	const seen = new Set<string>();
	const out: ProviderModelConfig[] = [];
	for (const row of rows) {
		const id = idOf(row);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(makeModel(entry, id, row));
		if (out.length >= MAX_DISCOVERED_MODELS) break;
	}
	if (rows.length > 0 && out.length === 0) throw new Error(`${entry.id}: 返回的模型条目全部无效`);
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 拉取模型目录。任何失败（网络/超时/非 2xx/坏 JSON/无列表）都必须抛错，
 * 让宿主保留上次目录；仅当端点明确返回空列表时才返回 []。
 */
async function discoverModels(entry: StoredProvider, apiKey: string | undefined): Promise<ProviderModelConfig[]> {
	if (entry.api === "google-generative-ai") return discoverGoogleModels(entry, apiKey);
	if (entry.api === "anthropic-messages") return discoverAnthropicModels(entry, apiKey);
	return discoverOpenAICompatibleModels(entry, apiKey);
}

async function discoverOpenAICompatibleModels(entry: StoredProvider, apiKey: string | undefined) {
	const url = `${entry.baseUrl}/models`;
	const rows = extractRows(await getJson(entry, url, discoveryHeaders(entry, apiKey)));
	if (!rows) throw new Error(`${entry.id}: GET ${url} 未返回模型列表`);
	return buildModels(entry, rows, (row) => str(row.id));
}

/** Anthropic 分页：limit/after_id + has_more/last_id（默认页大小 20，翻页取全）。 */
async function discoverAnthropicModels(entry: StoredProvider, apiKey: string | undefined) {
	const rows: Array<Record<string, unknown>> = [];
	let after: string | undefined;
	for (let page = 0; page < 5 && rows.length < MAX_DISCOVERED_MODELS; page += 1) {
		const query = `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
		const url = `${entry.baseUrl}/v1/models${query}`;
		const body = await getJson(entry, url, discoveryHeaders(entry, apiKey));
		const data = extractRows(body);
		if (!data) throw new Error(`${entry.id}: GET ${url} 未返回模型列表`);
		rows.push(...data);
		const pageRaw = body as Record<string, unknown>;
		const lastId = str(pageRaw?.last_id);
		if (pageRaw?.has_more !== true || !lastId) break;
		after = lastId;
	}
	return buildModels(entry, rows, (row) => str(row.id) ?? str(row.name));
}

/** Gemini 分页：pageSize/pageToken + nextPageToken；按 supportedGenerationMethods 过滤非生成模型。 */
async function discoverGoogleModels(entry: StoredProvider, apiKey: string | undefined) {
	const rows: Array<Record<string, unknown>> = [];
	let token: string | undefined;
	for (let page = 0; page < 10 && rows.length < MAX_DISCOVERED_MODELS; page += 1) {
		const params = new URLSearchParams({ pageSize: "100" });
		if (token) params.set("pageToken", token);
		if (apiKey) params.set("key", apiKey);
		const url = `${entry.baseUrl}/models?${params.toString()}`;
		const body = (await getJson(entry, url, discoveryHeaders(entry, apiKey))) as Record<string, unknown> | null;
		const models = body?.models;
		if (!Array.isArray(models)) throw new Error(`${entry.id}: GET ${url} 未返回模型列表`);
		for (const row of models) {
			if (!row || typeof row !== "object") continue;
			const methods = (row as Record<string, unknown>).supportedGenerationMethods;
			// 字段存在时只保留能生成内容的模型（embedding 等不能走 streamGenerateContent）。
			if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
			rows.push(row as Record<string, unknown>);
		}
		token = str(body?.nextPageToken);
		if (!token) break;
	}
	return buildModels(entry, rows, (row) => {
		const name = str(row.name);
		return name?.startsWith("models/") ? name.slice("models/".length) : name;
	});
}

// ── 注册 ─────────────────────────────────────────────────────────────────────

/** 最近一次真实发现的结果（宿主会吞掉发现异常并返回 stale，只能自己记）。 */
const discoveryLog = new Map<string, { at: number; ok: boolean; count?: number; error?: string }>();

function registerEntry(pi: ExtensionAPI, entry: StoredProvider): void {
	const staticModels = entry.models?.map((id) => makeModel(entry, id, {}));
	pi.registerProvider(entry.id, {
		baseUrl: entry.baseUrl,
		api: entry.api,
		...(entry.key ? { apiKey: entry.key } : {}),
		...(staticModels && staticModels.length > 0 ? { models: staticModels } : {}),
		oauth: {
			name: `${entry.id} · API Key`,
			login: async (callbacks) => {
				const value = await callbacks.onPrompt({
					message: `API key for ${entry.id}`,
					placeholder: "sk-…",
				});
				const key = (value ?? "").trim();
				if (!key) throw new Error(`${entry.id}: no API key entered`);
				return key;
			},
		},
		fetchDynamicModels: async (apiKey) => {
			const at = Date.now();
			try {
				const models = await discoverModels(entry, apiKey);
				discoveryLog.set(entry.id, { at, ok: true, count: models.length });
				return models;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				discoveryLog.set(entry.id, { at, ok: false, error: message });
				throw error;
			}
		},
	} satisfies ProviderConfig);
}

// ── 屏蔽输入 ─────────────────────────────────────────────────────────────────

/**
 * 密钥输入框：18.1.22 的 ui.input / OAuthPrompt 都不支持遮蔽（secret 字段不存在），
 * 这里用 ui.custom 自绘一个不回显的输入组件。返回输入值（可为空串），单独 Esc 取消返回 undefined。
 */
async function promptSecret(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
		const styled = theme as unknown as { fg(color: string, text: string): string };
		let value = "";
		return {
			render(width: number) {
				const shown =
					value.length > 0 ? "•".repeat(Math.min(value.length, 64)) : styled.fg("dim", placeholder);
				const line = `  ${shown}`;
				return [
					styled.fg("accent", title),
					line.length > width ? line.slice(0, Math.max(0, width)) : line,
					styled.fg("dim", "  Enter 确认 · Esc 取消 · 输入不回显"),
				];
			},
			handleInput(data: string) {
				if (data.startsWith("\x1b")) {
					if (data === "\x1b") done(undefined); // 单独 Esc = 取消
					return; // 其余转义序列（方向键等）忽略
				}
				for (const ch of data) {
					const code = ch.charCodeAt(0);
					if (ch === "\r" || ch === "\n") {
						done(value);
						return;
					}
					if (code === 127 || code === 8) {
						value = value.slice(0, -1);
						continue;
					}
					if (code < 32) continue; // 控制字符（含括号粘贴标记）
					value += ch;
				}
			},
		};
	});
}

// ── 命令 ─────────────────────────────────────────────────────────────────────

export default function quickProvider(pi: ExtensionAPI): void {
	pi.setLabel("Quick Provider");
	for (const entry of loadStorePreserving()) registerEntry(pi, entry);

	/** 加载期读存储：出错不抛（避免整个扩展加载失败），损坏文件仍会被备份保留。 */
	function loadStorePreserving(): StoredProvider[] {
		try {
			return loadStore().providers;
		} catch {
			return [];
		}
	}

	/** 注册后按需刷新目录；模型数取自注册表，成败以发现回调记录为准。 */
	async function refreshProviders(ctx: ExtensionCommandContext, ids: string[]): Promise<Map<string, number>> {
		const registry = ctx.modelRegistry as unknown as RegistryRefresh;
		try {
			if (typeof registry.refreshDiscoverableProviders === "function") {
				await registry.refreshDiscoverableProviders(ids, "online");
			} else if (typeof registry.refreshProvider === "function") {
				for (const id of ids) await registry.refreshProvider(id, "online");
			} else {
				ctx.ui.notify("当前 omp 版本缺少目录刷新接口，重启后生效", "warning");
			}
		} catch (error) {
			ctx.ui.notify(
				`目录刷新失败：${error instanceof Error ? error.message : String(error)}（可运行 omp models refresh）`,
				"warning",
			);
		}
		const counts = new Map<string, number>();
		for (const id of ids) {
			counts.set(id, ctx.modelRegistry.getAll().filter((m) => m.provider === id).length);
		}
		return counts;
	}

	/** 发现回调在本次刷新窗口内的真实结果（未跑过则 undefined）。 */
	function observedFailure(id: string, startedAt: number): string | undefined {
		const log = discoveryLog.get(id);
		if (!log || log.at < startedAt || log.ok) return undefined;
		return log.error ?? "目录拉取失败";
	}

	async function addFlow(ctx: ExtensionCommandContext, prefill: string[]): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("添加供应商需要 TUI：/qkprovider add", "warning");
			return;
		}
		const [prefillUrl, prefillId] = prefill;

		const rawUrl = prefillUrl ?? (await ctx.ui.input("Base URL（供应商端点）", "https://host/v1"));
		if (rawUrl === undefined) return;

		const rawId =
			prefillId ?? (await ctx.ui.input("Provider ID（模型名前缀，如 my-gw 对应 my-gw/model）", suggestId(rawUrl)));
		if (rawId === undefined) return;
		const id = (rawId.trim() || suggestId(rawUrl)).toLowerCase();
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
			ctx.ui.notify(`ID 无效："${rawId}"（字母/数字开头，可含 . _ -）`, "error");
			return;
		}

		const apiLabel = await ctx.ui.select(
			"API 协议",
			API_CHOICES.map((c) => c.label),
		);
		if (apiLabel === undefined) return;
		const api = API_CHOICES.find((c) => c.label === apiLabel)?.value ?? "openai-completions";

		const baseUrl = normalizeBaseUrl(rawUrl, api);
		if (!baseUrl) {
			ctx.ui.notify(
				`不是有效的 http(s) base URL："${rawUrl.trim()}"（不支持查询参数 / #片段 / 内嵌账号）`,
				"error",
			);
			return;
		}

		const store = readStoreOrNotify(ctx);
		if (!store) return;
		if (store.note) ctx.ui.notify(store.note, "warning");
		const inStore = store.providers.some((e) => e.id === id);
		if (inStore && !(await ctx.ui.confirm("覆盖供应商", `${id} 已存在，覆盖它？`))) return;
		const ownedElsewhere = !inStore && ctx.modelRegistry.getAll().some((m) => m.provider === id);
		if (ownedElsewhere) {
			const ok = await ctx.ui.confirm(
				"覆盖已有 provider",
				`已存在 provider「${id}」（内置 / models.yml / 其他扩展）。继续会把它的端点、密钥改到 ${baseUrl}（含其已有凭据）。继续？`,
			);
			if (!ok) return;
		}

		const rawKey = await promptSecret(ctx, `API Key for ${id}（可留空，之后可 /login ${id}）`, "sk-…");
		if (rawKey === undefined) return;
		const key = rawKey.trim() || undefined;

		// 先探测一次目录：成功则无需手填模型；失败给出提示并允许手动填 ID。
		const probe: StoredProvider = { id, baseUrl, api, ...(key ? { key } : {}) };
		let discovered: number | undefined;
		try {
			discovered = (await discoverModels(probe, key)).length;
			ctx.ui.notify(`已发现 ${discovered} 个模型（${id}）`, "info");
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}`, "warning");
		}

		let models: string[] = [];
		if (discovered === undefined || discovered === 0) {
			const rawModels = await ctx.ui.input("模型 ID（可选，逗号分隔；端点不支持 /models 时手动填写）", "可选");
			if (rawModels === undefined) return;
			models = rawModels.trim() ? rawModels.split(/[\s,]+/).filter(Boolean) : [];
		}

		const entry: StoredProvider = {
			id,
			baseUrl,
			api,
			...(key ? { key } : {}),
			...(models.length > 0 ? { models } : {}),
		};
		// 等待用户输入的这段时间里文件可能被其他实例改过：写入前重读并合并。
		const fresh = readStoreOrNotify(ctx);
		if (!fresh) return;
		const next = [...fresh.providers.filter((e) => e.id !== id), entry].sort((a, b) => a.id.localeCompare(b.id));
		try {
			writeStore(next);
		} catch (error) {
			ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		// 覆盖场景必须先注销旧注册：同源重注册只会合并字段，旧 key/旧静态模型会残留到重启。
		if (inStore || ownedElsewhere) pi.unregisterProvider(id);
		registerEntry(pi, entry);

		const startedAt = Date.now();
		const counts = await refreshProviders(ctx, [id]);
		const count = counts.get(id) ?? 0;
		const failure = observedFailure(id, startedAt);
		const lines = [`已添加 ${id} → ${baseUrl}`, `协议 ${api} · 模型 ${count}`];
		if (key) lines.push("密钥已存入本插件配置（优先于 /login；更换：重新 /qkprovider add 或先删后 /login）");
		else lines.push(`密钥：运行 /login ${id}`);
		if (failure) lines.push(`目录拉取失败：${failure}`);
		if (count === 0) {
			lines.push("模型为 0：可重新 /qkprovider add 手动填模型 ID，或 /qkprovider refresh " + id + " 重试");
			ctx.ui.notify(lines.join("\n"), "warning");
		} else {
			ctx.ui.notify(lines.join("\n"), "info");
		}
		if (fresh.note && fresh.note !== store.note) ctx.ui.notify(fresh.note, "warning");
	}

	async function listFlow(ctx: ExtensionCommandContext): Promise<void> {
		const store = readStoreOrNotify(ctx);
		if (!store) return;
		if (store.note) ctx.ui.notify(store.note, "warning");
		if (store.providers.length === 0) {
			ctx.ui.notify("没有已添加的供应商 — /qkprovider add", "info");
			return;
		}
		const lines = ["── API 供应商 ──"];
		for (const entry of store.providers) {
			let resolved: string | undefined;
			try {
				resolved = (await ctx.modelRegistry.getApiKeyForProvider(entry.id)) ?? undefined;
			} catch {
				resolved = undefined;
			}
			const count = ctx.modelRegistry.getAll().filter((m) => m.provider === entry.id).length;
			const source = entry.key ? "向导录入" : "凭据库/环境";
			lines.push(`${entry.id} · ${entry.baseUrl} · ${entry.api} · 密钥 ${mask(resolved ?? entry.key)}（${source}） · 模型 ${count}`);
		}
		lines.push("", "添加 /qkprovider add · 删除 /qkprovider delete <id>（remove 同）· 刷新 /qkprovider refresh [id]");
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function removeFlow(ctx: ExtensionCommandContext, idArg?: string): Promise<void> {
		const store = readStoreOrNotify(ctx);
		if (!store) return;
		if (store.providers.length === 0) {
			ctx.ui.notify("没有已添加的供应商", "warning");
			return;
		}
		let id = idArg?.trim().toLowerCase();
		if (id && !store.providers.some((e) => e.id === id)) {
			ctx.ui.notify(`未找到 ${id}（现有：${store.providers.map((e) => e.id).join(", ")}）`, "error");
			return;
		}
		if (!id) {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(`用法：/qkprovider delete <id>（现有：${store.providers.map((e) => e.id).join(", ")}）`, "warning");
				return;
			}
			id = await ctx.ui.select(
				"删除哪个供应商？",
				store.providers.map((e) => e.id),
			);
			if (!id) return;
		}
		if (ctx.mode === "tui" && ctx.hasUI && !(await ctx.ui.confirm("删除供应商", `删除 ${id} 及其配置？`))) return;
		// 等待确认期间文件可能被其他实例改过：写入前重读，只应用这一条删除。
		const fresh = readStoreOrNotify(ctx);
		if (!fresh) return;
		try {
			writeStore(fresh.providers.filter((e) => e.id !== id));
		} catch (error) {
			ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		pi.unregisterProvider(id);
		ctx.ui.notify(`已删除 ${id}`, "info");
	}

	async function refreshFlow(ctx: ExtensionCommandContext, idArg?: string): Promise<void> {
		const store = readStoreOrNotify(ctx);
		if (!store) return;
		if (store.providers.length === 0) {
			ctx.ui.notify("没有已添加的供应商", "warning");
			return;
		}
		const known = new Set(store.providers.map((e) => e.id));
		const ids = (idArg ? [idArg.trim().toLowerCase()] : store.providers.map((e) => e.id)).filter((id) => known.has(id));
		if (ids.length === 0) {
			ctx.ui.notify(`未找到 ${idArg}（现有：${[...known].join(", ")}）`, "error");
			return;
		}
		// 重新注册前先注销：清掉旧 key/旧静态模型，避免扩展配置变化后残留。
		for (const entry of store.providers.filter((e) => ids.includes(e.id))) {
			pi.unregisterProvider(entry.id);
			registerEntry(pi, entry);
		}
		const startedAt = Date.now();
		const counts = await refreshProviders(ctx, ids);
		const failures = ids
			.map((id) => ({ id, error: observedFailure(id, startedAt) }))
			.filter((row): row is { id: string; error: string } => row.error !== undefined);
		const lines = ids.map((id) => `${id} · 模型 ${counts.get(id) ?? 0}`);
		for (const row of failures) lines.push(`${row.id} 拉取失败：${row.error}`);
		const zeroWithoutFailure = ids.filter((id) => (counts.get(id) ?? 0) === 0 && !failures.some((f) => f.id === id));
		if (zeroWithoutFailure.length > 0) lines.push(`无模型：${zeroWithoutFailure.join(", ")}（端点无 /models 或结果为空）`);
		ctx.ui.notify(lines.join("\n"), failures.length > 0 || zeroWithoutFailure.length > 0 ? "warning" : "info");
	}

	async function menuFlow(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			await listFlow(ctx);
			return;
		}
		const choice = await ctx.ui.select("供应商管理", [
			"添加 API 供应商",
			"列出供应商",
			"删除供应商",
			"刷新模型目录",
		]);
		if (choice === "添加 API 供应商") await addFlow(ctx, []);
		else if (choice === "列出供应商") await listFlow(ctx);
		else if (choice === "删除供应商") await removeFlow(ctx);
		else if (choice === "刷新模型目录") await refreshFlow(ctx);
	}

	pi.registerCommand("qkprovider", {
		description: "快捷添加 / 管理 API 供应商（base URL + key）",
		getArgumentCompletions: (prefix) => {
			const parts = (prefix ?? "").trim().split(/\s+/);
			const subs = ["add", "list", "remove", "delete", "refresh"];
			if (parts.length <= 1) {
				const q = (parts[0] ?? "").toLowerCase();
				return subs.filter((s) => s.startsWith(q)).map((s) => ({ value: s, label: s }));
			}
			const sub = parts[0];
			if (sub === "remove" || sub === "delete" || sub === "refresh") {
				const q = parts.slice(1).join(" ").toLowerCase();
				return loadStorePreserving()
					.map((e) => e.id)
					.filter((id) => id.toLowerCase().includes(q))
					.map((id) => ({ value: `${sub} ${id}`, label: id }));
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const [sub = "", ...rest] = String(rawArgs ?? "").trim().split(/\s+/);
			if (sub === "") await menuFlow(ctx);
			else if (sub === "add") await addFlow(ctx, rest);
			else if (sub === "list") await listFlow(ctx);
			else if (sub === "remove" || sub === "delete") await removeFlow(ctx, rest[0]);
			else if (sub === "refresh") await refreshFlow(ctx, rest[0]);
			else ctx.ui.notify(`未知子命令 "${sub}"：用 /qkprovider [add|list|remove|delete|refresh]`, "error");
		},
	});
}
