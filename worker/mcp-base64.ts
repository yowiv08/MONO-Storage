/** Returns the decoded length of canonical standard Base64, or null for invalid or oversized data. */
export function canonicalBase64ByteLength(value: string, maxBytes: number): number | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || value.length % 4 !== 0) return null
  if (value.length === 0) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedLength = value.length / 4 * 3 - padding
  if (decodedLength > maxBytes) return null
  const contentLength = value.length - padding
  let lastSextet = 0
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index)
    if (code >= 65 && code <= 90) lastSextet = code - 65
    else if (code >= 97 && code <= 122) lastSextet = code - 71
    else if (code >= 48 && code <= 57) lastSextet = code + 4
    else if (code === 43) lastSextet = 62
    else if (code === 47) lastSextet = 63
    else return null
  }
  // Canonical Base64 requires zero unused tail bits.
  if (padding === 2 && (lastSextet & 15) !== 0 || padding === 1 && (lastSextet & 3) !== 0) return null
  return decodedLength
}

export function isCanonicalBase64(value: string, maxBytes: number): boolean {
  return canonicalBase64ByteLength(value, maxBytes) !== null
}
