// Turns a decrypted payload into the list of Baileys messages to send, in order.
//
// - Text only: one text message.
// - With attachments: the text becomes the caption of the first attachment. When that
//   attachment already has its own caption, the text goes first as a separate message.
// - image/* and video/* are sent as media; everything else as a document.

function buildMediaContent(attachment, caption) {
  const content = caption ? { caption } : {}
  if (attachment.mimetype.startsWith('image/')) {
    return { ...content, image: attachment.content, mimetype: attachment.mimetype }
  }
  if (attachment.mimetype.startsWith('video/')) {
    return { ...content, video: attachment.content, mimetype: attachment.mimetype }
  }
  return {
    ...content,
    document: attachment.content,
    mimetype: attachment.mimetype,
    fileName: attachment.file_name,
  }
}

function buildOutgoingMessages(payload) {
  const { text, attachments } = payload
  if (attachments.length === 0) {
    return [{ text }]
  }
  const isTextCaption = Boolean(text) && !attachments[0].caption
  const outgoingMessages = text && !isTextCaption ? [{ text }] : []
  attachments.forEach((attachment, index) => {
    const caption = index === 0 && isTextCaption ? text : attachment.caption
    outgoingMessages.push(buildMediaContent(attachment, caption))
  })
  return outgoingMessages
}

module.exports = { buildOutgoingMessages }
