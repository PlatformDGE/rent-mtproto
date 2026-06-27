import express from 'express';
import multer from 'multer';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { generateRandomBigInt } from 'telegram/Helpers.js';
import { _parseMessageText } from 'telegram/client/messageParse.js';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const app  = express();
const PORT = process.env.PORT || 8080;

const API_ID      = Number(process.env.TELEGRAM_API_ID);
const API_HASH    = process.env.TELEGRAM_API_HASH;
const SESSION_STR = process.env.TELEGRAM_SESSION;

// Хранилище задач в памяти
const jobs = new Map(); // jobId → { status, result, error }

// Multer — файлы в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

let client;

async function convertToMp4(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '28',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y', outputPath
  ]);
}

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

async function parseCaption(html) {
  if (!html) return { text: '', entities: [] };
  const finalEntities = [];
  let finalText = '';
  const re = /<a href="([^"]+)">([^<]+)<\/a>/g;
  let prev = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    finalText += html.slice(prev, m.index);
    const startOffset = Buffer.from(finalText, 'utf-16le').length / 2;
    finalText += m[2];
    const length = Buffer.from(m[2], 'utf-16le').length / 2;
    finalEntities.push(new Api.MessageEntityTextUrl({
      offset: startOffset,
      length,
      url: m[1],
    }));
    prev = m.index + m[0].length;
  }
  finalText += html.slice(prev);
  finalText = finalText.replace(/<[^>]+>/g, '');
  return { text: finalText, entities: finalEntities };
}

async function uploadMedia(peer, buffer, type, fileName, mimeType, dims) {
  let ext = fileName.split('.').pop() || 'bin';
  const tmpPath = join(tmpdir(), randomUUID() + '.' + ext);
  await writeFile(tmpPath, Buffer.from(buffer));
  let uploadPath = tmpPath;
  let uploadSize = buffer.length;
  let convertedPath = null;
  if (type === 'video' && (ext === 'mov' || ext === 'MOV' || ext === 'm4v')) {
    convertedPath = join(tmpdir(), randomUUID() + '.mp4');
    try {
      await convertToMp4(tmpPath, convertedPath);
      uploadPath = convertedPath;
      const { statSync } = await import('node:fs');
      uploadSize = statSync(convertedPath).size;
      ext = 'mp4';
      fileName = fileName.replace(/\.(mov|MOV|m4v)$/, '.mp4');
      mimeType = 'video/mp4';
      console.log('Converted to mp4:', uploadSize, 'bytes');
    } catch(e) {
      console.warn('ffmpeg conversion failed, using original:', e.message);
    }
  }
  const file = new CustomFile(fileName, uploadSize, uploadPath);
  let fileHandle;
  try {
    fileHandle = await client.uploadFile({ file, workers: 4 });
  } finally {
    await unlink(tmpPath).catch(() => {});
    if (convertedPath) await unlink(convertedPath).catch(() => {});
  }

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

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => res.json({ ok: true, status: 'MTProto service running' }));

// Polling — проверить статус задачи
app.get('/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.json({ ok: false, description: 'Job not found' });
  res.json(job);
});

// ── sendMessage ──────────────────────────────────────────────────────────────
app.post('/sendMessage', async (req, res) => {
  try {
    const { chatId, topicId, text } = req.body;
    const parsed = await parseCaption(text);
    console.log('entities count:', parsed.entities.length, parsed.entities.map(e => e.className + ':' + e.url).join(', '));
    const peer = await client.getInputEntity(chatId);
    const result = await client.invoke(new Api.messages.SendMessage({
      peer,
      replyTo: topicId ? new Api.InputReplyToMessage({ replyToMsgId: parseInt(topicId) }) : undefined,
      message: parsed.text,
      randomId: generateRandomBigInt(),
      noWebpage: true,
      ...(parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
    }));
    const ids = extractMessageIds(result);
    res.json({ ok: true, result: { message_id: ids[0] } });
  } catch (e) {
    console.error('sendMessage error:', e.message);
    res.json({ ok: false, description: e.message });
  }
});

// ── sendMediaGroup ASYNC — сразу возвращает jobId ────────────────────────────
app.post('/sendMediaGroup', upload.fields([
  { name: 'photos[]', maxCount: 10 },
  { name: 'video',    maxCount: 1  },
]), async (req, res) => {
  const jobId = randomUUID();
  jobs.set(jobId, { status: 'pending', result: null, error: null });

  // Сразу отвечаем
  res.json({ ok: true, jobId });

  // Сохраняем данные из req до async обработки
  const chatId   = req.body.chatId;
  const topicId  = req.body.topicId;
  const caption  = req.body.caption || '';
  const photos   = (req.files?.['photos[]'] || []).map(f => ({
    buffer: f.buffer, name: f.originalname || 'photo.jpg', mime: f.mimetype
  }));
  const videoArr = req.files?.['video'] || [];
  const videoFile = videoArr.length > 0 ? {
    buffer: videoArr[0].buffer,
    name:   videoArr[0].originalname || 'video.mp4',
    mime:   videoArr[0].mimetype,
  } : null;
  const dims = {
    width:    parseInt(req.body.width)    || 1280,
    height:   parseInt(req.body.height)   || 720,
    duration: parseInt(req.body.duration) || 1,
  };

  // Выполняем в фоне
  (async () => {
    try {
      jobs.set(jobId, { status: 'uploading', progress: 0, result: null, error: null });
      const peer = await client.getInputEntity(chatId);
      const multiMedia = [];
      const parsed = await parseCaption(caption);

      // Фото
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        console.log(`Uploading photo ${i+1}/${photos.length}`);
        jobs.set(jobId, { status: 'uploading', progress: Math.round(i / (photos.length + (videoFile ? 1 : 0)) * 80), result: null, error: null });
        const inputMedia = await uploadMedia(peer, p.buffer, 'photo', p.name, p.mime);
        multiMedia.push(new Api.InputSingleMedia({
          media: inputMedia,
          randomId: generateRandomBigInt(),
          message: i === 0 ? parsed.text : '',
          ...(i === 0 && parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
        }));
      }

      // Видео
      if (videoFile) {
        console.log(`Uploading video: ${videoFile.name} (${(videoFile.buffer.length/1024/1024).toFixed(1)}MB)`);
        jobs.set(jobId, { status: 'uploading_video', progress: 80, result: null, error: null });
        const mimeType = 'video/mp4';
        const videoName = videoFile.name.replace(/\.(mov|m4v)$/i, '.mp4');
        const inputMedia = await uploadMedia(peer, videoFile.buffer, 'video', videoName, mimeType, dims);
        const isFirst = multiMedia.length === 0;
        multiMedia.push(new Api.InputSingleMedia({
          media: inputMedia,
          randomId: generateRandomBigInt(),
          message: isFirst ? parsed.text : '',
          ...(isFirst && parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
        }));
      }

      if (multiMedia.length === 0) throw new Error('No media');

      console.log(`Sending album with ${multiMedia.length} items`);
      jobs.set(jobId, { status: 'sending', progress: 95, result: null, error: null });

      const threadId = topicId ? parseInt(topicId) : undefined;
      const result = await client.invoke(new Api.messages.SendMultiMedia({
        peer,
        multiMedia,
        ...(threadId ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: threadId }) } : {}),
      }));

      const ids = extractMessageIds(result);
      console.log(`Album sent, message ids: ${ids}`);
      jobs.set(jobId, { status: 'done', progress: 100, result: { message_ids: ids, message_id: ids[0] }, error: null });
    } catch (e) {
      console.error('sendMediaGroup job error:', e.message);
      jobs.set(jobId, { status: 'error', progress: 0, result: null, error: e.message });
    }
  })();
});

// ── sendDocument ─────────────────────────────────────────────────────────────
app.post('/sendDocument', upload.single('file'), async (req, res) => {
  try {
    const { chatId, topicId } = req.body;
    const f = req.file;
    if (!f) return res.json({ ok: false, description: 'No file' });

    const peer = await client.getInputEntity(chatId);
    const ext = (f.originalname || 'file').split('.').pop() || 'bin';
    const tmpPath = join(tmpdir(), randomUUID() + '.' + ext);
    await writeFile(tmpPath, Buffer.from(f.buffer));
    const file = new CustomFile(f.originalname || 'file', f.buffer.length, tmpPath);
    let fileHandle;
    try {
      fileHandle = await client.uploadFile({ file, workers: 4 });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }

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
    console.error('sendDocument error:', e.message);
    res.json({ ok: false, description: e.message });
  }
});

// ── forwardMessage ────────────────────────────────────────────────────────────
app.post('/forwardMessage', async (req, res) => {
  try {
    const { chatId, topicId, fromChatId, messageId } = req.body;
    const peer     = await client.getInputEntity(chatId);
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

// Чистим старые jobs каждые 10 минут
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt && job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000);

initClient()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 MTProto service on port ${PORT}`));
  })
  .catch(e => {
    console.error('Failed to init Telegram client:', e);
    process.exit(1);
  });
