import { writeTheSystem } from "../src/index.ts";
import { chat } from "../evals/model.ts";

const write = async (prompt: string): Promise<string> => (await chat([{ role: "user", content: prompt }])).content;

const judge = async (texts: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
	const reply = await chat([
		{ role: "system", content: "You route support tickets. Answer billing, bug or other for each one." },
		{ role: "user", content: `Reply with only a JSON array of ${texts.length} strings, in order.\n\n${JSON.stringify(texts)}` },
	]);
	const parsed = JSON.parse(reply.content.slice(reply.content.indexOf("["), reply.content.lastIndexOf("]") + 1)) as Array<unknown>;
	return texts.map((_text, index) => String(parsed[index] ?? "other"));
};

const built = await writeTheSystem({
	task: `Clean up support tickets. Output { id, email, team }.
- id: the number in "TCK-0042" style ids, as an integer
- email: lowercase and trimmed
- team: "billing", "bug" or "other", judged from the message`,
	examples: [
		{ input: { id: "TCK-0042", email: " Ana@Example.COM ", message: "I was charged twice this month" }, output: { id: 42, email: "ana@example.com", team: "billing" } },
		{ input: { id: "TCK-0107", email: "bo@site.io", message: "The export button crashes the page" }, output: { id: 107, email: "bo@site.io", team: "bug" } },
	],
	write,
	judge,
	judgeHelp: 'For each message it answers "billing", "bug" or "other".',
});

console.log(`program passed the examples after ${built.attempts.length} attempt(s):\n\n${built.source}\n`);

const result = await built.run([
	{ id: "TCK-0500", email: "CARL@Mail.com", message: "Refund please, wrong plan" },
	{ id: "TCK-0501", email: " dee@x.org", message: "Login page shows a blank screen" },
	{ id: "TCK-0502", email: "eve@y.net ", message: "Do you have a dark mode?" },
]);

console.log(result.outputs);
console.log(`judge calls: ${result.judgeCalls} for ${result.judgedTexts} messages`);
