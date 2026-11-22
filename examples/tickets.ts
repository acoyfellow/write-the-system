import { writeTheSystem } from "../src/index.ts";
import { chat } from "../evals/model.ts";

const TEAMS = ["billing", "bug", "other"];

const write = async (prompt: string) => {
	const reply = await chat([{ role: "user", content: prompt }]);
	return reply.content;
};

const judge = async (texts: ReadonlyArray<string>) => {
	const reply = await chat([
		{
			role: "system",
			content: `Route each support ticket to one team: ${TEAMS.join(", ")}.`,
		},
		{
			role: "user",
			content: [
				`Reply with only a JSON array of ${texts.length} strings.`,
				JSON.stringify(texts),
			].join("\n\n"),
		},
	]);
	const text = reply.content;
	const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
	const teams = JSON.parse(json) as Array<unknown>;
	return texts.map((_text, i) => String(teams[i] ?? "other"));
};

const built = await writeTheSystem({
	task: [
		"Clean up support tickets. Output { id, email, team }.",
		'- id: the number in a "TCK-0042" id, as an integer',
		"- email: lowercase and trimmed",
		"- team: billing, bug or other, judged from the message",
	].join("\n"),
	examples: [
		{
			input: {
				id: "TCK-0042",
				email: " Ana@Example.COM ",
				message: "I was charged twice this month",
			},
			output: { id: 42, email: "ana@example.com", team: "billing" },
		},
		{
			input: {
				id: "TCK-0107",
				email: "bo@site.io",
				message: "The export button crashes the page",
			},
			output: { id: 107, email: "bo@site.io", team: "bug" },
		},
	],
	write,
	judge,
	judgeHelp: "For each message it answers billing, bug or other.",
});

const tickets = [
	{
		id: "TCK-0500",
		email: "CARL@Mail.com",
		message: "Refund please, wrong plan",
	},
	{
		id: "TCK-0501",
		email: " dee@x.org",
		message: "Login page shows a blank screen",
	},
	{
		id: "TCK-0502",
		email: "eve@y.net ",
		message: "Do you have a dark mode?",
	},
];

const result = await built.run(tickets);

console.log(`Program (passed after ${built.attempts.length} attempt):\n`);
console.log(built.source);
console.log("\nOutput:\n");
console.log(JSON.stringify(result.outputs, null, 2));
console.log(`\nJudge calls: ${result.judgeCalls} for ${result.judgedTexts} tickets`);
