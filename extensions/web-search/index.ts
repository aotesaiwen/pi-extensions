import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface StructuredSearchArgs {
	query?: string;
	exactPhrases?: string[];
	excludeTerms?: string[];
	site?: string;
	count?: number;
}

interface BuiltSearchQuery {
	query: string;
	baseQuery?: string;
	exactPhrases: string[];
	excludeTerms: string[];
	site?: string;
}

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AUTH_PATH = path.join(EXT_DIR, "auth.json");
const SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 10;

interface CredentialsResult {
	apiKey?: string;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function cleanResultText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function convertDeepSeekResults(data: unknown): SearchResult[] {
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new Error('DeepSeek API returned an unexpected response: missing "results" array.');
	}

	return data.results.map((item, index) => {
		if (!isRecord(item)) {
			throw new Error(`DeepSeek API returned a malformed result at index ${index}.`);
		}

		const url = cleanResultText(item.url);
		if (!url) {
			throw new Error(`DeepSeek API returned a result without a URL at index ${index}.`);
		}

		const title = cleanResultText(item.title) || url;
		const snippet = cleanResultText(item.snippet) || cleanResultText(item.summary);
		return { title, url, snippet };
	});
}

function formatApiError(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "";

	try {
		const parsed = JSON.parse(trimmed);
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const message = parsed.error.message;
			if (typeof message === "string" && message.trim()) return message.trim();
		}
	} catch {}

	return trimmed.replace(/\s+/g, " ").slice(0, 200);
}

export async function deepseekSearch(
	query: string,
	count: number,
	apiKey: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
	let resp: Response;
	try {
		resp = await fetchImpl(SEARCH_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, count }),
			signal,
		});
	} catch (error) {
		if (error instanceof Error) throw new Error(`DeepSeek search request failed: ${error.message}`);
		throw new Error("DeepSeek search request failed.");
	}

	if (!resp.ok) {
		const detail = formatApiError(await resp.text().catch(() => ""));
		if (resp.status === 401 || resp.status === 403) {
			throw new Error(
				`DeepSeek rejected the API key (HTTP ${resp.status}). Check "deepseek_api_key" in ${AUTH_PATH}${detail ? `: ${detail}` : "."}`,
			);
		}
		throw new Error(`DeepSeek API ${resp.status}${detail ? `: ${detail}` : `: ${resp.statusText}`}`);
	}

	let data: unknown;
	try {
		data = await resp.json();
	} catch {
		throw new Error("DeepSeek API returned invalid JSON.");
	}

	return convertDeepSeekResults(data);
}

export function loadCredentials(authPath = AUTH_PATH): CredentialsResult {
	let raw: string;
	try {
		raw = fs.readFileSync(authPath, "utf-8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return {
				error: `Missing DeepSeek API key. Create ${authPath} with a "deepseek_api_key" field.`,
			};
		}
		return {
			error: `Could not read ${authPath}. Check that it is readable and contains a "deepseek_api_key" field.`,
		};
	}

	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		return {
			error: `Could not parse ${authPath}. Make sure it contains valid JSON with a "deepseek_api_key" field.`,
		};
	}

	const apiKey = isRecord(config) ? config.deepseek_api_key : undefined;
	if (typeof apiKey !== "string" || !apiKey.trim()) {
		return {
			error: `DeepSeek API key is missing or invalid in ${authPath}. Set "deepseek_api_key" to your DeepSeek API key.`,
		};
	}

	return { apiKey: apiKey.trim() };
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}

function stripWrappingQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).trim()
		: value;
}

function cleanItems(values?: string[]): string[] {
	if (!values) return [];
	return values
		.map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
		.filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.trim().replace(/\s+/g, " ");
	return cleaned || undefined;
}

function normalizeSite(site?: string): string | undefined {
	if (typeof site !== "string") return undefined;

	let value = site.trim().replace(/^site:/i, "").trim();
	if (!value) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(value)
			? value
			: `https://${value}`;
		const url = new URL(candidate);
		if (url.hostname) value = url.hostname;
	} catch {}

	return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
	const baseQuery = cleanQuery(args.query);
	const exactPhrases = cleanItems(args.exactPhrases);
	const excludeTerms = cleanItems(args.excludeTerms);
	const site = normalizeSite(args.site);

	if (!baseQuery && exactPhrases.length === 0) {
		throw new Error(
			"At least one of 'query' or 'exactPhrases' is required.",
		);
	}

	const parts: string[] = [];
	if (baseQuery) parts.push(baseQuery);
	for (const phrase of exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}
	for (const term of excludeTerms) {
		parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
	}
	if (site) {
		parts.push(`site:${site}`);
	}

	return {
		query: parts.join(" "),
		baseQuery,
		exactPhrases,
		excludeTerms,
		site,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via DeepSeek Search. Build one query per call from a base query, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet or summary.",
		promptSnippet:
			"Search the web with a query plus optional exactPhrases, excludeTerms, and site; one call per search angle.",
		promptGuidelines: [
			"Use exactPhrases instead of embedding quotes in query; make one web_search call per search angle.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Base search query.",
				}),
			),
			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Exact phrases; each becomes a quoted search phrase.",
				}),
			),
			excludeTerms: Type.Optional(
				Type.Array(Type.String(), {
					description: "Terms or phrases to exclude.",
				}),
			),
			site: Type.Optional(
				Type.String({
					description: "Optional site/domain restriction.",
				}),
			),
			count: Type.Optional(
				Type.Number({
					description: `Results to return (default: ${DEFAULT_RESULT_COUNT}, max: ${MAX_RESULT_COUNT}).`,
					minimum: 1,
					maximum: MAX_RESULT_COUNT,
				}),
			),
		}),

		async execute(_toolCallId, params: StructuredSearchArgs, signal) {
			const creds = loadCredentials();
			if (!creds.apiKey) {
				throw new Error(creds.error ?? "Missing DeepSeek API key.");
			}

			const count = Math.min(
				Math.max(params.count ?? DEFAULT_RESULT_COUNT, 1),
				MAX_RESULT_COUNT,
			);
			const built = buildSearchQuery(params);
			const results = await deepseekSearch(
				built.query,
				count,
				creds.apiKey,
				signal,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],
				details: {
					composedQuery: built.query,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					excludeTerms: built.excludeTerms,
					site: built.site,
					resultCount: results.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { count, ...searchArgs } = args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);
				const display =
					built.query.length > 70
						? built.query.slice(0, 67) + "..."
						: built.query;
				const lines = [
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("accent", `"${display}"`),
				];
				if (count && count !== DEFAULT_RESULT_COUNT) {
					lines.push(theme.fg("dim", `  count: ${count}`));
				}
				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(invalid query)"),
				);
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
			};
			const status = theme.fg(
				"success",
				`${details?.resultCount ?? 0} results`,
			);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.composedQuery
				? theme.fg("dim", `query: ${details.composedQuery}`)
				: "";
			text.setText(
				[status, queryLine, theme.fg("dim", preview)]
					.filter(Boolean)
					.join("\n"),
			);
			return text;
		},
	});
}
