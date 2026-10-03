import '@logseq/libs'

import { getSettings } from './settings'
import {
  ensureSchema,
  computeVideoTagIds,
  findAllVideoLikeBlocks,
  videoTagIds,
} from './graph'
import { processVideoBlock } from './linker'

/**
 * YouTube Video Info Grabber
 * ----------------------
 * When a block is tagged with the "video tag" (or any tag that extends it)
 * and contains a YouTube video link, this plugin looks up which channel
 * posted the video (via YouTube's public oEmbed endpoint — no API key
 * needed), checks whether that channel is already saved under the
 * "channel tag", and if so writes a reference to it into a configurable
 * property on the video block.
 *
 * See settings.ts, youtube.ts, graph.ts, and linker.ts for the rest.
 */

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

    for (const uuid of uuids) {
        const block = await logseq.Editor.getBlock(uuid)
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
    if (!videoTagIds.size) {
      await logseq.UI.showMsg(
        'Video tag not found — check the plugin settings, then reload the plugin.',
        'warning'
      )
      return
    }

    const videoBlocks = await findAllVideoLikeBlocks()
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
/* Startup retry                                                            */
/* ---------------------------------------------------------------------- */
/* logseq.ready(main) only guarantees the plugin<->host handshake is done —
 * it does NOT guarantee the graph has finished loading/indexing yet. On a
 * cold Logseq startup, DB-mutating calls like upsertProperty can go out
 * before the host is able to service them, and just sit unanswered until
 * the SDK's own 10s RPC timeout fires ("[deferred timeout] async call #n").
 * A manual plugin reload never hits this because the graph is already
 * loaded by then. Retrying with a short delay covers the cold-start case
 * without any special-casing, since ensureSchema/computeVideoTagIds are
 * both safe to redo from scratch (upsertProperty and addTagProperty are
 * idempotent; recomputing the tag cache has no side effects). */

async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 5, delayMs = 3000 }: { retries?: number; delayMs?: number } = {}
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt > retries) break
      console.warn(
        `[yt-vid-info] setup attempt ${attempt} failed (graph may still be loading), retrying in ${delayMs}ms`,
        e
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

/* ---------------------------------------------------------------------- */
/* Main                                                                     */
/* ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const isDbGraph = await logseq.App.checkCurrentIsDbGraph()
  if (!isDbGraph) {
    await logseq.UI.showMsg(
      'YouTube Video Info Grabber needs a DB graph — the property APIs it relies on are DB-only.',
      'warning'
    )
    return
  }

  // Registering commands is fire-and-forget on the SDK side (no RPC
  // timeout risk), so it's safe to do before the graph is confirmed ready.
  registerCommands()

  try {
    await withRetry(async () => {
      await ensureSchema()
      await computeVideoTagIds()
    })
  } catch (e) {
    console.error('[yt-vid-info] setup failed after retries — graph may not be ready', e)
    await logseq.UI.showMsg(
      'YouTube Video Info Grabber failed to start — try reloading the plugin from the Plugins page.',
      'error'
    )
    return
  }

  if (!videoTagIds.size) {
    const cfg = getSettings()
    await logseq.UI.showMsg(
      `Video tag "${cfg.videoTag}" wasn't found — create it (and any child tags you want), then reload the plugin.`,
      'warning'
    )
  }

  const offChanged = logseq.DB.onChanged(({ blocks , txData}) => {


    /* 'blocks' is an Array of structs with the following keys (and example values)
    uuid ("6abfb2ea-8021-4ba4-99d1-1f7d5f5cdeb3")
    id (302)
    createdAt (1790783482084)
    updatedAt (1790948078344)
    txId (536872845)
    refs (Array of structs with single key 'id', like [{id: 4}, {id: 21}])
    tags (Array of structs with single key 'id', like [{id: 4}] )
    - if block:
      title 
      order ("a00001")
      page (struct with single key 'id')
    - if page:
      name
    - if namespaced:
      parent (struct with single key 'id')


    /* 'txData' is an Array of Arrays of the form 
    [block-db-id, 
    DB thing it changes (like block/tags, block/refs, block/updated-at),
    the value thats changing it to,
    tx-id,
    true / false (depending on if its setting or deleting a value)]
    The last Arrays (unknown amount, usually 2 per tx) are always changing block/tx-id
    */

  /* Only schedule a processing of a video if we are certain the block has been tagged with one of the YouTube video tags,
  and we are able to check that just with the txData alone, and then use the blocks Array to get their uuid
  
  */

  const taggedBlocksUUID = []

  for (const tx of txData) {
    let blockId = tx[0]
    let txColumn = tx[1]
    let txValue = tx[2]
    let txAdd = tx[4]

    if (txColumn == "block/tx-id") {
      // No more relevant transactions
      break
    }

    if (txColumn == "block/tags" && txAdd && videoTagIds.has(txValue)) {
      // User just set a YouTube video tag on some block, find its UUID
      for (const b of blocks) {
        if (b.id == blockId) {
          taggedBlocksUUID.push(b.uuid)
        }
        
      }
    }
  }
  
  if (taggedBlocksUUID.length > 0) {

    console.log(`[yt-vid-info] user just set a YouTube video tag, processing ${taggedBlocksUUID.length} video/s`)

    for (const uuid of taggedBlocksUUID) {
      scheduleProcessing(uuid)
    }      
  }
  })

  logseq.beforeunload(async () => {
    offChanged()
    if (debounceTimer) clearTimeout(debounceTimer)
  })

   console.info(`[yt-vid-info] finished loading plugin with the following tag ids for Youtube videos: ${Array.from(
      videoTagIds
    ).join(', ')}`)

    await logseq.UI.showMsg(`Youtube Video Info Grabber - Finished loading plugin`, 'success', { timeout : 2800 })
}

logseq.ready(main).catch(console.error)