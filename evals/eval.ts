import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeItems } from "./data.ts";
import { MODEL } from "./model.ts";
import { modelDoesEveryItem, modelWritesProgram, modelWritesProgramClef, summarize } from "./arms.ts";

const COUNT = Number(process.env.COUNT ?? 500);

const TRIALS = Number(process.env.TRIALS ?? 3);

const SEED = Number(process.env.SEED ?? 7);

const ARMS = (process.env.ARMS ?? "every,program,checked").split(",");

const full = COUNT >= 500 && TRIALS >= 3;

const tag = process.env.TAG ?? "";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

if (full && execFileSync("git", ["status", "--porcelain", "src", "evals"], { encoding: "utf8" }).trim() !== "") throw new Error("commit src and evals before a full run");

const items = makeItems(COUNT, SEED);

const trials = [];

for (let trial = 1; trial <= TRIALS; trial++) {
	for (const arm of ARMS) {
		const result = arm === "every" ? await modelDoesEveryItem(items) : arm === "clef" || arm === "batch" ? await modelWritesProgramClef(items) : arm.startsWith("ladder-") ? await modelWritesProgramClef(items, Number(arm.slice(7))) : await modelWritesProgram(items, arm === "checked");
		const summary = { trial, ...summarize(items, result), ladder: result.ladder };
		trials.push(summary);
		if (summary.ladder !== undefined) {
			const truth = items.map((item) => item.expected.priority);
			const trace = summary.ladder;
			const wrong = (labels: ReadonlyArray<string>) => labels.filter((label, index) => label !== truth[index]).length;
			const confidentWrong = trace.clef.filter((label, index) => label !== truth[index] && !trace.escalated.includes(index)).length;
			const fixed = trace.escalated.filter((index) => trace.clef[index] !== truth[index] && trace.final[index] === truth[index]).length;
			const broke = trace.escalated.filter((index) => trace.clef[index] === truth[index] && trace.final[index] !== truth[index]).length;
			console.log(`  judge wrong=${wrong(trace.clef)} escalated=${trace.escalated.length} fixed=${fixed} broke=${broke} finalWrong=${wrong(trace.final)} wrongAndSure=${confidentWrong}`);
		}
		console.log(`${trial} ${summary.arm} exact=${summary.score.exact}/${summary.score.total} priority=${summary.score.fields.priority} tokens=${summary.tokens} calls=${summary.modelCalls} wall=${summary.wallMs}ms program=${summary.programMs ?? "-"}ms attempts=${summary.attempts}${summary.clefItems === undefined ? "" : ` judge=${summary.judgeName} ${summary.clefItems}items/${summary.judgeCalls}calls/${summary.clefMs}ms judgeTokens=${summary.judgeTokens} errors=${summary.clefErrors}`}${summary.error ? ` error=${summary.error.split("\n")[0]}` : ""}`);
	}
}

const sealed = { kind: "write-the-system", at: new Date().toISOString(), commit, model: MODEL, count: COUNT, seed: SEED, trials };
const body = JSON.stringify(sealed, null, 2);
const out = fileURLToPath(new URL(`../bench/${full ? "receipt" : "receipt-small"}${tag === "" ? "" : `-${tag}`}.json`, import.meta.url));
writeFileSync(out, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`DONE ${out}`);
