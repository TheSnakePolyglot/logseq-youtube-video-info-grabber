# YouTube Channel Linker

Auto-fills a channel property on `#YoutubeVideo` blocks by matching the
video's uploader against your saved `#YoutubeChannel` links — **no YouTube
API key required**.

## Requirements

- Logseq Desktop, latest version
- A **DB graph** (the property APIs this plugin uses are DB-only)
- Node.js + npm/pnpm/yarn to build the plugin

## How it works

1. You keep favorite channels as blocks/pages tagged `#YoutubeChannel`,
   containing the channel's link (`https://www.youtube.com/@SomeChannel`,
   `.../channel/UC...`, or a markdown link — any form works).
2. You tag a block `#YoutubeVideo` and it contains a YouTube video link.
3. The plugin extracts the video id, calls YouTube's public **oEmbed**
   endpoint (`youtube.com/oembed?url=...&format=json`) to get the
   uploading channel's `author_url` — this is an open, unauthenticated,
   officially documented endpoint, so no API key is needed.
4. It matches that channel against your saved `#YoutubeChannel` blocks.
   Matching is done on the canonical `UC...` channel id: if either side's
   URL is already in `/channel/UC.../` form that's free; if it's an
   `@handle` form, the plugin fetches that one channel page once and
   scrapes the id out of it, then **caches it** on the block so it's never
   fetched again.
5. If a match is found, it writes the channel as a `node`-type property on
   the video block (configurable name/key, default `youtubeChannel`).

## Settings

| Setting | Default | Purpose |
|---|---|---|
| Video tag | `YoutubeVideo` | Tag marking a block as a video to watch for |
| Channel tag | `YoutubeChannel` | Tag marking your saved channel links |
| Property key | `youtubeChannel` | Property key written on matched video blocks |
| Property display name | `YouTube Channel` | Human-readable label for that property |

All four are editable any time from the plugin's settings — the plugin
reads them fresh on every run, no reload needed.

## Commands

- **Block right-click → "Relink YouTube channel"** — clears and re-runs the
  match for that one block. Useful if you saved the channel *after*
  tagging the video, or edited the video link.
- **Slash command → "Rescan YouTube videos"** — walks every currently
  tagged video block once. Useful right after installing the plugin, or
  after a bulk import of videos/channels.

## Setup

```bash
npm install
npm run build
```

Then in Logseq: enable Developer mode → Plugins → **Load unpacked plugin**
→ select this folder.

## Known limitations

- The `@handle → UC...` resolution step scrapes the channel's public page
  for a `"channelId":"UC..."` string. That's not an official API, so a
  future YouTube markup change could break it — everything else
  (`oembed`) is on a stable, documented endpoint.
- Channels with neither a matching handle nor a resolvable id (e.g. very
  old channels serving neither cleanly) won't match automatically; you can
  fall back to setting the property by hand.
- Matching against many unresolved saved channels is sequential and
  network-bound the first time; subsequent runs are fast since ids are
  cached on the channel blocks.
- No YouTube API key is used or required anywhere in this plugin.