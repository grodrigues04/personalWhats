const test = require('node:test')
const assert = require('node:assert')
const vectors = require('./vectors/v1.json')
const { deriveKey, decrypt, decryptPayload } = require('../crypto')

const key = deriveKey(vectors.password)

test('derived key matches the interface', () => {
  assert.strictEqual(key.toString('base64'), vectors.key_base64)
})

test('key check decrypts', () => {
  const plaintext = decrypt(
    key,
    Buffer.from(vectors.key_check.nonce_base64, 'base64'),
    Buffer.from(vectors.key_check.ciphertext_base64, 'base64'),
  )
  assert.strictEqual(plaintext.toString('utf8'), vectors.key_check.plaintext_utf8)
})

for (const vector of vectors.messages) {
  test(`decrypts vector: ${vector.description}`, () => {
    const payload = decryptPayload(key, {
      encryption_version: vectors.encryption_version,
      nonce: Buffer.from(vector.nonce_base64, 'base64'),
      ciphertext: Buffer.from(vector.ciphertext_base64, 'base64'),
    })
    const expected = JSON.parse(vector.plaintext)
    assert.strictEqual(payload.text, expected.text)
    assert.strictEqual(payload.recipient, expected.recipient)
    assert.deepStrictEqual(
      payload.attachments.map((attachment) => attachment.content.toString('base64')),
      expected.attachments.map((attachment) => attachment.content),
    )
  })
}

test('wrong password throws', () => {
  const vector = vectors.messages[0]
  assert.throws(() => decryptPayload(deriveKey('outra-senha'), {
    encryption_version: 1,
    nonce: Buffer.from(vector.nonce_base64, 'base64'),
    ciphertext: Buffer.from(vector.ciphertext_base64, 'base64'),
  }))
})

test('unknown encryption version throws', () => {
  assert.throws(() => decryptPayload(key, { encryption_version: 2 }), /versão de criptografia/)
})
