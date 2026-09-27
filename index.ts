import '@logseq/libs'
import type { BlockEntity } from '@logseq/libs/dist/LSPlugin'

/**
 * YouTube Channel Linker
 * ----------------------
 * When a block is tagged with the "video tag" and contains a YouTube video
 * link, this plugin looks up which channel posted the video (via YouTube's
 * public oEmbed endpoint — no API key needed), checks whether that channel
 * is already saved under the "channel tag", and if so writes a reference to
 * it into a configurable property on the video block.
 */

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

logseq.useSettingsSchema([
  {
    key: 'videoTag',
    type: 'string',
    default: 'YoutubeVideo',
    title: 'Video tag',
    description: 'Tag used on blocks that hold a YouTube video link.',
  },
  {
    key: 'channelTag',
    type: 'string',
    default: 'YoutubeChannel',
    title: 'Channel tag',
    description: 'Tag used on blocks/pages that hold a saved YouTube channel link.',
  },
  {
    key: 'propertyKey',
    type: 'string',
    default: 'youtubeChannel',
    title: 'Property key',
    description: 'Property written on video blocks once a matching channel is found.',
  },
  {
    key: 'propertyName',
    type: 'string',
    default: 'YouTube Channel',
    title: 'Property display name',
    description: 'Human-readable name shown for the property above.',
  },
])

function getSettings() {
  const s = logseq.settings || {}
  return {
    videoTag: (s.videoTag as string) || 'YoutubeVideo',
    channelTag: (s.channelTag as string) || 'YoutubeChannel',
    propertyKey: (s.propertyKey as string) || 'youtubeChannel',
    propertyName: (s.propertyName as string) || 'YouTube Channel',
  }
}

// Internal, hidden property used to cache each saved channel's canonical
// "UC..." id so we don't have to re-resolve it on every run.
const CHANNEL_ID_PROP = 'youtubeChannelId'

/* ---------------------------------------------------------------------- */
/* URL / id parsing helpers                                                */
/* ---------------------------------------------------------------------- */

const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/
const CANONICAL_CHANNEL_RE = /youtube\.com\/channel\/(UC[\w-]{22})/
const HANDLE_RE = /youtube\.com\/@([\w.-]+)/i

function extractVideoId(text: string): string | null {
  const m = text?.match(VIDEO_ID_RE)
  return m ? m[1] : null
}

function extractChannelKey(url: string): { kind: 'id' | 'handle'; value: string } | null {
  const idMatch = url.match(CANONICAL_CHANNEL_RE)
  if (idMatch) return { kind: 'id', value: idMatch[1] }
  const handleMatch = url.match(HANDLE_RE)
  if (handleMatch) return { kind: 'handle', value: handleMatch[1].toLowerCase() }
  return null
}

async function getProp(uuid: string, key: string): Promise<any> {
  const props = await logseq.Editor.getBlockProperties(uuid)
  if (!props) return undefined
  // Plugin-created properties are stored under a namespaced ident
  // (":plugin.property.<plugin-id>/<key>"), not the bare key passed to
  // upsertProperty/upsertBlockProperty — getBlockProperties reflects that
  // namespaced form, so a plain props[key] lookup silently always misses.
  if (props[key] != null) return props[key]
  return props[`plugin.property.${logseq.baseInfo.id}/${key}`]
}

/* ---------------------------------------------------------------------- */
/* Network: oEmbed lookup + canonical channel id resolution                */
/* ---------------------------------------------------------------------- */
/* Uses plain fetch() rather than logseq.Net — the latter isn't present in
 * every published @logseq/libs version, while fetch works everywhere and
 * YouTube's oEmbed endpoint is explicitly CORS-open for this exact use. */

const oembedCache = new Map<string, { author_name: string; author_url: string } | null>()

async function fetchOEmbed(videoId: string): Promise<{ author_name: string; author_url: string } | null> {
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
    console.warn('[yt-linker] oEmbed lookup failed for', videoId, e)
  }

  oembedCache.set(videoId, result)
  return result
}

// handle -> resolved "UC..." id (or null if resolution failed), for this
// running session only. Saved channels get their id cached persistently
// on the block instead (see getSavedChannelId).
const sessionChannelIdCache = new Map<string, string | null>()

// Resolve any channel URL form down to a canonical "UC..." id. Cheap when
// the URL already contains /channel/UC..., otherwise fetches the channel
// page once and scrapes the id out of it. This one request is NOT on an
// endpoint YouTube designed for cross-origin use, so it may fail under
// CORS depending on your setup — callers should treat a null result as
// "couldn't confirm", not as an error.
async function resolveChannelId(url: string): Promise<string | null> {
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
    console.warn('[yt-linker] channel id resolution failed for', key.value, e)
  }

  sessionChannelIdCache.set(key.value, resolved)
  return resolved
}

/* ---------------------------------------------------------------------- */
/* Matching a video's channel against saved #YoutubeChannel blocks         */
/* ---------------------------------------------------------------------- */

async function getSavedChannelId(channelBlock: BlockEntity): Promise<string | null> {
  const cached = await getProp(channelBlock.uuid, CHANNEL_ID_PROP)
  if (cached) return cached as string

  const text = channelBlock.title || channelBlock.content || ''
  const id = await resolveChannelId(text)
  if (id) {
    await logseq.Editor.upsertBlockProperty(channelBlock.uuid, CHANNEL_ID_PROP, id)
  }
  return id
}

async function findMatchingChannelBlock(videoAuthorUrl: string): Promise<BlockEntity | null> {
  const cfg = getSettings()
  const savedChannels = (await logseq.Editor.getTagObjects(cfg.channelTag)) || []
  if (!savedChannels.length) return null

  const videoKey = extractChannelKey(videoAuthorUrl)
  if (!videoKey) return null

  // Cheap pass first: direct string match (handle-to-handle or id-to-id),
  // no network involved. Covers the common case where both sides already
  // use the same URL form.
  for (const channelBlock of savedChannels) {
    const text = channelBlock.title || channelBlock.content || ''
    const key = extractChannelKey(text)
    if (key && key.kind === videoKey.kind && key.value === videoKey.value) {
      return channelBlock
    }
  }

  // Fallback: resolve both sides to a canonical channel id, so an @handle
  // saved one way still matches a /channel/UC... form (or vice versa).
  const videoChannelId = await resolveChannelId(videoAuthorUrl)
  if (!videoChannelId) return null

  for (const channelBlock of savedChannels) {
    const id = await getSavedChannelId(channelBlock)
    if (id && id === videoChannelId) return channelBlock
  }
  return null
}

/* ---------------------------------------------------------------------- */
/* Processing a single video block                                        */
/* ---------------------------------------------------------------------- */

const processing = new Set<string>()

// Belt-and-suspenders "already linked" guard. getBlockProperties doesn't
// always reliably reflect a freshly-written node-type property back on the
// very next read in every @logseq/libs version, and if that check silently
// fails it turns into an infinite write -> onChanged -> write loop (each
// write re-triggers DB.onChanged for the same block). Tracking linked
// blocks in memory the moment we write them guarantees we never re-link the
// same block twice in one running session, independent of whether the
// persisted read-back is trustworthy.
const linkedThisSession = new Set<string>()

async function isAlreadyLinked(uuid: string, key: string): Promise<boolean> {
  if (linkedThisSession.has(uuid)) return true
  return (await getProp(uuid, key)) != null
}

async function processVideoBlock(block: BlockEntity): Promise<void> {
  if (processing.has(block.uuid)) return
  processing.add(block.uuid)

  try {
    const cfg = getSettings()
    const text = block.title || block.content || ''
    const videoId = extractVideoId(text)
    if (!videoId) return

    // Already linked — nothing to do.
    if (await isAlreadyLinked(block.uuid, cfg.propertyKey)) return
    
    const oembed = await fetchOEmbed(videoId)
    if (!oembed?.author_url) return

    const channelBlock = await findMatchingChannelBlock(oembed.author_url)
    if (!channelBlock) return

    await logseq.Editor.upsertBlockProperty(block.uuid, cfg.propertyKey, channelBlock.id)
    linkedThisSession.add(block.uuid)
    await logseq.UI.showMsg(`Linked to ${oembed.author_name}`, 'success', { timeout: 2000 })
  } catch (e) {
    console.error('[yt-linker] failed to process block', block.uuid, e)
  } finally {
    processing.delete(block.uuid)
  }
}

/* ---------------------------------------------------------------------- */
/* Schema setup (property + tag attachment)                                */
/* ---------------------------------------------------------------------- */

async function ensureSchema(): Promise<void> {
  const cfg = getSettings()

  await logseq.Editor.upsertProperty(
    cfg.propertyKey,
    { type: 'node', cardinality: 'one', public: true, hide: false },
    { name: cfg.propertyName }
  )

  await logseq.Editor.upsertProperty(CHANNEL_ID_PROP, {
    type: 'default',
    cardinality: 'one',
    public: false,
    hide: true,
  })

  const videoTag = await logseq.Editor.getTag(cfg.videoTag)
  if (videoTag) {
    await logseq.Editor.addTagProperty(videoTag.uuid, cfg.propertyKey)
  }
}

/* ---------------------------------------------------------------------- */
/* Debounced change watcher                                                */
/* ---------------------------------------------------------------------- */

let pendingUuids = new Set<string>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleProcessing(uuid: string): void {
  pendingUuids.add(uuid)
  if (debounceTimer) clearTimeout(debounceTimer)

  debounceTimer = setTimeout(async () => {
    const uuids = Array.from(pendingUuids)
    pendingUuids = new Set()
    debounceTimer = null

    const cfg = getSettings()
    const videoBlocks = (await logseq.Editor.getTagObjects(cfg.videoTag)) || []
    const videoBlockByUuid = new Map(videoBlocks.map((b) => [b.uuid, b]))

    for (const uuid of uuids) {
      const block = videoBlockByUuid.get(uuid)
      if (block) await processVideoBlock(block)
    }
  }, 800)
}

/* ---------------------------------------------------------------------- */
/* Commands                                                                 */
/* ---------------------------------------------------------------------- */

function registerCommands(): void {
  // Force a single block to be re-checked, e.g. after saving the missing
  // channel or after editing the video link.
  logseq.Editor.registerBlockContextMenuItem('Relink YouTube channel', async ({ uuid }) => {
    const cfg = getSettings()
    await logseq.Editor.removeBlockProperty(uuid, cfg.propertyKey)
    const block = await logseq.Editor.getBlock(uuid)
    if (block) await processVideoBlock(block)
  })

  // Bulk pass over every currently-tagged video block — handy right after
  // installing the plugin, or after bulk-importing videos/channels.
  logseq.Editor.registerSlashCommand('Rescan YouTube videos', async () => {
    const cfg = getSettings()
    const videoBlocks = (await logseq.Editor.getTagObjects(cfg.videoTag)) || []
    const tip = await logseq.UI.showMsg(`Scanning ${videoBlocks.length} video(s)…`, 'info', {
      timeout: 0,
    })

    for (const block of videoBlocks) {
      await processVideoBlock(block)
      await new Promise((r) => setTimeout(r, 150)) // gentle throttle
    }

    logseq.UI.closeMsg(tip)
    await logseq.UI.showMsg('Rescan complete', 'success')
  })
}

/* ---------------------------------------------------------------------- */
/* Main                                                                     */
/* ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const isDbGraph = await logseq.App.checkCurrentIsDbGraph()
  if (!isDbGraph) {
    await logseq.UI.showMsg(
      'YouTube Channel Linker needs a DB graph — the property APIs it relies on are DB-only.',
      'warning'
    )
    return
  }

  await ensureSchema()
  registerCommands()

  const offChanged = logseq.DB.onChanged(({ blocks }) => {
    for (const b of blocks) scheduleProcessing(b.uuid)
  })

  logseq.beforeunload(async () => {
    offChanged()
    if (debounceTimer) clearTimeout(debounceTimer)
  })
}

logseq.ready(main).catch(console.error)