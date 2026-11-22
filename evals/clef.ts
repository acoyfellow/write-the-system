import { execFileSync } from "node:child_process";

const SWARM = process.env.SWARM_URL ?? "";

const QUESTION = {
	priority: {
		type: "choice",
		instructions: "This is a service owner's note about their service. How urgent is the service?",
		criteria: {
			urgent: "outage hurts customers, revenue or login, or needs someone woken up",
			normal: "ordinary service; fix in business hours or the sprint",
			low: "nobody depends on it, experimental, legacy or best effort",
		},
	},
};

type SwarmReply = {
	readonly answers: ReadonlyArray<{ readonly index: number; readonly answers: { readonly priority?: { readonly choice?: string; readonly confidence?: number } } }>;
	readonly errors: number;
	readonly wall_ms: number;
};

const accessToken = (): string => execFileSync("cloudflared", ["access", "token", `-app=${SWARM}`], { encoding: "utf8", timeout: 30_000 }).trim();

export type ClefJudgment = { readonly labels: ReadonlyArray<string>; readonly confidence: ReadonlyArray<number>; readonly errors: number; readonly swarmMs: number; readonly roundTripMs: number };

export const clefPriorities = async (notes: ReadonlyArray<string>): Promise<ClefJudgment> => {
	if (SWARM === "") throw new Error("set SWARM_URL to the swarm worker");
	const started = Date.now();
	const response = await fetch(`${SWARM}/ask`, {
		method: "POST",
		headers: { "content-type": "application/json", "cf-access-token": accessToken() },
		body: JSON.stringify({ items: notes, questions: QUESTION, model: "clef" }),
		signal: AbortSignal.timeout(300_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`swarm ${response.status}: ${text.slice(0, 200)}`);
	const reply = JSON.parse(text) as SwarmReply;
	const labels = notes.map((_note, index) => reply.answers.find((answer) => answer.index === index)?.answers.priority?.choice ?? "normal");
	const confidence = notes.map((_note, index) => reply.answers.find((answer) => answer.index === index)?.answers.priority?.confidence ?? 0);
	return { labels, confidence, errors: reply.errors, swarmMs: reply.wall_ms, roundTripMs: Date.now() - started };
};
