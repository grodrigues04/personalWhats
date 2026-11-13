const test = require('node:test')
const assert = require('node:assert')
const { buildEditMessageId, matchesCommand, matchCommands, matchEdits } = require('../watches')

const CLAUDIO = '120363000000000001@g.us'
const SQUEAKER = '120363000000000002@g.us'
const CREATED_AT = new Date('2026-01-01T12:00:00.400Z')
const NOW = new Date('2026-01-01T12:01:00Z')

function watch(chatJids, command = null, until = null, includeEdits = false) {
  return { chatJids: new Set(chatJids), command, createdAt: CREATED_AT, until, includeEdits }
}

// Like Baileys emits an edit in "messages.update": the key of the original message
function edited({ remoteJid = CLAUDIO, id = 'IN1', text = '/claude faça direito', seconds = 1767268850, fromMe = true } = {}) {
  return {
    key: { remoteJid, id, fromMe },
    update: {
      message: { editedMessage: { message: { extendedTextMessage: { text } } } },
      messageTimestamp: seconds,
    },
  }
}

function received({ remoteJid = SQUEAKER, id = 'IN1', text = '/prompt faça o login', seconds = 1767268830, fromMe = false } = {}) {
  return {
    key: { remoteJid, id, fromMe, participant: '5548999998888@s.whatsapp.net' },
    pushName: 'Maria',
    message: { conversation: text },
    messageTimestamp: seconds,
  }
}

test('matchesCommand: any command when the watch names none', () => {
  assert.strictEqual(matchesCommand('/liberar prompt 30 Squeaker 5', null), true)
  assert.strictEqual(matchesCommand('  /x', null), true)
  assert.strictEqual(matchesCommand('bom dia', null), false)
})

test('matchesCommand: only the named command, as the first word', () => {
  assert.strictEqual(matchesCommand('/PROMPT faça', '/prompt'), true)
  assert.strictEqual(matchesCommand('/prompt', '/prompt'), true)
  assert.strictEqual(matchesCommand('/promptx faça', '/prompt'), false)
  assert.strictEqual(matchesCommand('/liberar', '/prompt'), false)
})

test('a command of the watched chat is stored with sender and quote', () => {
  const watches = new Map([['w1', watch([SQUEAKER], '/prompt')]])
  assert.deepStrictEqual(matchCommands(watches, received(), new Set(), NOW), [{
    watchId: 'w1',
    incoming: {
      text: '/prompt faça o login',
      sender_name: 'Maria',
      sender_jid: '5548999998888@s.whatsapp.net',
      from_me: false,
      quote: {
        chat_jid: SQUEAKER,
        message_id: 'IN1',
        participant: '5548999998888@s.whatsapp.net',
        from_me: false,
        text: '/prompt faça o login',
      },
    },
  }])
})

test('messages that are not commands are discarded', () => {
  const watches = new Map([['w1', watch([SQUEAKER])]])
  assert.deepStrictEqual(matchCommands(watches, received({ text: 'oi pessoal' }), new Set(), NOW), [])
})

test('another command than the watched one is discarded', () => {
  const watches = new Map([['w1', watch([SQUEAKER], '/prompt')]])
  assert.deepStrictEqual(matchCommands(watches, received({ text: '/outro' }), new Set(), NOW), [])
})

test('other chats are discarded', () => {
  const watches = new Map([['w1', watch([CLAUDIO])]])
  assert.deepStrictEqual(matchCommands(watches, received(), new Set(), NOW), [])
})

test('messages sent by this session are never commands', () => {
  const watches = new Map([['w1', watch([SQUEAKER])]])
  assert.deepStrictEqual(matchCommands(watches, received({ id: 'OWN' }), new Set(['OWN']), NOW), [])
})

test('messages written before the watch started are discarded', () => {
  const watches = new Map([['w1', watch([SQUEAKER])]])
  assert.deepStrictEqual(matchCommands(watches, received({ seconds: 1767268799 }), new Set(), NOW), [])
})

test('the second the watch started counts', () => {
  const watches = new Map([['w1', watch([SQUEAKER])]])
  assert.strictEqual(matchCommands(watches, received({ seconds: 1767268800 }), new Set(), NOW).length, 1)
})

test('an ended watch stores nothing', () => {
  const watches = new Map([['w1', watch([SQUEAKER], null, new Date('2026-01-01T12:00:30Z'))]])
  assert.deepStrictEqual(matchCommands(watches, received(), new Set(), NOW), [])
})

test('messages from the phone of the account count, as from_me', () => {
  const watches = new Map([['w1', watch([CLAUDIO])]])
  const [match] = matchCommands(watches, received({ remoteJid: CLAUDIO, text: '/liberar', fromMe: true }), new Set(), NOW)
  assert.strictEqual(match.incoming.from_me, true)
})

test('every watch of the chat gets the command', () => {
  const watches = new Map([['w1', watch([SQUEAKER])], ['w2', watch([SQUEAKER], '/prompt')]])
  assert.deepStrictEqual(matchCommands(watches, received(), new Set(), NOW).map((match) => match.watchId), ['w1', 'w2'])
})

test('an edit of a command is stored for watches with include_edits, pointing to the original', () => {
  const watches = new Map([['w1', watch([CLAUDIO], '/claude', null, true)], ['w2', watch([CLAUDIO])]])
  assert.deepStrictEqual(matchEdits(watches, edited(), new Set(), NOW), [{
    watchId: 'w1',
    incoming: {
      text: '/claude faça direito',
      sender_name: null,
      sender_jid: CLAUDIO,
      from_me: true,
      quote: {
        chat_jid: CLAUDIO,
        message_id: 'IN1',
        participant: null,
        from_me: true,
        text: '/claude faça direito',
      },
      edited_message_id: 'IN1',
    },
  }])
})

test('an edit that is no longer the command of the watch is discarded', () => {
  const watches = new Map([['w1', watch([CLAUDIO], '/claude', null, true)]])
  assert.deepStrictEqual(matchEdits(watches, edited({ text: 'esquece' }), new Set(), NOW), [])
  assert.deepStrictEqual(matchEdits(watches, edited({ text: '/prompt x' }), new Set(), NOW), [])
})

test('updates that are not edits are discarded', () => {
  const watches = new Map([['w1', watch([CLAUDIO], null, null, true)]])
  const statusUpdate = { key: { remoteJid: CLAUDIO, id: 'IN1' }, update: { status: 4 } }
  assert.deepStrictEqual(matchEdits(watches, statusUpdate, new Set(), NOW), [])
})

test('edits of other chats are discarded', () => {
  const watches = new Map([['w1', watch([SQUEAKER], null, null, true)]])
  assert.deepStrictEqual(matchEdits(watches, edited(), new Set(), NOW), [])
})

test('each edit of a message has its own id', () => {
  assert.strictEqual(buildEditMessageId(edited()), 'edit:IN1:1767268850')
  assert.notStrictEqual(buildEditMessageId(edited()), buildEditMessageId(edited({ seconds: 1767268860 })))
})
