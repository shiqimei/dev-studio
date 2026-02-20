export interface TaskState {
  task_uuid: string
  task_name: string
  runs: RunState[]
  lastAccess: number
}

export interface RunState {
  run: number
  entries: any[]
  passed: boolean | null
  checkpoints: any[]
  status: string
}

export interface InstSummary {
  totalRuns: number
  passed: number
  failed: number
  checkpoints: { total: number; passed: number }
}

const TTL_MS = 60 * 60 * 1000 // 1 hour

export class Store {
  tasks = new Map<string, TaskState>()
  /** taskUuid → sessionId */
  private sessionIndex = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.timer = setInterval(() => this.expire(), 60_000)
    if (this.timer.unref) this.timer.unref()
  }

  private expire() {
    const now = Date.now()
    for (const [uuid, task] of this.tasks) {
      if (now - task.lastAccess > TTL_MS) {
        this.tasks.delete(uuid)
        this.sessionIndex.delete(uuid)
      }
    }
  }

  touch(uuid: string) {
    const t = this.tasks.get(uuid)
    if (t) t.lastAccess = Date.now()
  }

  ingest(payload: { entries: any[]; passed: boolean; checkpoints: any[] }): { task_uuid: string; run: number; received: number; passed: boolean } {
    const taskEntry = payload.entries.find((e: any) => e.type === 'task')
    if (!taskEntry) throw new Error('No task entry found')

    const uuid = taskEntry.task_uuid
    const name = taskEntry.task_name || ''

    let task = this.tasks.get(uuid)
    if (!task) {
      task = { task_uuid: uuid, task_name: name, runs: [], lastAccess: Date.now() }
      this.tasks.set(uuid, task)
    }
    task.lastAccess = Date.now()
    task.task_name = name

    const runNum = task.runs.length + 1

    // Cap at 100 runs
    if (task.runs.length >= 100) {
      task.runs.shift()
    }

    const run: RunState = {
      run: runNum,
      entries: payload.entries,
      passed: payload.passed,
      checkpoints: payload.checkpoints,
      status: payload.entries.some((e: any) => e.type === 'done') ? 'done' : 'exited',
    }
    task.runs.push(run)

    return { task_uuid: uuid, run: runNum, received: payload.entries.length, passed: payload.passed }
  }

  getTask(uuid: string): TaskState | undefined {
    this.touch(uuid)
    return this.tasks.get(uuid)
  }

  deleteTask(uuid: string): boolean {
    this.sessionIndex.delete(uuid)
    return this.tasks.delete(uuid)
  }

  registerTaskSession(taskUuid: string, sessionId: string): void {
    this.sessionIndex.set(taskUuid, sessionId)
  }

  getTasksForSession(sessionId: string): TaskState[] {
    const results: TaskState[] = []
    for (const [uuid, sid] of this.sessionIndex) {
      if (sid === sessionId) {
        const task = this.tasks.get(uuid)
        if (task) results.push(task)
      }
    }
    return results
  }

  getSessionSummary(sessionId: string): InstSummary | null {
    const tasks = this.getTasksForSession(sessionId)
    if (tasks.length === 0) return null

    let totalRuns = 0
    let passed = 0
    let failed = 0
    let checkTotal = 0
    let checkPassed = 0

    for (const task of tasks) {
      for (const run of task.runs) {
        totalRuns++
        if (run.passed === true) passed++
        else if (run.passed === false) failed++
        for (const cp of run.checkpoints) {
          checkTotal++
          if (cp.passed) checkPassed++
        }
      }
    }

    return { totalRuns, passed, failed, checkpoints: { total: checkTotal, passed: checkPassed } }
  }

  listTasks(): any[] {
    return Array.from(this.tasks.values()).map(t => ({
      task_uuid: t.task_uuid,
      task_name: t.task_name,
      total_runs: t.runs.length,
      latest_passed: t.runs.length > 0 ? t.runs[t.runs.length - 1].passed : null,
    }))
  }

  close() {
    if (this.timer) clearInterval(this.timer)
  }
}
