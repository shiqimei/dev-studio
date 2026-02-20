import { evaluate, type Assertion, type AssertionResult } from './evaluator.js'

export { evaluate, type Assertion, type AssertionResult } from './evaluator.js'

export interface ConfigOptions {
  serverUrl?: string
  enabled?: boolean
}

interface Entry {
  task_uuid: string
  task_name: string
  ts: number
  type: string
  text?: string
  label?: string
  data?: any
  expect?: Assertion[]
  url?: string
  assertions?: AssertionResult[]
}

interface CheckpointResult {
  label: string
  passed: boolean
  assertions: AssertionResult[]
}

interface TaskState {
  task_uuid: string
  task_name: string
  entries: Entry[]
  expects: Map<string, Assertion[]>
  webhookUrl: string
  pushScheduled: boolean
}

const INST_PREFIX = ':::INST:'

let configured = false
let origLog: typeof console.log
let origError: typeof console.error
let origWarn: typeof console.warn

const tasks = new Map<string, TaskState>()
let serverUrl = 'http://localhost:9701'

function now(): number {
  return Date.now() / 1000
}

function getTask(uuid: string): TaskState | undefined {
  return tasks.get(uuid)
}

function ensureTask(uuid: string, name?: string): TaskState {
  let t = tasks.get(uuid)
  if (!t) {
    t = { task_uuid: uuid, task_name: name ?? '', entries: [], expects: new Map(), webhookUrl: '', pushScheduled: false }
    tasks.set(uuid, t)
  }
  if (name) t.task_name = name
  return t
}

function parseLine(line: string, stream: 'stdout' | 'stderr'): boolean {
  if (!line.startsWith(INST_PREFIX)) return false

  const rest = line.slice(INST_PREFIX.length)
  const colonIdx = rest.indexOf(':')
  const command = colonIdx === -1 ? rest : rest.slice(0, colonIdx)
  const payload = colonIdx === -1 ? '' : rest.slice(colonIdx + 1)

  switch (command) {
    case 'TASK': {
      // payload: <task_uuid>:<task_name>
      const firstColon = payload.indexOf(':')
      if (firstColon === -1) return false
      const uuid = payload.slice(0, firstColon)
      const name = payload.slice(firstColon + 1)
      const t = ensureTask(uuid, name)
      t.entries.push({ task_uuid: uuid, task_name: name, ts: now(), type: 'task' })
      break
    }
    case 'LOG': {
      // payload: <task_uuid>:<text>
      const firstColon = payload.indexOf(':')
      if (firstColon === -1) return false
      const uuid = payload.slice(0, firstColon)
      const text = payload.slice(firstColon + 1)
      const t = ensureTask(uuid)
      t.entries.push({ task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'log', text })
      break
    }
    case 'WEBHOOK': {
      // payload: <task_uuid>:<url>
      const firstColon = payload.indexOf(':')
      if (firstColon === -1) return false
      const uuid = payload.slice(0, firstColon)
      const url = payload.slice(firstColon + 1)
      const t = ensureTask(uuid)
      t.webhookUrl = url
      t.entries.push({ task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'webhook', url })
      break
    }
    case 'EXPECT': {
      // payload: <task_uuid>:<label>:<json_array>
      const firstColon = payload.indexOf(':')
      if (firstColon === -1) return false
      const uuid = payload.slice(0, firstColon)
      const rest2 = payload.slice(firstColon + 1)
      const secondColon = rest2.indexOf(':')
      if (secondColon === -1) return false
      const label = rest2.slice(0, secondColon)
      try {
        const assertions = JSON.parse(rest2.slice(secondColon + 1)) as Assertion[]
        const t = ensureTask(uuid)
        t.expects.set(label, assertions)
        t.entries.push({ task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'expect', label, expect: assertions })
      } catch { /* ignore bad JSON */ }
      break
    }
    case 'CHECK': {
      // payload: <task_uuid>:<label>:<json>
      const firstColon = payload.indexOf(':')
      if (firstColon === -1) return false
      const uuid = payload.slice(0, firstColon)
      const rest2 = payload.slice(firstColon + 1)
      const secondColon = rest2.indexOf(':')
      if (secondColon === -1) return false
      const label = rest2.slice(0, secondColon)
      let data: any
      try {
        data = JSON.parse(rest2.slice(secondColon + 1))
      } catch {
        data = { _raw: rest2.slice(secondColon + 1) }
      }
      const t = ensureTask(uuid)
      const entry: Entry = { task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'checkpoint', label, data }
      const assertionDefs = t.expects.get(label)
      if (assertionDefs) {
        const logEntries = t.entries.filter(e => e.type === 'log')
        entry.assertions = evaluate(assertionDefs, data, logEntries)
      }
      t.entries.push(entry)
      break
    }
    case 'DONE': {
      // payload: <task_uuid>
      const uuid = payload
      if (!uuid) return false
      const t = getTask(uuid)
      if (t) {
        t.entries.push({ task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'done' })
        schedulePush(uuid)
      }
      break
    }
    default:
      return false
  }
  return true
}

function makeInterceptor(orig: (...args: any[]) => void, stream: 'stdout' | 'stderr') {
  return function (...args: any[]) {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    const lines = text.split('\n')
    for (const line of lines) {
      if (parseLine(line, stream)) continue // swallow convention lines
      // Plain output: pass through to terminal but do NOT capture
      orig.call(console, ...args)
      return // only call orig once for the full args
    }
  }
}

function buildPayload(t: TaskState): { entries: Entry[]; passed: boolean; checkpoints: CheckpointResult[] } {
  const checkpoints: CheckpointResult[] = []
  for (const entry of t.entries) {
    if (entry.type === 'checkpoint' && entry.assertions) {
      checkpoints.push({
        label: entry.label!,
        passed: entry.assertions.every(a => a.passed),
        assertions: entry.assertions,
      })
    }
  }
  const passed = checkpoints.length === 0 || checkpoints.every(c => c.passed)
  return { entries: t.entries, passed, checkpoints }
}

async function push(uuid: string): Promise<void> {
  const t = tasks.get(uuid)
  if (!t || t.entries.length === 0) return
  const payload = buildPayload(t)
  try {
    await fetch(`${serverUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // silently fail — best effort
  }
  tasks.delete(uuid)
}

function schedulePush(uuid: string): void {
  const t = tasks.get(uuid)
  if (!t || t.pushScheduled) return
  t.pushScheduled = true
  queueMicrotask(() => { push(uuid) })
}

function pushAllPending(): void {
  for (const [uuid, t] of tasks) {
    if (t.entries.length > 0 && !t.pushScheduled) {
      t.entries.push({ task_uuid: uuid, task_name: t.task_name, ts: now(), type: 'exit', text: 'process exit' })
      const payload = buildPayload(t)
      try {
        fetch(`${serverUrl}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {}
    }
  }
  tasks.clear()
}

// For testing: reset all state
function reset(): void {
  tasks.clear()
}

// For testing: build payload for a specific task
function buildPayloadForTask(uuid: string): { entries: Entry[]; passed: boolean; checkpoints: CheckpointResult[] } {
  const t = tasks.get(uuid)
  if (!t) return { entries: [], passed: true, checkpoints: [] }
  return buildPayload(t)
}

export function config(options?: ConfigOptions): void {
  const enabled = options?.enabled ?? (process.env.INST_ENABLED !== '0')
  if (!enabled) return
  if (configured) return

  serverUrl = options?.serverUrl ?? process.env.INST_SERVER ?? 'http://localhost:9701'
  configured = true

  origLog = console.log.bind(console)
  origError = console.error.bind(console)
  origWarn = console.warn.bind(console)

  console.log = makeInterceptor(origLog, 'stdout')
  console.error = makeInterceptor(origError, 'stderr')
  console.warn = makeInterceptor(origWarn, 'stderr')

  process.on('exit', () => {
    pushAllPending()
  })
}

// Export for testing
export { parseLine as _parseLine, reset as _reset, buildPayloadForTask as _buildPayload, tasks as _tasks }
