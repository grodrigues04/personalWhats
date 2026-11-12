// Decides which received WhatsApp message is a command for a chat watch (see the interface:
// watch_chat / read_new_messages).
//
// Privacy rule, same as replies.js: only the watched chat is looked at, and only messages that
// start with "/" (and, when the watch names a command, only that command). Every other message is
// discarded unread: nothing is stored or logged about it.
const { chatJidsOf, readReply } = require('./replies')

const COMMAND_PREFIX = '/'

// `command`: null for every command, or "/prompt" for only that one (case-insensitive, first word)
function matchesCommand(text, command) {
  const trimmedText = (text || '').trim()
  if (!trimmedText.startsWith(COMMAND_PREFIX)) {
    return false
  }
  if (!command) {
    return true
  }
  const [firstWord] = trimmedText.split(/\s+/, 1)
  return firstWord.toLowerCase() === command
}

// `watches`: Map of watch id -> {chatJids: Set, command, createdAt: Date, until: Date | null}.
// `ownMessageIds`: ids of the messages this session sent, which are never commands.
// Returns [{watchId, incoming}], empty when the message is not a command of any watch.
function matchCommands(watches, webMessage, ownMessageIds, now = new Date()) {
  const messageKey = webMessage.key || {}
  const chatJids = chatJidsOf(messageKey)
  const candidates = [...watches.entries()].filter(([, watch]) =>
    (!watch.until || now <= watch.until) && chatJids.some((jid) => watch.chatJids.has(jid)))
  if (!candidates.length || ownMessageIds.has(messageKey.id)) {
    return []
  }
  const content = readReply(webMessage)
  if (!content?.text || !content.text.trim().startsWith(COMMAND_PREFIX)) {
    return []
  }
  // WhatsApp timestamps are in seconds: compare with the second the watch started
  const messageTimeMs = Number(webMessage.messageTimestamp || 0) * 1000
  const text = content.text.trim()
  return candidates
    .filter(([, watch]) => messageTimeMs >= Math.floor(watch.createdAt.getTime() / 1000) * 1000
      && (!watch.until || messageTimeMs <= watch.until.getTime())
      && matchesCommand(text, watch.command))
    .map(([watchId]) => ({ watchId, incoming: buildIncoming(webMessage, text) }))
}

function buildIncoming(webMessage, text) {
  const messageKey = webMessage.key
  const senderJid = messageKey.participant || messageKey.participantAlt || messageKey.remoteJid
  return {
    text,
    sender_name: webMessage.pushName || null,
    sender_jid: senderJid || null,
    from_me: Boolean(messageKey.fromMe),
    quote: {
      chat_jid: messageKey.remoteJid,
      message_id: messageKey.id,
      participant: messageKey.participant || null,
      from_me: Boolean(messageKey.fromMe),
      text,
    },
  }
}

module.exports = { COMMAND_PREFIX, matchesCommand, matchCommands }
