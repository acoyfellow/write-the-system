export type Priority = "urgent" | "normal" | "low";

export type Legacy = Record<string, unknown>;

export type Migrated = {
	readonly name: string;
	readonly timeoutMs: number;
	readonly host: string;
	readonly port: number;
	readonly retries: number;
	readonly tags: ReadonlyArray<string>;
	readonly enabled: boolean;
	readonly priority: Priority;
};

export type Item = { readonly input: Legacy; readonly expected: Migrated };

const NOTES: Record<Priority, ReadonlyArray<string>> = {
	urgent: [
		"pages on-call if this goes down",
		"customer checkout depends on it",
		"outage here means lost revenue",
		"wake someone up if it breaks",
		"payments flow, treat as sev1",
		"if this is down the login page is down",
		"this one cannot be offline, ever",
		"exec dashboard reads from this in real time",
	],
	normal: [
		"standard internal service",
		"business hours support is fine",
		"fix within the sprint if it breaks",
		"used by the reporting team daily",
		"regular service, nothing special",
		"page during the day, not at night",
		"important but has a fallback",
		"owned by platform, usual SLAs",
	],
	low: [
		"nobody will notice for a week",
		"experimental, can be off",
		"legacy job, scheduled for removal",
		"not urgent at all, can wait",
		"only used in demos",
		"best effort, no SLA",
		"internal toy, ignore alerts",
		"not critical; downtime is fine",
	],
};

const FILLER = ["", "", " (per Dana)", " - see runbook", " — updated Q3", " fwiw", " as of last review"];

const HOSTS = ["api", "auth", "billing", "search", "queue", "cache", "mail", "files", "events", "report"];

const TAGS = ["Prod", "edge", "EU", "us", "batch", "internal", "beta", "pci", "core", "web"];

const mulberry = (seed: number) => () => {
	let value = (seed += 0x6d2b79f5);
	value = Math.imul(value ^ (value >>> 15), value | 1);
	value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
	return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

export const makeItems = (count: number, seed: number): Array<Item> => {
	const random = mulberry(seed);
	const pick = <A>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)] as A;
	const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

	return Array.from({ length: count }, (_unused, index) => {
		const name = `svc-${pick(HOSTS)}-${index + 1}`;
		const seconds = int(1, 120);
		const timeoutForm = int(0, 3);
		const timeout = timeoutForm === 0 ? `${seconds}s` : timeoutForm === 1 ? `${seconds * 1000}ms` : timeoutForm === 2 && seconds % 60 === 0 ? `${seconds / 60}m` : seconds;
		const host = `${pick(HOSTS)}.${pick(["internal", "example.com", "svc.local"])}`;
		const hasPort = random() < 0.7;
		const port = hasPort ? pick([80, 8080, 8443, 3000, 9090, 5432]) : 443;
		const retriesForm = int(0, 2);
		const retries = int(0, 5);
		const tagList = Array.from({ length: int(0, 4) }, () => pick(TAGS));
		const tags = random() < 0.5 ? tagList.map((tag) => (random() < 0.3 ? ` ${tag} ` : tag)).join(",") : tagList;
		const enabledValue = random() < 0.8;
		const enabled = pick(enabledValue ? ["yes", "true", 1, true, "on"] : ["no", "false", 0, false, "off"]);
		const priority = pick<Priority>(["urgent", "normal", "normal", "low"]);
		const note = `${pick(NOTES[priority])}${pick(FILLER)}`;
		const input: Legacy = {
			name,
			timeout,
			endpoint: hasPort ? `${host}:${port}` : host,
			...(retriesForm === 0 ? {} : { retries: retriesForm === 1 ? String(retries) : retries }),
			tags,
			enabled,
			owner_note: note,
		};
		const expected: Migrated = {
			name,
			timeoutMs: typeof timeout === "number" ? timeout * 1000 : seconds * 1000,
			host,
			port,
			retries: retriesForm === 0 ? 0 : retries,
			tags: [...new Set(tagList.map((tag) => tag.trim().toLowerCase()))].sort(),
			enabled: enabledValue,
			priority,
		};
		return { input, expected };
	});
};

export const SPEC = `Migrate legacy service configs (v1) to v2.

v1 fields:
- name: string
- timeout: "30s", "1500ms", "2m", or a bare number meaning seconds
- endpoint: "host" or "host:port"
- retries: number or numeric string; may be missing
- tags: comma-separated string (with stray spaces) or an array of strings; may be empty
- enabled: one of "yes", "no", "true", "false", "on", "off", 1, 0, true, false
- owner_note: free text written by the service owner

v2 fields (all required):
- name: unchanged
- timeoutMs: integer milliseconds
- host: string
- port: integer; 443 when the endpoint has no port
- retries: integer; 0 when missing
- tags: lowercase, trimmed, de-duplicated, sorted ascending; [] when none
- enabled: boolean
- priority: "urgent", "normal" or "low", judged from owner_note. urgent: outage hurts customers, revenue or login, or needs someone woken up. low: nobody depends on it, experimental, legacy or best effort. normal: everything else.`;

export const EXAMPLES: ReadonlyArray<Item> = [
	{
		input: { name: "svc-demo-a", timeout: "90s", endpoint: "api.internal:8080", retries: "2", tags: " Prod,edge,prod", enabled: "yes", owner_note: "checkout breaks if this is down" },
		expected: { name: "svc-demo-a", timeoutMs: 90000, host: "api.internal", port: 8080, retries: 2, tags: ["edge", "prod"], enabled: true, priority: "urgent" },
	},
	{
		input: { name: "svc-demo-b", timeout: 5, endpoint: "cache.svc.local", tags: [], enabled: 0, owner_note: "prototype, safe to turn off" },
		expected: { name: "svc-demo-b", timeoutMs: 5000, host: "cache.svc.local", port: 443, retries: 0, tags: [], enabled: false, priority: "low" },
	},
	{
		input: { name: "svc-demo-c", timeout: "2m", endpoint: "mail.example.com:3000", retries: 4, tags: ["EU", "batch"], enabled: "on", owner_note: "used by finance every morning" },
		expected: { name: "svc-demo-c", timeoutMs: 120000, host: "mail.example.com", port: 3000, retries: 4, tags: ["batch", "eu"], enabled: true, priority: "normal" },
	},
];

const FIELDS = ["name", "timeoutMs", "host", "port", "retries", "tags", "enabled", "priority"] as const;

export type Score = { readonly exact: number; readonly fields: Record<(typeof FIELDS)[number], number>; readonly total: number };

export const score = (items: ReadonlyArray<Item>, outputs: ReadonlyArray<unknown>): Score => {
	const fields = Object.fromEntries(FIELDS.map((field) => [field, 0])) as Record<(typeof FIELDS)[number], number>;
	let exact = 0;
	items.forEach((item, index) => {
		const output = outputs[index];
		const record = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : {};
		let all = true;
		for (const field of FIELDS) {
			const same = JSON.stringify(record[field]) === JSON.stringify(item.expected[field]);
			if (same) fields[field] += 1;
			else all = false;
		}
		if (all) exact += 1;
	});
	return { exact, fields, total: items.length };
};
