// ─────────────────────────────────────────────────────────────────────────────
// NinzyBot — bot WhatsApp (Baileys) yang memakai API key NinzyCompress (v2)
//
//   npm i && cp .env.example .env   (isi NINZY_API_KEY)  →  npm start
//
// Semua fitur lewat API v2 punya lo sendiri:
//   /api/v2/download  → .dl / .mp3 (link sementara, Baileys yang narik filenya)
//   /api/v2/run       → 60+ perintah tool (remove bg, remini, brat, AI, dll)
//   /api/v2/tools     → .tools (cari tool) · .run (jalankan tool apa pun dari katalog ±380)
//   /api/v2/anime/*   → .anime
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

// Satu file saja: kalau dependensi belum ada, bikin package.json + npm install sendiri (sekali di awal).
function ensureDeps() {
  const need = ['@whiskeysockets/baileys', 'pino', 'qrcode-terminal'];
  if (need.every(d => fs.existsSync(path.join('node_modules', d)))) return;
  console.log('Pertama kali jalan: memasang dependensi, tunggu 1-3 menit…');
  if (!fs.existsSync('package.json')) {
    fs.writeFileSync('package.json', JSON.stringify({ name: 'ninzy-wa-bot', version: '1.0.0', type: 'module', main: 'bot.js' }, null, 2));
  }
  execSync('npm install --no-audit --no-fund @whiskeysockets/baileys@latest pino@9 qrcode-terminal', { stdio: 'inherit' });
}

// ── .env loader kecil (tanpa dependensi) ─────────────────────────────────────
try {
  for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !m[0].trimStart().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* tidak ada .env, pakai env sistem */ }

const BASE = (process.env.NINZY_BASE || 'https://ninzycompress.cloud').replace(/\/+$/, '');
const API_KEY = process.env.NINZY_API_KEY || 'ninzy_live_3c4e637219ae7c50dca8ac1d22dc25912de46336cec21f14';
let RPM = Number(process.env.NINZY_RPM || 100);
const PREFIXES = process.env.PREFIX || '.!/';
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);
const ALLOWED = (process.env.ALLOWED_NUMBERS || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const PAIRING = (process.env.PAIRING_NUMBER || '6285741771203').replace(/\D/g, ''); // nomor bot, format internasional (62...)
const BOT_NAME = process.env.BOT_NAME || 'NinzyBot';
const MAX_IMAGES = 4;
const MAX_TEXT = 3500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

// ── Baileys dimuat saat start (biar file ini bisa dites tanpa Baileys) ──────
export const B = { logger: undefined };
async function loadBaileys() {
  const m = await import('@whiskeysockets/baileys');
  B.makeWASocket = typeof m.default === 'function' ? m.default : (m.default?.default ?? m.makeWASocket);
  for (const k of ['useMultiFileAuthState', 'DisconnectReason', 'fetchLatestBaileysVersion', 'downloadMediaMessage',
    'normalizeMessageContent', 'Browsers', 'makeCacheableSignalKeyStore']) B[k] = m[k];
}

// ── Klien API (rate limiter di sisi bot, supaya gak kena 429 dari server) ───
const hits = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (hits.length && now - hits[0] >= 60000) hits.shift();
    if (hits.length < RPM) { hits.push(now); return; }
    await sleep(60000 - (now - hits[0]) + 25);
  }
}

async function api(pathname, params = {}, retry = true) {
  await throttle();
  const u = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(u, { headers: { 'X-API-Key': API_KEY }, signal: ctl.signal });
    const ct = r.headers.get('content-type') || '';
    if (r.status === 429 && retry) { await sleep(15000); return api(pathname, params, false); }
    if (ct.includes('json') || ct.startsWith('text/')) {
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
      if (!r.ok || (json && json.success === false)) throw new ApiError(json?.error || json?.message || `HTTP ${r.status}`, r.status);
      return { json, text };
    }
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
    return { buffer: Buffer.from(await r.arrayBuffer()), ct };
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('Timeout, server kelamaan merespons.', 0);
    throw e;
  } finally { clearTimeout(to); }
}

async function fetchBuffer(url, max = 60 * 1024 * 1024) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > max) throw new Error('File terlalu besar');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new Error('File terlalu besar');
  return { buffer: buf, ct: r.headers.get('content-type') || '' };
}

// ── Upload gambar WA → link publik sementara (tool gambar butuh URL) ────────
function sniffMime(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}
export async function uploadTemp(buffer) {
  const mime = sniffMime(buffer);
  const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'jpg';
  const mk = field => { const f = new FormData(); f.set(field, new Blob([buffer], { type: mime }), `ninzy.${ext}`); return f; };
  const tries = [
    async () => { const f = mk('fileToUpload'); f.set('reqtype', 'fileupload'); f.set('time', '1h');
      const r = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: f, signal: AbortSignal.timeout(45000) });
      return (await r.text()).trim(); },
    async () => { const f = mk('fileToUpload'); f.set('reqtype', 'fileupload');
      const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: f, signal: AbortSignal.timeout(45000) });
      return (await r.text()).trim(); },
    async () => { const r = await fetch('https://uguu.se/upload', { method: 'POST', body: mk('files[]'), signal: AbortSignal.timeout(45000) });
      return (await r.json())?.files?.[0]?.url; }
  ];
  for (const t of tries) {
    try { const u = await t(); if (/^https?:\/\//i.test(u || '')) return u; } catch { /* coba host berikutnya */ }
  }
  throw new ApiError('Gagal upload gambar ke server sementara. Coba lagi, atau kirim link gambar langsung.');
}

// ── Baca pesan WhatsApp ─────────────────────────────────────────────────────
const norm = m => (B.normalizeMessageContent ? B.normalizeMessageContent(m) : m) || undefined;
const ctxOf = c => c?.extendedTextMessage?.contextInfo || c?.imageMessage?.contextInfo || c?.videoMessage?.contextInfo || c?.documentMessage?.contextInfo;
const textOf = c => c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || c?.documentMessage?.caption || '';

function imageHolder(msg) {
  const c = norm(msg.message);
  if (c?.imageMessage) return msg;
  const ctx = ctxOf(c);
  const q = norm(ctx?.quotedMessage);
  if (q?.imageMessage) return { key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: ctx.quotedMessage };
  return null;
}
const quotedText = msg => textOf(norm(ctxOf(norm(msg.message))?.quotedMessage));

async function imageUrlFrom(sock, msg, arg) {
  const link = (arg || '').match(/https?:\/\/\S+/i)?.[0];
  if (link) return link;
  const holder = imageHolder(msg);
  if (!holder) throw new ApiError('Kirim gambar dengan caption perintahnya, atau reply gambar, atau tulis link gambar.');
  const buf = await B.downloadMediaMessage(holder, 'buffer', {}, { logger: B.logger, reuploadRequest: sock.updateMediaMessage });
  return uploadTemp(buf);
}

// ── Baca hasil tool → media / teks ──────────────────────────────────────────
const EXT = { image: /\.(jpe?g|png|webp|gif)(\?|#|$)/i, video: /\.(mp4|mov|webm|mkv)(\?|#|$)/i, audio: /\.(mp3|m4a|opus|ogg|wav|aac)(\?|#|$)/i };
function typeOfUrl(u, key = '') {
  for (const [t, re] of Object.entries(EXT)) if (re.test(u)) return t;
  const k = key.toLowerCase();
  if (/video|mp4/.test(k)) return 'video';
  if (/audio|mp3|music/.test(k)) return 'audio';
  if (/image|img|photo|thumb|cover|pict|poster/.test(k)) return 'image';
  return 'file';
}
function collectUrls(o, key, out, depth = 0) {
  if (depth > 6 || o == null) return;
  if (typeof o === 'string') {
    if (/^https?:\/\//i.test(o) && o.length < 2000) out.push({ url: o, key, type: typeOfUrl(o, key), thumb: /thumb|cover|poster|preview/i.test(key) });
  } else if (Array.isArray(o)) o.slice(0, 30).forEach(x => collectUrls(x, key, out, depth + 1));
  else if (typeof o === 'object') for (const [k, v] of Object.entries(o)) collectUrls(v, k, out, depth + 1);
}
export function pickMedia(payload, prefer = 'auto') {
  const all = []; collectUrls(payload, '', all);
  const seen = new Set();
  const items = all.filter(x => !seen.has(x.url) && seen.add(x.url));
  const by = t => items.filter(x => x.type === t);
  const imgs = by('image'); const imgsMain = imgs.filter(x => !x.thumb); const imgPool = imgsMain.length ? imgsMain : imgs;
  const order = {
    video: ['video', 'image', 'audio'], audio: ['audio', 'video'], image: ['image'], sticker: ['image', 'video'],
    doc: ['file', 'video', 'audio', 'image'], auto: ['video', 'image', 'audio', 'file'], text: []
  }[prefer] || ['video', 'image', 'audio'];
  for (const t of order) {
    const list = t === 'image' ? imgPool : by(t);
    if (list.length) return { type: t, urls: (t === 'image' ? list.slice(0, MAX_IMAGES) : list.slice(0, 1)).map(x => x.url) };
  }
  return null;
}

const HIDE = new Set(['creator', 'status', 'success', 'tool', 'version', 'developer']);
function pretty(o, ind = '') {
  if (o == null) return '';
  if (typeof o !== 'object') return String(o);
  const lines = [];
  const entries = Array.isArray(o) ? o.slice(0, 10).map((x, i) => [i + 1, x]) : Object.entries(o);
  for (const [k, v] of entries) {
    if (HIDE.has(k) || v == null || v === '') continue;
    if (typeof v === 'object') { const inner = pretty(v, ind + '  '); if (inner) lines.push(`${ind}*${k}*:\n${inner}`); }
    else lines.push(`${ind}*${k}*: ${v}`);
  }
  return lines.join('\n');
}
export function toText(payload) {
  const core = payload?.data ?? payload?.result ?? payload;
  const s = typeof core === 'string' ? core : pretty(core);
  return (s || 'Selesai, tapi server gak ngasih data.').slice(0, MAX_TEXT);
}
const captionOf = payload => {
  const core = payload?.data ?? payload?.result ?? payload;
  const o = Array.isArray(core) ? core[0] : core;
  for (const k of ['title', 'name', 'caption', 'judul']) if (typeof o?.[k] === 'string' && o[k].length < 300) return o[k];
  return '';
};

// ── Kirim hasil ─────────────────────────────────────────────────────────────
async function sendMedia(sock, jid, quoted, type, url, caption, opts = {}) {
  const fileName = opts.fileName || decodeURIComponent((url.split('?')[0].split('/').pop() || 'file')).slice(0, 80);
  const build = src => ({
    image: { image: src, caption },
    video: { video: src, caption },
    audio: { audio: src, mimetype: 'audio/mpeg' },
    sticker: { sticker: src },
    file: { document: src, fileName, mimetype: 'application/octet-stream', caption },
    docimg: { document: src, fileName: opts.fileName || 'hasil.png', mimetype: 'image/png', caption }
  }[type]);
  try { return await sock.sendMessage(jid, build({ url }), { quoted }); }
  catch { // beberapa CDN nolak fetch dari Baileys → tarik sendiri
    const { buffer } = await fetchBuffer(url);
    return sock.sendMessage(jid, build(buffer), { quoted });
  }
}

async function deliver(sock, msg, res, cmd) {
  const jid = msg.key.remoteJid;
  const prefer = cmd.prefer || 'auto';
  // 1) Server ngirim file mentah (gambar/audio/video langsung)
  if (res.buffer) {
    const ct = res.ct.split(';')[0];
    if (prefer === 'sticker' && (ct === 'image/webp' || sniffMime(res.buffer) === 'image/webp')) return sock.sendMessage(jid, { sticker: res.buffer }, { quoted: msg });
    if (ct.startsWith('image/')) {
      await sock.sendMessage(jid, { image: res.buffer }, { quoted: msg });
      if (cmd.alsoDoc) await sock.sendMessage(jid, { document: res.buffer, fileName: 'hasil.png', mimetype: ct }, { quoted: msg });
      return;
    }
    if (ct.startsWith('video/')) return sock.sendMessage(jid, { video: res.buffer }, { quoted: msg });
    if (ct.startsWith('audio/')) return sock.sendMessage(jid, { audio: res.buffer, mimetype: ct }, { quoted: msg });
    return sock.sendMessage(jid, { document: res.buffer, fileName: 'hasil', mimetype: ct || 'application/octet-stream' }, { quoted: msg });
  }
  // 2) JSON
  const payload = res.json?.result ?? res.json;
  if (payload && payload.status === false) throw new ApiError(payload.msg || payload.message || 'Tool gagal diproses.');
  const media = prefer === 'text' ? null : pickMedia(payload, prefer);
  const cap = captionOf(payload);
  if (!media) return sock.sendMessage(jid, { text: toText(payload) }, { quoted: msg });

  if (media.type === 'image' && prefer === 'sticker') {
    const { buffer } = await fetchBuffer(media.urls[0]);
    if (sniffMime(buffer) === 'image/webp') return sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
    return sock.sendMessage(jid, { image: buffer, caption: cap }, { quoted: msg });
  }
  if (media.type === 'image') {
    for (const [i, u] of media.urls.entries()) await sendMedia(sock, jid, msg, 'image', u, i === 0 ? cap : '');
    if (cmd.alsoDoc) await sendMedia(sock, jid, msg, 'docimg', media.urls[0], '', { fileName: 'hasil.png' });
    return;
  }
  await sendMedia(sock, jid, msg, media.type, media.urls[0], cap);
  // lagu/video yang punya info tambahan → kirim ringkasan teks juga
  if (cmd.withInfo) await sock.sendMessage(jid, { text: toText(payload) }, { quoted: msg });
}

// ── Daftar perintah (tabel) ─────────────────────────────────────────────────
// p: nama parameter tool (string = seluruh argumen, array = dipecah per spasi) · img: nama parameter gambar
// extra: parameter tetap · prefer: jenis hasil yang dikirim · opt: argumen boleh kosong
const CMDS = [];
const add = (cat, name, tool, desc, o = {}) => CMDS.push({ cat, name, tool, desc, ...o });

// Downloader
add('Downloader', 'tiktok', 'downloader-tiktok', 'Video TikTok', { p: 'url', alias: ['tt'], prefer: 'video' });
add('Downloader', 'ig', 'downloader-instagram-downloader', 'Post/Reel Instagram', { p: 'url', alias: ['instagram'] });
add('Downloader', 'fb', 'downloader-facebook', 'Video Facebook', { p: 'url', alias: ['facebook'], prefer: 'video' });
add('Downloader', 'twitter', 'downloader-twitter-x', 'Video/foto Twitter-X', { p: 'url', alias: ['x'] });
add('Downloader', 'spotify', 'downloader-spotify', 'Lagu Spotify', { p: 'url', prefer: 'audio', withInfo: true });
add('Downloader', 'capcut', 'downloader-capcut', 'Template CapCut', { p: 'url', prefer: 'video' });
add('Downloader', 'mediafire', 'downloader-mediafire', 'File MediaFire', { p: 'url', prefer: 'doc', withInfo: true });
add('Downloader', 'gdrive', 'downloader-google-drive', 'File Google Drive', { p: 'url', prefer: 'doc', withInfo: true });
add('Downloader', 'terabox', 'downloader-terabox', 'File Terabox', { p: 'url', prefer: 'doc', withInfo: true });
add('Downloader', 'play', 'downloader-youtube-play', 'Cari & kirim lagu YouTube', { p: 'q', ph: '<judul lagu>', prefer: 'audio', withInfo: true });

// Gambar (kirim/reply gambar, atau tulis link gambar)
add('Gambar', 'removebg', 'tools-remove-background', 'Hapus background', { img: 'image', alias: ['nobg'], prefer: 'image', alsoDoc: true });
add('Gambar', 'remini', 'tools-remini', 'Pertajam / HD-kan foto', { img: 'image', alias: ['hd'], prefer: 'image' });
add('Gambar', 'upscale', 'tools-image-upscaler', 'Perbesar resolusi', { img: 'image', prefer: 'image' });
add('Gambar', 'toanime', 'ai-tools-to-anime', 'Foto jadi anime', { img: 'image', prefer: 'image' });
add('Gambar', 'ghibli', 'ai-tools-ghibli-style', 'Gaya Ghibli', { img: 'image', prefer: 'image' });
add('Gambar', 'toreal', 'ai-tools-anime-to-realistic', 'Anime jadi realistis', { img: 'image', prefer: 'image' });
add('Gambar', 'zombie', 'tools-make-a-zombie', 'Ubah jadi zombie', { img: 'image', prefer: 'image' });
add('Gambar', 'nowm', 'tools-watermark-removal', 'Hapus watermark', { img: 'image', prefer: 'image' });
add('Gambar', 'ocr', 'tools-ocr', 'Baca teks dari gambar', { img: 'image', prefer: 'text' });
add('Gambar', 'img2prompt', 'tools-image-to-prompt', 'Gambar jadi prompt AI', { img: 'image', prefer: 'text' });

// Pembuat gambar / stiker
add('Maker', 'brat', 'canvas-brat-generator', 'Stiker brat', { p: 'text', ph: '<teks>', prefer: 'sticker' });
add('Maker', 'bratvid', 'canvas-brat-video-generator', 'Brat animasi', { p: 'text', ph: '<teks>', prefer: 'video' });
add('Maker', 'attp', 'canvas-attp', 'Stiker teks warna-warni', { p: 'text', ph: '<teks>', prefer: 'sticker' });
add('Maker', 'ttp', 'canvas-ttp', 'Stiker teks', { p: 'text', ph: '<teks>', extra: { color: 'white' }, prefer: 'sticker' });
add('Maker', 'neon', 'image-maker-neon', 'Teks neon', { p: 'text', ph: '<teks>', prefer: 'image' });
add('Maker', 'glitch', 'image-maker-glitchtext', 'Teks glitch', { p: 'text', ph: '<teks>', prefer: 'image' });
add('Maker', 'nulis', 'canvas-nulis', 'Tulisan tangan di buku', { p: 'text', ph: '<teks>', prefer: 'image' });

// AI
add('AI', 'gpt', 'ai-tools-chat-gpt-4', 'Tanya ChatGPT-4', { p: 'q', ph: '<pertanyaan>', alias: ['ai'], prefer: 'text' });
add('AI', 'gemini', 'ai-tools-google-gemini-chat', 'Tanya Gemini', { p: 'q', ph: '<pertanyaan>', prefer: 'text' });
add('AI', 'deepseek', 'ai-tools-deepseek-reasoning', 'Tanya DeepSeek', { p: 'q', ph: '<pertanyaan>', prefer: 'text' });
add('AI', 'genimg', 'ai-tools-genimg-ai', 'Buat gambar dari teks', { p: 'prompt', ph: '<deskripsi gambar>', alias: ['imagine'], prefer: 'image' });

// Info & utilitas
add('Info', 'cuaca', 'tools-cuaca', 'Cuaca per kecamatan', { p: 'subdistrict', ph: '<kecamatan>' , prefer: 'text' });
add('Info', 'gempa', 'tools-gempa', 'Gempa terbaru BMKG', { prefer: 'auto' });
add('Info', 'sholat', 'tools-sholat', 'Jadwal sholat', { p: 'q', ph: '<kota>', prefer: 'text' });
add('Info', 'quran', 'religion-al-quran', 'Ayat Al-Quran', { p: ['surah', 'verse'], ph: '<surah> <ayat>', prefer: 'text' });
add('Info', 'resi', 'tools-cek-resi', 'Cek resi', { p: ['resi', 'ekspedisi'], ph: '<resi> <ekspedisi>', prefer: 'text' });
add('Info', 'bola', 'entertainment-jadwal-bola', 'Jadwal bola', { prefer: 'text' });
add('Info', 'trends', 'entertainment-twitter-trends', 'Trending Twitter', { p: 'country', opt: true, ph: '[negara]', extra: { country: 'indonesia' }, prefer: 'text' });
add('Info', 'ss', 'tools-screenshot-desktop', 'Screenshot website', { p: 'url', extra: { device: 'desktop' }, prefer: 'image' });
add('Info', 'shorten', 'tools-url-shortener', 'Pendekkan link', { p: 'url', prefer: 'text' });
add('Info', 'tempmail', 'tools-tempmail', 'Email sementara', { prefer: 'text' });
add('Info', 'google', 'searching-google', 'Cari di Google', { p: 'q', ph: '<kata kunci>', prefer: 'text' });
add('Info', 'yts', 'searching-youtube-search', 'Cari video YouTube', { p: 'q', ph: '<kata kunci>', prefer: 'text' });
add('Info', 'lirik', 'searching-lyric', 'Lirik lagu', { p: 'q', ph: '<judul lagu>', alias: ['lyric'], prefer: 'text' });
add('Info', 'urban', 'tools-urban-dictionary', 'Urban Dictionary', { p: 'q', ph: '<kata>', prefer: 'text' });
add('Info', 'brainly', 'tools-brainly', 'Cari jawaban Brainly', { p: 'q', ph: '<soal>', prefer: 'text' });
add('Info', 'stalkig', 'tools-stalk-instagram-account', 'Profil Instagram', { p: 'username', ph: '<username>', prefer: 'auto', withInfo: true });
add('Info', 'stalkgh', 'tools-stalk-github-account', 'Profil GitHub', { p: 'username', ph: '<username>', prefer: 'auto', withInfo: true });
add('Info', 'stalktt', 'tools-stalk-tiktok-account', 'Profil TikTok', { p: 'username', ph: '<username>', prefer: 'auto', withInfo: true });

// Gambar acak & hiburan
add('Hiburan', 'pinterest', 'searching-pinterest-image-only', 'Cari gambar Pinterest', { p: 'q', ph: '<kata kunci>', alias: ['pin'], prefer: 'image' });
add('Hiburan', 'wallpaper', 'searching-wallpaper', 'Cari wallpaper', { p: 'q', ph: '<kata kunci>', prefer: 'image' });
add('Hiburan', 'waifu', 'randomly-waifu', 'Waifu acak', { prefer: 'image' });
add('Hiburan', 'quotes', 'entertainment-quotes', 'Kutipan tokoh', { p: 'q', ph: '<nama tokoh>', prefer: 'text' });
add('Hiburan', 'fakta', 'randomly-fakta-unik', 'Fakta unik', { prefer: 'text' });
add('Hiburan', 'pantun', 'randomly-pantun', 'Pantun acak', { prefer: 'text' });
add('Hiburan', 'bucin', 'randomly-bucin', 'Kata bucin', { prefer: 'text' });
add('Hiburan', 'khodam', 'randomly-cek-khodam', 'Cek khodam', { prefer: 'text' });
add('Hiburan', 'artimimpi', 'primbon-arti-mimpi', 'Arti mimpi', { p: 'q', ph: '<mimpi>', prefer: 'text' });
add('Hiburan', 'artinama', 'primbon-arti-nama', 'Arti nama', { p: 'q', ph: '<nama>', prefer: 'text' });

const INDEX = new Map();
for (const c of CMDS) { INDEX.set(c.name, c); for (const a of c.alias || []) INDEX.set(a, c); }
export const COMMAND_COUNT = CMDS.length;

function menuText() {
  const p = PREFIXES[0];
  const cats = {};
  for (const c of CMDS) (cats[c.cat] ||= []).push(c);
  let t = `*${BOT_NAME}* — ${CMDS.length + 7}+ perintah\n`;
  t += `\n*Downloader*\n${p}dl <link> [kualitas] — video (YouTube/TikTok/IG/dll)\n${p}mp3 <link> — audio`;
  for (const [cat, list] of Object.entries(cats)) {
    t += `\n\n*${cat}*`;
    for (const c of list) {
      const arg = c.img ? '(gambar)' : c.p ? (c.ph || `<${Array.isArray(c.p) ? c.p.join('> <') : c.p}>`) : '';
      t += `\n${p}${c.name}${arg ? ' ' + arg : ''} — ${c.desc}`;
    }
  }
  t += `\n\n*Lainnya*\n${p}anime <judul> — cari anime\n${p}tools <kata> — cari tool (±380 tersedia)\n${p}run <id-tool> param=nilai — jalankan tool apa pun\n${p}ping — cek koneksi API`;
  t += `\n\n_Tool gambar: kirim gambar dengan caption perintah, atau reply gambarnya._`;
  return t;
}

// ── Eksekusi ────────────────────────────────────────────────────────────────
async function runCommand(sock, msg, cmd, arg) {
  const params = { ...(cmd.extra || {}) };
  if (cmd.img) params[cmd.img] = await imageUrlFrom(sock, msg, arg);
  if (cmd.p) {
    let a = arg.trim();
    if (!a && /^url$/.test(String(cmd.p))) a = (quotedText(msg).match(/https?:\/\/\S+/) || [''])[0];
    if (!a && !cmd.opt) throw new UsageError(cmd);
    if (Array.isArray(cmd.p)) {
      const parts = a.split(/\s+/);
      if (parts.length < cmd.p.length && !cmd.opt) throw new UsageError(cmd);
      cmd.p.forEach((k, i) => { params[k] = i === cmd.p.length - 1 ? parts.slice(i).join(' ') : parts[i]; });
    } else if (a) params[cmd.p] = a;
  }
  const res = await api('/api/v2/run', { tool: cmd.tool, ...params });
  await deliver(sock, msg, res, cmd);
}

class UsageError extends Error {
  constructor(cmd) {
    super(`Format: ${PREFIXES[0]}${cmd.name} ${cmd.ph || `<${[].concat(cmd.p).join('> <')}>`}`);
  }
}

async function cmdDownload(sock, msg, arg, asAudio) {
  const jid = msg.key.remoteJid;
  const link = (arg.match(/https?:\/\/\S+/) || quotedText(msg).match(/https?:\/\/\S+/) || [])[0];
  if (!link) throw new ApiError(`Format: ${PREFIXES[0]}${asAudio ? 'mp3' : 'dl'} <link>`);
  const q = asAudio ? 'audio' : (arg.replace(link, '').trim().match(/^[a-z0-9_]{1,24}$/i)?.[0] || 'best');
  const { json } = await api('/api/v2/download', { url: link, quality: q });
  if (!json?.url) throw new ApiError('Server gak ngasih link download.');
  try {
    await sock.sendMessage(jid, asAudio ? { audio: { url: json.url }, mimetype: 'audio/mpeg' } : { video: { url: json.url }, caption: 'Selesai ✅' }, { quoted: msg });
  } catch (e) {
    // video terlalu besar buat WA / format aneh → kirim sebagai dokumen
    await sock.sendMessage(jid, { document: { url: json.url }, fileName: asAudio ? 'audio.mp3' : 'video.mp4', mimetype: asAudio ? 'audio/mpeg' : 'video/mp4' }, { quoted: msg });
  }
}

async function cmdTools(sock, msg, arg) {
  const { json } = await api('/api/v2/tools', { q: arg.trim() });
  const lines = [];
  for (const c of json.categories || []) for (const t of c.tools) lines.push(`• ${t.id}${t.params?.length ? ' (' + t.params.map(p => p.k).join(', ') + ')' : ''}`);
  const shown = lines.slice(0, 30).join('\n');
  await sock.sendMessage(msg.key.remoteJid, { text: `*${json.total} tool${arg ? ` cocok "${arg.trim()}"` : ''}*\n${shown}${lines.length > 30 ? `\n…dan ${lines.length - 30} lagi, persempit pencarian.` : ''}\n\nJalankan: ${PREFIXES[0]}run <id> param=nilai` }, { quoted: msg });
}

async function cmdRun(sock, msg, arg) {
  const [id, ...rest] = arg.trim().split(/\s+/);
  if (!id) throw new ApiError(`Format: ${PREFIXES[0]}run <id-tool> param=nilai\nCari id: ${PREFIXES[0]}tools <kata>`);
  const params = {};
  for (const m of rest.join(' ').matchAll(/([a-z0-9_]+)=("[^"]*"|\S+)/gi)) params[m[1]] = m[2].replace(/^"|"$/g, '');
  if (!params.image && imageHolder(msg)) params.image = await imageUrlFrom(sock, msg, '');
  const res = await api('/api/v2/run', { tool: id, ...params });
  await deliver(sock, msg, res, { prefer: 'auto' });
}

async function cmdAnime(sock, msg, arg) {
  if (!arg.trim()) throw new ApiError(`Format: ${PREFIXES[0]}anime <judul>`);
  const res = await api('/api/v2/anime/search', { q: arg.trim() });
  await deliver(sock, msg, res, { prefer: 'image', withInfo: true });
}

const friendly = e => {
  if (e instanceof UsageError) return e.message;
  const s = e.status;
  if (s === 401) return 'API key salah atau sudah di-revoke. Buat key baru di web.';
  if (s === 403) return 'Akun Premium pemilik API key sudah habis. Perpanjang dulu.';
  if (s === 429) return 'Kebanyakan request ke API. Tunggu sebentar lalu coba lagi.';
  if (s === 503) return 'Layanan downloader lagi belum aktif. Coba lagi nanti.';
  return String(e.message || e).slice(0, 300);
};

// ── Handler utama ───────────────────────────────────────────────────────────
const cooldown = new Map();
const digits = j => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

export async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return;
  if (msg.key.fromMe && process.env.ALLOW_SELF !== '1') return;
  const content = norm(msg.message);
  const text = textOf(content).trim();
  const re = new RegExp(`^[${PREFIXES.replace(/[\]\\^-]/g, '\\$&')}]\\s*([a-z0-9_-]+)\\s*([\\s\\S]*)$`, 'i');
  const m = text.match(re);
  if (!m) return;
  const name = m[1].toLowerCase(); const arg = m[2] || '';

  const sender = msg.key.participant || msg.key.remoteJid;
  if (ALLOWED.length) {
    const ids = [sender, msg.key.participantAlt, msg.key.remoteJidAlt, msg.key.remoteJid].map(digits);
    if (!ids.some(d => ALLOWED.includes(d))) return;
  }
  const special = ['menu', 'help', 'start', 'ping', 'dl', 'mp3', 'tools', 'run', 'anime'];
  const cmd = INDEX.get(name);
  if (!cmd && !special.includes(name)) return;

  const now = Date.now();
  if (now - (cooldown.get(sender) || 0) < COOLDOWN_MS) return;
  cooldown.set(sender, now);
  if (cooldown.size > 5000) cooldown.delete(cooldown.keys().next().value);

  const jid = msg.key.remoteJid;
  const react = e => sock.sendMessage(jid, { react: { text: e, key: msg.key } }).catch(() => {});
  try {
    if (['menu', 'help', 'start'].includes(name)) return void await sock.sendMessage(jid, { text: menuText() }, { quoted: msg });
    if (name === 'ping') {
      const t0 = Date.now(); const { json } = await api('/api/api-access-info');
      return void await sock.sendMessage(jid, { text: `🏓 API oke — ${Date.now() - t0} ms\nLimit server: ${json?.ratePerMin}/menit (bot pakai ${RPM})` }, { quoted: msg });
    }
    await react('⏳');
    if (name === 'dl' || name === 'mp3') await cmdDownload(sock, msg, arg, name === 'mp3');
    else if (name === 'tools') await cmdTools(sock, msg, arg);
    else if (name === 'run') await cmdRun(sock, msg, arg);
    else if (name === 'anime') await cmdAnime(sock, msg, arg);
    else await runCommand(sock, msg, cmd, arg);
    await react('✅');
  } catch (e) {
    console.error(`[${name}]`, e.status || '', e.message);
    await react('❌');
    await sock.sendMessage(jid, { text: `Gagal: ${friendly(e)}` }, { quoted: msg }).catch(() => {});
  }
}

// ── Koneksi WhatsApp ────────────────────────────────────────────────────────
async function start() {
  if (!API_KEY) { console.error('NINZY_API_KEY belum diisi. Salin .env.example ke .env lalu isi key-nya.'); process.exit(1); }
  ensureDeps();
  await loadBaileys();
  const pino = (await import('pino')).default;
  const qrt = (await import('qrcode-terminal')).default;
  const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
  B.logger = logger;

  try { // samakan laju bot dengan limit asli di server
    const info = await (await fetch(BASE + '/api/api-access-info', { signal: AbortSignal.timeout(10000) })).json();
    if (info?.ratePerMin) { RPM = Math.max(10, Math.min(RPM, info.ratePerMin - 10)); console.log(`Limit server ${info.ratePerMin}/menit → bot pakai ${RPM}/menit`); }
  } catch { console.log('Gagal baca limit server, pakai NINZY_RPM =', RPM); }

  async function connect() {
    const { state, saveCreds } = await B.useMultiFileAuthState(process.env.AUTH_DIR || 'auth');
    let version; try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* pakai bawaan */ }
    const sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
      logger, browser: B.Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);

    let asked = false;
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (PAIRING && !sock.authState.creds.registered) {
          if (asked) return; asked = true;
          try { console.log('\nKode pairing (WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon):', await sock.requestPairingCode(PAIRING), '\n'); }
          catch (e) { console.error('Gagal minta kode pairing:', e.message); }
        } else { console.log('\nScan QR ini dari WhatsApp → Perangkat tertaut:\n'); qrt.generate(qr, { small: true }); }
      }
      if (connection === 'open') console.log('✅ Bot nyambung sebagai', sock.user?.id, '·', COMMAND_COUNT + 7, 'perintah siap');
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === B.DisconnectReason.loggedOut) { console.log('Sesi logout. Hapus folder "auth" lalu jalankan lagi.'); process.exit(1); }
        console.log(`Koneksi putus (${code ?? '?'}), nyambung ulang…`);
        setTimeout(() => connect().catch(e => console.error(e)), 3000);
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handleMessage(sock, m).catch(e => console.error('handler:', e));
    });
  }
  await connect();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) start().catch(e => { console.error(e); process.exit(1); });
