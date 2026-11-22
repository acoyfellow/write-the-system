export const MODEL = process.env.AGENT_MODEL ?? "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

export type Message = { readonly role: "system" | "user" | "assistant"; readonly content: string };

export type Reply = { readonly content: string; readonly tokens: number; readonly ms: number };

type Settings = { readonly url: (model: string) => string; readonly token: string };

const required = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set. See "Run it" in the README.`);
	return value;
};

const fromEnvironment = (): Settings => {
	const accountId = required("CLOUDFLARE_ACCOUNT_ID");
	const token = required("CLOUDFLARE_API_TOKEN");
	const gateway = process.env.AI_GATEWAY;
	return {
		url: (model) => (gateway ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/workers-ai/${model}` : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`),
		token,
	};
};

let cached: Settings | undefined;

const settings = (): Settings => (cached ??= fromEnvironment());

type Body = { result?: { choices?: ReadonlyArray<{ message?: { content?: string | null }; finish_reason?: string }>; usage?: { total_tokens?: number } }; errors?: ReadonlyArray<{ message?: string }> };

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export const chat = async (messages: ReadonlyArray<Message>, model: string = MODEL): Promise<Reply> => {
	for (let attempt = 1; ; attempt++) {
		const started = Date.now();
		const response = await fetch(settings().url(model), {
			method: "POST",
			headers: { authorization: `Bearer ${settings().token}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
			body: JSON.stringify({ messages, max_tokens: Number(process.env.MAX_TOKENS ?? 12000), temperature: 0.7, chat_template_kwargs: { enable_thinking: false } }),
			signal: AbortSignal.timeout(180_000),
		}).catch(() => null);
		if (response?.ok) {
			const body = (await response.json()) as Body;
			const choice = body.result?.choices?.[0];
			return { content: choice?.message?.content ?? "", tokens: body.result?.usage?.total_tokens ?? 0, ms: Date.now() - started };
		}
		if (response !== null && !RETRYABLE.has(response.status)) {
			const body = (await response.json().catch(() => ({}))) as Body;
			throw new Error(`${model} returned ${response.status}: ${body.errors?.[0]?.message ?? "no detail"}`);
		}
		if (attempt >= 6) throw new Error(`${model} failed after ${attempt} tries: ${response?.status ?? "network error"}`);
		await new Promise((resume) => setTimeout(resume, 2 ** attempt * 1000));
	}
};
