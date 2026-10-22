import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Jobs: every generation runs in the background as a job with an id. A tool call waits for it up to its `wait` seconds and
 * returns the finished paths, or the job id while it still runs; `wait` and `cancel` take the id. Jobs are saved to a state file
 * (debounced, atomic) and reloaded at start: finished jobs keep their result, running ones are resumed by the service from their
 * ComfyUI prompt ids and `save` spec.
 */

export type JobState = 'running' | 'done' | 'error' | 'cancelled'

/** Where outputs go: a folder (names are made up) or one file path (numbered when a job writes several). */
export interface OutTarget {
  dir: string
  /** File stem when the caller named a file. */
  stem?: string
  /** The extension the caller asked for, without the dot. */
  ext?: string
}

/** How a job's outputs are saved. Persisted with the job, so a restarted server can finish it the same way. */
export interface SaveSpec {
  target: OutTarget
  /** File name prefix: `image`, `edit`, `cutout`, `music`, `speech` or the workflow name. */
  prefix: string
  /** Which files of a prompt are written: the first, the audio one (else the first), or every one. */
  pick: 'first' | 'audio' | 'all'
  onlyNode?: string
  /** How many prompts the job queues in total. */
  prompts: number
  /** Numbering total for `first`/`audio` (the number of prompts); `all` numbers over the files of the prompt. */
  total?: number
  /** Seed per prompt, used in generated file names. */
  seeds?: number[]
  /** Prompts already collected and written (a resumed job skips them). */
  saved: number
}

export interface Job {
  id: string
  tool: string
  /** One line on what it makes, e.g. `z-image-turbo 1024x1024 x2`. */
  summary: string
  state: JobState
  /** Latest progress note: `queued`, `running 12s`, `download`, ... */
  progress: string
  createdAt: number
  finishedAt?: number
  /** ComfyUI prompt ids this job queued (for cancel). */
  promptIds: string[]
  /** Absolute paths of the files written so far. */
  outputs: string[]
  seeds: number[]
  error?: string
  /** Extra result fields a tool reports (engine, model, warnings). */
  info: Record<string, unknown>
  /** How to save the outputs; without it a running job cannot be resumed after a restart. */
  save?: SaveSpec
}

/** What a job runner gets: the job to fill in and a signal that fires on cancel. */
export type JobRunner = (job: Job, signal: AbortSignal) => Promise<void>

export interface JobStorage {
  load(): Job[]
  save(jobs: Job[]): void
}

const KEEP_FINISHED = 200
const SAVE_DELAY_MS = 250

/** Jobs in a JSON file, written atomically (temp file + rename). */
export class JobStore implements JobStorage {
  constructor(private readonly file: string, private readonly log?: (msg: string) => void) {}

  /** The saved jobs; a missing file is empty, an unreadable one is set aside as `<file>.bad` with a warning. */
  load(): Job[] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.(`warning: cannot read job state ${this.file}: ${(e as Error).message}`)
      return []
    }
    try {
      const data = JSON.parse(text) as { jobs?: unknown }
      if (!Array.isArray(data?.jobs)) throw new Error('no "jobs" list')
      return (data.jobs as Job[]).filter((j) => typeof j?.id === 'string' && typeof j.state === 'string')
    } catch (e) {
      this.log?.(`warning: job state ${this.file} is corrupt (${(e as Error).message}); starting empty`)
      try {
        renameSync(this.file, `${this.file}.bad`)
      } catch {
        /* leave it; the next save replaces it */
      }
      return []
    }
  }

  save(jobs: Job[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2))
    renameSync(tmp, this.file)
  }
}

export class JobManager {
  private jobs = new Map<string, Job>()
  private done = new Map<string, Promise<void>>()
  private aborts = new Map<string, AbortController>()
  private timer?: NodeJS.Timeout
  private dirty = false

  constructor(
    private readonly onCancel?: (job: Job) => Promise<void>,
    private readonly log?: (msg: string) => void,
    private readonly store?: JobStorage
  ) {}

  start(tool: string, summary: string, runner: JobRunner, info: Record<string, unknown> = {}): Job {
    const job: Job = { id: `job_${randomBytes(4).toString('hex')}`, tool, summary, state: 'running', progress: 'starting', createdAt: Date.now(), promptIds: [], outputs: [], seeds: [], info }
    this.jobs.set(job.id, job)
    this.log?.(`${job.id} ${tool}: ${summary}`)
    this.run(job, runner)
    return job
  }

  /** Adds the saved jobs (ids, times and results unchanged) and returns them; the caller resumes or fails the running ones. */
  load(): Job[] {
    const loaded = this.store?.load() ?? []
    for (const job of loaded) this.jobs.set(job.id, job)
    return loaded
  }

  /** Re-attaches a loaded running job to a runner, as `start` does for a new one. */
  resume(job: Job, runner: JobRunner): void {
    job.progress = 'resuming'
    this.log?.(`${job.id} resumed: ${job.summary}`)
    this.run(job, runner)
  }

  /** Ends a loaded running job as an error without running anything. */
  fail(job: Job, message: string): void {
    job.state = 'error'
    job.error = message
    job.progress = 'error'
    job.finishedAt = Date.now()
    this.log?.(`${job.id} error: ${message}`)
    this.changed()
  }

  /** Tells the manager a job changed, so the state file is rewritten soon. */
  changed(): void {
    if (!this.store) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
    this.timer.unref()
  }

  /** Writes the state file now when something changed (also on SIGINT/SIGTERM). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.store || !this.dirty) return
    this.dirty = false
    this.prune()
    try {
      this.store.save(this.list())
    } catch (e) {
      this.log?.(`warning: cannot save job state: ${(e as Error).message}`)
    }
  }

  private run(job: Job, runner: JobRunner): void {
    const abort = new AbortController()
    this.aborts.set(job.id, abort)
    this.changed()
    const finished = runner(job, abort.signal).then(
      () => {
        if (job.state === 'running') job.state = 'done'
        job.progress = job.state
      },
      (e: unknown) => {
        if (job.state === 'running') {
          job.state = abort.signal.aborted ? 'cancelled' : 'error'
          job.error = e instanceof Error ? e.message : String(e)
        }
        job.progress = job.state
      }
    ).finally(() => {
      job.finishedAt = Date.now()
      this.aborts.delete(job.id)
      this.log?.(`${job.id} ${job.state}${job.error ? `: ${job.error}` : ''}${job.outputs.length ? ` -> ${job.outputs.join(', ')}` : ''}`)
      this.prune()
      this.changed()
    })
    this.done.set(job.id, finished)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  active(): Job[] {
    return this.list().filter((j) => j.state === 'running')
  }

  /** Waits until every job has finished or the timeout passes; returns whether all finished. */
  async wait(ids: string[], timeoutMs: number): Promise<boolean> {
    const pending = ids.map((id) => this.done.get(id)).filter((p): p is Promise<void> => !!p)
    if (timeoutMs <= 0) return ids.every((id) => this.jobs.get(id)?.state !== 'running')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([Promise.all(pending).then(() => true as const), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async cancel(id: string): Promise<Job> {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job id "${id}" (only the last ${KEEP_FINISHED} finished jobs are kept)`)
    if (job.state !== 'running') return job
    job.state = 'cancelled'
    job.error = 'cancelled by the caller'
    this.aborts.get(id)?.abort()
    this.changed()
    await this.onCancel?.(job).catch((e: unknown) => this.log?.(`cancel ${id}: ${(e as Error).message}`))
    return job
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.state !== 'running')
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.delete(job.id)
      this.done.delete(job.id)
    }
  }
}

/** The job as a tool returns it. */
export function jobView(job: Job): Record<string, unknown> {
  const end = job.finishedAt ?? Date.now()
  return {
    job_id: job.id,
    tool: job.tool,
    state: job.state,
    summary: job.summary,
    ...(job.state === 'running' ? { progress: job.progress, next: `still running: call wait with job_id "${job.id}"` } : {}),
    outputs: job.outputs,
    ...(job.seeds.length > 0 ? { seeds: job.seeds } : {}),
    ...job.info,
    elapsed_s: Math.round((end - job.createdAt) / 100) / 10,
    ...(job.error ? { error: job.error } : {})
  }
}
