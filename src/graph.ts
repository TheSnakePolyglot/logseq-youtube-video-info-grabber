import type { BlockEntity } from '@logseq/libs/dist/LSPlugin'
import { getSettings, CHANNEL_ID_PROP } from './settings'

/**
 * Logseq-graph plumbing shared across the plugin: reading plugin-namespaced
 * properties, setting up the plugin's own property/tag schema, and tracking
 * which tags count as "video tags" (the configured tag plus every tag that
 * extends it).
 */

export async function getProp(uuid: string, key: string): Promise<any> {
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
/* Schema setup (property + tag attachment)                                */
/* ---------------------------------------------------------------------- */

export async function ensureSchema(): Promise<void> {
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
/* Tag hierarchy: also match child tags that extend the video tag          */
/* ---------------------------------------------------------------------- */
/* A block tagged with e.g. "#Funny Youtube Vid" should be treated as a
 * video block too, as long as that tag extends the configured video tag.
 * The full set of video-tag-or-descendant ids is computed ONCE at plugin
 * startup and cached here — a tag created/extended afterward won't be
 * picked up until Logseq (the plugin) is reloaded. That trade-off is
 * intentional: it turns every check during normal editing into a plain
 * Set lookup instead of a live graph walk. ensureSchema() still only ever
 * attaches the property to the root video tag — children inherit it, so
 * they're deliberately never touched there. */

export let videoTagIds = new Set<number>()

async function getRootVideoTagId(): Promise<number | null> {
  const cfg = getSettings()
  const tag = await logseq.Editor.getTag(cfg.videoTag)
  return tag ? tag.id : null
}

async function getTagChildIds(tagId: number): Promise<number[]> {
  const query = `
    [:find [?child ...]
     :where
     [?child :logseq.property.class/extends ${tagId}]]
  `
  return (await logseq.DB.datascriptQuery<number[]>(query)) || []
}

// Walks DOWN from the root video tag once, breadth-first, collecting every
// descendant tag id (root included). Called only at startup. Updates the
// exported `videoTagIds` cache in place and returns it.
export async function computeVideoTagIds(): Promise<Set<number>> {
  const rootId = await getRootVideoTagId()
  if (rootId == null) {
    videoTagIds = new Set()
    return videoTagIds
  }

  const ids = new Set<number>([rootId])
  let frontier = [rootId]
  let depth = 0

  while (frontier.length && depth < 20) {
    depth++
    const nextFrontier: number[] = []
    for (const tagId of frontier) {
      const children = await getTagChildIds(tagId)
      for (const childId of children) {
        if (!ids.has(childId)) {
          ids.add(childId)
          nextFrontier.push(childId)
        }
      }
    }
    frontier = nextFrontier
  }

  videoTagIds = ids
  return videoTagIds
}

export async function findAllVideoLikeBlocks(): Promise<BlockEntity[]> {
  if (!videoTagIds.size) return []
  const idsLiteral = Array.from(videoTagIds).join(' ')
  const query = `
    [:find [(pull ?b [*]) ...]
     :where
     [?b :block/tags ?tag]
     [(contains? #{${idsLiteral}} ?tag)]]
  `
  return (await logseq.DB.datascriptQuery<BlockEntity[]>(query)) || []
}