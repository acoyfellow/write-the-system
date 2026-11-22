import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractProgram, NoPassingProgram, ProgramFailed, runProgram, writeTheSystem, writerPrompt } from "../src/index.ts";

const FENCE = "`".repeat(3);

const fenced = (source: string): string => `Here you go:\n${FENCE}javascript\n${source}\n${FENCE}`;

const DOUBLE = `const out = [];
for (const n of tool("inputs", {})) out.push(n * 2);
out;`;

const LABEL = `const inputs = tool("inputs", {});
const texts = [];
for (const item of inputs) texts.push(item.note);
const labels = tool("judge", { texts });
const out = [];
let i = 0;
for (const item of inputs) { out.push({ id: item.id, label: labels[i] }); i += 1; }
out;`;

const keywordJudge = async (texts: ReadonlyArray<string>) => texts.map((text) => (text.includes("down") ? "urgent" : "normal"));

test("extractProgram takes the fenced code and falls back to the whole reply", () => {
	assert.equal(extractProgram(fenced("1 + 1;")), "1 + 1;");
	assert.equal(extractProgram("  2 + 2;  "), "2 + 2;");
});

test("the prompt mentions judge only when a judge is given", () => {
	const job = { task: "Double each number.", examples: [{ input: 2, output: 4 }], write: async () => "" };
	assert.doesNotMatch(writerPrompt(job), /tool\("judge"/);
	assert.match(writerPrompt({ ...job, judge: keywordJudge }), /tool\("judge"/);
});

test("a program that passes the examples is kept and runs on new inputs", async () => {
	const built = await writeTheSystem({ task: "Double each number.", examples: [{ input: 2, output: 4 }], write: async () => fenced(DOUBLE) });
	assert.equal(built.attempts.length, 1);
	assert.deepEqual((await built.run([1, 5, 10])).outputs, [2, 10, 20]);
});

test("a wrong program gets the mismatch back and can fix itself", async () => {
	const prompts: Array<string> = [];
	const replies = [fenced(DOUBLE.replace("* 2", "* 3")), fenced(DOUBLE)];
	const built = await writeTheSystem({ task: "Double each number.", examples: [{ input: 2, output: 4 }], write: async (prompt) => (prompts.push(prompt), replies.shift() ?? "") });
	assert.equal(built.attempts.length, 2);
	assert.match(prompts[1] ?? "", /expected: 4\ngot: 6/);
});

test("judgment calls go to the judge in one batch", async () => {
	const seen: Array<ReadonlyArray<string>> = [];
	const judge = async (texts: ReadonlyArray<string>) => (seen.push(texts), keywordJudge(texts));
	const built = await writeTheSystem({ task: "Label each note.", examples: [{ input: { id: 1, note: "down = lost revenue" }, output: { id: 1, label: "urgent" } }], write: async () => fenced(LABEL), judge });
	const result = await built.run([{ id: 7, note: "fine" }, { id: 8, note: "goes down a lot" }, { id: 9, note: "ok" }]);
	assert.deepEqual(result.outputs, [{ id: 7, label: "normal" }, { id: 8, label: "urgent" }, { id: 9, label: "normal" }]);
	assert.equal(result.judgeCalls, 1);
	assert.deepEqual(seen.at(-1), ["fine", "goes down a lot", "ok"]);
});

test("it gives up after the attempt limit and reports every attempt", async () => {
	await assert.rejects(
		writeTheSystem({ task: "Double each number.", examples: [{ input: 2, output: 4 }], write: async () => fenced("[0];"), attempts: 2 }),
		(error: unknown) => error instanceof NoPassingProgram && error.attempts.length === 2,
	);
});

test("a program that throws is reported, not swallowed", async () => {
	await assert.rejects(runProgram("null.x;", [], undefined), ProgramFailed);
});

test("a judge that returns the wrong number of answers is caught", async () => {
	await assert.rejects(runProgram(LABEL, [{ id: 1, note: "a" }], async () => []), /0 answers for 1 texts/);
});
