# CMC-06: Jobs survive a server restart

Branch: `CMC-03_roadmap-items` (shared by CMC-03..CMC-06, one commit per ticket).

## Goal

Today `JobManager` (`src/jobs.ts`) keeps jobs in memory, so after a restart `wait`/`cancel` say "unknown job id" even though ComfyUI may still be rendering the prompts. After this ticket:

- jobs are saved to a state file and reloaded at start: finished jobs keep their state, outputs, seeds and errors;
- jobs that were running are **resumed**: the server re-attaches to their ComfyUI prompt ids, waits for them and writes the files exactly as the original call would have;
- a running job that cannot be resumed (it had not queued all its prompts yet, or ComfyUI no longer knows the prompt) ends as `error` with a clear message.

## Design

### Save spec (one code path for live jobs and resumed jobs)

Today every tool in `src/service.ts` has its own collect-and-save loop. Replace them with one persisted description of how a job's outputs are saved:

```ts
interface SaveSpec {
  target: OutTarget          // dir, stem?, ext?
  prefix: string             // 'image' | 'edit' | 'cutout' | 'music' | 'speech' | <workflow name>
  pick: 'first' | 'audio' | 'all'   // items[0] | audio item else first | every item
  onlyNode?: string
  prompts: number            // how many prompts the job queues in total
  total?: number             // numbering total for 'first'/'audio' (count of images); 'all' numbers over the items of the prompt
  seeds?: number[]           // per-prompt seed used in generated file names
  saved: number              // prompts already collected and written (resume skips them)
}
```

`ComfyService.finish(job, spec, signal)` loops over `job.promptIds` from `spec.saved`, collects (`collect()` as now), saves per `pick`, increments `spec.saved` and tells the manager the job changed. Every tool builds its spec, posts its prompt(s) (uploads first, as now) and calls `finish`. Behaviour and file names must stay exactly as today (the existing server tests guard this).

### Persistence

- `Config.stateFile`: `--state <file>` / `COMFY_MCP_STATE`, default `~/ComfyMCP/jobs.json` (`src/config.ts`, `src/index.ts` HELP, README later).
- `Job` gets `save?: SaveSpec` (persisted with it).
- `JobManager` takes an optional store `{ load(): Job[]; save(jobs: Job[]): void }` (a small `JobStore` class in `src/jobs.ts`, JSON file, atomic write: tmp file + rename, `mkdir -p`). The manager saves debounced (~250 ms) on start, finish, cancel and on `changed(job)`; `flush()` writes synchronously (called from the SIGINT/SIGTERM handler in `src/index.ts`). Progress strings are not worth a write on every poll. Keep `KEEP_FINISHED` pruning; prune before saving.
- A corrupt or unreadable state file: log a warning, start empty, do not crash and do not overwrite it until the first job change (rename it to `jobs.json.bad` is fine too).

### Restore / resume

`ComfyService.restoreJobs(): Promise<void>` (called by `main()` in `src/index.ts` after the server starts; **not** in the constructor, so tests that build a service do not touch the state file unless they ask):

1. Load jobs from the store into the manager (ids, timestamps and everything else unchanged).
2. For each job with `state === 'running'`:
   - no `save` spec, or `job.promptIds.length < save.prompts` → `error: "the server restarted before this job was queued on ComfyUI; run it again"`;
   - else re-attach with a manager method like `resume(job, runner)` that registers the done-promise and abort controller like `start()` does, with a runner that first checks each unsaved prompt id is known to ComfyUI (in `/queue` running/pending or in `/history/<id>`; add a small `promptKnown(base, id)` helper in `src/comfy/client.ts`) → else fail with "ComfyUI no longer has prompt <id> (it was restarted?)"; then `finish(job, job.save, signal)`.
   - ComfyUI unreachable at restore time: the runner's normal polling keeps retrying until the job timeout (as now); do not fail the whole restore.
3. Log one line per restored/resumed/failed job.

`wait`/`cancel` error messages that say "jobs are forgotten when the server restarts" change to say the id is unknown (it may be older than the last `KEEP_FINISHED` jobs).

## Steps

- [x] SaveSpec + `finish()` refactor in `src/service.ts`; all existing tests still pass unchanged.
- [x] `JobStore`, manager persistence hooks, `flush()`, `resume()` in `src/jobs.ts`.
- [x] `promptKnown` in `src/comfy/client.ts`.
- [x] `--state` config, `restoreJobs()` call and flush-on-shutdown in `src/index.ts`; HELP text.
- [x] Tests:
  - `tests/server.test.ts`: pass `--state <tmp>/jobs.json` in every `loadConfig` call so tests never touch `~/ComfyMCP`.
  - new `tests/jobs.test.ts`: (a) a finished job is written and a new manager/service loads it (`get`, `jobView` identical); (b) resume: fake ComfyUI (reuse the pattern in `tests/server.test.ts`) with a prompt that the first service posted; build a second service on the same state file whose first service was stopped mid-job (simulate by writing a state file with a running job + `save` spec + promptIds the fake knows), call `restoreJobs()`, `wait` → `done` and the file is written with the expected name; (c) unknown prompt id → `error` with the "no longer has prompt" message; (d) running job with fewer promptIds than `save.prompts` → `error`.
- [x] Live check: start the built server (`yarn build`, `node out/index.js --port <spare> --state <tmp>`) against the running ComfyUI, start a `generate_image` with `wait: 0`, kill the server (`Stop-Process`), start it again with the same state file, call `wait` with the old job id → `done` with the image written.

## Acceptance

- `yarn typecheck`, `yarn lint`, `yarn test` pass.
- Restarting the server keeps finished jobs and finishes running ones (live check above).

## Not in scope

README / ROADMAP edits (orchestrator).

## Results

- `yarn typecheck`, `yarn lint`, `yarn test` (4 files, 44 tests, incl. the new `tests/jobs.test.ts`) pass; `yarn build` ok. Existing server tests unchanged apart from `--state <tmp>` in both `loadConfig` calls.
- New tests: finished job saved and reloaded identically; corrupt state file -> warning, empty, copy kept as `.bad`; resume writes the file with the expected name; already-saved prompts skipped; unknown prompt -> "ComfyUI no longer has prompt ..."; too few promptIds or no save spec -> "the server restarted before this job was queued ...".
- Live check (ComfyUI at 8188, server on 7471, state in `.claude/temp/cmc06/jobs.json`): `generate_image` count 2, steps 20, `wait: 0` returned `job_af808b09`; server killed with `Stop-Process -Force` 2 s later (state file showed `running`, 2 promptIds, save spec); restarted with the same `--state`: log "restored 1 job(s)" + "resumed", `wait` returned `done` with both PNGs written (`image_<stamp>_<seed>_1.png`, `_2.png`); after another restart `wait` still reported the job `done` with its outputs.
- Deviations / notes: `OutTarget` and `SaveSpec` live in `src/jobs.ts` (service imports them) so the persisted `Job` type is self-contained. `JobStore` is wrapped by a `JobStorage` interface. A hard kill within the 250 ms debounce window of a job's start loses it (first live attempt: no state file yet); after the first prompt is queued it is persisted within 250 ms, and SIGINT/SIGTERM flush synchronously. The SDK client's 60 s request timeout needs `wait` calls with `timeout_seconds` below 60 in the live script.
