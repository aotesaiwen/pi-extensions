import { strict as assert } from "node:assert";
import test from "node:test";
import askUserQuestion from "../extensions/ask-user-question.ts";

const DOWN = "\x1b[B";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function makeTui(rows: number) {
	return {
		terminal: { rows },
		requestRender() {},
	};
}

function getTool() {
	let tool: any;
	askUserQuestion({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as any);
	return tool;
}

async function openDialog(params: Record<string, unknown>, rows = 80) {
	let component: any;
	const tui = makeTui(rows);
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory: Function) {
				component = factory(tui, theme, {}, () => {});
				return Promise.resolve(null);
			},
			async editor() {
				return undefined;
			},
		},
	};

	const result = await getTool().execute("test-call", params, undefined, undefined, ctx);
	return { component, result };
}

function flatten(lines: string[]): string {
	return lines.join(" ").replace(/\s+/g, " ").trim();
}

test("re-checks abort after acquiring the shared UI lock", async () => {
	const tool = getTool();
	const controller = new AbortController();
	let uiCalls = 0;
	const ctx = {
		hasUI: true,
		ui: {
			custom() {
				uiCalls++;
				return Promise.resolve(null);
			},
			async editor() {
				uiCalls++;
				return undefined;
			},
		},
	};

	const lock = (globalThis as any).__piSharedUiLock;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holding = lock.withLock(() => gate);

	const pending = tool.execute(
		"test-call",
		{ question: "Pick one", options: [{ label: "First" }] },
		controller.signal,
		undefined,
		ctx,
	);
	controller.abort();
	release();
	await holding;

	const result = await pending;
	assert.equal(result.details.status, "cancelled");
	assert.equal(uiCalls, 0);
});

test("cancelled queued request resolves without waiting for the lock", async () => {
	const tool = getTool();
	const controller = new AbortController();
	let uiCalls = 0;
	const ctx = {
		hasUI: true,
		ui: {
			custom() {
				uiCalls++;
				return Promise.resolve(null);
			},
			async editor() {
				uiCalls++;
				return undefined;
			},
		},
	};

	const lock = (globalThis as any).__piSharedUiLock;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holding = lock.withLock(() => gate);

	const pending = tool.execute(
		"test-call",
		{ question: "Pick one", options: [{ label: "First" }] },
		controller.signal,
		undefined,
		ctx,
	);
	try {
		controller.abort();
		const timeout = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("cancellation waited for the lock")), 200);
			timer.unref();
		});
		const result = await Promise.race([pending, timeout]);
		assert.equal(result.details.status, "cancelled");
		assert.equal(uiCalls, 0);
	} finally {
		release();
		await holding;
		await pending;
	}
});

test("renderCall keeps large option lists compact", () => {
	const options = Array.from({ length: 20 }, (_, index) => ({
		label: `Option ${index + 1} ${"x".repeat(80)}`,
	}));
	const rendered = getTool().renderCall({ question: "Pick one", options }, theme).render(200).join("\n");
	assert.ok(rendered.includes("+16 more"));
	assert.ok(!rendered.includes("Option 20"));
});

test("single-select wraps long option labels instead of truncating them", async () => {
	const label = "This is a deliberately long option label that should wrap across several lines instead of being cut off";
	const { component } = await openDialog({
		question: "Pick one",
		options: [{ label }, { label: "Short" }],
	});
	const rendered = flatten(component.render(28));
	assert.ok(rendered.includes(label), `rendered output did not contain the full label:\n${rendered}`);
});

test("multi-select wraps long option labels instead of truncating them", async () => {
	const label = "This is a deliberately long option label that should wrap across several lines instead of being cut off";
	const { component } = await openDialog({
		question: "Pick several",
		multiSelect: true,
		options: [{ label }, { label: "Short" }],
	});
	const rendered = flatten(component.render(28));
	assert.ok(rendered.includes(label), `rendered output did not contain the full label:\n${rendered}`);
});

test("single-select scrolling keeps later options visible and reachable", async () => {
	const options = Array.from({ length: 12 }, (_, index) => ({
		label: `Option ${index + 1} with enough words to wrap a little`,
	}));
	const { component } = await openDialog({ question: "Pick one", options }, 12);

	const initial = component.render(32);
	assert.ok(initial.length <= 12);
	assert.ok(flatten(initial).includes("Option 1"));

	for (let i = 0; i < options.length; i++) {
		component.handleInput(DOWN);
	}
	const scrolled = component.render(32);
	assert.ok(flatten(scrolled).includes("Other"));
	assert.ok(!flatten(scrolled).includes("Option 1 with"));
});

test("multi-select scrolling keeps the submit row visible and reachable", async () => {
	const options = Array.from({ length: 12 }, (_, index) => ({
		label: `Option ${index + 1} with enough words to wrap a little`,
	}));
	const { component } = await openDialog({ question: "Pick several", multiSelect: true, options }, 12);

	for (let i = 0; i < options.length + 1; i++) {
		component.handleInput(DOWN);
	}
	const scrolled = component.render(32);
	assert.ok(scrolled.length <= 12);
	assert.ok(flatten(scrolled).includes("Submit"));
});
