// Keeps a WhatsApp session (Baileys) open and sends the messages of the MongoDB queue that the
// validator already approved (status "validated"). It knows nothing about the projects that
// send them: each message says its own text, recipient and attachments.
//
// Queue: validated -> sending -> sent, or back to validated (next_attempt_at in the future)
// after a temporary error, or failed after MAX_ATTEMPTS / a permanent error.
//
// Messages queued with expect_unique_reply: during REPLY_WINDOW_MS after sending, the first message
// written in that same chat is stored, encrypted, as the reply (see replies.js). No other chat
// is ever read.
//
// Sent messages are kept in SENT_MESSAGES_FILE: when the recipient's phone cannot
// decrypt a message it asks for a retry, and Baileys answers it through
// getMessage. Without this the message stays as "Waiting for this message".
const fs = require('fs')
const path = require('path')
const http = require('http')
const pino = require('pino')
const QRCode = require('qrcode')
const { MongoClient, ObjectId } = require('mongodb')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  BufferJSON,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys')
const { deriveKey, decryptJson, decryptPayload, encryptJson } = require('./crypto')
const { buildOutgoingMessages } = require('./outgoing')
const { REPLY_WINDOW_MS, matchReply } = require('./replies')

const AUTH_DIR = '/app/auth'
const QR_DIR = '/app/qr'
const QR_PORT = 3010
const SENT_MESSAGES_FILE = path.join(AUTH_DIR, 'sent-messages.json')
const MAX_SENT_MESSAGES = 100
const MAX_ERROR_LENGTH = 500

const MONGO_URI = process.env.MONGO_URI
const MONGO_DATABASE = process.env.MONGO_DATABASE || 'personal_whats'
const DEFAULT_RECIPIENT = (process.env.DEFAULT_RECIPIENT || '').trim()
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 5) * 1000
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5)
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_SECONDS || 60) * 1000
const RETENTION_MS = Number(process.env.MESSAGE_RETENTION_DAYS || 30) * 24 * 60 * 60 * 1000

const encryptionKey = deriveKey(process.env.ENCRYPTION_PASSWORD)
const logger = pino({ level: 'warn' })

let socket = null
let isConnected = false
let currentQr = null
let isProcessing = false
let messages = null
// Message id -> {chatJids: Set, sentMessageIds: Set, sentAt: Date, deadline: Date}
const awaitingReplies = new Map()

// Errors that will not go away with a retry: the message fails at once
class PermanentError extends Error {}

function log(message) {
  console.log(`[whatsapp ${new Date().toLocaleString('pt-BR')}] ${message}`)
}

// ---------------------------------------------------------------- sent messages (retry support)

function loadSentMessages() {
  try {
    return JSON.parse(fs.readFileSync(SENT_MESSAGES_FILE, 'utf8'), BufferJSON.reviver)
  } catch {
    return {}
  }
}

const sentMessages = loadSentMessages()

function rememberSentMessage(sentMessage) {
  if (!sentMessage?.key?.id || !sentMessage.message) {
    return
  }
  sentMessages[sentMessage.key.id] = sentMessage.message
  const messageIds = Object.keys(sentMessages)
  for (const oldMessageId of messageIds.slice(0, Math.max(0, messageIds.length - MAX_SENT_MESSAGES))) {
    delete sentMessages[oldMessageId]
  }
  fs.writeFileSync(SENT_MESSAGES_FILE, JSON.stringify(sentMessages, BufferJSON.replacer))
}

async function getMessage(key) {
  return sentMessages[key.id]
}

// Counts retry requests per message, so Baileys stops after a few attempts
const retryCounters = new Map()
const msgRetryCounterCache = {
  get: (key) => retryCounters.get(key),
  set: (key, value) => { retryCounters.set(key, value) },
  del: (key) => { retryCounters.delete(key) },
  flushAll: () => { retryCounters.clear() },
}

// ---------------------------------------------------------------- QR code

async function saveQr(qr) {
  currentQr = qr
  const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true })
  fs.writeFileSync(path.join(QR_DIR, 'qr.txt'), terminalQr)
  await QRCode.toFile(path.join(QR_DIR, 'qr.png'), qr, { width: 400, margin: 2 })
  console.log(terminalQr)
  log(`Novo QR code gerado. Também disponível em http://localhost:${QR_PORT}`)
}

function clearQr() {
  currentQr = null
  for (const fileName of ['qr.txt', 'qr.png']) {
    fs.rmSync(path.join(QR_DIR, fileName), { force: true })
  }
}

function startQrServer() {
  http.createServer(async (request, response) => {
    if (request.url === '/qr.png' && currentQr) {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(await QRCode.toBuffer(currentQr, { width: 400, margin: 2 }))
      return
    }
    const body = isConnected
      ? '<h2>WhatsApp conectado.</h2>'
      : currentQr
        ? '<h2>Escaneie no WhatsApp: Aparelhos conectados &gt; Conectar aparelho</h2><img src="/qr.png">'
        : '<h2>Aguardando QR code...</h2>'
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><meta http-equiv="refresh" content="5"><body style="font-family:sans-serif;text-align:center">${body}</body>`)
  }).listen(QR_PORT)
}

// ---------------------------------------------------------------- connection

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    getMessage,
    msgRetryCounterCache,
    browser: Browsers.ubuntu('personalWhats'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Messages sent by this session must not come back as received ones: they would be
    // taken as replies before sendMessage returns their ids
    emitOwnEvents: false,
  })

  socket.ev.on('creds.update', saveCreds)
  // "notify": live messages. "append": messages received while disconnected.
  socket.ev.on('messages.upsert', ({ messages: receivedMessages }) => {
    handleReceivedMessages(receivedMessages).catch((error) => {
      log(`Erro ao processar mensagens recebidas: ${error.message}`)
    })
  })

  socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      await saveQr(qr)
    }
    if (connection === 'open') {
      isConnected = true
      clearQr()
      log('Conectado ao WhatsApp')
      processQueue()
    }
    if (connection === 'close') {
      isConnected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      if (statusCode === DisconnectReason.loggedOut) {
        log('Sessão desconectada pelo celular. Apagando a sessão e gerando um novo QR code.')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        fs.mkdirSync(AUTH_DIR, { recursive: true })
      } else {
        log(`Conexão fechada (código ${statusCode}), reconectando em 5 segundos`)
      }
      setTimeout(connect, 5000)
    }
  })
}

// ---------------------------------------------------------------- sending

async function resolveRecipient(recipient) {
  if (recipient.endsWith('@g.us')) {
    return recipient
  }
  const phoneNumber = recipient.replace(/@s\.whatsapp\.net$/, '')
  const [result] = await socket.onWhatsApp(phoneNumber)
  if (!result?.exists) {
    throw new PermanentError(`o número ${phoneNumber} não tem WhatsApp`)
  }
  return result.jid
}

async function sendQueuedMessage(messageDocument) {
  let payload
  try {
    payload = decryptPayload(encryptionKey, messageDocument)
  } catch (error) {
    throw new PermanentError(`não foi possível descriptografar: ${error.message}`)
  }
  const recipient = payload.recipient || DEFAULT_RECIPIENT
  if (!recipient) {
    throw new PermanentError('mensagem sem destinatário e DEFAULT_RECIPIENT não definido')
  }
  const recipientJid = await resolveRecipient(recipient)
  const sentAt = new Date()
  const sentMessageIds = []
  for (const outgoingMessage of buildOutgoingMessages(payload)) {
    const sentMessage = await socket.sendMessage(recipientJid, outgoingMessage)
    rememberSentMessage(sentMessage)
    sentMessageIds.push(sentMessage?.key?.id)
  }
  return { recipientJid, sentAt, sentMessageIds: sentMessageIds.filter(Boolean) }
}

async function claimNextMessage() {
  const now = new Date()
  return messages.findOneAndUpdate(
    { status: 'validated', next_attempt_at: { $lte: now } },
    { $set: { status: 'sending', updated_at: now }, $inc: { attempts: 1 } },
    { sort: { created_at: 1 }, returnDocument: 'after' },
  )
}

// ---------------------------------------------------------------- replies

// A contact chat can arrive by phone number or by LID: listen to both
async function findChatJids(recipientJid) {
  const chatJids = [recipientJid]
  if (recipientJid.endsWith('@s.whatsapp.net')) {
    try {
      const lid = await socket.signalRepository?.lidMapping?.getLIDForPN(recipientJid)
      if (lid) {
        chatJids.push(lid)
      }
    } catch (error) {
      log(`Não foi possível buscar o LID do destinatário: ${error.message}`)
    }
  }
  return chatJids
}

async function startAwaitingReply(messageDocument, delivery) {
  const awaiting = {
    chatJids: new Set(await findChatJids(delivery.recipientJid)),
    sentMessageIds: new Set(delivery.sentMessageIds),
    sentAt: delivery.sentAt,
    deadline: new Date(delivery.sentAt.getTime() + REPLY_WINDOW_MS),
  }
  awaitingReplies.set(messageDocument._id.toString(), awaiting)
  return {
    reply_deadline: awaiting.deadline,
    // Kept only so a restart keeps listening; encrypted like the recipient in the payload
    reply_chat: encryptJson(encryptionKey, {
      chat_jids: [...awaiting.chatJids],
      sent_message_ids: [...awaiting.sentMessageIds],
      sent_at: awaiting.sentAt.toISOString(),
    }),
  }
}

async function loadAwaitingReplies() {
  const awaitingDocuments = await messages.find(
    { expect_unique_reply: true, status: 'sent', reply: { $exists: false }, reply_deadline: { $gt: new Date() } },
    { projection: { reply_chat: 1, reply_deadline: 1 } },
  ).toArray()
  for (const messageDocument of awaitingDocuments) {
    try {
      const replyChat = decryptJson(encryptionKey, messageDocument.reply_chat)
      awaitingReplies.set(messageDocument._id.toString(), {
        chatJids: new Set(replyChat.chat_jids),
        sentMessageIds: new Set(replyChat.sent_message_ids),
        sentAt: new Date(replyChat.sent_at),
        deadline: messageDocument.reply_deadline,
      })
    } catch (error) {
      log(`Não foi possível retomar a espera de resposta de ${messageDocument._id}: ${error.message}`)
    }
  }
  if (awaitingReplies.size) {
    log(`Aguardando resposta de ${awaitingReplies.size} mensagem(ns)`)
  }
}

function forgetExpiredReplies(now) {
  for (const [messageId, awaiting] of awaitingReplies) {
    if (now > awaiting.deadline) {
      awaitingReplies.delete(messageId)
    }
  }
}

async function handleReceivedMessages(receivedMessages) {
  const now = new Date()
  forgetExpiredReplies(now)
  if (!awaitingReplies.size) {
    return
  }
  const ownMessageIds = new Set(Object.keys(sentMessages))
  for (const webMessage of receivedMessages) {
    const match = matchReply(awaitingReplies, webMessage, ownMessageIds, now)
    if (!match) {
      continue
    }
    awaitingReplies.delete(match.messageId)
    const result = await messages.updateOne(
      { _id: new ObjectId(match.messageId), reply: { $exists: false } },
      { $set: { reply: encryptJson(encryptionKey, match.reply), replied_at: now, updated_at: now } },
    )
    if (result.modifiedCount) {
      log(`Resposta recebida para ${match.messageId}`)
    }
  }
}

// ---------------------------------------------------------------- queue

async function finishMessage(messageDocument, error, delivery) {
  const now = new Date()
  const filter = { _id: messageDocument._id, status: 'sending' }
  if (!error) {
    const replyFields = messageDocument.expect_unique_reply
      ? await startAwaitingReply(messageDocument, delivery)
      : {}
    await messages.updateOne(filter, { $set: {
      status: 'sent', sent_at: now, updated_at: now, error: null,
      expires_at: new Date(now.getTime() + RETENTION_MS),
      ...replyFields,
    } })
    log(`Enviada: ${messageDocument._id} (${messageDocument.source})`)
    return
  }
  const errorMessage = error.message.slice(0, MAX_ERROR_LENGTH)
  if (error instanceof PermanentError || messageDocument.attempts >= MAX_ATTEMPTS) {
    await messages.updateOne(filter, { $set: {
      status: 'failed', updated_at: now, error: errorMessage,
      expires_at: new Date(now.getTime() + RETENTION_MS),
    } })
    log(`Falhou de vez: ${messageDocument._id} (${messageDocument.source}): ${errorMessage}`)
    return
  }
  await messages.updateOne(filter, { $set: {
    status: 'validated', updated_at: now, error: errorMessage,
    next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS),
  } })
  log(`Falha ao enviar ${messageDocument._id}: ${errorMessage}. Nova tentativa em ${RETRY_DELAY_MS / 1000}s.`)
}

async function processQueue() {
  if (!isConnected || isProcessing) {
    return
  }
  isProcessing = true
  try {
    let messageDocument
    while (isConnected && (messageDocument = await claimNextMessage())) {
      try {
        const delivery = await sendQueuedMessage(messageDocument)
        await finishMessage(messageDocument, null, delivery)
      } catch (error) {
        await finishMessage(messageDocument, error)
      }
    }
  } catch (error) {
    log(`Erro ao ler a fila: ${error.message}`)
  } finally {
    isProcessing = false
  }
}

// A message left in "sending" by a crash goes back to the queue. If the crash happened right
// after WhatsApp accepted it, it is sent twice: preferable to losing it.
async function requeueInterruptedMessages() {
  const result = await messages.updateMany(
    { status: 'sending' },
    { $set: { status: 'validated', next_attempt_at: new Date(), updated_at: new Date() } },
  )
  if (result.modifiedCount) {
    log(`${result.modifiedCount} mensagem(ns) interrompida(s) voltaram para a fila`)
  }
}

// ---------------------------------------------------------------- main

async function main() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is required')
  }
  const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000 })
  await mongoClient.connect()
  messages = mongoClient.db(MONGO_DATABASE).collection('messages')
  await requeueInterruptedMessages()
  await loadAwaitingReplies()
  if (!DEFAULT_RECIPIENT) {
    log('DEFAULT_RECIPIENT não definido: mensagens sem destinatário vão falhar')
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true })
  fs.mkdirSync(QR_DIR, { recursive: true })
  startQrServer()
  setInterval(processQueue, POLL_INTERVAL_MS)
  connect()
  log(`Lendo a fila de ${MONGO_DATABASE} a cada ${POLL_INTERVAL_MS / 1000}s`)
}

main().catch((error) => {
  log(`Erro fatal: ${error.message}`)
  process.exit(1)
})
