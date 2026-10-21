import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	convertDeepSeekResults,
	deepseekSearch,
	loadCredentials,
} from "../extensions/web-search/index.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

test("loadCredentials reads deepseek_api_key from the configured auth file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
	const authPath = join(dir, "auth.json");
	try {
		assert.match(loadCredentials(authPath).error ?? "", /Missing DeepSeek API key/);

		const authDirectory = join(dir, "auth-dir");
		mkdirSync(authDirectory);
		assert.match(loadCredentials(authDirectory).error ?? "", /Could not read/);

		writeFileSync(authPath, "{not json");
		assert.match(loadCredentials(authPath).error ?? "", /Could not parse/);

		writeFileSync(authPath, "{}");
		assert.match(loadCredentials(authPath).error ?? "", /missing or invalid/);

		writeFileSync(authPath, '{"deepseek_api_key":"   "}');
		assert.match(loadCredentials(authPath).error ?? "", /missing or invalid/);

		writeFileSync(authPath, '{"deepseek_api_key":" test-key "}');
		assert.deepEqual(loadCredentials(authPath), { apiKey: "test-key" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deepseekSearch sends the documented request and maps results", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requestUrl = String(url);
		requestInit = init;
		return jsonResponse({
			results: [
				{
					title: "  First result  ",
					url: "https://example.com/first",
					snippet: "Short\nsnippet",
					summary: "Longer summary",
				},
				{
					title: "",
					url: "https://example.com/second",
					snippet: "",
					summary: "Fallback\nsummary",
				},
			],
		});
	}) as typeof fetch;

	const results = await deepseekSearch(
		"DeepSeek search syntax site:example.com",
		3,
		"test-key",
		undefined,
		fakeFetch,
	);

	assert.equal(requestUrl, "https://api.deepseek.com/v1/tools/search");
	assert.equal(requestInit?.method, "POST");
	assert.equal(
		(requestInit?.headers as Record<string, string>).Authorization,
		"Bearer test-key",
	);
	assert.equal(
		(requestInit?.headers as Record<string, string>)["Content-Type"],
		"application/json",
	);
	assert.deepEqual(JSON.parse(String(requestInit?.body)), {
		query: "DeepSeek search syntax site:example.com",
		count: 3,
	});
	assert.deepEqual(results, [
		{
			title: "First result",
			url: "https://example.com/first",
			snippet: "Short snippet",
		},
		{
			title: "https://example.com/second",
			url: "https://example.com/second",
			snippet: "Fallback summary",
		},
	]);
});

test("deepseekSearch handles empty and malformed responses", async () => {
	const empty = (async () => jsonResponse({ results: [] })) as typeof fetch;
	assert.deepEqual(await deepseekSearch("query", 5, "test-key", undefined, empty), []);

	assert.throws(
		() => convertDeepSeekResults({}),
		/missing "results" array/,
	);
	assert.throws(
		() => convertDeepSeekResults({ results: [{}] }),
		/without a URL/,
	);
	assert.throws(
		() => convertDeepSeekResults({ results: [null] }),
		/malformed result/,
	);

	const invalidJson = (async () =>
		new Response("not json", { status: 200 })) as typeof fetch;
	await assert.rejects(
		deepseekSearch("query", 5, "test-key", undefined, invalidJson),
		/returned invalid JSON/,
	);
});

test("deepseekSearch reports HTTP and network errors without exposing the key", async () => {
	const unauthorized = (async () =>
		jsonResponse({ error: { message: "Authentication Fails" } }, 401)) as typeof fetch;
	await assert.rejects(
		deepseekSearch("query", 5, "super-secret-key", undefined, unauthorized),
		(error: Error) => {
			assert.match(error.message, /HTTP 401/);
			assert.match(error.message, /deepseek_api_key/);
			assert.match(error.message, /Authentication Fails/);
			assert.ok(!error.message.includes("super-secret-key"));
			return true;
		},
	);

	const serverError = (async () => new Response("", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;
	await assert.rejects(
		deepseekSearch("query", 5, "test-key", undefined, serverError),
		/DeepSeek API 500: Internal Server Error/,
	);

	const networkError = (async () => {
		throw new Error("socket closed");
	}) as typeof fetch;
	await assert.rejects(
		deepseekSearch("query", 5, "test-key", undefined, networkError),
		/DeepSeek search request failed: socket closed/,
	);
});
