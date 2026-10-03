
const pluginShorthandConsole = "[yt-vid-info-grabber]"

export function consoleLog(...toLog: any[]) {
    console.warn(`${pluginShorthandConsole} `, ...toLog)
}

export function consoleWarn(...toWarn: any[]) {
    console.warn(`${pluginShorthandConsole} `, ...toWarn)
}

export function consoleError(...error: any[]) {
    console.error(`${pluginShorthandConsole} `, ...error)
}
