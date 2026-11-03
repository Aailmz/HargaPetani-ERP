const WARNA_HIJAU = '#92D050';
const WARNA_ORANYE = '#F4B183';

const BASE_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; }
  body { background: #ffffff; padding: 16px; width: fit-content; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #000; padding: 6px 10px; font-size: 14px; }
  th { font-weight: bold; text-align: center; }
  .judul { font-size: 22px; font-weight: bold; padding: 6px 0; }
  .bar-hijau { background: ${WARNA_HIJAU}; font-size: 18px; font-weight: bold; padding: 8px 10px; margin-bottom: 8px; }
  .label-kategori { font-size: 17px; font-weight: bold; padding: 4px 0; }
  .total-row td { font-weight: bold; text-align: right; }
  .baris-oranye td { background: ${WARNA_ORANYE}; }
`;

function templateDO({ outletNama, tanggalDisplay, items }) {
  const rows = items.map((i) => `
    <tr>
      <td style="text-align:left">${i.barang_nama.toUpperCase()}</td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:center">${i.uom || ''}</td>
    </tr>
  `).join('');

  return `
    <html><head><style>${BASE_STYLE}</style></head><body>
      <div class="judul">${outletNama.toUpperCase()}</div>
      <div class="bar-hijau">${tanggalDisplay}</div>
      <table>
        <tr><th>NAMA BARANG</th><th>QTY</th><th>UOM</th></tr>
        ${rows}
      </table>
    </body></html>
  `;
}

function templateInvoice({ outletNama, tanggalDisplay, items, total }) {
  const rows = items.map((i) => `
    <tr>
      <td style="text-align:left">${i.barang_nama.toUpperCase()}</td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:center">${i.uom || ''}</td>
      <td style="text-align:right">${i.harga_satuan.toLocaleString('id-ID')}</td>
      <td style="text-align:right">${i.subtotal.toLocaleString('id-ID')}</td>
    </tr>
  `).join('');

  return `
    <html><head><style>${BASE_STYLE}</style></head><body>
      <div class="judul">INVOICE - ${outletNama.toUpperCase()}</div>
      <div class="bar-hijau">${tanggalDisplay}</div>
      <table>
        <tr><th>NAMA BARANG</th><th>QTY</th><th>UOM</th><th>HARGA SATUAN</th><th>SUBTOTAL</th></tr>
        ${rows}
        <tr class="total-row"><td colspan="4">TOTAL</td><td style="text-align:right">${total.toLocaleString('id-ID')}</td></tr>
      </table>
    </body></html>
  `;
}

function templatePO({ tanggalDisplay, labelKategori, supplierNama, grupBarang }) {
  // grupBarang: Map<namaBarang, [{kode, qty, uom}]>
  let rows = '';
  let grupKe = 0;
  for (const [namaBarang, baris] of grupBarang.entries()) {
    const kelas = grupKe % 2 === 1 ? 'baris-oranye' : '';
    for (const b of baris) {
      rows += `
        <tr class="${kelas}">
          <td style="text-align:left">SSB ${b.kode}</td>
          <td style="text-align:left">${namaBarang.toUpperCase()}</td>
          <td style="text-align:center">${b.qty}</td>
          <td style="text-align:center">${b.uom || ''}</td>
        </tr>
      `;
    }
    grupKe++;
  }

  return `
    <html><head><style>${BASE_STYLE}</style></head><body>
      <div class="bar-hijau">${tanggalDisplay}</div>
      ${labelKategori ? `<div class="label-kategori">${labelKategori.toUpperCase()}</div>` : ''}
      <div class="label-kategori">PO ${supplierNama.toUpperCase()}</div>
      <table>
        <tr><th>KODE</th><th>NAMA BARANG</th><th>QTY</th><th>UOM</th></tr>
        ${rows}
      </table>
    </body></html>
  `;
}

module.exports = { templateDO, templateInvoice, templatePO };