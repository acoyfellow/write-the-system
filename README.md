# write-the-system

Don't make a model do 500 jobs. Make it write the program once.

A batch job is usually mostly rules plus a little judgment. `write-the-system` asks a model to write one JavaScript program for the job. The program does the rules itself. When it needs judgment, it hands every case to a small model in one batch. The program is tested on your examples before it touches real data.

```ts
import { writeTheSystem } from "./src/index.ts";

const built = await writeTheSystem({
  task: "Clean up support tickets. Output { id, email, team }. team is billing, bug or other, judged from the message.",
  examples: [
    { input: { id: "TCK-0042", email: " Ana@Example.COM ", message: "I was charged twice" }, output: { id: 42, email: "ana@example.com", team: "billing" } },
  ],
  write: (prompt) => myModel(prompt),
  judge: (messages) => mySmallModel(messages),
});

const { outputs, judgeCalls } = await built.run(tickets);
```

## How it works

1. **Write.** Your model gets the task and examples, and writes a program.
2. **Check.** The program runs on the examples in a sandbox. If any output is wrong, the model sees what it got and what was expected, and tries again (3 tries by default).
3. **Run.** The program that passed runs on your real inputs. It reads them with `tool("inputs")`, and makes judgment calls with `tool("judge", { texts })`. Each call pauses the program, sends every text to your judge at once, and resumes it with the answers.

The program runs in [amber](https://github.com/acoyfellow/amber): QuickJS in WebAssembly, with no imports, network or timers. `tool()` is its only way out.

## Results

500 messy service configs from a fixed seed. Seven fields are rules (timeouts, host and port, tags, flags). One field, priority, is judged from a free-text note. A config counts as right only if all 8 fields match. 3 tries each.

**Current model: deepseek-v4.1-flash** on Workers AI, writing and judging. Receipt: [`bench/receipt-deepseek.json`](bench/receipt-deepseek.json).

| | Right of 500 | Tokens per run | Model calls | Time |
|---|---|---|---|---|
| Model does every item | 487, 487, 487 | 82,463 | 50 | ~39 s |
| Program plus batch judge | 489, 484, 482 | ~8,400 (1,400 writing, 7,000 judging) | 1 + 2 judge | ~7 s |

**Original run: glm-5.3-flash** writing, with Clef (a small classifier) judging. glm-5.3-flash was retired on 2026-11-20, so this run can no longer be repeated. Receipt: [`bench/receipt-clef.json`](bench/receipt-clef.json). Written up at [coey.dev/write-the-system](https://coey.dev/write-the-system).

| | Right of 500 | Tokens per run | Model calls | Time |
|---|---|---|---|---|
| Model does every item | 478, 478, 478 | ~131,000 | 50 | 2.0–2.3 min |
| Program plus Clef | 489, 489, 489 | ~5,500, Clef not counted | 1 | 26–53 s |

**What holds across both:** about 10 times fewer tokens and 5 times faster. The program got every rule field right in every run. All of its misses were judgment calls.

**What changed:** glm-5.3-flash was weak at doing every item, so the program also won on accuracy. deepseek-v4.1-flash is good at doing every item, so accuracy is now about even. Judgment is the limit either way: the program can only be as right as its judge.

## What didn't work

- **One model call per judgment.** The first version asked the model about each note, one at a time. 473 of 500, 109,616 tokens, 25 minutes. Writing the program saved nothing until the judgment calls were batched.
- **Escalating unsure answers to a bigger model.** All 11 of Clef's misses were answers it was confident about, so no confidence cutoff reached them. Sending more up made it worse: 127 sent, 4 fixed, 15 broken. Receipt: [`bench/receipt-small-ladder.json`](bench/receipt-small-ladder.json).

## Run it

Needs Node 22 or newer and a Cloudflare account with Workers AI.

```sh
npm install
npm run check                # types and tests, no API key needed

export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...   # a token with Workers AI read
npm run example              # writes and runs a ticket-cleanup program
npm run bench:small          # 30 configs, about a minute
npm run bench                # 500 configs x 3, about 3 minutes
```

Optional settings:

| Variable | Default | What it does |
|---|---|---|
| `AGENT_MODEL` | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | Writes the program, and does every item in the baseline |
| `JUDGE_MODEL` | same | Judges notes in batches of 50 |
| `AI_GATEWAY` | none | Route calls through this AI Gateway |
| `ARMS` | `every,program,checked` | `every`, `batch`, `program` (one call per note), `ladder-0.3` |
| `COUNT`, `TRIALS`, `SEED` | 500, 3, 7 | Size of the benchmark |

A full run (500 or more configs, 3 or more trials) refuses to start with uncommitted code, and writes the commit and a SHA-256 into the receipt.

## API

`writeTheSystem(job)` returns `{ source, attempts, run(inputs) }`, or throws `NoPassingProgram` with every attempt.

| `job` field | |
|---|---|
| `task` | What to do, in plain words |
| `examples` | `{ input, output }` pairs. The program must reproduce them all |
| `write(prompt)` | Your model. Returns text with a javascript code block |
| `judge(texts)` | Optional. Returns one answer per text |
| `judgeHelp` | Optional. Tells the writer what the judge answers |
| `compare(got, expected)` | Optional. Defaults to JSON equality |
| `attempts`, `budgetTicks` | 3 and 5000 |

`run(inputs)` returns `{ outputs, judgeCalls, judgedTexts, ms }`, or throws `ProgramFailed`.

## Limits

- One benchmark task, with data and answers I generated.
- If the examples don't cover a case, the program can pass and still be wrong on it. Your examples are the spec.
- Tokens are model tokens only. Clef does not report tokens, so the original run leaves them out.
- In the current run, the baseline produced the same tokens and score in all 3 trials. The model may be close to deterministic at this setting.
- The program runs in QuickJS: much slower than V8 for heavy computation. It took 7–16 ms for 500 configs.
- Not a package. Clone the repo and import `src/index.ts`.

## License

MIT
