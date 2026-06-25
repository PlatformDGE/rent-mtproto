import express from 'express';
import multer from 'multer';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { generateRandomBigInt } from 'telegram/Helpers.js';
import { _parseMessageText } from 'telegram/client/messageParse.js';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const app  = express();
const PORT = process.env.PORT || 3000;

const API_ID      = Number(process.env.TELEGRAM_API_ID);
const API_HASH    = process.env.TELEGRAM_API_HASH;
const SESSION_STR = process.env.TELEGRAM_SESSION;

// Multer — файлы в память (до 500MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

let client;

async function initClient() {
  client = new TelegramClient(
    new StringSession(SESSION_STR),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  const me = await client.getMe();
  console.log(`✅ Telegram MTProto connected as ${me.firstName} (id: ${me.id})`);
}

// Парсим HTML caption в entities
async function parseCaption(html) {
  if (!html) return { text: '', entities: [] };
  const parsed = await _parseMessageText(client, html, 'html');
  return { text: parsed[0] || '', entities: parsed[1] || [] };
}

// Загрузить медиафайл в Telegram
async function uploadMedia(peer, buffer, type, fileName, mimeType, dims) {
  const file = new CustomFile(fileName, buffer.length, '', buffer);
  const fileHandle = await client.uploadFile({ file, workers: 4 });

  if (type === 'video') {
    const attrs = [
      new Api.DocumentAttributeVideo({
        supportsStreaming: true,
        duration: dims?.duration || 1,
        w: dims?.width || 1280,
        h: dims?.height || 720,
      }),
      new Api.DocumentAttributeFilename({ fileName }),
    ];
    const uploaded = new Api.InputMediaUploadedDocument({
      file: fileHandle,
      mimeType: mimeType || 'video/mp4',
      attributes: attrs,
    });
    const result = await client.invoke(
      new Api.messages.UploadMedia({ peer, media: uploaded })
    );
    if (result instanceof Api.MessageMediaDocument && result.document instanceof Api.Document) {
      return new Api.InputMediaDocument({
        id: new Api.InputDocument({
          id: result.document.id,
          accessHash: result.document.accessHash,
          fileReference: result.document.fileReference,
        }),
      });
    }
    throw new Error(`Video upload failed: ${result.className}`);
  }

  // Фото
  const uploaded = new Api.InputMediaUploadedPhoto({ file: fileHandle });
  const result = await client.invoke(
    new Api.messages.UploadMedia({ peer, media: uploaded })
  );
  if (result instanceof Api.MessageMediaPhoto && result.photo instanceof Api.Photo) {
    return new Api.InputMediaPhoto({
      id: new Api.InputPhoto({
        id: result.photo.id,
        accessHash: result.photo.accessHash,
        fileReference: result.photo.fileReference,
      }),
    });
  }
  throw new Error(`Photo upload failed: ${result.className}`);
}

function extractMessageIds(updates) {
  if (updates instanceof Api.Updates) {
    return updates.updates
      .filter(u => u instanceof Api.UpdateMessageID)
      .map(u => u.id);
  }
  return [];
}

app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); res.header("Access-Control-Allow-Headers", "Content-Type"); if (req.method === "OPTIONS") return res.sendStatus(200); next(); });
app.use(express.json({ limit: "10mb" }));

async function resolvePeer(chatId) {
  try { return await client.getInputEntity(chatId); }
  catch(e) {
    const idStr = String(chatId).replace(/^-100/, "");
    return new Api.PeerChannel({ channelId: BigInt(parseInt(idStr)) });
  }
}

// Health check
app.get('/', (req, res) => res.json({ ok: true, status: 'MTProto service running' }));

// ── sendMessage ──────────────────────────────────────────────────────────────
app.post('/sendMessage', express.json(), async (req, res) => {
  try {
    const { chatId, topicId, text } = req.body;
    const parsed = await parseCaption(text);
    const result = await client.invoke(new Api.messages.SendMessage({
      peer: await resolvePeer(chatId),
      replyTo: topicId ? new Api.InputReplyToMessage({ replyToMsgId: topicId }) : undefined,
      message: parsed.text,
      randomId: generateRandomBigInt(),
      noWebpage: true,
      ...(parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
    }));
    const ids = extractMessageIds(result);
    res.json({ ok: true, result: { message_id: ids[0] } });
  } catch (e) {
    res.json({ ok: false, description: e.message });
  }
});

// ── sendMediaGroup (фото + видео одним альбомом) ─────────────────────────────
app.post('/sendMediaGroup', upload.fields([
  { name: 'photos[]', maxCount: 10 },
  { name: 'video',    maxCount: 1  },
]), async (req, res) => {
  try {
    const { chatId, topicId, caption } = req.body;
    const photos = req.files?.['photos[]'] || [];
    const videoFiles = req.files?.['video'] || [];

    const peer = await resolvePeer(chatId);
    const multiMedia = [];
    const parsed = await parseCaption(caption);

    // Загружаем фото
    for (let i = 0; i < photos.length; i++) {
      const f = photos[i];
      const inputMedia = await uploadMedia(peer, f.buffer, 'photo', f.originalname || 'photo.jpg', f.mimetype);
      multiMedia.push(new Api.InputSingleMedia({
        media: inputMedia,
        randomId: generateRandomBigInt(),
        message: i === 0 ? parsed.text : '',
        ...(i === 0 && parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
      }));
    }

    // Загружаем видео
    if (videoFiles.length > 0) {
      const v = videoFiles[0];
      const dims = {
        width:    parseInt(req.body.width)    || 1280,
        height:   parseInt(req.body.height)   || 720,
        duration: parseInt(req.body.duration) || 1,
      };
      const mimeType = v.mimetype || (v.originalname?.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
      const inputMedia = await uploadMedia(peer, v.buffer, 'video', v.originalname || 'video.mp4', mimeType, dims);
      const isFirst = multiMedia.length === 0;
      multiMedia.push(new Api.InputSingleMedia({
        media: inputMedia,
        randomId: generateRandomBigInt(),
        message: isFirst ? parsed.text : '',
        ...(isFirst && parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
      }));
    }

    if (multiMedia.length === 0) {
      return res.json({ ok: false, description: 'No media' });
    }

    const threadId = topicId ? parseInt(topicId) : undefined;
    const result = await client.invoke(new Api.messages.SendMultiMedia({
      peer,
      multiMedia,
      ...(threadId ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: threadId }) } : {}),
    }));

    const ids = extractMessageIds(result);
    res.json({ ok: true, result: { message_ids: ids, message_id: ids[0] } });
  } catch (e) {
    console.error('sendMediaGroup error:', e);
    res.json({ ok: false, description: e.message });
  }
});

// ── sendDocument (оригинальное фото как документ) ────────────────────────────
app.post('/sendDocument', upload.single('file'), async (req, res) => {
  try {
    const { chatId, topicId } = req.body;
    const f = req.file;
    if (!f) return res.json({ ok: false, description: 'No file' });

    const peer = await resolvePeer(chatId);
    const file = new CustomFile(f.originalname || 'file', f.buffer.length, '', f.buffer);
    const fileHandle = await client.uploadFile({ file, workers: 4 });

    const media = new Api.InputMediaUploadedDocument({
      file: fileHandle,
      mimeType: f.mimetype || 'application/octet-stream',
      attributes: [new Api.DocumentAttributeFilename({ fileName: f.originalname || 'file' })],
    });

    const threadId = topicId ? parseInt(topicId) : undefined;
    const result = await client.invoke(new Api.messages.SendMedia({
      peer,
      media,
      message: '',
      randomId: generateRandomBigInt(),
      ...(threadId ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: threadId }) } : {}),
    }));

    const ids = extractMessageIds(result);
    res.json({ ok: true, result: { message_id: ids[0] } });
  } catch (e) {
    res.json({ ok: false, description: e.message });
  }
});

// ── forwardMessage ────────────────────────────────────────────────────────────
app.post('/forwardMessage', express.json(), async (req, res) => {
  try {
    const { chatId, topicId, fromChatId, messageId } = req.body;
    const peer     = await resolvePeer(chatId);
    const fromPeer = await client.getInputEntity(fromChatId);
    const threadId = topicId ? parseInt(topicId) : undefined;

    const result = await client.invoke(new Api.messages.ForwardMessages({
      fromPeer,
      id: [parseInt(messageId)],
      toPeer: peer,
      randomId: [generateRandomBigInt()],
      ...(threadId ? { topMsgId: threadId } : {}),
    }));

    const ids = extractMessageIds(result);
    res.json({ ok: true, result: { message_id: ids[0] } });
  } catch (e) {
    res.json({ ok: false, description: e.message });
  }
});

initClient()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 MTProto service on port ${PORT}`));
  })
  .catch(e => {
    console.error('Failed to init Telegram client:', e);
    process.exit(1);
  });
