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

const MULTIPART_OVERHEAD_BYTES = 64 * 1024

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
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
      if (size > maxBytes) {
        await reader.cancel()
        throw new MobileAvatarError('avatarTooLarge', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Reads an uploaded avatar payload from either `multipart/form-data` (field `avatar`)
 * or a direct binary `image/png | image/jpeg | image/webp` request body, capping
 * buffered bytes before parsing even when `Content-Length` is omitted.
 */
export async function readMobileAvatarPayload(
  request: Request,
): Promise<{ declaredType: string; bytes: Uint8Array }> {
  const rawContentType = request.headers.get('content-type')
  const mediaType = normalizeMediaType(rawContentType)

  if (mediaType === 'multipart/form-data') {
    const rawBody = await readBoundedBody(request, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD_BYTES)
    let form: FormData
    try {
      form = await new Response(rawBody, {
        headers: rawContentType ? { 'content-type': rawContentType } : undefined,
      }).formData()
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

  return { declaredType: mediaType, bytes: await readBoundedBody(request, AVATAR_MAX_BYTES) }
}
