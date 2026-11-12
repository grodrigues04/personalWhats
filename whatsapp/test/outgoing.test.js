const test = require('node:test')
const assert = require('node:assert')
const { buildOutgoingMessages, buildQuotedMessage } = require('../outgoing')

const pdf = { file_name: 'a.pdf', mimetype: 'application/pdf', content: Buffer.from('pdf'), caption: null }
const image = { file_name: 'a.png', mimetype: 'image/png', content: Buffer.from('png'), caption: 'Foto' }

test('text only', () => {
  assert.deepStrictEqual(buildOutgoingMessages({ text: 'oi', attachments: [] }), [{ text: 'oi' }])
})

test('text becomes the caption of the first attachment', () => {
  assert.deepStrictEqual(buildOutgoingMessages({ text: 'Relatório', attachments: [pdf] }), [
    { caption: 'Relatório', document: pdf.content, mimetype: 'application/pdf', fileName: 'a.pdf' },
  ])
})

test('text goes first when the first attachment has its own caption', () => {
  assert.deepStrictEqual(buildOutgoingMessages({ text: 'Oi', attachments: [image, pdf] }), [
    { text: 'Oi' },
    { caption: 'Foto', image: image.content, mimetype: 'image/png' },
    { document: pdf.content, mimetype: 'application/pdf', fileName: 'a.pdf' },
  ])
})

test('attachment without text and caption has no caption', () => {
  assert.deepStrictEqual(buildOutgoingMessages({ text: null, attachments: [pdf] }), [
    { document: pdf.content, mimetype: 'application/pdf', fileName: 'a.pdf' },
  ])
})

test('quoted message keeps the key of the received message', () => {
  assert.deepStrictEqual(buildQuotedMessage({
    chat_jid: '120363000000000000@g.us', message_id: 'ABC', participant: '1@s.whatsapp.net', from_me: false, text: '/prompt x',
  }), {
    key: { remoteJid: '120363000000000000@g.us', id: 'ABC', fromMe: false, participant: '1@s.whatsapp.net' },
    message: { conversation: '/prompt x' },
  })
  assert.strictEqual(buildQuotedMessage(null), null)
})
