const OpenAI = require('openai');
const db = require('./db');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 5;

// ========== TOOLS — EMPLOYEE ==========

const TOOLS_EMPLOYEE = [
    {
    type: 'function',
    function: {
      name: 'ajukan_reimburse',
      description: 'Catat pengajuan reimburse dan teruskan ke operator untuk di-approve/reject. HANYA panggil ini kalau nominal (angka pasti) dan peruntukan (jelas buat apa) SUDAH LENGKAP dari percakapan. Kalau salah satu belum jelas, tanya dulu, jangan panggil tool ini.',
      parameters: {
        type: 'object',
        properties: {
          nominal: {
            type: 'integer',
            description: 'Nominal reimburse dalam Rupiah, angka murni (contoh: 50000, bukan "50rb" atau string).',
          },
          peruntukan: {
            type: 'string',
            description: 'Keterangan singkat buat apa reimburse ini, dirapikan (contoh: "Bensin antar pesanan", bukan kalimat mentah apa adanya).',
          },
        },
        required: ['nominal', 'peruntukan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_status_reimburse_saya',
      description: 'Lihat status reimburse yang pernah diajukan employee ini (pending/approved/rejected). Dipakai kalau employee nanya soal reimburse yang sudah diajukan sebelumnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_status_absen_saya',
      description: 'Cek apakah employee ini sudah check-in/absen hari ini atau belum, beserta jam berapa kalau sudah.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const TOOLS_OPERATOR = [
  {
    type: 'function',
    function: {
      name: 'lihat_reimburse_pending',
      description: 'Lihat daftar reimburse yang masih menunggu approval. Dipakai kalau operator tanya ada reimburse apa aja yang pending.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_reimburse',
      description: 'Setujui sebuah reimburse. Dipakai kalau operator bilang oke/approve/acc untuk reimburse tertentu.',
      parameters: {
        type: 'object',
        properties: {
          reimburse_id: {
            type: 'integer',
            description: 'ID reimburse yang mau di-approve. Ambil dari konteks chat (nomor yang disebut, atau reimburse yang baru dibahas).',
          },
        },
        required: ['reimburse_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_reimburse',
      description: 'Tolak sebuah reimburse. Dipakai kalau operator bilang tolak/reject untuk reimburse tertentu.',
      parameters: {
        type: 'object',
        properties: {
          reimburse_id: {
            type: 'integer',
            description: 'ID reimburse yang mau ditolak.',
          },
          alasan: {
            type: 'string',
            description: 'Alasan penolakan, untuk disampaikan ke karyawan.',
          },
        },
        required: ['reimburse_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_semua_employee',
      description: 'Lihat daftar semua karyawan yang terdaftar beserta posisinya. Dipakai kalau operator tanya ada karyawan siapa aja.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cari_employee',
      description: 'Cari karyawan berdasarkan nama atau posisi. Dipakai kalau operator sebut nama karyawan tapi tidak ada nomor WA-nya di konteks.',
      parameters: {
        type: 'object',
        properties: {
          kata_kunci: {
            type: 'string',
            description: 'Kata kunci pencarian, nama atau posisi karyawan.',
          },
        },
        required: ['kata_kunci'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_histori_chat_employee',
      description: 'Lihat histori chat seorang karyawan dengan bot. Dipakai kalau operator mau tau apa yang sudah dibahas karyawan tertentu.',
      parameters: {
        type: 'object',
        properties: {
          nomor: {
            type: 'string',
            description: 'Nomor WA karyawan, format angka saja.',
          },
        },
        required: ['nomor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lengkapi_kwitansi',
      description: 'Lengkapi data kwitansi yang baru diupload (foto sudah masuk, tapi nominal/peruntukan belum jelas). HANYA panggil ini kalau ada kwitansi yang sedang menunggu kelengkapan data DAN kedua info (nominal + peruntukan) sudah bisa dipastikan dari pesan employee sekarang.',
      parameters: {
        type: 'object',
        properties: {
          nominal: {
            type: 'integer',
            description: 'Nominal di kwitansi, angka murni.',
          },
          peruntukan: {
            type: 'string',
            description: 'Keterangan singkat kwitansi ini buat apa, dirapikan.',
          },
        },
        required: ['nominal', 'peruntukan'],
      },
    },
  },
];

const SYSTEM_PROMPT_OPERATOR = `Kamu adalah asisten kerja buat operator ERP internal "Harga Petani". Operator ini rekan kerja yang kamu bantu urus approval reimburse & data karyawan.

Gaya bicaramu:
- Langsung, efisien, seperti asisten yang paham kerjaan, bukan formal kaku.
- Boleh santai/informal khas chat kerja sehari-hari.

CARA KERJA:
- Operator bisa minta apapun soal approval reimburse, lihat data karyawan, cek histori chat karyawan tertentu.
- Kalau operator sebut "yang tadi"/"reimburse barusan" tanpa nomor jelas, cari dari histori chat reimburse mana yang dimaksud. Kalau ambigu, tanya balik, jangan asal nebak.
- Kalau operator sebut nama karyawan tapi bukan nomor, panggil cari_employee dulu sebelum tool lain yang butuh nomor.
- Setelah tool jalan, sampaikan hasilnya natural, bukan data mentah.

ATURAN PENULISAN:
- Kapitalisasi normal, bukan Title Case tiap kata.
- Jangan sebut dirimu "AI"/"bot"/"sistem".
- Jawaban singkat, maksimal 2-4 kalimat kecuali perlu daftar (pakai format angka 1. 2. 3., bukan bullet/strip).
- Jangan pakai tanda strip panjang (—) atau double dash (--).`;

const SYSTEM_PROMPT_EMPLOYEE = `Kamu adalah asisten internal "Harga Petani" buat bantu karyawan (driver, marketing, dll) urus hal operasional sehari-hari: reimburse, check-in, lapor foto bukti jalan/kwitansi.

Gaya bicaramu:
- Santai, natural, seperti rekan kerja ngobrol di WA, bukan robot yang jawab template.
- Jangan sebut dirimu "AI"/"bot"/"sistem".
- Boleh nanggepin basa-basi/update kerjaan karyawan dengan natural, TANPA harus selalu ngasih instruksi/panduan balik kalau tidak relevan/tidak diminta.

CARA KERJA REIMBURSE (PENTING, DATA HARUS LENGKAP):
- Reimburse WAJIB ada 2 data pasti: nominal (angka jelas dalam Rupiah) dan peruntukan (jelas buat apa).
- Kalau karyawan baru kasih salah satu, atau nominalnya nggak jelas (misal "sekitar 50rb-an"), TANYAKAN yang kurang/minta kepastian angka dulu. JANGAN panggil tool ajukan_reimburse sebelum dua-duanya pasti.
- Convert semua bentuk nominal ("goceng", "50rb", "lima puluh ribu") ke angka murni Rupiah.
- Kalau ambigu (koreksi vs pengajuan baru, atau jelas bercanda), tanya SATU pertanyaan simpel buat klarifikasi.
- Begitu dua data lengkap dan pasti, langsung panggil tool ajukan_reimburse, jangan tanya ulang konfirmasi.
- Kalau karyawan batal SEBELUM tool dipanggil, konfirmasi oke dibatalkan, tidak perlu panggil tool.

CARA KERJA KWITANSI YANG BELUM LENGKAP:
- Kalau ada notice "KWITANSI MENUNGGU KELENGKAPAN" di konteks, itu artinya karyawan baru upload foto kwitansi tapi nominal/peruntukannya belum jelas dari caption. Pesan karyawan SEKARANG kemungkinan adalah jawaban susulan buat melengkapi itu.
- Begitu nominal dan peruntukan kwitansi itu jelas dari pesan karyawan, panggil tool lengkapi_kwitansi.
- Kalau masih belum jelas, tanya lagi sampai pasti.

CARA KERJA LAIN:
- Kalau karyawan tanya status reimburse, panggil cek_status_reimburse_saya.
- Kalau karyawan tanya status absen hari ini, panggil cek_status_absen_saya.
- Kalau karyawan cuma nanya cara pakai, jawab langsung: check-in = share location, lapor foto = kirim foto + keterangan jelas (nominal+peruntukan) di caption, reimburse = chat aja sebutkan keperluan + nominal.
- Kalau cuma chat biasa/update kerjaan/basa-basi yang tidak butuh aksi, balas natural secukupnya.

ATURAN PENULISAN:
- Kapitalisasi normal, bukan Title Case tiap kata.
- Jawaban singkat natural, 1-3 kalimat.
- Jangan pakai tanda strip panjang (—) atau double dash (--).`;

async function jalankanAgent({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;

  while (iterasi < MAX_TOOL_ITERATIONS) {
    iterasi++;

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.5,
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      return { jawabanFinal: null, error: err.message };
    }

    const pesanAi = completion.choices[0].message;
    messages.push(pesanAi);

    if (!pesanAi.tool_calls || pesanAi.tool_calls.length === 0) {
      return { jawabanFinal: pesanAi.content, error: null };
    }

    for (const toolCall of pesanAi.tool_calls) {
      const namaFungsi = toolCall.function.name;
      let argumen;
      try {
        argumen = JSON.parse(toolCall.function.arguments);
      } catch {
        argumen = {};
      }

      console.log(`🔧 Agent manggil tool: ${namaFungsi}(${JSON.stringify(argumen)})`);

      let hasilTool;
      try {
        const fungsiEksekutor = eksekutorTools[namaFungsi];
        hasilTool = fungsiEksekutor
          ? await fungsiEksekutor(argumen, konteks)
          : { error: `Tool ${namaFungsi} tidak dikenali.` };
      } catch (err) {
        console.error(`❌ Error eksekusi tool ${namaFungsi}:`, err.message);
        hasilTool = { error: `Gagal eksekusi: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(hasilTool),
      });
    }
  }

  console.log('⚠️  Agent mencapai batas iterasi maksimal.');
  return { jawabanFinal: 'Maaf, ada kendala teknis. Boleh diulang permintaannya?', error: 'MAX_ITERATIONS' };
}

// ========== EKSEKUTOR — EMPLOYEE ==========

async function eksekusiAjukanReimburse({ nominal, peruntukan }, konteks) {
  const { db: dbModule, appendRow, formatWaktu } = konteks;
  const employee = dbModule.getEmployee(konteks.jid);
  const waktu = formatWaktu();

  const reimburseId = dbModule.buatReimburseBaru(konteks.jid, peruntukan, nominal);

  await konteks.kirimPesan(
    process.env.OPERATOR_JID,
    `💰 Reimburse baru\nDari: ${employee.nama} (${konteks.jid.split('@')[0]})\nPeruntukan: ${peruntukan}\nNominal: Rp${nominal.toLocaleString('id-ID')}\n\n[reimburse #${reimburseId}]`
  );

  try {
    const row = await appendRow('Reimburse', [
      employee.nama, konteks.jid.split('@')[0], waktu, peruntukan, nominal, 'PENDING', ''
    ]);
    dbModule.setSheetsRowReimburse(reimburseId, row);
  } catch (err) {
    console.error('⚠️  Gagal catat Reimburse ke Sheets:', err.message);
  }

  return { sukses: true, reimburse_id: reimburseId, pesan: 'Reimburse berhasil diajukan dan diteruskan ke tim.' };
}

async function eksekusiLengkapiKwitansi({ nominal, peruntukan }, konteks) {
  const { db: dbModule, appendRow, formatWaktu } = konteks;
  const pending = dbModule.getKwitansiPendingAktif(konteks.jid);

  if (!pending) {
    return { sukses: false, pesan: 'Tidak ada kwitansi yang sedang menunggu kelengkapan data.' };
  }

  const employee = dbModule.getEmployee(konteks.jid);
  const waktu = formatWaktu();

  try {
    await appendRow('Kwitansi', [employee.nama, konteks.jid.split('@')[0], waktu, peruntukan, nominal, pending.nama_file]);
  } catch (err) {
    console.error('⚠️  Gagal catat Kwitansi ke Sheets:', err.message);
  }

  dbModule.hapusKwitansiPending(pending.id);

  return { sukses: true, pesan: 'Kwitansi sudah lengkap dan tercatat.' };
}

async function eksekusiCekStatusReimburseSaya(_, konteks) {
  const semua = konteks.db.db.prepare(`
    SELECT * FROM reimburse WHERE employee_jid = ? ORDER BY created_at DESC LIMIT 5
  `).all(konteks.jid);

  if (semua.length === 0) {
    return { sukses: true, jumlah: 0, pesan: 'Belum ada reimburse yang pernah diajukan.' };
  }

  return {
    sukses: true,
    jumlah: semua.length,
    daftar: semua.map((r) => ({
      id: r.id, peruntukan: r.peruntukan, nominal: r.nominal, status: r.status, alasan_reject: r.alasan_reject,
    })),
  };
}

async function eksekusiCekStatusAbsenSaya(_, konteks) {
  const absenHariIni = konteks.db.getAbsensiHariIni(konteks.jid);

  if (absenHariIni.length === 0) {
    return { sukses: true, sudah_absen: false, pesan: 'Belum absen hari ini.' };
  }

  return {
    sukses: true,
    sudah_absen: true,
    jumlah_checkin: absenHariIni.length,
    jam_pertama: absenHariIni[0].created_at_display,
  };
}

const EKSEKUTOR_EMPLOYEE = {
  ajukan_reimburse: eksekusiAjukanReimburse,
  cek_status_reimburse_saya: eksekusiCekStatusReimburseSaya,
  cek_status_absen_saya: eksekusiCekStatusAbsenSaya,
  lengkapi_kwitansi: eksekusiLengkapiKwitansi,
};

async function eksekusiLihatReimbursePending(_, konteks) {
  const pending = konteks.db.getReimbursePendingTerbaru(20);

  if (pending.length === 0) {
    return { sukses: true, jumlah: 0, pesan: 'Tidak ada reimburse yang pending saat ini.' };
  }

  return {
    sukses: true,
    jumlah: pending.length,
    daftar: pending.map((r) => {
      const emp = konteks.db.getEmployee(r.employee_jid);
      return { id: r.id, nama: emp.nama, peruntukan: r.peruntukan, nominal: r.nominal };
    }),
  };
}

async function prosesKeputusanReimburse(reimburseId, statusBaru, alasan, konteks) {
  const reimburse = konteks.db.getReimburseById(reimburseId);

  if (!reimburse) {
    return { sukses: false, pesan: `Reimburse #${reimburseId} tidak ditemukan.` };
  }
  if (reimburse.status !== 'PENDING') {
    return { sukses: false, pesan: `Reimburse #${reimburseId} sudah berstatus ${reimburse.status}, tidak bisa diubah lagi.` };
  }

  konteks.db.setStatusReimburse(reimburseId, statusBaru, alasan || null);
  const waktuUpdate = konteks.formatWaktu();

  if (reimburse.sheets_row) {
    try {
      await konteks.updateCell('Reimburse', reimburse.sheets_row, 'F', statusBaru);
      await konteks.updateCell('Reimburse', reimburse.sheets_row, 'G', waktuUpdate);
    } catch (err) {
      console.error('⚠️  Gagal update status Reimburse ke Sheets:', err.message);
    }
  }

  const employee = konteks.db.getEmployee(reimburse.employee_jid);
  const pesanNotif = statusBaru === 'APPROVED'
    ? `Reimburse kamu udah di-ACC ya 👍\n${reimburse.peruntukan}: Rp${reimburse.nominal.toLocaleString('id-ID')}`
    : `Reimburse kamu ditolak${alasan ? `: ${alasan}` : ''}.\n${reimburse.peruntukan}: Rp${reimburse.nominal.toLocaleString('id-ID')}`;

  await konteks.kirimPesan(reimburse.employee_jid, pesanNotif);

  return { sukses: true, reimburse_id: reimburseId, nama: employee.nama, status: statusBaru };
}

async function eksekusiApproveReimburse({ reimburse_id }, konteks) {
  return prosesKeputusanReimburse(reimburse_id, 'APPROVED', null, konteks);
}

async function eksekusiRejectReimburse({ reimburse_id, alasan }, konteks) {
  return prosesKeputusanReimburse(reimburse_id, 'REJECTED', alasan, konteks);
}

async function eksekusiLihatSemuaEmployee(_, konteks) {
  const semua = konteks.db.getAllEmployees();
  return {
    sukses: true,
    jumlah: semua.length,
    daftar: semua.map((e) => ({ nama: e.nama, posisi: e.posisi, nomor: e.jid.split('@')[0] })),
  };
}

async function eksekusiCariEmployee({ kata_kunci }, konteks) {
  const pola = `%${kata_kunci}%`;
  const hasil = konteks.db.db.prepare(`
    SELECT * FROM employees WHERE is_registered = 1 AND (nama LIKE ? OR posisi LIKE ?) LIMIT 10
  `).all(pola, pola);

  if (hasil.length === 0) {
    return { sukses: false, pesan: `Tidak ada karyawan yang cocok dengan "${kata_kunci}".` };
  }

  return {
    sukses: true,
    jumlah: hasil.length,
    daftar: hasil.map((e) => ({ nama: e.nama, posisi: e.posisi, nomor: e.jid.split('@')[0] })),
  };
}

async function eksekusiLihatHistoriChatEmployee({ nomor }, konteks) {
  const jid = `${nomor.replace(/\D/g, '')}@s.whatsapp.net`;
  const employee = konteks.db.getEmployee(jid);
  const histori = konteks.db.getChatHistory(jid);

  if (histori.length === 0) {
    return { sukses: true, jumlah: 0, pesan: `Belum ada histori chat untuk ${employee.nama || nomor}.` };
  }

  return {
    sukses: true,
    nama: employee.nama,
    histori: histori.map((h) => `[${h.role === 'user' ? 'karyawan' : 'bot'}] ${h.content}`),
  };
}

const EKSEKUTOR_OPERATOR = {
  lihat_reimburse_pending: eksekusiLihatReimbursePending,
  approve_reimburse: eksekusiApproveReimburse,
  reject_reimburse: eksekusiRejectReimburse,
  lihat_semua_employee: eksekusiLihatSemuaEmployee,
  cari_employee: eksekusiCariEmployee,
  lihat_histori_chat_employee: eksekusiLihatHistoriChatEmployee,
};

module.exports = {
  TOOLS_EMPLOYEE,
  SYSTEM_PROMPT_EMPLOYEE,
  EKSEKUTOR_EMPLOYEE,
  TOOLS_OPERATOR,
  SYSTEM_PROMPT_OPERATOR,
  EKSEKUTOR_OPERATOR,
  jalankanAgent,
};