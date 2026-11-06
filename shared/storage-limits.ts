export const MIB = 1024 * 1024
export const DEFAULT_APPEND_MAX_MIB = 90
export const MAX_APPEND_MAX_MIB = 5115

export function normalizeAppendMaxMiB(value: unknown): number {
  if (value === undefined) return DEFAULT_APPEND_MAX_MIB
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_APPEND_MAX_MIB) throw new Error(`追加后文件大小上限必须是 1 到 ${MAX_APPEND_MAX_MIB} MiB 的整数。`)
  return value
}
