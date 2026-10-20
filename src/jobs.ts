import { randomBytes } from 'node:crypto'

/**
 * Jobs: every generation runs in the background as a job with an id. A tool call waits for it up to its `wait` seconds and
 * returns the finished paths, or the job id while it still runs; `wait` and `cancel` take the id. Jobs live in memory only (a
 * restart forgets them; files already written stay on disk).
 */

export type JobState = 'running' | 'done' | 'error' | 'cancelled'

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
}

/** What a job runner gets: the job to fill in and a signal that fires on cancel. */
export type JobRunner = (job: Job, signal: AbortSignal) => Promise<void>

const KEEP_FINISHED = 200

export class JobManager {
  private jobs = new Map<string, Job>()
  private done = new Map<string, Promise<void>>()
  private aborts = new Map<string, AbortController>()

  constructor(private readonly onCancel?: (job: Job) => Promise<void>, private readonly log?: (msg: string) => void) {}

  start(tool: string, summary: string, runner: JobRunner, info: Record<string, unknown> = {}): Job {
    const job: Job = { id: `job_${randomBytes(4).toString('hex')}`, tool, summary, state: 'running', progress: 'starting', createdAt: Date.now(), promptIds: [], outputs: [], seeds: [], info }
    const abort = new AbortController()
    this.jobs.set(job.id, job)
    this.aborts.set(job.id, abort)
    this.log?.(`${job.id} ${tool}: ${summary}`)
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
    })
    this.done.set(job.id, finished)
    return job
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
    if (!job) throw new Error(`no job "${id}" (jobs are forgotten when the server restarts)`)
    if (job.state !== 'running') return job
    job.state = 'cancelled'
    job.error = 'cancelled by the caller'
    this.aborts.get(id)?.abort()
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
