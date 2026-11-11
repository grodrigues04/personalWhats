// Decides which received WhatsApp message is the reply to a message sent with expect_unique_reply.
//
// Privacy rule: only the chat the message was sent to is listened to, and only during
// REPLY_WINDOW_MS after sending. Messages from any other chat are discarded before their
// content is read, and nothing is stored or logged about them.
const { getContentType, jidNormalizedUser, normalizeMessageContent } = require('@whiskeysockets/baileys')

const REPLY_WINDOW_MS = 10 * 60 * 1000

// Content types that are not something a person wrote: reactions, edits, deletions, keys...
const IGNORED_CONTENT_TYPES = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
])

// The same chat can arrive by phone number (@s.whatsapp.net) or by LID (@lid)
function chatJidsOf(messageKey) {
  return [messageKey.remoteJid, messageKey.remoteJidAlt]
    .filter(Boolean)
    .map((jid) => jidNormalizedUser(jid))
}

// Returns {text, message_type, quoted_message_id}, or null when the message has nothing a
// person wrote
function readReply(webMessage) {
  if (webMessage.messageStubType || !webMessage.message) {
    return null
  }
  const content = normalizeMessageContent(webMessage.message)
  const messageType = getContentType(content)
  if (!messageType || IGNORED_CONTENT_TYPES.has(messageType)) {
    return null
  }
  const typedContent = content[messageType]
  const text = typeof typedContent === 'string'
    ? typedContent
    : typedContent?.text ?? typedContent?.caption ?? null
  return {
    text: text || null,
    message_type: messageType,
    quoted_message_id: typedContent?.contextInfo?.stanzaId ?? null,
  }
}

// `awaitingReplies`: Map of message id -> {chatJids: Set, sentMessageIds: Set, sentAt: Date,
// deadline: Date}. `ownMessageIds`: ids of every message this session sent, which are never
// a reply. Returns {messageId, reply} or null.
function matchReply(awaitingReplies, webMessage, ownMessageIds, now = new Date()) {
  const messageKey = webMessage.key || {}
  const chatJids = chatJidsOf(messageKey)
  const candidates = [...awaitingReplies.entries()].filter(([, awaiting]) =>
    now <= awaiting.deadline && chatJids.some((jid) => awaiting.chatJids.has(jid)))
  if (!candidates.length) {
    return null
  }
  if (ownMessageIds.has(messageKey.id)
    || candidates.some(([, awaiting]) => awaiting.sentMessageIds.has(messageKey.id))) {
    return null
  }
  // WhatsApp timestamps are in seconds: compare with the second the message was sent
  const messageTimeMs = Number(webMessage.messageTimestamp || 0) * 1000
  const recentCandidates = candidates.filter(([, awaiting]) =>
    messageTimeMs >= Math.floor(awaiting.sentAt.getTime() / 1000) * 1000)
  const reply = readReply(webMessage)
  if (!recentCandidates.length || !reply) {
    return null
  }
  // A quoted message wins; otherwise the reply belongs to the last message sent to that chat
  const quoted = recentCandidates.find(([, awaiting]) =>
    awaiting.sentMessageIds.has(reply.quoted_message_id))
  const [messageId] = quoted
    || recentCandidates.reduce((latest, candidate) =>
      candidate[1].sentAt > latest[1].sentAt ? candidate : latest)
  return { messageId, reply: { text: reply.text, message_type: reply.message_type } }
}

module.exports = { REPLY_WINDOW_MS, chatJidsOf, readReply, matchReply }
