import 'server-only'
import { AwsClient } from 'aws4fetch'
import { isCloudEdition } from '@/lib/edition'
import { deploymentStage } from '../deployment-stage.mjs'

// Artifact files use an administrator-owned S3-compatible bucket (including R2).
// Each version is immutable. Community installations without a bucket retain
// the bytes in their database; hosted production still requires object storage.

interface ObjectStorageConfig { endpoint: string; bucket: string; client: AwsClient }

function objectStorageConfig(): ObjectStorageConfig | null {
  const endpoint = process.env.S3_ENDPOINT?.trim()
  if (endpoint || process.env.S3_BUCKET || process.env.S3_ACCESS_KEY_ID || process.env.S3_SECRET_ACCESS_KEY) {
    const bucket = process.env.S3_BUCKET?.trim(), accessKeyId = process.env.S3_ACCESS_KEY_ID, secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 configuration is incomplete')
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\\/]/.test(bucket)) throw new Error('S3 configuration is invalid')
    return { endpoint: url.href.replace(/\/+$/, ''), bucket, client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: process.env.S3_REGION?.trim() || 'us-east-1' }) }
  }
  const accountId = process.env.R2_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return { endpoint: `https://${accountId}.r2.cloudflarestorage.com`, bucket: process.env.R2_ARTIFACTS_BUCKET ?? 'mikka-artifacts', client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }) }
}

/** Where files go: R2, or the database row when no bucket is configured outside production. */
export function artifactStorage(): 'r2' | 'inline' {
  const stage = deploymentStage() ?? (process.env.NODE_ENV === 'production' ? 'production' : undefined)
  // Keep the existing persisted 'r2' discriminator for every S3 transport.
  if (objectStorageConfig()) return 'r2'
  if (isCloudEdition() && stage === 'production') throw new Error('Object storage is not configured')
  return 'inline'
}

function objectUrl(config: ObjectStorageConfig, key: string): string {
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/** aws4fetch's retry backoff does not observe AbortSignal. Deadline-bound
 * writes sign once and let fetch abort the actual request without late retries. */
async function writeObject(config: ObjectStorageConfig, key: string, init: RequestInit, signal?: AbortSignal, query?: Record<string, string>) {
  const url = new URL(objectUrl(config, key))
  if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  if (!signal) return config.client.fetch(url, init)
  signal.throwIfAborted()
  const signed = await config.client.sign(url, { ...init, signal })
  signal.throwIfAborted()
  return fetch(signed, { signal })
}

export async function putArtifactObject(key: string, body: string | Uint8Array<ArrayBuffer>, contentType: string, signal?: AbortSignal): Promise<void> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  // Next's fetch adapter can stream a signed Request and lose its implicit
  // body length. R2 rejects that transfer with 411, so carry the byte length.
  const contentLength = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength
  const response = await writeObject(config, key, { method: 'PUT', body, redirect: 'error', headers: { 'content-type': contentType, 'content-length': String(contentLength), 'if-none-match': '*' } }, signal)
  // 412: the object is already there; keys are content-addressed per version, so it is the same file.
  if (!response.ok && response.status !== 412) throw new Error(`Object storage put failed: ${response.status}`)
}

/** A known-length immutable binary upload, without reading the stream for signing or retrying it. */
export async function putArtifactObjectStream(key: string, body: ReadableStream<Uint8Array<ArrayBuffer>>,
  contentType: string, contentLength: number, sha256: string, signal: AbortSignal): Promise<void> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const partSize = Math.max(16 * 1024 * 1024, Math.ceil(contentLength / 10_000))
  if (contentLength > partSize) {
    await putArtifactMultipart(config, key, body, contentType, contentLength, partSize, signal)
    return
  }
  const response = await writeObject(config, key, { method: 'PUT', body, redirect: 'error', headers: {
    'content-type': contentType, 'content-length': String(contentLength), 'x-amz-content-sha256': sha256, 'if-none-match': '*',
  } }, signal)
  if (!response.ok && response.status !== 412) throw new Error(`Object storage put failed: ${response.status}`)
}

const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Sequential fixed-length parts share one upstream read cursor and one leftover chunk. */
async function putArtifactMultipart(config: ObjectStorageConfig, key: string, body: ReadableStream<Uint8Array<ArrayBuffer>>,
  contentType: string, size: number, partSize: number, signal: AbortSignal) {
  const start = await writeObject(config, key, { method: 'POST', redirect: 'error', headers: { 'content-type': contentType } }, signal, { uploads: '' })
  if (!start.ok) throw new Error(`Object storage multipart start failed: ${start.status}`)
  const uploadId = /<UploadId>([A-Za-z0-9_=+./-]+)<\/UploadId>/.exec(await start.text())?.[1]
  if (!uploadId) throw new Error('Object storage multipart upload ID missing')
  const reader = body.getReader()
  const parts: string[] = []
  let pending = new Uint8Array(), completed = false
  try {
    for (let offset = 0; offset < size; offset += partSize) {
      const partNumber = parts.length + 1
      const length = Math.min(size - offset, partSize)
      let remaining = length
      const part = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (!pending.byteLength) {
            const next = await reader.read()
            if (next.done) throw new Error('Object storage multipart body ended early')
            pending = next.value
          }
          const bytes = Math.min(remaining, pending.byteLength)
          if (bytes) controller.enqueue(pending.subarray(0, bytes))
          pending = pending.subarray(bytes)
          remaining -= bytes
          if (!remaining) controller.close()
        },
      }, { highWaterMark: 0 })
      const response = await writeObject(config, key, { method: 'PUT', body: part, redirect: 'error', headers: {
        'content-length': String(length), 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      } }, signal, { uploadId, partNumber: String(partNumber) })
      const etag = response.headers.get('etag')
      if (!response.ok || remaining || !etag) throw new Error(`Object storage multipart part ${partNumber} failed: ${response.status}`)
      parts.push(`<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
    }
    // A source verifier may reject on EOF even after supplying the expected length.
    if (pending.byteLength || !(await reader.read()).done) throw new Error('Object storage multipart body exceeds its length')
    const manifest = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`
    const response = await writeObject(config, key, { method: 'POST', body: manifest, redirect: 'error', headers: {
      'content-type': 'application/xml', 'if-none-match': '*',
    } }, signal, { uploadId })
    if (response.status === 412) return // The caller still checks the old object's bytes.
    if (!response.ok || !/<CompleteMultipartUploadResult(?:\s|>)/.test(await response.text())) {
      throw new Error(`Object storage multipart completion failed: ${response.status}`)
    }
    completed = true
  } finally {
    if (!completed) {
      await writeObject(config, key, { method: 'DELETE', redirect: 'error' }, AbortSignal.timeout(5_000), { uploadId }).catch(() => undefined)
      // A transport error can leave a source pull pending. Do not await its cleanup.
      void reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}

export async function getArtifactObject(key: string): Promise<string> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { redirect: 'error' })
  if (!response.ok) throw new Error(`Object storage get failed: ${response.status}`)
  return response.text()
}

/** Stream an existing immutable object without buffering a recording in the server. */
export async function getArtifactObjectStream(key: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Object storage get failed: ${response.status}`)
  return response.body
}

export class ObjectStorageReadError extends Error {
  constructor(readonly code: number) {
    super(`Object storage get failed: ${code}`)
    this.name = 'ObjectStorageReadError'
  }
}

/** What the bucket says about an object, learned without reading its bytes. */
export interface ArtifactObjectHead {
  /** The stored byte length, or null when the provider reports none. */
  size: number | null
}

/** An object's own metadata, without downloading it; null when the key holds nothing. */
export async function headArtifactObject(key: string): Promise<ArtifactObjectHead | null> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), { method: 'HEAD', redirect: 'error' })
  if (response.status === 404) return null
  if (!response.ok) throw new ObjectStorageReadError(response.status)
  const length = response.headers.get('content-length')
  const size = length === null ? Number.NaN : Number(length)
  return { size: Number.isSafeInteger(size) && size >= 0 ? size : null }
}

/**
 * The object's bytes, for binary files such as run captures. `maxBytes` bounds
 * what is buffered: the bucket returns at most one byte past it, so an object
 * that grew after its metadata was read still cannot be loaded whole.
 */
export async function getArtifactObjectBytes(key: string, maxBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await config.client.fetch(objectUrl(config, key), {
    redirect: 'error', ...(maxBytes === undefined ? {} : { headers: { range: `bytes=0-${maxBytes}` } }),
  })
  // A range the object cannot satisfy means it holds nothing at all.
  if (maxBytes !== undefined && response.status === 416) return new Uint8Array()
  if (!response.ok) throw new ObjectStorageReadError(response.status)
  return new Uint8Array(await response.arrayBuffer())
}

export async function deleteArtifactObject(key: string, signal?: AbortSignal): Promise<void> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const response = await writeObject(config, key, { method: 'DELETE', redirect: 'error' }, signal)
  if (!response.ok && response.status !== 404) throw new Error(`Object storage delete failed: ${response.status}`)
}

/**
 * A URL that lets its holder repeatedly PUT the same object key, with these
 * headers, for `seconds`. Callers must not expose this key as immutable
 * evidence: the holder can overwrite it until the signature expires.
 *
 * `contentLength` is signed along with the type, so the bucket itself refuses
 * a body of any other size with a signature mismatch. aws4fetch would drop
 * both headers on its own (`UNSIGNABLE_HEADERS`); `allHeaders` keeps them in
 * `X-Amz-SignedHeaders`, which R2 and S3 both verify.
 */
export async function presignArtifactPut(key: string, contentType: string, seconds: number, contentLength: number): Promise<{ url: string; headers: Record<string, string> }> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const url = new URL(objectUrl(config, key))
  url.searchParams.set('X-Amz-Expires', String(seconds))
  const headers = { 'content-type': contentType, 'content-length': String(contentLength) }
  const signed = await config.client.sign(url.toString(), { method: 'PUT', headers, aws: { signQuery: true, allHeaders: true } })
  return { url: signed.url, headers }
}

/** Short-lived private download; large originals bypass the function response-body limit. */
export async function presignArtifactGet(key: string, contentType: string, disposition: string, seconds = 60): Promise<string> {
  const config = objectStorageConfig()
  if (!config) throw new Error('Object storage is not configured')
  const url = new URL(objectUrl(config, key))
  url.searchParams.set('X-Amz-Expires', String(seconds))
  url.searchParams.set('response-content-type', contentType)
  url.searchParams.set('response-content-disposition', disposition)
  return (await config.client.sign(url.toString(), { method: 'GET', aws: { signQuery: true, allHeaders: true } })).url
}
