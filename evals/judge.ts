import { clefPriorities } from "./clef.ts";
import { chat, type Message } from "./model.ts";

export type Judged = { readonly labels: ReadonlyArray<string>; readonly confidence: ReadonlyArray<number>; readonly errors: number; readonly roundTripMs: number; readonly tokens: number };

export type BatchJudge = { readonly name: string; readonly judge: (notes: ReadonlyArray<string>) => Promise<Judged> };

const LABELS = new Set(["urgent", "normal", "low"]);

const RULES = `urgent: outage hurts customers, revenue or login, or needs someone woken up. low: nobody depends on it, experimental, legacy or best effort. normal: everything else.`;

const CHUNK = 50;

const parseLabels = (text: string, count: number): Array<string> => {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	const parsed = start < 0 || end < start ? [] : (JSON.parse(text.slice(start, end + 1)) as Array<unknown>);
	return Array.from({ length: count }, (_unused, index) => {
		const label = String(parsed[index] ?? "").toLowerCase();
		return LABELS.has(label) ? label : "normal";
	});
};

const askChunk = async (model: string, notes: ReadonlyArray<string>): Promise<{ readonly labels: Array<string>; readonly tokens: number; readonly failed: boolean }> => {
	const messages: Array<Message> = [
		{ role: "system", content: `You label service owner notes by priority. ${RULES}` },
		{ role: "user", content: `Reply with only a JSON array of ${notes.length} strings, each "urgent", "normal" or "low", in the same order.\n\n${JSON.stringify(notes)}` },
	];
	const reply = await chat(messages, model);
	try {
		return { labels: parseLabels(reply.content, notes.length), tokens: reply.tokens, failed: false };
	} catch {
		return { labels: notes.map(() => "normal"), tokens: reply.tokens, failed: true };
	}
};

export const workersAiJudge = (model: string): BatchJudge => ({
	name: model.split("/").at(-1) ?? model,
	judge: async (notes) => {
		const started = Date.now();
		const chunks = Array.from({ length: Math.ceil(notes.length / CHUNK) }, (_unused, index) => notes.slice(index * CHUNK, (index + 1) * CHUNK));
		const replies = await Promise.all(chunks.map((chunk) => askChunk(model, chunk)));
		return {
			labels: replies.flatMap((reply) => reply.labels),
			confidence: notes.map(() => 1),
			errors: replies.filter((reply) => reply.failed).length,
			roundTripMs: Date.now() - started,
			tokens: replies.reduce((sum, reply) => sum + reply.tokens, 0),
		};
	},
});

export const clefJudge: BatchJudge = {
	name: "clef",
	judge: async (notes) => ({ ...(await clefPriorities(notes)), tokens: 0 }),
};

export const DEFAULT_JUDGE_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

export const selectJudge = (): BatchJudge => {
	const choice = process.env.JUDGE ?? (process.env.SWARM_URL ? "clef" : "workers-ai");
	return choice === "clef" ? clefJudge : workersAiJudge(process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL);
};
