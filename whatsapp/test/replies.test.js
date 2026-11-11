const test = require('node:test')
const assert = require('node:assert')
const { matchReply, readReply } = require('../replies')

const GROUP = '120363000000000000@g.us'
const CONTACT = '5548999998888@s.whatsapp.net'
const CONTACT_LID = '123456789012345@lid'
const SENT_AT = new Date('2026-01-01T12:00:00.400Z')
const NOW = new Date('2026-01-01T12:01:00Z')

function awaiting(chatJids, sentMessageIds, sentAt = SENT_AT) {
  return {
    chatJids: new Set(chatJids),
    sentMessageIds: new Set(sentMessageIds),
    sentAt,
    deadline: new Date(sentAt.getTime() + 10 * 60 * 1000),
  }
}

function received({ remoteJid = GROUP, remoteJidAlt, id = 'IN1', message = { conversation: 'sim' }, seconds = 1767268830 } = {}) {
  return { key: { remoteJid, remoteJidAlt, id, fromMe: true }, message, messageTimestamp: seconds }
}

const awaitingGroup = () => new Map([['msg-group', awaiting([GROUP], ['OUT1'])]])

test('a message in the awaited chat is the reply', () => {
  assert.deepStrictEqual(matchReply(awaitingGroup(), received(), new Set(), NOW), {
    messageId: 'msg-group',
    reply: { text: 'sim', message_type: 'conversation' },
  })
})

test('messages from any other chat are never read', () => {
  const otherChat = received({ remoteJid: '5511988887777@s.whatsapp.net' })
  Object.defineProperty(otherChat, 'message', { get: () => assert.fail('content was read') })
  assert.strictEqual(matchReply(awaitingGroup(), otherChat, new Set(), NOW), null)
})

test('nothing is awaited after the deadline', () => {
  const afterDeadline = new Date(SENT_AT.getTime() + 10 * 60 * 1000 + 1)
  assert.strictEqual(matchReply(awaitingGroup(), received(), new Set(), afterDeadline), null)
})

test('messages older than the sent message are not replies', () => {
  assert.strictEqual(matchReply(awaitingGroup(), received({ seconds: 1767268799 }), new Set(), NOW), null)
})

test('messages sent by this session are not replies', () => {
  assert.strictEqual(matchReply(awaitingGroup(), received({ id: 'OUT1' }), new Set(), NOW), null)
  assert.strictEqual(matchReply(awaitingGroup(), received({ id: 'OTHER_PROJECT' }), new Set(['OTHER_PROJECT']), NOW), null)
})

test('reactions and protocol messages are not replies', () => {
  for (const message of [{ reactionMessage: { text: '👍' } }, { protocolMessage: { type: 0 } }]) {
    assert.strictEqual(matchReply(awaitingGroup(), received({ message }), new Set(), NOW), null)
  }
  const stub = { ...received(), messageStubType: 20 }
  assert.strictEqual(matchReply(awaitingGroup(), stub, new Set(), NOW), null)
})

test('a contact replying by LID is found by the phone number alternative', () => {
  const awaitingContact = new Map([['msg-contact', awaiting([CONTACT], ['OUT1'])]])
  const reply = received({ remoteJid: CONTACT_LID, remoteJidAlt: CONTACT })
  assert.strictEqual(matchReply(awaitingContact, reply, new Set(), NOW).messageId, 'msg-contact')
})

test('a quoted message wins, otherwise the last message sent to the chat', () => {
  const awaitingTwo = new Map([
    ['first', awaiting([GROUP], ['OUT1'])],
    ['second', awaiting([GROUP], ['OUT2'], new Date(SENT_AT.getTime() + 5000))],
  ])
  const quoting = received({ message: { extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'OUT1' } } } })
  assert.strictEqual(matchReply(awaitingTwo, quoting, new Set(), NOW).messageId, 'first')
  assert.strictEqual(matchReply(awaitingTwo, received(), new Set(), NOW).messageId, 'second')
})

test('media replies keep only the caption', () => {
  assert.deepStrictEqual(readReply(received({ message: { imageMessage: { caption: 'olha' } } })), {
    text: 'olha', message_type: 'imageMessage', quoted_message_id: null,
  })
  assert.deepStrictEqual(readReply(received({ message: { audioMessage: { seconds: 3 } } })), {
    text: null, message_type: 'audioMessage', quoted_message_id: null,
  })
})
