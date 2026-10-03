/**
 * Pure YouTube URL parsing and network lookups. No Logseq imports here —
 * this module only knows about YouTube.
 */

import {consoleWarn } from './logging'


const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/
const CANONICAL_CHANNEL_RE = /youtube\.com\/channel\/(UC[\w-]{22})/
const HANDLE_RE = /youtube\.com\/@([\w.-]+)/i

export function extractVideoId(text: string): string | null {
  const m = text?.match(VIDEO_ID_RE)
  return m ? m[1] : null
}

export function extractChannelKey(
  url: string
): { kind: 'id' | 'handle'; value: string } | null {
  const idMatch = url.match(CANONICAL_CHANNEL_RE)
  if (idMatch) return { kind: 'id', value: idMatch[1] }
  const handleMatch = url.match(HANDLE_RE)
  if (handleMatch) return { kind: 'handle', value: handleMatch[1].toLowerCase() }
  return null
}

/* ---------------------------------------------------------------------- */
/* Network: oEmbed lookup + canonical channel id resolution                */
/* ---------------------------------------------------------------------- */
/* Uses plain fetch() rather than logseq.Net — the latter isn't present in
 * every published @logseq/libs version, while fetch works everywhere and
 * YouTube's oEmbed endpoint is explicitly CORS-open for this exact use. */

const oembedCache = new Map<string, { author_name: string; author_url: string } | null>()

export async function fetchOEmbed(
  videoId: string
): Promise<{ author_name: string; author_url: string } | null> {
  if (oembedCache.has(videoId)) return oembedCache.get(videoId)!

  let result: { author_name: string; author_url: string } | null = null
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`
    )
    if (res.ok) result = await res.json()
  } catch (e) {
    consoleWarn('oEmbed lookup failed for', videoId, e)
  }

  oembedCache.set(videoId, result)
  return result
}

// handle -> resolved "UC..." id (or null if resolution failed), for this
// running session only. Saved channels get their id cached persistently
// on the block instead (see linker.ts's getSavedChannelId).
const sessionChannelIdCache = new Map<string, string | null>()

// Resolve any channel URL form down to a canonical "UC..." id. Cheap when
// the URL already contains /channel/UC..., otherwise fetches the channel
// page once and scrapes the id out of it. This one request is NOT on an
// endpoint YouTube designed for cross-origin use, so it may fail under
// CORS depending on your setup — callers should treat a null result as
// "couldn't confirm", not as an error.
export async function resolveChannelId(url: string): Promise<string | null> {
  const key = extractChannelKey(url)
  if (!key) return null
  if (key.kind === 'id') return key.value

  if (sessionChannelIdCache.has(key.value)) {
    return sessionChannelIdCache.get(key.value)!
  }

  let resolved: string | null = null
  try {
    const res = await fetch(`https://www.youtube.com/@${key.value}`)
    if (res.ok) {
      const html = await res.text()
      const m = html.match(/"channelId":"(UC[\w-]{22})"/)
      resolved = m ? m[1] : null
    }
  } catch (e) {
    consoleWarn('channel id resolution failed for', key.value, e)
  }

  sessionChannelIdCache.set(key.value, resolved)
  return resolved
}