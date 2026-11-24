import { z } from 'zod'
import { AVATAR_MAX_BYTES, isAvatarContentType } from '@/lib/account/avatar-file'

export const mobileProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict()

export type MobileProfilePatch = z.infer<typeof mobileProfilePatchSchema>

export interface MobileProfileUser {
  id: string
  name: string
  email: string
  image: string | null
}

export class MobileAvatarError extends Error {
  constructor(
    readonly code: 'avatarInvalidType' | 'avatarTooLarge',
    readonly status: 400 | 413,
    options?: ErrorOptions,
  ) {
    super(code, options)
  }
}

/** Extracts the base MIME type without parameters (e.g. `image/png; charset=binary` -> `image/png`). */
export function normalizeMediaType(header: string | null): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/**
 * Reads an uploaded avatar payload from either `multipart/form-data` (field `avatar`)
 * or a direct binary `image/png | image/jpeg | image/webp` request body, capping
 * buffered bytes at `AVATAR_MAX_BYTES` before reading unbounded memory.
 */
export async function readMobileAvatarPayload(
  request: Request,
): Promise<{ declaredType: string; bytes: Uint8Array }> {
  const mediaType = normalizeMediaType(request.headers.get('content-type'))

  if (mediaType === 'multipart/form-data') {
    const contentLength = Number(request.headers.get('content-length'))
    // Multipart overhead is small; reject egregiously large forms early.
    if (Number.isFinite(contentLength) && contentLength > AVATAR_MAX_BYTES + 64 * 1024) {
      throw new MobileAvatarError('avatarTooLarge', 413)
    }
    let form: FormData
    try {
      form = await request.formData()
    } catch (cause) {
      throw new MobileAvatarError('avatarInvalidType', 400, { cause })
    }
    const file = form.get('avatar')
    if (!(file instanceof Blob)) throw new MobileAvatarError('avatarInvalidType', 400)
    if (file.size > AVATAR_MAX_BYTES) throw new MobileAvatarError('avatarTooLarge', 413)
    return {
      declaredType: normalizeMediaType(file.type),
      bytes: new Uint8Array(await file.arrayBuffer()),
    }
  }

  if (!isAvatarContentType(mediaType)) {
    throw new MobileAvatarError('avatarInvalidType', 400)
  }

  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > AVATAR_MAX_BYTES) {
    throw new MobileAvatarError('avatarTooLarge', 413)
  }

  const reader = request.body?.getReader()
  if (!reader) throw new MobileAvatarError('avatarInvalidType', 400)

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > AVATAR_MAX_BYTES) {
        await reader.cancel()
        throw new MobileAvatarError('avatarTooLarge', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  return { declaredType: mediaType, bytes: new Uint8Array(Buffer.concat(chunks)) }
}
