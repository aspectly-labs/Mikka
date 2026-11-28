export function recordTaskArchiveBase(root: string): Promise<void>

export function writeTaskArchive(root: string, output: string): Promise<{
  size: number
  sha256: string
  headSha: string
}>

export function verifyTaskArchive(packed: AsyncIterable<Uint8Array>, mask: (value: string) => string): Promise<void>

export function restoreTaskArchive(root: string, packedPath: string, sha256: string): Promise<void>
