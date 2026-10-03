import type { BlockEntity } from '@logseq/libs/dist/LSPlugin'
import { getSettings, CHANNEL_ID_PROP } from './settings'
import { extractVideoId, extractChannelKey, fetchOEmbed, resolveChannelId } from './youtube'
import { getProp } from './graph'
import {consoleError, consoleLog } from './logging'


/**
 * Matches a video's channel against saved #YoutubeChannel blocks, and
 * drives processing a single video block end to end.
 */

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

export async function processVideoBlock(block: BlockEntity): Promise<void> {
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
    consoleLog(`linked to '${oembed.author_name}'`)
  } catch (e) {
    consoleError('failed to process block', block.uuid, e)
  } finally {
    processing.delete(block.uuid)
  }
}