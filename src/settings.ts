/**
 * Plugin settings schema and typed accessor, plus the one internal
 * (hidden) property key shared across modules.
 */

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

export function getSettings() {
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
export const CHANNEL_ID_PROP = 'youtubeChannelId'