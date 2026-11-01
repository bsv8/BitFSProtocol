import { sha256 } from '@noble/hashes/sha2.js'

/** 调试事件：仅宿主显式启用；序号属于当前 JS runtime，不是业务/协议序号。 */
export interface BitfsDebugEvent {
  source: string
  event: string
  runtimeId: string
  sequence: number
  time: string
  monotonicMs: number
  details: unknown
}
export type BitfsDebugSink = (event: Readonly<BitfsDebugEvent>) => void
let sink: BitfsDebugSink | undefined
let sequence = 0
const runtimeId = globalThis.crypto?.randomUUID?.() ?? `bitfs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** 宿主控制开关和输出渠道。undefined 关闭；SDK 不猜环境、不写文件。 */
export function setBitfsDebugSink (next?: BitfsDebugSink): void { sink = next }
export function bitfsDebugEnabled (): boolean { return sink !== undefined }

const privateField = /password|passwd|private.?key|secret|token|credential|mnemonic|wif|authorizationheader/i
function safeText (text: string): string {
  return text.replace(/(bearer\s+)[^\s"',;]+/giu, '$1[redacted]')
    .replace(/((?:password|passwd|private[_-]?key|secret|token|api[_-]?key)\s*[=:]\s*)[^\s"',;&]+/giu, '$1[redacted]')
}
/** 防误传：二进制只保留长度与 SHA-256；敏感字段替换，不输出正文或签名原文。 */
export function bitfsDebugSummary (value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return safeText(value)
  if (typeof value === 'bigint') return value.toString()
  if (value == null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return { byteLength: value.byteLength, sha256: Array.from(sha256(value), byte => byte.toString(16).padStart(2, '0')).join('') }
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown, kind?: unknown, field?: unknown, cause?: unknown }
    return { name: error.name, message: safeText(error.message), stack: error.stack === undefined ? undefined : safeText(error.stack), code: error.code,
      kind: error.kind, field: error.field, cause: bitfsDebugSummary(error.cause, seen) }
  }
  if (Array.isArray(value)) return value.map(item => bitfsDebugSummary(item, seen))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    privateField.test(key) ? '[redacted]' : bitfsDebugSummary(item, seen)]))
}

/** 同步/异步操作的起止与失败；不记录参数/返回正文，调用者另记安全摘要。 */
export function bitfsDebugStart (source: string, operation: string): (error?: unknown) => void {
  if (!sink) return () => {}
  const start = performance.now()
  const spanId = `${runtimeId}/${sequence + 1}`
  bitfsDebug(source, `${operation}.start`, () => ({ spanId }))
  return error => bitfsDebug(source, `${operation}.finish`, () => ({ spanId, elapsedMs: performance.now() - start, error }))
}

/** details 使用惰性函数，关闭时不计算快照/摘要；日志失败不改变交易结果。 */
export function bitfsDebug (source: string, event: string, details: () => unknown = () => ({})): void {
  const output = sink
  if (!output) return
  try {
    output({ source, event, runtimeId, sequence: ++sequence, time: new Date().toISOString(),
      monotonicMs: performance.now(), details: bitfsDebugSummary(details()) })
  } catch { /* 诊断不是交易责任存储，输出失败不得影响业务。 */ }
}
