import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

let engine: WebAssembly.Module | undefined;

const loadEngine = (): WebAssembly.Module => (engine ??= new Module(readFileSync(fileURLToPath(import.meta.resolve("@acoyfellow/amber/dq.wasm")))));

export type Example<Input, Output> = { readonly input: Input; readonly output: Output };

export type Writer = (prompt: string) => Promise<string>;

export type BatchJudge = (texts: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;

export type Job<Input, Output> = {
	readonly task: string;
	readonly examples: ReadonlyArray<Example<Input, Output>>;
	readonly write: Writer;
	readonly judge?: BatchJudge;
	readonly judgeHelp?: string;
	readonly compare?: (got: unknown, expected: Output) => boolean;
	readonly attempts?: number;
	readonly budgetTicks?: number;
};

export type Mismatch = { readonly input: unknown; readonly expected: unknown; readonly got: unknown };

export type Attempt = { readonly source: string; readonly passed: boolean; readonly problem: string | null };

export type Built<Input, Output> = {
	readonly source: string;
	readonly attempts: ReadonlyArray<Attempt>;
	readonly run: (inputs: ReadonlyArray<Input>) => Promise<RunResult<Output>>;
};

export type RunResult<Output> = { readonly outputs: ReadonlyArray<Output>; readonly judgeCalls: number; readonly judgedTexts: number; readonly ms: number };

export class ProgramFailed extends Error {
	override readonly name = "ProgramFailed";
}

export class NoPassingProgram extends Error {
	override readonly name = "NoPassingProgram";

	constructor(readonly attempts: ReadonlyArray<Attempt>) {
		super(`no program passed the examples in ${attempts.length} attempts. Last problem: ${attempts.at(-1)?.problem ?? "none"}`);
	}
}

const FENCE = "`".repeat(3);

export const extractProgram = (reply: string): string => {
	const match = new RegExp(`${FENCE}(?:javascript|js)?\\s*\\n([\\s\\S]*?)${FENCE}`).exec(reply);
	return (match?.[1] ?? reply).trim();
};

const judgeLines = (job: Job<unknown, unknown>): string =>
	job.judge === undefined
		? ""
		: `\n- tool("judge", { texts }) takes an array of strings and returns an array of answers of the same length. ${job.judgeHelp ?? "A small model answers each text."} It is the only way to make judgment calls. Call it once, with every text you need judged.`;

export const writerPrompt = <Input, Output>(job: Job<Input, Output>): string => `${job.task}

Write a JavaScript program that does this for every input. It runs in a sandbox with no imports, no network and no timers.
- tool("inputs", {}) returns the array of inputs.${judgeLines(job as Job<unknown, unknown>)}
- The program's last expression is its result: an array with one output per input, in input order.
Use plain for...of loops, not forEach or map, around tool() calls.

Examples:

${job.examples.map((example) => `input: ${JSON.stringify(example.input)}\noutput: ${JSON.stringify(example.output)}`).join("\n\n")}

Reply with only the program in one javascript code block.`;

const sameJson = (got: unknown, expected: unknown): boolean => JSON.stringify(got) === JSON.stringify(expected);

const MAX_STEPS = 10_000;

export const runProgram = async <Output>(source: string, inputs: ReadonlyArray<unknown>, judge: BatchJudge | undefined, budgetTicks = 5000): Promise<RunResult<Output>> => {
	const tools = { inputs: read(Schema.Json, () => inputs as unknown as Schema.Json), judge: external(Schema.Json) };
	const script = new DurableScript({ programId: `wts-${crypto.randomUUID()}`, storage: memoryStorage(), tools, wasm: loadEngine(), budgetTicks });
	const started = Date.now();
	let judgeCalls = 0;
	let judgedTexts = 0;
	let outcome: Outcome = await script.run(source);
	for (let step = 0; step < MAX_STEPS; step++) {
		if (outcome._tag === "Running") {
			outcome = await script.alarm();
			continue;
		}
		if (outcome._tag !== "Waiting") break;
		if (judge === undefined) throw new ProgramFailed(`the program called tool("${outcome.name}") but no judge was given`);
		const texts = ((outcome.args as { texts?: ReadonlyArray<unknown> } | null)?.texts ?? []).map(String);
		const answers = await judge(texts);
		if (answers.length !== texts.length) throw new ProgramFailed(`the judge returned ${answers.length} answers for ${texts.length} texts`);
		judgeCalls += 1;
		judgedTexts += texts.length;
		outcome = await script.answer(outcome.token, answers);
	}
	if (outcome._tag === "Failed") throw new ProgramFailed(`${outcome.error}: ${outcome.message.split("\n").slice(0, 3).join(" ")}`);
	if (outcome._tag !== "Finished") throw new ProgramFailed(`the program did not finish within ${MAX_STEPS} steps`);
	if (!Array.isArray(outcome.result)) throw new ProgramFailed("the program's result is not an array");
	return { outputs: outcome.result as ReadonlyArray<Output>, judgeCalls, judgedTexts, ms: Date.now() - started };
};

const problemWith = async <Input, Output>(job: Job<Input, Output>, source: string): Promise<string | null> => {
	const compare = job.compare ?? sameJson;
	try {
		const { outputs } = await runProgram<Output>(source, job.examples.map((example) => example.input), job.judge, job.budgetTicks);
		const wrong: Array<Mismatch> = job.examples.flatMap((example, index) => (compare(outputs[index], example.output) ? [] : [{ input: example.input, expected: example.output, got: outputs[index] ?? null }]));
		return wrong.length === 0 ? null : `These examples came out wrong:\n\n${wrong.map((miss) => `input: ${JSON.stringify(miss.input)}\nexpected: ${JSON.stringify(miss.expected)}\ngot: ${JSON.stringify(miss.got)}`).join("\n\n")}`;
	} catch (error) {
		return `It did not finish: ${error instanceof Error ? error.message : String(error)}`;
	}
};

export const writeTheSystem = async <Input, Output>(job: Job<Input, Output>): Promise<Built<Input, Output>> => {
	const attempts: Array<Attempt> = [];
	let prompt = writerPrompt(job);
	for (let attempt = 1; attempt <= (job.attempts ?? 3); attempt++) {
		const source = extractProgram(await job.write(prompt));
		const problem = source === "" ? "The reply had no program." : await problemWith(job, source);
		attempts.push({ source, passed: problem === null, problem });
		if (problem === null) return { source, attempts, run: (inputs) => runProgram<Output>(source, inputs, job.judge, job.budgetTicks) };
		prompt = `${writerPrompt(job)}\n\nYour last program:\n\n${FENCE}javascript\n${source}\n${FENCE}\n\nI ran it on the examples. ${problem}\n\nFix it. Reply with only the whole program in one javascript code block.`;
	}
	throw new NoPassingProgram(attempts);
};
