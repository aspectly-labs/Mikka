/** One upload fits the hosted request body limit, including the API proxy. */
export const TASK_FILE_MAX_BYTES = 3 * 1024 * 1024
export const TASK_FILE_MAX_COUNT = 10
/**
 * Files shown inside the description or a comment (placement `inline`), as
 * Linear's and GitHub's editors take pasted images. They do not count toward
 * the task's own files and never appear in its file list.
 */
export const TASK_INLINE_FILE_MAX_COUNT = 100
/** An inline upload nothing has referenced yet expires after a day, as an unsent chat file does. */
export const TASK_INLINE_FILE_PENDING_HOURS = 24
/** An inline file whose last reference was removed stays this long: a restored description version or an undo still finds it. */
export const TASK_INLINE_FILE_RETAIN_DAYS = 30
export const TASK_FILE_PLACEMENTS = ['task', 'inline'] as const
export type TaskFilePlacement = typeof TASK_FILE_PLACEMENTS[number]
/** Raster images the server recognises by their bytes; only these are ever served for display (never SVG). */
export const TASK_FILE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type TaskFileImageType = typeof TASK_FILE_IMAGE_TYPES[number]
/** `mediaType` is a recognised image type, or null for any other file. Older servers omit it. */
export type TaskFile = { id: string; name: string; size: number; mediaType?: TaskFileImageType | null }
export type TaskFileList = { files: TaskFile[]; canEdit: boolean }
/** What an upload answers; `placement` is present on servers that support inline files. */
export type SavedTaskFile = TaskFile & { placement?: TaskFilePlacement }

/** Canonical authenticated bytes, relative to the selected installation's mount. */
export function taskFileDownloadPath(taskId: string, fileId: string) {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments?id=${encodeURIComponent(fileId)}`
}

/** An image's bytes for an `<img>`, with the task's own access; any other file downloads as from taskFileDownloadPath. */
export function taskFileDisplayPath(taskId: string, fileId: string) {
  return `${taskFileDownloadPath(taskId, fileId)}&disposition=inline`
}

/** Where an inline upload goes: `POST` multipart with one `file` field. */
export function taskInlineFileUploadPath(taskId: string, fileId: string) {
  return `${taskFileDownloadPath(taskId, fileId)}&placement=inline`
}

/** The image type the bytes start with (magic numbers), or null. The file's name and the client's type are not trusted. */
export function sniffTaskFileMediaType(bytes: Uint8Array): TaskFileImageType | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}
