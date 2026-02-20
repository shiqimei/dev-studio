export interface Assertion {
  field: string
  op: string
  value?: any
  msg: string
}

export interface AssertionResult {
  field: string
  op: string
  value?: any
  msg: string
  passed: boolean
  actual?: any
  error?: string
}

/**
 * Resolve a dot-path into a value from an object.
 * Supports array indices like "users.0.name".
 * Special field "_logs" returns the logs parameter.
 */
export function resolvePath(data: any, path: string, logs?: any[]): { value: any; exists: boolean } {
  if (path === '_logs') {
    return { value: logs ?? [], exists: true }
  }

  const parts = path.split('.')
  let current = data

  for (const part of parts) {
    if (current == null) {
      return { value: undefined, exists: false }
    }
    if (typeof current === 'object' && part in current) {
      current = current[part]
    } else if (Array.isArray(current) && /^\d+$/.test(part)) {
      const idx = parseInt(part, 10)
      if (idx < current.length) {
        current = current[idx]
      } else {
        return { value: undefined, exists: false }
      }
    } else if (part === 'length' && (Array.isArray(current) || typeof current === 'string')) {
      current = current.length
    } else {
      return { value: undefined, exists: false }
    }
  }

  return { value: current, exists: true }
}

/**
 * Evaluate a single assertion against checkpoint data.
 */
export function evaluateAssertion(assertion: Assertion, data: any, logs?: any[]): AssertionResult {
  const base: AssertionResult = {
    field: assertion.field,
    op: assertion.op,
    msg: assertion.msg,
    passed: false,
  }
  if (assertion.value !== undefined) base.value = assertion.value

  try {
    const { value: actual, exists } = resolvePath(data, assertion.field, logs)
    base.actual = actual

    switch (assertion.op) {
      case 'eq':
        base.passed = actual === assertion.value
        break
      case 'neq':
        base.passed = actual !== assertion.value
        break
      case 'gt':
        base.passed = typeof actual === 'number' && actual > assertion.value
        break
      case 'gte':
        base.passed = typeof actual === 'number' && actual >= assertion.value
        break
      case 'lt':
        base.passed = typeof actual === 'number' && actual < assertion.value
        break
      case 'lte':
        base.passed = typeof actual === 'number' && actual <= assertion.value
        break
      case 'contains':
        if (Array.isArray(actual)) {
          base.passed = actual.includes(assertion.value)
        } else if (typeof actual === 'string') {
          base.passed = actual.includes(assertion.value)
        }
        break
      case 'not_contains':
        if (Array.isArray(actual)) {
          base.passed = !actual.includes(assertion.value)
        } else if (typeof actual === 'string') {
          base.passed = !actual.includes(assertion.value)
        }
        break
      case 'in':
        base.passed = Array.isArray(assertion.value) && assertion.value.includes(actual)
        break
      case 'not_in':
        base.passed = Array.isArray(assertion.value) && !assertion.value.includes(actual)
        break
      case 'exists':
        base.passed = exists && actual != null
        break
      case 'not_exists':
        base.passed = !exists || actual == null
        break
      case 'matches':
        base.passed = typeof actual === 'string' && new RegExp(assertion.value).test(actual)
        break
      case 'length_eq':
        base.passed = (Array.isArray(actual) || typeof actual === 'string') && actual.length === assertion.value
        break
      case 'length_gte':
        base.passed = (Array.isArray(actual) || typeof actual === 'string') && actual.length >= assertion.value
        break
      case 'length_lte':
        base.passed = (Array.isArray(actual) || typeof actual === 'string') && actual.length <= assertion.value
        break
      case 'type':
        if (assertion.value === 'array') {
          base.passed = Array.isArray(actual)
        } else if (assertion.value === 'null') {
          base.passed = actual === null
        } else {
          base.passed = typeof actual === assertion.value
        }
        break
      default:
        base.error = `Unknown operator: ${assertion.op}`
    }
  } catch (err: any) {
    base.error = err.message ?? String(err)
  }

  return base
}

/**
 * Evaluate an array of assertions against checkpoint data.
 */
export function evaluate(assertions: Assertion[], data: any, logs?: any[]): AssertionResult[] {
  return assertions.map(a => evaluateAssertion(a, data, logs))
}
