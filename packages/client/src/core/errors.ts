export type ErrorCode =
  | 'snapshot_admission_required'
  | 'unknown_model'
  | 'unknown_field'
  | 'unknown_relation'
  | 'forbidden_operation'
  | 'forbidden_field'
  | 'unsupported_query'
  | 'validation_failed'
  | 'conflict'
  | 'schema_mismatch'
  | 'cursor_expired'
  | 'idempotency_mismatch'
  | 'upgrade_required'
  | 'not_found'
  | 'session_changed'
  | 'nested_transaction'
  | 'closed_database'
  | 'incomplete_dataset'
  | 'snapshot_invalid'
  | 'confirmation_timeout'
  | 'operation_attempted'
  | 'stale_generation'
  | 'invalid_snapshot'
  | 'authentication_required'
  | 'rate_limited'
  | 'causal_dependency'

const errorCodes: ReadonlySet<string> = new Set<ErrorCode>([
  'snapshot_admission_required',
  'unknown_model',
  'unknown_field',
  'unknown_relation',
  'forbidden_operation',
  'forbidden_field',
  'unsupported_query',
  'validation_failed',
  'conflict',
  'schema_mismatch',
  'cursor_expired',
  'idempotency_mismatch',
  'upgrade_required',
  'not_found',
  'session_changed',
  'nested_transaction',
  'closed_database',
  'incomplete_dataset',
  'snapshot_invalid',
  'confirmation_timeout',
  'operation_attempted',
  'stale_generation',
  'invalid_snapshot',
  'authentication_required',
  'rate_limited',
  'causal_dependency',
])

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && errorCodes.has(value)
}

export class SynloquentError extends Error {
  readonly code: ErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: ErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'SynloquentError'
    this.code = code
    this.details = details
  }
}

export function unsupported(capability: string): never {
  throw new SynloquentError(
    'unsupported_query',
    `Capability ${capability} requires an explicitly registered remote execution mode.`,
    { capability },
  )
}
