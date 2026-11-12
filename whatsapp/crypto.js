// JavaScript copy of interface_personal_whats/crypto.py (encryption version 1).
// Any change must match the interface and pass test/vectors/v1.json.
const crypto = require('crypto')

const ENCRYPTION_VERSION = 1
const KEY_DERIVATION_SALT = 'personal-whats/v1'
const KEY_DERIVATION_ITERATIONS = 600000
const KEY_SIZE = 32
const TAG_SIZE = 16
const NONCE_SIZE = 12

function deriveKey(password) {
  if (!password) {
    throw new Error('ENCRYPTION_PASSWORD is required')
  }
  return crypto.pbkdf2Sync(password, KEY_DERIVATION_SALT, KEY_DERIVATION_ITERATIONS, KEY_SIZE, 'sha256')
}

// `ciphertext` ends with the 16 byte GCM tag, like Python's AESGCM. Throws on a wrong key.
function decrypt(key, nonce, ciphertext) {
  const encryptedBody = ciphertext.subarray(0, ciphertext.length - TAG_SIZE)
  const tag = ciphertext.subarray(ciphertext.length - TAG_SIZE)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encryptedBody), decipher.final()])
}

// Same output as Python's AESGCM: the 16 byte tag at the end of the ciphertext
function encrypt(key, plaintext) {
  const nonce = crypto.randomBytes(NONCE_SIZE)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const encryptedBody = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce, ciphertext: Buffer.concat([encryptedBody, cipher.getAuthTag()]) }
}

function encryptJson(key, value) {
  return encrypt(key, Buffer.from(JSON.stringify(value), 'utf8'))
}

function decryptJson(key, encryptedData) {
  const plaintext = decrypt(key, toBuffer(encryptedData.nonce), toBuffer(encryptedData.ciphertext))
  return JSON.parse(plaintext.toString('utf8'))
}

// Returns {text, recipient, attachments: [{file_name, mimetype, content: Buffer, caption}], quoted, reaction}
function decryptPayload(key, messageDocument) {
  if (messageDocument.encryption_version !== ENCRYPTION_VERSION) {
    throw new Error(`versão de criptografia não suportada: ${messageDocument.encryption_version}`)
  }
  const plaintext = decrypt(key, toBuffer(messageDocument.nonce), toBuffer(messageDocument.ciphertext))
  const payload = JSON.parse(plaintext.toString('utf8'))
  return {
    text: payload.text ?? null,
    recipient: payload.recipient ?? null,
    attachments: (payload.attachments || []).map((attachment) => ({
      ...attachment,
      content: Buffer.from(attachment.content, 'base64'),
    })),
    quoted: payload.quoted ?? null,
    reaction: payload.reaction ?? null,
  }
}

// Watches keep their encrypted JSON in the top-level nonce/ciphertext fields
function decryptDocumentJson(key, document) {
  if (document.encryption_version !== ENCRYPTION_VERSION) {
    throw new Error(`versão de criptografia não suportada: ${document.encryption_version}`)
  }
  return decryptJson(key, { nonce: document.nonce, ciphertext: document.ciphertext })
}

// BSON Binary from the driver, or a Buffer in tests
function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer)
}

module.exports = {
  ENCRYPTION_VERSION, deriveKey, encrypt, decrypt, encryptJson, decryptJson, decryptPayload, decryptDocumentJson,
}
