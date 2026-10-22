# Changelog

## 2026-10-22 — CMC-06: jobs survive a server restart

Jobs are now saved to a state file, and running jobs are resumed after a restart. A live hard-kill test passed.

**Repo** `comfy-mcp`, branch `CMC-03_roadmap-items`, commit `5f56de3`.

| File | Change |
|---|---|
| `src/jobs.ts` | Adds `OutTarget` and `SaveSpec` types and `Job.save`. New `JobStore`: a JSON file written atomically (tmp + rename); a corrupt file is renamed to `.bad` and the store starts empty. `JobManager` takes an optional store, saves debounced (250 ms, pruned first), and has `flush()`, `load()`, `resume()`, `fail()` and `changed()`; `start` and `resume` share `run()`. The unknown-id error no longer says restarts forget jobs. |
| `src/service.ts` | Every tool builds a persisted `SaveSpec` and saves through one `finish()`; `queue()` persists each prompt id as it is posted. File names and behaviour are unchanged. New `restoreJobs()`. A running job without a spec, or with fewer prompt ids than the spec expects, is failed. Otherwise the job is resumed after `promptKnown` checks; when ComfyUI is unreachable the check is skipped and normal polling retries. |
| `src/comfy/client.ts` | `promptKnown(base, id)`: checks the prompt is in `/queue` or `/history/<id>`. |
| `src/config.ts`, `src/index.ts` | `--state` / `COMFY_MCP_STATE`, default `~/ComfyMCP/jobs.json`. `main()` calls `restoreJobs()` after start and `jobs.flush()` on SIGINT/SIGTERM; HELP text and the startup log line updated. |
| `src/mcp/tools.ts` | `wait` unknown-id message updated. |
| `tests/server.test.ts` | `--state <tmp>` added to both `loadConfig` calls; nothing else changed. |
| `tests/jobs.test.ts` | New. Covers save and reload, a corrupt file, resume writing the expected file name, skipping already-saved prompts, an unknown prompt failing, and too few prompt ids or no spec failing. |
| `README.md`, `ROADMAP.md` | Jobs paragraph, `--state` flag row and the roadmap item ticked. The "Where it stands" summary was updated in the same commit. |

**Deviations:** `OutTarget` and `SaveSpec` live in `jobs.ts`, so the persisted `Job` type is self-contained. A small `JobStorage` interface was added. The orchestrator removed an unused `changed()` parameter.

**Verification**
- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 44 passed (4 files). `yarn build`: OK.
- Live, ComfyUI 0.42.0 and a server on port 7471 with its own state file:
  1. `generate_image` with `count: 2`, `steps: 20`, `wait: 0` returned `job_af808b09`.
  2. `Stop-Process -Force` 2 s later. The state file held the running job with 2 prompt ids and its spec.
  3. Restart with the same `--state`. The log showed "restored 1 job(s)" and "resumed"; `wait` returned `done` and both PNGs were written.
  4. After another restart the job was still reported as `done`.

**Known limitations**
- A hard kill within 250 ms of a job starting, before the first debounced save, loses that job id. SIGINT and SIGTERM flush synchronously.
- If a crash interrupts the saving of a multi-file `run_workflow` prompt, resuming writes that prompt's files again.

**Commit status:** committed locally (`5f56de3`), not pushed.
