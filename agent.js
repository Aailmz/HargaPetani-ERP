require('dotenv').config();
const fs = require('fs');
const OpenAI = require('openai');
const { simpanPending, hapusPending, getPending } = require('./db');
const dump = require('./dump');
const { formatWaktu, potong } = require('./utils');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 60 * 1000,
  maxRetries: 1,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 8;
const MAX_TEKS_LAMPIRAN_DI_PROMPT = 4000;
const TEKS_KUAT_MIN = 200; // teks sepanjang ini dianggap konten sungguhan, bukan sekadar jawaban singkat

// ========== TOOLS ==========

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'simpan_data',
      description:
        'Simpan konten yang dikirim user sebagai satu entri dump. Panggil LANGSUNG kalau ada konten yang jelas (jangan minta konfirmasi dulu). Teks mentah, hasil baca gambar/PDF/Excel, dan file aslinya disimpan otomatis oleh sistem, jadi kamu cuma isi label dan hasil ekstraksi terstruktur.',
      parameters: {
        type: 'object',
        properties: {
          jenis: { type: 'string', description: 'Label jenis data, singkat, huruf kecil, 1-4 kata (cth: "nota belanja", "stok opname", "komplain klien"). Utamakan jenis yang sudah ada di daftar.' },
          judul: { type: 'string', description: 'Judul spesifik maksimal 80 karakter (siapa/apa/kapan).' },
          ringkasan: { type: 'string', description: 'Ringkasan 1-2 kalimat isi data.' },
          data: {
            type: 'object',
            description:
              'Field penting hasil ekstraksi sebagai object fleksibel, kunci snake_case bahasa Indonesia. Contoh: {"tanggal":"2025-11-12","toko":"UD Makmur","total":450000,"item":[{"nama":"Cabe rawit","qty":5,"satuan":"kg","harga":48000}]}. Jangan mengarang field yang tidak ada di sumber.',
            additionalProperties: true,
          },
          sumber: {
            type: 'string',
            enum: ['pesan_ini', 'tertunda'],
            description: '"pesan_ini" (default) = konten di pesan sekarang. "tertunda" = konten dari pesan sebelumnya yang kamu tanyakan dulu karena ambigu dan sekarang sudah dijawab user.',
          },
          perlu_konfirmasi: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Hal yang janggal atau bisa ditafsir lebih dari satu cara di sumber (angka tidak cocok, satuan harga tidak jelas, tanggal ganda, dll), ditulis sebagai pertanyaan spesifik. Kosongkan kalau tidak ada. Jangan memilih satu tafsiran diam-diam: isi data sesuai teks apa adanya dan taruh keraguannya di sini.',
          },
          lampiran: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Nomor lampiran (mulai 1) yang masuk ke entri ini. Kosongkan untuk memakai semua lampiran yang belum tersimpan. Pisahkan jadi beberapa panggilan kalau tiap lampiran adalah dokumen berbeda.',
          },
        },
        required: ['jenis', 'judul', 'ringkasan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lanjutkan_data',
      description:
        'Tambahkan pesan baru ke dump yang SUDAH ada (misal ada balasan baru di thread yang sudah tercatat). Hanya pesan yang belum tercatat di dump itu yang ditambahkan ke teks asli, file barunya ikut disimpan. Field judul/ringkasan/data bisa diperbarui sekaligus (data digabung dengan yang lama).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID dump yang dilanjutkan, cth "DUMP-0007".' },
          judul: { type: 'string' },
          ringkasan: { type: 'string', description: 'Ringkasan baru yang mencakup perkembangan terbaru.' },
          data: { type: 'object', additionalProperties: true, description: 'Field baru atau yang berubah (null untuk menghapus field).' },
          sumber: { type: 'string', enum: ['pesan_ini', 'tertunda'] },
          perlu_konfirmasi: { type: 'array', items: { type: 'string' }, description: 'Daftar hal yang masih belum terjawab sekarang ([] kalau semua beres).' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ubah_data',
      description: 'Ubah entri yang sudah tersimpan (misal user koreksi jenisnya, judulnya, atau ada field yang salah). Field di "data" digabung ke data lama; isi null untuk menghapus satu field.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID entri, cth "DUMP-0042" atau 42.' },
          jenis: { type: 'string' },
          judul: { type: 'string' },
          ringkasan: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
          perlu_konfirmasi: {
            type: 'array',
            items: { type: 'string' },
            description: 'Daftar hal yang MASIH belum terjawab setelah koreksi ini. Kirim [] kalau semuanya sudah terjawab; hilangkan poin yang sudah dijawab user.',
          },
          catatan_koreksi: {
            type: 'string',
            description: 'Kutipan kata-kata user yang mengoreksi atau menjawab (apa adanya). Dicatat terpisah, teks asli tidak ditimpa.',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hapus_data',
      description: 'Hapus entri (hapus lunak, masih bisa dipulihkan admin). Pakai kalau user minta batal/hapus/salah kirim.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID entri, cth "DUMP-0042".' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batalkan_tertunda',
      description: 'Buang konten yang tadi kamu tanyakan (belum disimpan) karena user bilang tidak jadi.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cari_data',
      description: 'Cari entri yang sudah tersimpan berdasarkan kata kunci dan/atau jenis. Tanpa argumen = entri terbaru.',
      parameters: {
        type: 'object',
        properties: {
          kata_kunci: { type: 'string' },
          jenis: { type: 'string' },
          limit: { type: 'integer', description: 'Default 10, maksimal 30.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detail_data',
      description: 'Ambil isi lengkap satu entri (termasuk teks asli) untuk ditampilkan ke user.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_jenis',
      description: 'Daftar jenis data yang sudah terkumpul beserta jumlahnya.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ekspor_data',
      description: 'Buat file rekap data tersimpan (CSV atau JSON) dan kirim ke user. Pakai kalau user minta rekap/ekspor/download data.',
      parameters: {
        type: 'object',
        properties: {
          jenis: { type: 'string', description: 'Opsional, batasi ke satu jenis.' },
          format: { type: 'string', enum: ['csv', 'json'], description: 'Default csv.' },
        },
      },
    },
  },
];

// ========== SYSTEM PROMPT ==========

function buatSystemPrompt(ctx) {
  const jenisAda = dump.daftarJenisGlobal(40);
  const daftarJenis = jenisAda.length ? jenisAda.map((j) => `${j.jenis} (${j.jumlah})`).join(', ') : '(belum ada, kamu yang menentukan label pertama)';
  const lokasi = ctx.chat.isGrup ? `grup "${ctx.chat.grupNama || '?'}"` : 'chat pribadi';

  return `Kamu pencatat data untuk tim "Harga Petani" (bisnis distributor sayur dan bahan dapur). Kamu ada di grup WhatsApp dan chat pribadi. Orang mengirim apa saja ke kamu (teks, forward chat, nota, kwitansi, foto, PDF, Excel, voice note) dan tugasmu menyimpannya dengan rapi dan terstruktur, bukan teks mentah.

Tujuan besarnya: mengumpulkan contoh nyata alur kerja dan bentuk data yang dipakai tim, untuk dipelajari belakangan. Jadi yang terpenting adalah isi yang setia ke sumber, bukan interpretasi kreatif.

Konteks sekarang: ${formatWaktu()} (WIB), ${lokasi}, pengirim: ${ctx.pengirim.nama || 'tanpa nama'}${ctx.isOwner ? ' (owner)' : ''}.

Jenis data yang sudah ada: ${daftarJenis}

ATURAN SIMPAN:
- Kalau ada konten yang jelas, langsung panggil simpan_data. Jangan minta konfirmasi dulu.
- Tanya HANYA kalau benar-benar ambigu: (a) tidak jelas ini data apa dan tebakan terbaikmu lemah, (b) pesan hampir kosong (misal cuma "tolong simpan" tanpa isi apa pun), (c) beberapa lampiran dan tidak jelas satu dokumen atau terpisah, (d) gambar/file gagal terbaca. Kalau tanya, cukup satu pertanyaan singkat dengan tebakan terbaikmu sebagai pilihan, contoh: "Ini nota belanja atau tagihan supplier?". Jangan simpan dulu. Begitu user menjawab, panggil simpan_data dengan sumber="tertunda".
- Pesan yang jelas bukan dump (sapaan, pertanyaan ke kamu, minta cari/ubah/hapus/rekap) ditangani dengan tool lain atau jawaban singkat. Jangan menyimpan basa-basi.
- Kalau user koreksi data yang baru kamu simpan ("bukan, ini tagihan supplier"), pakai ubah_data dengan ID dari riwayat chat. Kalau minta batal/hapus, pakai hapus_data.

HAL YANG MERAGUKAN DAN KOREKSI:
- Kalau saat menyimpan kamu menemukan hal yang janggal atau bisa ditafsir lebih dari satu cara (angka tidak cocok, misal total tidak sama dengan qty x harga; satuan harga tidak jelas, per pack atau per pcs; tanggal ganda; nama pihak mirip), JANGAN memilih satu tafsiran diam-diam dan jangan menaruh dugaanmu sebagai fakta di data. Simpan data apa adanya sesuai sumber, lalu tulis keraguannya sebagai pertanyaan spesifik di perlu_konfirmasi. Contoh: "Total Rp400.000 tidak sama dengan 10 x 8.000 = 80.000. Apakah harga 8.000 per pcs, dan berapa pcs isi 1 pack?". Kartu otomatis menampilkannya dan mengajak user membalas pesan itu.
- Kalau ada blok "PESAN INI MEMBALAS PESAN KAMU SEBELUMNYA TENTANG", user sedang menjawab atau mengoreksi dump itu. Panggil ubah_data untuk dump tersebut: terapkan koreksi persis seperti kata user (misal ubah struktur item, tambah field yang baru diketahui), isi catatan_koreksi dengan kutipan kata user, dan kirim perlu_konfirmasi berisi hanya poin yang MASIH belum terjawab ([] kalau semuanya beres). Teks asli tidak berubah, koreksi dicatat terpisah. Kalau jawabannya belum menuntaskan keraguan atau masih bisa dibaca dua cara, tanyakan lagi, jangan dianggap beres.
- Koreksi dari orang lain, bukan pengirim awal, tetap diterima dan dicatat siapa yang mengoreksi. Kalau user mengoreksi tanpa menyebut dump mana dan ada lebih dari satu kemungkinan, tanya dulu dump yang mana.
- Jangan hanya menyebut keraguan di balasan: selalu masukkan juga ke perlu_konfirmasi supaya tersimpan dan terlihat di Sheets sampai terjawab.

GAMBAR DAN FILE (JANGAN SOK TAHU):
- Isi data hanya dari apa yang tertulis atau terlihat. Jangan menebak angka, nama, atau tanggal yang tidak terbaca, jangan menghitung atau melengkapi sendiri (misal menjumlah total yang tidak tertulis), dan jangan mengarang jenis dokumen. Bagian yang tidak jelas biarkan kosong di data dan catat di field "tidak_terbaca" (daftar teks) supaya terlihat jelas bahwa itu memang tidak terbaca.
- Hasil baca gambar memuat baris KEJELASAN. Kalau gambar jelas dan kamu yakin isinya, langsung simpan. TANYA dulu (jangan simpan) kalau salah satunya benar: KEJELASAN bukan "jelas" dan bagian pentingnya (total, tanggal, nama pihak, atau angka utama) meragukan; tulisan tangan yang bisa dibaca lebih dari satu cara; tidak jelas gambar itu dokumen apa; atau gambar tanpa teks dan tanpa pesan pendamping sehingga tidak jelas mau dicatat sebagai apa.
- Cara bertanya: satu pesan singkat. Sebut persis apa yang kamu baca dan bagian mana yang meragukan, lalu tanya yang benar. Contoh: "Totalnya kebaca Rp 450.000 atau Rp 460.000? Angka terakhirnya buram." atau "Ini foto apa dan mau dicatat sebagai apa?". Jangan bertanya hal yang sudah jelas dari gambar.
- Kalau gambar gagal terbaca (ada tanda BERMASALAH), bilang apa adanya dan minta user mengirim ulang atau mengetik isinya. Jangan berpura-pura sudah membacanya.

THREAD DAN REPLY DI GRUP:
- Konten bisa berupa potongan percakapan grup: baris seperti "[08:40 Budi]: ..." dan "[08:45 Sari ↪ Budi]: ..." (tanda ↪ artinya membalas). Itu satu kesatuan konteks, simpan SEMUANYA sebagai SATU dump dengan jenis sesuai topik utamanya (misal "purchase order"), bukan jenis "percakapan" atau "chat". Isi ringkasan dengan inti diskusi, dan masukkan hal penting dari balasan (status, keputusan, perubahan jumlah atau jadwal, siapa yang mengurus) ke data, misal field "tindak_lanjut" atau "catatan".
- Baris "(Pesan yang men-tag hanya berisi tag, artinya minta dicatat.)" berarti user minta thread itu dicatat. Jangan bertanya apa pun, langsung simpan_data.
- Voice note di thread tidak bisa dibaca isinya. Sebut di ringkasan bahwa ada voice note dari siapa, dan file-nya ikut tersimpan sebagai lampiran.
- Kalau ada blok "SUDAH TERSIMPAN", sebagian pesan di thread ini sudah tercatat. Kalau pesan baru itu lanjutan atau kabar terbaru dari hal yang sama, panggil lanjutkan_data dengan ID itu (perbarui ringkasan dan data supaya mencerminkan keadaan terbaru) dan JANGAN membuat dump baru. Kalau topiknya benar-benar berbeda, pakai simpan_data.

CARA MENGISI:
- jenis: singkat, huruf kecil. Pakai jenis yang sudah ada kalau cocok, buat baru hanya kalau memang berbeda.
- judul: spesifik, maksimal 80 karakter.
- data: ekstrak field penting apa adanya: tanggal (format YYYY-MM-DD kalau pasti), pihak (toko, supplier, klien, outlet, orang), nominal (angka rupiah tanpa titik), item (array berisi nama, qty, satuan, harga), status, catatan. Field yang tidak ada di sumber jangan dibuat. Angka yang tidak terbaca jangan ditebak, tulis apa adanya atau tinggalkan.
- Teks mentah dan file asli disimpan otomatis oleh sistem, jadi kamu tidak perlu menyalin isinya.
- Beberapa lampiran: kalau tiap lampiran dokumen berbeda (misal 3 nota), panggil simpan_data sekali per lampiran dengan field lampiran. Kalau halaman dari satu dokumen, simpan sekali.
- Voice note belum bisa ditranskrip. Simpan dengan jenis "voice note", judul memuat siapa pengirimnya, dan sebutkan konteks kalau ada teks pendampingnya.

BALASAN:
- simpan_data mengembalikan field "kartu". Kirim kartu itu APA ADANYA sebagai balasan. Boleh menambah satu kalimat pendek di bawahnya kalau ada hal penting (misal sebagian gambar tidak jelas terbaca). Jangan menulis ulang atau meringkas kartu.
- Gaya santai dan singkat, bahasa Indonesia, kapitalisasi normal. Boleh format WhatsApp (*tebal*). Jangan pakai tanda strip panjang (—) atau double dash (--). Jangan menyebut dirimu AI, bot, atau sistem.

AKSES:
- Kamu hanya bisa melihat, mengubah, dan menghapus data dari chat ini${ctx.isOwner ? ', kecuali pengirim ini owner yang boleh mengakses semua data' : ''}. Kalau tool menolak, sampaikan apa adanya.`;
}

// ========== PESAN USER UNTUK MODEL ==========

function renderKonten(konten, label) {
  const bagian = [];
  if (konten.teks) bagian.push(konten.teks);
  if (konten.lampiran?.length) {
    bagian.push('Lampiran:');
    for (const lp of konten.lampiran) {
      const nama = lp.namaAsli ? ` (${lp.namaAsli})` : '';
      const status = lp.gagal ? ` [BERMASALAH: ${lp.gagal}]` : '';
      const isi = lp.teksHasil ? `\n${potong(lp.teksHasil, MAX_TEKS_LAMPIRAN_DI_PROMPT)}` : '';
      const caption = lp.caption ? `\nCaption: ${lp.caption}` : '';
      bagian.push(`${lp.idx}. ${lp.tipe}${nama}${status}${caption}${isi}`);
    }
  }
  return bagian.length ? `${label}\n${bagian.join('\n')}` : '';
}

function buatPesanUser(ctx) {
  const header = `[Dari: ${ctx.pengirim.nama || 'tanpa nama'}${ctx.chat.isGrup ? ` · grup: ${ctx.chat.grupNama || '?'}` : ''}]`;
  const utama = renderKonten(ctx.konten, 'Pesan ini:') || 'Pesan ini: (kosong)';
  const tertunda = ctx.pending ? '\n\n' + renderKonten(ctx.pending, 'KONTEN TERTUNDA dari pesan sebelumnya (belum disimpan, kamu tadi bertanya soal ini; kalau pesan ini jawabannya, simpan dengan sumber="tertunda"):') : '';
  const rujukan = ctx.rujukan.length
    ? `\n\nPESAN INI MEMBALAS PESAN KAMU SEBELUMNYA TENTANG:\n${ctx.rujukan
        .map((e) => `${dump.formatId(e.id)} (${e.jenis}: ${e.judul || 'tanpa judul'})\nData saat ini: ${potong(JSON.stringify(e.data || {}), 3000)}`)
        .join('\n')}\nAnggap pesan ini jawaban atau koreksi untuk data tersebut.`
    : '';
  const sudah = ctx.sudahAda.length
    ? `\n\nSUDAH TERSIMPAN: sebagian pesan di atas sudah tercatat sebagai ${ctx.sudahAda.map((e) => `${dump.formatId(e.id)} (${e.jenis}: ${e.judul || 'tanpa judul'})`).join('; ')}.`
    : '';
  // "ringkas" masuk riwayat chat (tanpa blok tertunda supaya riwayat tidak berisi duplikat)
  return { lengkap: `${header}\n${utama}${sudah}${rujukan}${tertunda}`, ringkas: `${header}\n${utama}` };
}

// ========== EKSEKUTOR TOOL ==========

function pilihLampiran(sumberKonten, nomor) {
  const semua = (sumberKonten.lampiran || []).filter((l) => !l.dipakai);
  return Array.isArray(nomor) ? semua.filter((l) => nomor.includes(l.idx)) : semua;
}

async function eksekusiSimpanData({ jenis, judul, ringkasan, data, sumber, lampiran, perlu_konfirmasi }, ctx) {
  const pakaiTertunda = sumber === 'tertunda';
  const sumberKonten = pakaiTertunda ? ctx.pending : ctx.konten;
  if (!sumberKonten) return { error: 'Tidak ada konten tertunda. Minta user kirim ulang isinya.' };

  const dipilih = pilihLampiran(sumberKonten, lampiran);
  if (!sumberKonten.teks && dipilih.length === 0) {
    return { error: 'Tidak ada isi yang bisa disimpan (pesan kosong dan tanpa lampiran). Tanyakan ke user apa yang mau disimpan.' };
  }

  const teksAsli = [
    sumberKonten.teks || '',
    ...dipilih.map((l) => `[Lampiran ${l.idx}: ${l.tipe}${l.namaAsli ? ` ${l.namaAsli}` : ''}${l.caption ? ` | caption: ${l.caption}` : ''}]\n${l.teksHasil || ''}`),
  ].filter(Boolean).join('\n\n');

  const dataFinal = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  const konfirmasi = Array.isArray(perlu_konfirmasi) ? perlu_konfirmasi.map((x) => String(x).trim()).filter(Boolean) : [];
  if (konfirmasi.length) dataFinal.perlu_konfirmasi = konfirmasi;

  const entri = dump.simpanEntri({
    jenis,
    judul,
    ringkasan,
    data: Object.keys(dataFinal).length ? dataFinal : null,
    teksAsli,
    chat: ctx.chat,
    pengirim: ctx.pengirim,
    lampiran: dipilih.filter((l) => l.path && fs.existsSync(l.path)).map((l) => ({ path: l.path, namaAsli: l.namaAsli, mimetype: l.mimetype, tipe: l.tipe, ukuran: l.ukuran })),
  });

  for (const l of dipilih) l.dipakai = true;
  if (pakaiTertunda) ctx.pakaiTertunda = true;
  ctx.entriBaru.push(entri.id);

  // Catat pesan WhatsApp mana yang masuk ke dump ini (teks hanya ke dump pertama giliran ini,
  // lampiran ke dump pemiliknya) supaya balasan berikutnya di thread bisa dilanjutkan ke dump yang sama.
  const idTeks = ctx.teksSudahDicatat ? [] : (sumberKonten.bagian || []).map((b) => b.id);
  ctx.teksSudahDicatat = true;
  dump.catatPesan(entri.id, ctx.chat.jid, [...idTeks, ...dipilih.map((l) => l.pesanId)]);

  return { sukses: true, id: dump.formatId(entri.id), kartu: dump.formatKartu(entri) };
}

function blokLampiran(l) {
  return `[Lampiran ${l.idx}: ${l.tipe}${l.namaAsli ? ` ${l.namaAsli}` : ''}]\n${l.teksHasil || ''}`;
}

async function eksekusiLanjutkanData({ id, judul, ringkasan, data, sumber, perlu_konfirmasi }, ctx) {
  const cek = cekAkses(id, ctx);
  if (cek.error) return cek;
  const sumberKonten = sumber === 'tertunda' ? ctx.pending : ctx.konten;
  if (!sumberKonten) return { error: 'Tidak ada konten tertunda.' };

  const sudah = dump.pesanDiEntri(cek.entri.id);
  const bagianBaru = (sumberKonten.bagian || []).filter((b) => !sudah.has(b.id));
  const kandidat = pilihLampiran(sumberKonten);
  const lampiranBaru = kandidat.filter((l) => !(l.pesanId && sudah.has(l.pesanId)));

  // lampiran yang ternyata sudah tersimpan di dump itu tidak perlu disimpan dua kali
  for (const l of kandidat) {
    l.dipakai = true;
    if (!lampiranBaru.includes(l) && l.path) {
      try {
        fs.unlinkSync(l.path);
      } catch {
        /* abaikan */
      }
    }
  }
  if (sumber === 'tertunda') ctx.pakaiTertunda = true;

  if (!bagianBaru.length && !lampiranBaru.length) {
    return { sukses: false, pesan: `Tidak ada pesan baru: seluruh isi thread ini sudah ada di ${dump.formatId(cek.entri.id)}.` };
  }

  const teksTambahan = [...bagianBaru.map((b) => b.teks), ...lampiranBaru.map(blokLampiran)].filter(Boolean).join('\n\n');
  const hasil = dump.tambahKeEntri(cek.entri.id, {
    teksTambahan,
    judul,
    ringkasan,
    data,
    perluKonfirmasi: perlu_konfirmasi,
    lampiran: lampiranBaru.filter((l) => l.path && fs.existsSync(l.path)).map((l) => ({ path: l.path, namaAsli: l.namaAsli, mimetype: l.mimetype, tipe: l.tipe, ukuran: l.ukuran })),
  });
  dump.catatPesan(cek.entri.id, ctx.chat.jid, [...bagianBaru.map((b) => b.id), ...lampiranBaru.map((l) => l.pesanId)]);

  ctx.teksSudahDicatat = true;
  ctx.entriDiubah.push(cek.entri.id);
  ctx.entriLanjut.push({ id: cek.entri.id, fileBaruIds: hasil.fileBaruIds });
  return { sukses: true, kartu: dump.formatKartu(hasil.entri, { judulKartu: 'Dilanjutkan' }) };
}

function cekAkses(idInput, ctx) {
  const id = dump.parseId(idInput);
  if (!id) return { error: `ID "${idInput}" tidak valid.` };
  const entri = dump.getEntri(id);
  if (!entri || entri.status !== 'AKTIF') return { error: `${dump.formatId(id)} tidak ditemukan.` };
  if (!dump.bolehAkses(entri, ctx.chat.jid, ctx.isOwner)) return { error: `${dump.formatId(id)} bukan data dari chat ini, tidak bisa diakses dari sini.` };
  return { entri };
}

async function eksekusiUbahData({ id, jenis, judul, ringkasan, data, perlu_konfirmasi, catatan_koreksi }, ctx) {
  const cek = cekAkses(id, ctx);
  if (cek.error) return cek;
  const baru = dump.ubahEntri(cek.entri.id, {
    jenis,
    judul,
    ringkasan,
    data,
    perluKonfirmasi: perlu_konfirmasi,
    catatanKoreksi: catatan_koreksi,
    oleh: ctx.pengirim.nama,
  });
  // pesan koreksi ikut tercatat di dump ini, jadi balasan berikutnya di thread yang sama nyambung
  dump.catatPesan(baru.id, ctx.chat.jid, ctx.konten.pesanIds);
  ctx.entriDiubah.push(baru.id);
  return { sukses: true, kartu: dump.formatKartu(baru, { judulKartu: 'Diperbarui' }) };
}

async function eksekusiHapusData({ id }, ctx) {
  const cek = cekAkses(id, ctx);
  if (cek.error) return cek;
  dump.hapusEntri(cek.entri.id);
  ctx.entriDiubah.push(cek.entri.id);
  return { sukses: true, pesan: `🗑️ ${dump.formatId(cek.entri.id)} dihapus.` };
}

async function eksekusiBatalkanTertunda(_args, ctx) {
  ctx.batalTertunda = true;
  return { sukses: true };
}

async function eksekusiCariData({ kata_kunci, jenis, limit }, ctx) {
  const hasil = dump.cariEntri({ kataKunci: kata_kunci, jenis, limit: limit || 10, chatJid: ctx.chat.jid, isOwner: ctx.isOwner });
  return { jumlah: hasil.length, hasil: hasil.map((r) => ({ id: dump.formatId(r.id), baris: dump.barisRingkas(r), ringkasan: potong(r.ringkasan || '', 200) })) };
}

async function eksekusiDetailData({ id }, ctx) {
  const cek = cekAkses(id, ctx);
  if (cek.error) return cek;
  return { kartu: dump.formatKartu(cek.entri, { judulKartu: 'Detail' }), teks_asli: potong(cek.entri.teks_asli || '', 3000) };
}

async function eksekusiLihatJenis(_args, ctx) {
  return { jenis: dump.daftarJenis({ chatJid: ctx.chat.jid, isOwner: ctx.isOwner }) };
}

async function eksekusiEksporData({ jenis, format }, ctx) {
  const hasil = dump.ekspor({ jenis, format: format || 'csv', chatJid: ctx.chat.jid, isOwner: ctx.isOwner });
  if (!hasil) return { error: 'Belum ada data yang cocok untuk diekspor.' };
  ctx.filesUntukDikirim.push(hasil.path);
  return { sukses: true, jumlah_entri: hasil.jumlah, catatan: 'File akan dikirim otomatis setelah balasanmu.' };
}

const EKSEKUTOR = {
  simpan_data: eksekusiSimpanData,
  lanjutkan_data: eksekusiLanjutkanData,
  ubah_data: eksekusiUbahData,
  hapus_data: eksekusiHapusData,
  batalkan_tertunda: eksekusiBatalkanTertunda,
  cari_data: eksekusiCariData,
  detail_data: eksekusiDetailData,
  lihat_jenis: eksekusiLihatJenis,
  ekspor_data: eksekusiEksporData,
};

// ========== SISA KONTEN SETELAH GILIRAN SELESAI ==========

function hapusFile(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* abaikan */
  }
}

/**
 * Menentukan nasib konten tiap giliran:
 * - kalau konten tertunda sudah dipakai/dibatalkan -> bersihkan
 * - kalau pesan ini tidak disimpan dan kelihatan konten sungguhan -> jadi konten tertunda (nunggu jawaban user)
 * - file sementara yang tidak dipakai siapa pun dihapus
 */
function selesaikanKonten(ctx) {
  const sisaLampiran = ctx.konten.lampiran.filter((l) => l.path && !l.dipakai);
  const lampiranPendingLama = ctx.pending?.lampiran || [];

  if (ctx.pakaiTertunda || ctx.batalTertunda) {
    for (const l of lampiranPendingLama) if (!l.dipakai) hapusFile(l.path);
    hapusPending(ctx.chatKey);
    ctx.pending = null;
  }

  const teks = (ctx.konten.teks || '').trim();
  const kontenKuat = ctx.konten.kuat || teks.length >= TEKS_KUAT_MIN;
  let jadiTertunda = false;
  if (!ctx.batalTertunda) {
    if (sisaLampiran.length) jadiTertunda = true;
    else if (!ctx.adaTool && teks) jadiTertunda = kontenKuat || (!ctx.pending && teks.length >= 15);
  }

  if (jadiTertunda) {
    // konten tertunda lama (kalau masih ada) tergantikan, file-nya dibuang
    for (const l of ctx.pending?.lampiran || []) if (!l.dipakai) hapusFile(l.path);
    const sudahTersimpan = ctx.entriBaru.length > 0;
    simpanPending(ctx.chatKey, {
      teks: sudahTersimpan ? '' : ctx.konten.teks,
      bagian: sudahTersimpan ? [] : ctx.konten.bagian || [],
      pesanIds: ctx.konten.pesanIds || [],
      lampiran: sisaLampiran,
    });
    return;
  }

  for (const l of sisaLampiran) hapusFile(l.path);
}

// ========== LOOP TOOL (dipakai percakapan biasa dan mode diskusi) ==========

async function loopTool(messages, ctx, tools, maksIterasi) {
  const kartu = [];
  let jawabanFinal = null;
  let error = null;

  for (let iterasi = 0; iterasi < maksIterasi; iterasi++) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      error = err.message;
      break;
    }

    const pesanAi = completion.choices[0].message;
    messages.push(pesanAi);

    if (!pesanAi.tool_calls?.length) {
      jawabanFinal = pesanAi.content;
      break;
    }

    for (const toolCall of pesanAi.tool_calls) {
      const nama = toolCall.function.name;
      let argumen;
      try {
        argumen = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        argumen = {};
      }
      ctx.adaTool = true;
      console.log(`🔧 Tool: ${nama}(${potong(JSON.stringify(argumen), 300)})`);

      let hasil;
      try {
        const fn = EKSEKUTOR[nama];
        hasil = fn ? await fn(argumen, ctx) : { error: `Tool ${nama} tidak dikenali.` };
      } catch (err) {
        console.error(`❌ Error tool ${nama}:`, err.message);
        hasil = { error: `Gagal eksekusi: ${err.message}` };
      }
      if (hasil?.kartu && ['simpan_data', 'ubah_data', 'lanjutkan_data'].includes(nama)) kartu.push(hasil);

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(hasil) });
    }
  }

  if (!error && jawabanFinal === null) error = 'Agent melewati batas iterasi tool.';
  return { jawabanFinal, error, kartu };
}

// ========== LOOP AGENT ==========

/**
 * @param {object} p
 * @param {string} p.chatKey
 * @param {{jid:string,isGrup:boolean,grupNama?:string}} p.chat
 * @param {{jid:string,nama?:string}} p.pengirim
 * @param {boolean} p.isOwner
 * @param {{teks:string, lampiran:object[], kuat?:boolean}} p.konten
 * @param {{role:string,content:string}[]} p.riwayat
 */
async function jalankanAgent({ chatKey, chat, pengirim, isOwner, konten, riwayat }) {
  const ctx = {
    chatKey,
    chat,
    pengirim,
    isOwner,
    konten: { ...konten, lampiran: konten.lampiran.map((l, i) => ({ ...l, idx: i + 1 })) },
    pending: getPending(chatKey),
    sudahAda: dump.cariEntriByPesan(chat.jid, konten.pesanIds),
    rujukan: (konten.rujukanIds || []).map((rid) => dump.getEntri(rid)).filter((e) => e && e.status === 'AKTIF'),
    adaTool: false,
    pakaiTertunda: false,
    batalTertunda: false,
    entriBaru: [],
    entriDiubah: [],
    entriLanjut: [],
    teksSudahDicatat: false,
    filesUntukDikirim: [],
  };
  if (ctx.pending) ctx.pending.lampiran = (ctx.pending.lampiran || []).map((l, i) => ({ ...l, idx: i + 1 }));

  const pesanUser = buatPesanUser(ctx);
  const messages = [
    { role: 'system', content: buatSystemPrompt(ctx) },
    ...riwayat,
    { role: 'user', content: pesanUser.lengkap },
  ];

  const hasilLoop = await loopTool(messages, ctx, TOOLS, MAX_TOOL_ITERATIONS);
  const { jawabanFinal, kartu } = hasilLoop;
  const error = hasilLoop.error;

  // Model kadang lupa menyertakan kartu: pastikan pengirim selalu melihat ID yang tersimpan.
  const semuaKartu = kartu.map((k) => k.kartu);
  let balasan = (jawabanFinal || '').trim();
  const idHilang = ctx.entriBaru.concat(ctx.entriDiubah).some((id) => !balasan.includes(dump.formatId(id)));
  if (semuaKartu.length && (idHilang || !balasan)) {
    balasan = semuaKartu.join('\n\n') + (balasan ? `\n\n${balasan}` : '');
  }

  selesaikanKonten(ctx);

  return {
    balasan: balasan || null,
    error,
    entriBaru: ctx.entriBaru,
    entriDiubah: ctx.entriDiubah,
    entriLanjut: ctx.entriLanjut,
    files: ctx.filesUntukDikirim,
    // teks yang disimpan ke riwayat chat supaya percakapan lanjutan punya konteks
    teksUser: pesanUser.ringkas,
  };
}

// ========== MODE DISKUSI (menyimak obrolan grup setelah bot bertanya) ==========

const PROMPT_DISKUSI = `Kamu pencatat data tim "Harga Petani" dan sedang menyimak obrolan grup setelah kamu mengajukan pertanyaan konfirmasi tentang data yang tersimpan. Tidak ada yang men-tag kamu, kamu hanya ikut menyimak.

Tugasmu: tentukan apakah pesan-pesan terbaru di grup menjawab atau mengoreksi pertanyaan terbuka pada salah satu data di bawah.

ATURAN:
- Sebagian besar obrolan TIDAK berkaitan. Kalau pesan tidak jelas berkaitan dengan data dan pertanyaan terbuka itu (barang, angka, satuan, atau pihak yang sama), jawab persis [DIAM] tanpa memanggil tool. Jangan membalas basa-basi, jangan berkomentar, jangan bertanya.
- Terapkan perubahan HANYA kalau pesan-pesan itu jelas dan cukup menjawab satu atau lebih pertanyaan. Kalau belum jelas tetapi orang-orangnya MASIH SEDANG berdiskusi (saling bertanya, "sebentar saya cek", belum ada kesimpulan), jawab [DIAM] dan tunggu.
- BERTANYA kalau obrolan tampak menuju kesimpulan atau sudah ditutup (ada yang menyimpulkan, sepakat, "oke fix", "ya sudah segitu", "jadi begitu ya") TETAPI hasilnya masih ambigu, bertentangan antar orang, atau belum menjawab semua pertanyaan, sehingga kamu tidak bisa memperbarui tanpa menebak. Jangan memanggil tool; jawab satu baris yang diawali persis "TANYA: " lalu satu pertanyaan singkat dan spesifik yang menyebut ID data dan apa yang bertentangan atau belum jelas, contoh: "TANYA: DUMP-0007: Harga 8.000 itu per pack atau per pcs?". Jangan bertanya kalau obrolan belum mengarah ke kesimpulan, dan jangan menanyakan hal yang jawabannya sudah ada di obrolan.
- Untuk menerapkan, panggil ubah_data untuk data itu: ubah field sesuai yang dikatakan (jangan menambah asumsi di luar pesan), isi catatan_koreksi dengan kutipan pesan yang relevan lengkap dengan nama pengirim dan jam, dan isi perlu_konfirmasi hanya dengan pertanyaan yang MASIH belum terjawab ([] kalau semuanya terjawab). Pesan yang tidak relevan jangan dikutip.
- Pesan boleh berasal dari beberapa orang. Gabungkan kalau saling melengkapi (misal satu menyebut isi per pack, yang lain menjelaskan harga per pcs).
- Setelah ubah_data, balas SATU kalimat pendek bahasa Indonesia yang menyebut apa yang kamu perbarui dari obrolan tadi. Kartu data ditambahkan otomatis. Kapitalisasi normal, tanpa tanda strip panjang (—) atau double dash (--).`;

/**
 * @param {{chat:{jid:string,isGrup:boolean,grupNama?:string}, dumps:object[], pesan:{id:string,nama:string,jam:string,teks:string,baru:boolean,replyKe?:string}[]}} p
 * Mengembalikan balasan hanya kalau ada data yang benar-benar diperbarui; selain itu bot diam.
 */
async function jalankanDiskusi({ chat, dumps, pesan }) {
  const ctx = {
    chat,
    pengirim: { jid: '', nama: null },
    isOwner: false,
    konten: { teks: '', lampiran: [], pesanIds: pesan.map((x) => x.id) },
    adaTool: false,
    entriBaru: [],
    entriDiubah: [],
    entriLanjut: [],
    filesUntukDikirim: [],
  };

  const blokDump = dumps
    .map((e) =>
      [
        `${dump.formatId(e.id)} (${e.jenis}: ${e.judul || 'tanpa judul'})`,
        `Data saat ini: ${potong(JSON.stringify(e.data || {}), 3000)}`,
        `Pertanyaan terbuka:\n${dump.daftarKonfirmasi(e.data).map((x, i) => `${i + 1}. ${x}`).join('\n')}`,
        `Cuplikan teks asli: ${potong(e.teks_asli || '', 600)}`,
      ].join('\n'),
    )
    .join('\n\n');

  const barisPesan = pesan.map((x) => `[${x.jam} ${x.nama}${x.replyKe ? ` ↪ ${x.replyKe}` : ''}]${x.baru ? ' (baru)' : ''}: ${potong(x.teks, 500)}`);
  const messages = [
    { role: 'system', content: `${PROMPT_DISKUSI}\n\nSekarang: ${formatWaktu()} (WIB).` },
    {
      role: 'user',
      content: `DATA DENGAN PERTANYAAN TERBUKA:\n${blokDump}\n\nOBROLAN GRUP TERBARU (urut waktu; yang bertanda "(baru)" belum pernah kamu periksa):\n${barisPesan.join('\n')}`,
    },
  ];

  const toolsDiskusi = TOOLS.filter((t) => t.function.name === 'ubah_data');
  const { jawabanFinal, error, kartu } = await loopTool(messages, ctx, toolsDiskusi, 4);

  const ringkasPesanBaru = `[Obrolan grup]\n${barisPesan.filter((x) => x.includes('(baru)')).join('\n')}`;

  // Tanpa perubahan data bot diam, kecuali model menilai obrolan sudah menuju kesimpulan tapi masih ambigu: bertanya
  if (!ctx.entriDiubah.length) {
    const tanya = /^\s*TANYA:\s*([\s\S]+)/i.exec((jawabanFinal || '').trim());
    if (tanya?.[1].trim()) {
      return { balasan: tanya[1].trim(), tanya: true, error, entriDiubah: [], teksUser: ringkasPesanBaru };
    }
    return { balasan: null, tanya: false, error, entriDiubah: [], teksUser: null };
  }

  const semuaKartu = kartu.map((k) => k.kartu);
  let balasan = (jawabanFinal || '').replace(/\[DIAM\]/gi, '').trim();
  const idHilang = ctx.entriDiubah.some((id) => !balasan.includes(dump.formatId(id)));
  if (semuaKartu.length && (idHilang || !balasan)) {
    balasan = semuaKartu.join('\n\n') + (balasan ? `\n\n${balasan}` : '');
  }

  return { balasan: balasan || null, tanya: false, error, entriDiubah: ctx.entriDiubah, teksUser: ringkasPesanBaru };
}

module.exports = { jalankanAgent, jalankanDiskusi };
