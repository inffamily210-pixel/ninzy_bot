# NinzyBot — bot WhatsApp untuk API NinzyCompress

Butuh **Node.js 20+** dan API key (menu API Access di web, khusus Premium).

```bash
npm install
cp .env.example .env      # isi NINZY_API_KEY=ninzy_live_xxx
npm start
```

Login pertama: scan QR yang muncul di terminal (WhatsApp → Perangkat tertaut).
Atau isi `PAIRING_NUMBER=628xxx` di `.env` untuk login pakai kode pairing.
Sesi tersimpan di folder `auth/` — jangan dibagikan, jangan di-commit.

## Perintah
Ketik `.menu` di WhatsApp. Ringkasnya:
- `.dl <link>` / `.mp3 <link>` — downloader (lewat /api/v2/download)
- 59 perintah tool: downloader (TikTok, IG, FB, X, Spotify, CapCut, MediaFire, GDrive, Terabox, YouTube play),
  gambar (`.removebg`, `.remini`, `.upscale`, `.toanime`, `.ghibli`, `.ocr`, dll — kirim gambar + caption atau reply gambar),
  maker (`.brat`, `.attp`, `.ttp`, `.neon`, `.nulis`), AI (`.gpt`, `.gemini`, `.deepseek`, `.genimg`),
  info (`.cuaca`, `.gempa`, `.sholat`, `.quran`, `.resi`, `.ss`, `.lirik`, ...), hiburan.
- `.tools <kata>` cari tool, `.run <id> param=nilai` jalankan tool mana pun dari ±380 tool di katalog.
- `.anime <judul>` cari anime.

## Menambah perintah
Buka `bot.js`, cari bagian "Daftar perintah", tambah satu baris `add(...)`:
```js
add('Info', 'urban', 'tools-urban-dictionary', 'Urban Dictionary', { p: 'q', ph: '<kata>', prefer: 'text' });
```
`tool` = id dari `.tools`, `p` = nama parameter, `img` = parameter gambar,
`prefer` = `text | image | video | audio | sticker | doc | auto`.

## Catatan
- Bot membatasi dirinya ke (limit server − 10) request/menit. Satu key dipakai bersama semua pengguna bot,
  jadi kalau ramai, pakai `ALLOWED_NUMBERS` atau `COOLDOWN_MS` yang lebih besar.
- Tool gambar butuh link publik: gambar dari WhatsApp diunggah dulu ke host sementara (litterbox → catbox → uguu).
- Jangan commit `.env`. Kalau key bocor, Revoke di tab API Access lalu bikin baru.
