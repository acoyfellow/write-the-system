import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";
import { EXAMPLES, type Item, type Legacy, SPEC, score } from "./data.ts";
import { clefPriorities } from "./clef.ts";
import { chat, type Message } from "./model.ts";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const wasm = new Module(readFileSync(fileURLToPath(import.meta.resolve("@acoyfellow/amber/dq.wasm"))));

export type Meter = { tokens: number; calls: number; modelMs: number };

export type ArmResult = {
	readonly arm: string;
	readonly outputs: ReadonlyArray<unknown>;
	readonly tokens: number;
	readonly modelCalls: number;
	readonly modelMs: number;
	readonly wallMs: number;
	readonly programMs: number | null;
	readonly programSource: string | null;
	readonly attempts: number;
	readonly error: string | null;
	readonly judgeCalls?: number;
	readonly clefItems?: number;
	readonly clefErrors?: number;
	readonly clefMs?: number;
	readonly ladder?: LadderTrace;
};

const meter = (): Meter => ({ tokens: 0, calls: 0, modelMs: 0 });

const ask = async (counter: Meter, messages: ReadonlyArray<Message>): Promise<string> => {
	const reply = await chat(messages);
	counter.tokens += reply.tokens;
	counter.calls += 1;
	counter.modelMs += reply.ms;
	return reply.content;
};

const fenced = (text: string, language: string): string => {
	const open = "`".repeat(3);
	const start = text.indexOf(`${open}${language}`);
	const from = start >= 0 ? start + open.length + language.length : text.indexOf(open) >= 0 ? text.indexOf(open) + open.length : -1;
	if (from < 0) return text.trim();
	const end = text.indexOf(open, from);
	return (end < 0 ? text.slice(from) : text.slice(from, end)).trim();
};

const parseArray = (text: string): Array<unknown> => {
	const body = fenced(text, "json");
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start < 0 || end < start) return [];
	try {
		const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};

const examplesText = EXAMPLES.map((example) => `input: ${JSON.stringify(example.input)}\noutput: ${JSON.stringify(example.expected)}`).join("\n\n");

const BATCH = Number(process.env.BATCH ?? 10);

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

const pool = async <A, B>(items: ReadonlyArray<A>, limit: number, work: (item: A, index: number) => Promise<B>): Promise<Array<B>> => {
	const results: Array<B> = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as A, index);
		}
	});
	await Promise.all(runners);
	return results;
};

export const modelDoesEveryItem = async (items: ReadonlyArray<Item>): Promise<ArmResult> => {
	const counter = meter();
	const started = Date.now();
	const batches = Array.from({ length: Math.ceil(items.length / BATCH) }, (_unused, index) => items.slice(index * BATCH, (index + 1) * BATCH));
	const outputs = await pool(batches, CONCURRENCY, async (batch) => {
		const reply = await ask(counter, [
			{ role: "system", content: `${SPEC}\n\nExamples:\n\n${examplesText}` },
			{ role: "user", content: `Migrate these ${batch.length} v1 configs. Reply with only a JSON array of ${batch.length} v2 objects, in the same order.\n\n${JSON.stringify(batch.map((item) => item.input))}` },
		]);
		const parsed = parseArray(reply);
		return batch.map((_item, index) => parsed[index] ?? null);
	});
	return { arm: "model-does-every-item", outputs: outputs.flat(), tokens: counter.tokens, modelCalls: counter.calls, modelMs: counter.modelMs, wallMs: Date.now() - started, programMs: null, programSource: null, attempts: 1, error: null };
};

const WRITER = `${SPEC}

Write a JavaScript program that migrates every config. It runs in a sandbox with no imports, no network and no timers.
- tool("configs", {}) returns the array of v1 configs.
- tool("judge", { question, options, text }) asks a language model one judgment question and returns one of the options. Use it only for what code cannot decide. Each call is slow and costs tokens.
- The program's last expression is its result: the array of v2 objects, in input order.
Write plain loops (for...of), not forEach or map, around tool() calls.

Examples:

${examplesText}

Reply with only the program in one javascript code block.`;

const runProgram = async (source: string, configs: ReadonlyArray<Legacy>, counter: Meter): Promise<{ readonly outcome: Outcome; readonly programMs: number; readonly judgeCalls: number }> => {
	let judgeCalls = 0;
	const tools = {
		configs: read(Schema.Json, () => configs as unknown as Schema.Json),
		judge: external(Schema.Json),
	};
	const script = new DurableScript({ programId: `p-${Date.now()}-${Math.random()}`, storage: memoryStorage(), tools, wasm, budgetTicks: 5000 });
	const started = Date.now();
	let judgeMs = 0;
	let outcome = await script.run(source);
	for (let guard = 0; guard < 20000; guard++) {
		if (outcome._tag === "Running") {
			outcome = await script.alarm();
			continue;
		}
		if (outcome._tag !== "Waiting") break;
		const args = outcome.args as { question?: string; options?: ReadonlyArray<string>; text?: string };
		const options = Array.isArray(args.options) ? args.options.map(String) : [];
		const judgeStarted = Date.now();
		const reply = await ask(counter, [
			{ role: "system", content: "Answer with exactly one of the options and nothing else." },
			{ role: "user", content: `${args.question ?? ""}\n\nOptions: ${options.join(", ")}\n\nText: ${args.text ?? ""}` },
		]);
		judgeMs += Date.now() - judgeStarted;
		judgeCalls += 1;
		const cleaned = reply.trim().toLowerCase().replace(new RegExp("[^a-z0-9_-]", "g"), "");
		outcome = await script.answer(outcome.token, options.find((option) => option.toLowerCase() === cleaned) ?? options.find((option) => cleaned.includes(option.toLowerCase())) ?? reply.trim());
	}
	return { outcome, programMs: Date.now() - started - judgeMs, judgeCalls };
};

const firstLines = (text: string, count: number): string => text.split("\n").slice(0, count).join("\n");

export const modelWritesProgram = async (items: ReadonlyArray<Item>, withCheck: boolean): Promise<ArmResult> => {
	const counter = meter();
	const started = Date.now();
	const messages: Array<Message> = [{ role: "user", content: WRITER }];
	let source = "";
	let attempts = 0;
	const limit = withCheck ? 3 : 1;
	while (attempts < limit) {
		attempts += 1;
		const reply = await ask(counter, messages);
		source = fenced(reply, "javascript");
		messages.push({ role: "assistant", content: reply });
		if (!withCheck) break;
		if (source === "") {
			messages.pop();
			continue;
		}
		const trial = await runProgram(source, EXAMPLES.map((example) => example.input), counter);
		if (trial.outcome._tag === "Finished") {
			const outputs = Array.isArray(trial.outcome.result) ? trial.outcome.result : [];
			const wrong = EXAMPLES.flatMap((example, index) => (JSON.stringify(outputs[index]) === JSON.stringify(example.expected) ? [] : [`input: ${JSON.stringify(example.input)}\nexpected: ${JSON.stringify(example.expected)}\ngot: ${JSON.stringify(outputs[index] ?? null)}`]));
			if (wrong.length === 0) break;
			messages.push({ role: "user", content: `I ran your program on the examples. These came out wrong:\n\n${wrong.join("\n\n")}\n\nFix the program. Reply with only the whole program in one javascript code block.` });
		} else {
			const detail = trial.outcome._tag === "Failed" ? `${trial.outcome.error}: ${firstLines(trial.outcome.message, 4)}` : trial.outcome._tag;
			messages.push({ role: "user", content: `I ran your program on the examples and it did not finish: ${detail}\n\nFix the program. Reply with only the whole program in one javascript code block.` });
		}
	}
	if (source === "") return { arm: withCheck ? "model-writes-program-checked" : "model-writes-program", outputs: items.map(() => null), tokens: counter.tokens, modelCalls: counter.calls, modelMs: counter.modelMs, wallMs: Date.now() - started, programMs: null, programSource: "", attempts, error: "EmptyReply: the model returned no program" };
	const run = await runProgram(source, items.map((item) => item.input), counter);
	const outputs = run.outcome._tag === "Finished" && Array.isArray(run.outcome.result) ? run.outcome.result : [];
	const error = run.outcome._tag === "Failed" ? `${run.outcome.error}: ${firstLines(run.outcome.message, 3)}` : run.outcome._tag === "Finished" ? null : run.outcome._tag;
	return {
		arm: withCheck ? "model-writes-program-checked" : "model-writes-program",
		outputs: items.map((_item, index) => outputs[index] ?? null),
		tokens: counter.tokens,
		modelCalls: counter.calls,
		modelMs: counter.modelMs,
		wallMs: Date.now() - started,
		programMs: run.programMs,
		programSource: source,
		attempts,
		error,
	};
};

export const summarize = (items: ReadonlyArray<Item>, result: ArmResult) => ({ ...result, outputs: undefined, score: score(items, result.outputs) });

const CLEF_WRITER = `${SPEC}

Write a JavaScript program that migrates every config. It runs in a sandbox with no imports, no network and no timers.
- tool("configs", {}) returns the array of v1 configs.
- tool("judge_priorities", { notes }) takes an array of owner_note strings and returns an array of the same length, each "urgent", "normal" or "low". A fast small model judges them all at once. Call it once, with every note.
- The program's last expression is its result: the array of v2 objects, in input order.
Write plain loops (for...of), not forEach or map, around tool() calls.

Examples:

${examplesText}

Reply with only the program in one javascript code block.`;

type Ladder = { readonly floor: number; readonly counter: Meter };

export type LadderTrace = { readonly clef: ReadonlyArray<string>; readonly confidence: ReadonlyArray<number>; readonly final: ReadonlyArray<string>; readonly escalated: ReadonlyArray<number> };

type ClefRun = { readonly outcome: Outcome; readonly programMs: number; readonly calls: number; readonly items: number; readonly errors: number; readonly clefMs: number; readonly trace: LadderTrace | null };

const PRIORITIES = new Set(["urgent", "normal", "low"]);

const escalate = async (ladder: Ladder, notes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
	const reply = await ask(ladder.counter, [
		{ role: "system", content: SPEC },
		{ role: "user", content: `Judge the priority of each owner_note. Reply with only a JSON array of ${notes.length} strings, each "urgent", "normal" or "low", in the same order.\n\n${JSON.stringify(notes)}` },
	]);
	return parseArray(reply).map(String);
};

const judge = async (notes: ReadonlyArray<string>, ladder: Ladder | null): Promise<{ readonly labels: ReadonlyArray<string>; readonly errors: number; readonly ms: number; readonly trace: LadderTrace }> => {
	const judged = await clefPriorities(notes);
	const escalated = ladder === null ? [] : notes.flatMap((_note, index) => ((judged.confidence[index] ?? 0) < ladder.floor ? [index] : []));
	const upper = ladder === null || escalated.length === 0 ? [] : await escalate(ladder, escalated.map((index) => notes[index] ?? ""));
	const final = judged.labels.map((label, index) => {
		const position = escalated.indexOf(index);
		const better = position < 0 ? undefined : upper[position];
		return better !== undefined && PRIORITIES.has(better) ? better : label;
	});
	return { labels: final, errors: judged.errors, ms: judged.roundTripMs, trace: { clef: judged.labels, confidence: judged.confidence, final, escalated } };
};

const runClefProgram = async (source: string, configs: ReadonlyArray<Legacy>, ladder: Ladder | null): Promise<ClefRun> => {
	const tools = {
		configs: read(Schema.Json, () => configs as unknown as Schema.Json),
		judge_priorities: external(Schema.Json),
	};
	const script = new DurableScript({ programId: `c-${Date.now()}-${Math.random()}`, storage: memoryStorage(), tools, wasm, budgetTicks: 5000 });
	const started = Date.now();
	let judgeMs = 0;
	let calls = 0;
	let items = 0;
	let errors = 0;
	let clefMs = 0;
	let trace: LadderTrace | null = null;
	let outcome = await script.run(source);
	for (let guard = 0; guard < 1000; guard++) {
		if (outcome._tag === "Running") {
			outcome = await script.alarm();
			continue;
		}
		if (outcome._tag !== "Waiting") break;
		const notes = ((outcome.args as { notes?: ReadonlyArray<unknown> }).notes ?? []).map(String);
		const judgeStarted = Date.now();
		const judged = await judge(notes, ladder);
		judgeMs += Date.now() - judgeStarted;
		calls += 1;
		items += notes.length;
		errors += judged.errors;
		clefMs += judged.ms;
		trace = judged.trace;
		outcome = await script.answer(outcome.token, judged.labels);
	}
	return { outcome, programMs: Date.now() - started - judgeMs, calls, items, errors, clefMs, trace };
};

const mechanicalMistakes = (outputs: ReadonlyArray<unknown>): Array<string> =>
	EXAMPLES.flatMap((example, index) => {
		const got = outputs[index] as Record<string, unknown> | undefined;
		const wanted = { ...example.expected, priority: got?.priority };
		return JSON.stringify(got) === JSON.stringify(wanted) ? [] : [`input: ${JSON.stringify(example.input)}\nexpected: ${JSON.stringify(example.expected)}\ngot: ${JSON.stringify(got ?? null)}`];
	});

export const modelWritesProgramClef = async (items: ReadonlyArray<Item>, floor: number | null = null): Promise<ArmResult> => {
	const counter = meter();
	const ladder = floor === null ? null : { floor, counter };
	const started = Date.now();
	const messages: Array<Message> = [{ role: "user", content: CLEF_WRITER }];
	let source = "";
	let attempts = 0;
	const clef = { calls: 0, items: 0, errors: 0, ms: 0 };
	const add = (run: ClefRun): void => {
		clef.calls += run.calls;
		clef.items += run.items;
		clef.errors += run.errors;
		clef.ms += run.clefMs;
	};
	while (attempts < 3) {
		attempts += 1;
		const reply = await ask(counter, messages);
		source = fenced(reply, "javascript");
		if (source === "") continue;
		messages.push({ role: "assistant", content: reply });
		const trial = await runClefProgram(source, EXAMPLES.map((example) => example.input), ladder);
		add(trial);
		if (trial.outcome._tag === "Finished") {
			const wrong = mechanicalMistakes(Array.isArray(trial.outcome.result) ? trial.outcome.result : []);
			if (wrong.length === 0) break;
			messages.push({ role: "user", content: `I ran your program on the examples. These came out wrong (priority comes from judge_priorities, so only the other fields count):\n\n${wrong.join("\n\n")}\n\nFix the program. Reply with only the whole program in one javascript code block.` });
		} else {
			const detail = trial.outcome._tag === "Failed" ? `${trial.outcome.error}: ${firstLines(trial.outcome.message, 4)}` : trial.outcome._tag;
			messages.push({ role: "user", content: `I ran your program on the examples and it did not finish: ${detail}\n\nFix the program. Reply with only the whole program in one javascript code block.` });
		}
	}
	const base = { arm: floor === null ? "model-writes-program-clef" : `ladder-${floor}`, attempts };
	if (source === "") return { ...base, outputs: items.map(() => null), tokens: counter.tokens, modelCalls: counter.calls, modelMs: counter.modelMs, wallMs: Date.now() - started, programMs: null, programSource: "", error: "EmptyReply: the model returned no program" };
	const run = await runClefProgram(source, items.map((item) => item.input), ladder);
	add(run);
	const outputs = run.outcome._tag === "Finished" && Array.isArray(run.outcome.result) ? run.outcome.result : [];
	const error = run.outcome._tag === "Failed" ? `${run.outcome.error}: ${firstLines(run.outcome.message, 3)}` : run.outcome._tag === "Finished" ? null : run.outcome._tag;
	return {
		...base,
		outputs: items.map((_item, index) => outputs[index] ?? null),
		tokens: counter.tokens,
		modelCalls: counter.calls,
		modelMs: counter.modelMs,
		wallMs: Date.now() - started,
		programMs: run.programMs,
		programSource: source,
		error,
		judgeCalls: clef.calls,
		clefItems: clef.items,
		clefErrors: clef.errors,
		clefMs: clef.ms,
		ladder: run.trace ?? undefined,
	};
};
