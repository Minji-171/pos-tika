/**
 * POS TIKA - Business Management Modules (Dashboard, Items, Categories, Modifiers, Discounts, Taxes,
 * Inventory, Employees, Permissions, Customers, Devices, P2P Sync, Integrations, Settings, Backup, Help)
 * Pemilik: TIKA | Bahasa: Indonesia | Mata Uang: IDR | Zona Waktu: Asia/Jakarta
 */

const posModules = {
  /* ========================================================================
     1. DASHBOARD VIEW
     ======================================================================== */
  renderDashboardView(app) {
    const m = app.reports.computeMetrics();
    const products = app.db.getCollection('products');
    const lowStockItems = products.filter(
      (p) => p.track_stock !== false && Number(p.stock || 0) <= Number(p.min_stock || 0)
    );
    const recentTx = app.db.getCollection('transactions').slice(-8).reverse();
    const openTickets = app.db.getCollection('open_tickets');
    const syncState = app.sync.getStatusSummary();

    return `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Omzet (Bulan Ini)</div>
          <div class="kpi-value">${app.formatIDR(m.totalRevenue)}</div>
          <div class="kpi-sub">Penjualan Bersih: ${app.formatIDR(m.netSales)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Estimasi Keuntungan Kotor</div>
          <div class="kpi-value" style="color:var(--primary-dark)">${app.formatIDR(m.grossProfit)}</div>
          <div class="kpi-sub">Total HPP: ${app.formatIDR(m.totalCogs)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Transaksi & Tiket</div>
          <div class="kpi-value">${m.txCount} Transaksi</div>
          <div class="kpi-sub">Tiket Terbuka Aktif: ${openTickets.length}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Status Sinkronisasi P2P</div>
          <div class="kpi-value" style="font-size:16px;color:${syncState.online ? 'var(--primary-dark)' : 'var(--warning)'}">
            ${syncState.online ? 'ONLINE (P2P + Relay)' : 'OFFLINE (DB Lokal)'}
          </div>
          <div class="kpi-sub">Perangkat Terdeteksi: ${syncState.discoveredPeers + 1} unit</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;">
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Transaksi Terbaru</h3>
            <button class="btn btn-sm btn-secondary" onclick="window.posApp.navigate('reports');window.posApp.reports.setTab('receipts')">Lihat Semua</button>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>No. Struk</th>
                  <th>Waktu</th>
                  <th>Metode</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${
                  recentTx.length === 0
                    ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Belum ada transaksi</td></tr>`
                    : recentTx
                        .map(
                          (t) => `
                  <tr style="cursor:pointer;" onclick="window.posApp.showReceiptModal('${t.id}')">
                    <td><strong>${app.escapeHtml(t.receipt_number)}</strong></td>
                    <td>${app.formatDateTime(t.created_at)}</td>
                    <td>${app.escapeHtml(t.payment_method)}</td>
                    <td><strong>${app.formatIDR(t.total)}</strong></td>
                    <td>
                      <span class="badge ${t.status === 'VOIDED' ? 'badge-danger' : t.type === 'REFUND' ? 'badge-warning' : 'badge-success'}">
                        ${t.status === 'VOIDED' ? 'VOID' : t.type === 'REFUND' ? 'REFUND' : 'LUNAS'}
                      </span>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">⚠️ Peringatan Stok Rendah (${lowStockItems.length})</h3>
            <button class="btn btn-sm btn-primary" onclick="window.posApp.navigate('inventory')">Kelola Stok</button>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Nama Barang</th>
                  <th>SKU</th>
                  <th>Stok Tersisa</th>
                  <th>Stok Minimum</th>
                </tr>
              </thead>
              <tbody>
                ${
                  lowStockItems.length === 0
                    ? `<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">Semua stok barang dalam kondisi aman ✅</td></tr>`
                    : lowStockItems
                        .map(
                          (p) => `
                  <tr>
                    <td><strong>${app.escapeHtml(p.name)}</strong></td>
                    <td>${app.escapeHtml(p.sku || '-')}</td>
                    <td><span class="badge badge-danger">${p.stock} ${app.escapeHtml(p.unit || 'pcs')}</span></td>
                    <td>${p.min_stock} ${app.escapeHtml(p.unit || 'pcs')}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  /* ========================================================================
     2. ITEMS / PRODUCTS MANAGEMENT + CSV/EXCEL IMPORT & EXPORT
     ======================================================================== */
  renderItemsView(app) {
    const products = app.db.getCollection('products');
    const categoriesMap = {};
    app.db.getCollection('categories').forEach((c) => {
      categoriesMap[c.id] = c.name;
    });

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Daftar Barang (${products.length} Produk)</h3>
            <p style="font-size:12px;color:var(--text-muted)">Kelola harga beli, harga jual, SKU, barcode, foto, modifier, pajak, dan stok barang.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" onclick="window.posModules.printAllProductBarcodes()">🏷️ Cetak Label Barcode</button>
            <button class="btn btn-secondary" onclick="window.posModules.exportProductsCSV()">📥 Export CSV/Excel</button>
            <label class="btn btn-secondary" style="cursor:pointer;">
              📤 Import CSV/Excel
              <input type="file" accept=".csv" style="display:none" onchange="window.posModules.importProductsCSV(event)" />
            </label>
            <button class="btn btn-primary" onclick="window.posModules.openProductModal()">+ Tambah Barang</button>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Barang</th>
                <th>Kategori</th>
                <th>SKU / Barcode</th>
                <th>Harga Beli</th>
                <th>Harga Jual</th>
                <th>Stok</th>
                <th>Stok Min</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${products
                .map((p) => {
                  const isLow = p.track_stock !== false && Number(p.stock || 0) <= Number(p.min_stock || 0);
                  return `
                  <tr>
                    <td>
                      <div style="display:flex;align-items:center;gap:10px;">
                        <div style="width:34px;height:34px;border-radius:8px;background:${p.color || '#10b981'};background-image:${p.image ? `url('${p.image}')` : 'none'};background-size:cover;flex-shrink:0;"></div>
                        <div>
                          <strong>${app.escapeHtml(p.name)}</strong>
                          ${p.sold_by_weight ? `<span class="badge badge-info" style="margin-left:4px;">Timbangan (${app.escapeHtml(p.unit || 'kg')})</span>` : ''}
                        </div>
                      </div>
                    </td>
                    <td>${app.escapeHtml(categoriesMap[p.category_id] || 'Umum')}</td>
                    <td>${app.escapeHtml(p.sku || '-')} / <span style="color:var(--text-muted)">${app.escapeHtml(p.barcode || '-')}</span></td>
                    <td>${app.formatIDR(p.cost)}</td>
                    <td><strong>${app.formatIDR(p.price)}</strong></td>
                    <td>
                      <span class="badge ${isLow ? 'badge-danger' : 'badge-success'}">
                        ${p.track_stock !== false ? `${p.stock} ${app.escapeHtml(p.unit || 'pcs')}` : 'Tidak Dilacak'}
                      </span>
                    </td>
                    <td>${p.min_stock || 0}</td>
                    <td style="display:flex;gap:6px;">
                      <button class="btn btn-sm btn-secondary" onclick="window.posModules.openProductModal('${p.id}')">Edit</button>
                      <button class="btn btn-sm btn-danger" onclick="window.posModules.deleteProduct('${p.id}')">Hapus</button>
                    </td>
                  </tr>
                `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openProductModal(productId = null) {
    const app = window.posApp;
    const p = productId
      ? app.db.getById('products', productId)
      : {
          id: '',
          name: '',
          category_id: app.db.getCollection('categories')[0]?.id || '',
          sku: `SKU-${Math.floor(100 + Math.random() * 900)}`,
          barcode: `899100${Math.floor(1000000 + Math.random() * 8999999)}`,
          cost: 10000,
          price: 20000,
          unit: 'pcs',
          stock: 20,
          min_stock: 5,
          track_stock: true,
          sold_by_weight: false,
          color: '#10b981',
          image: '',
          modifier_ids: [],
          tax_ids: ['tax_pb1']
        };

    const categories = app.db.getCollection('categories');
    const modifiers = app.db.getCollection('modifiers');
    const taxes = app.db.getCollection('taxes');
    this._tempProductImage = p.image || '';

    app.openModal(
      productId ? `Edit Barang: ${app.escapeHtml(p.name)}` : 'Tambah Barang Baru',
      `
        <div class="form-grid">
          <div class="form-group">
            <label>Nama Barang *</label>
            <input type="text" id="prd-name" class="form-control" value="${app.escapeHtml(p.name)}" />
          </div>
          <div class="form-group">
            <label>Kategori</label>
            <select id="prd-category" class="form-control">
              ${categories.map((c) => `<option value="${c.id}" ${p.category_id === c.id ? 'selected' : ''}>${app.escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Harga Beli / Modal HPP (Rp)</label>
            <input type="number" id="prd-cost" class="form-control" value="${p.cost || 0}" />
          </div>
          <div class="form-group">
            <label>Harga Jual (Rp) *</label>
            <input type="number" id="prd-price" class="form-control" value="${p.price || 0}" />
          </div>
          <div class="form-group">
            <label>SKU (Kode Barang)</label>
            <input type="text" id="prd-sku" class="form-control" value="${app.escapeHtml(p.sku || '')}" />
          </div>
          <div class="form-group">
            <label>Barcode (EAN-13 / Kode Timbangan 5 Digit)</label>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" id="prd-barcode" class="form-control" value="${app.escapeHtml(p.barcode || '')}"
                oninput="const el=document.getElementById('prd-barcode-preview'); if(el) el.innerHTML=window.posApp.renderBarcodeSVG(this.value, 28);" />
              <label class="btn btn-sm btn-secondary" style="cursor:pointer;white-space:nowrap;margin:0;" title="Scan Barcode dari Foto/Kamera">
                📷 Scan
                <input type="file" accept="image/*" capture="environment" style="display:none;"
                  onchange="window.posApp._barcodeTargetInputId='prd-barcode'; window.posApp.scanBarcodeFromImageFile(event)" />
              </label>
            </div>
            <div id="prd-barcode-preview" style="margin-top:6px;">${app.renderBarcodeSVG(p.barcode || p.sku || '8991001000011', 28)}</div>
          </div>
          <div class="form-group">
            <label>Satuan (pcs, cup, porsi, kg, liter)</label>
            <input type="text" id="prd-unit" class="form-control" value="${app.escapeHtml(p.unit || 'pcs')}" />
          </div>
          <div class="form-group">
            <label>Warna Kartu / Foto Produk</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="color" id="prd-color" value="${p.color || '#10b981'}" style="height:38px;width:54px;border:1px solid var(--border);border-radius:6px;" />
              <input type="file" accept="image/*" class="form-control" onchange="window.posModules.handleProductImageUpload(event)" />
            </div>
          </div>
          <div class="form-group">
            <label>Stok Tersedia Saat Ini</label>
            <input type="number" id="prd-stock" class="form-control" value="${p.stock || 0}" step="0.01" />
          </div>
          <div class="form-group">
            <label>Stok Minimum (Batas Peringatan)</label>
            <input type="number" id="prd-min-stock" class="form-control" value="${p.min_stock || 0}" step="0.01" />
          </div>
        </div>

        <div style="display:flex;gap:20px;margin:10px 0;">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="prd-track-stock" ${p.track_stock !== false ? 'checked' : ''} /> Lacak Stok Otomatis
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="prd-by-weight" ${p.sold_by_weight ? 'checked' : ''} /> Dijual Berdasarkan Berat / Timbangan (Kg)
          </label>
        </div>

        <div class="form-group">
          <label>Modifier Produk yang Berlaku</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;">
            ${modifiers
              .map(
                (m) => `
              <label style="display:flex;align-items:center;gap:6px;">
                <input type="checkbox" class="prd-mod-cb" value="${m.id}" ${(p.modifier_ids || []).includes(m.id) ? 'checked' : ''} />
                ${app.escapeHtml(m.name)}
              </label>
            `
              )
              .join('')}
          </div>
        </div>

        <div class="form-group">
          <label>Pajak Barang</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;">
            ${taxes
              .map(
                (t) => `
              <label style="display:flex;align-items:center;gap:6px;">
                <input type="checkbox" class="prd-tax-cb" value="${t.id}" ${(p.tax_ids || []).includes(t.id) ? 'checked' : ''} />
                ${app.escapeHtml(t.name)} (${t.rate}%)
              </label>
            `
              )
              .join('')}
          </div>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveProduct('${p.id || ''}')">Simpan Barang</button>
      `,
      true
    );
  },

  handleProductImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this._tempProductImage = e.target.result;
      window.posApp.toast('Foto produk siap disimpan');
    };
    reader.readAsDataURL(file);
  },

  async saveProduct(existingId) {
    const app = window.posApp;
    const name = (document.getElementById('prd-name')?.value || '').trim();
    if (!name) {
      app.toast('Nama barang wajib diisi!', 'error');
      return;
    }
    const modIds = Array.from(document.querySelectorAll('.prd-mod-cb:checked')).map((c) => c.value);
    const taxIds = Array.from(document.querySelectorAll('.prd-tax-cb:checked')).map((c) => c.value);

    const payload = {
      id: existingId || `prd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      category_id: document.getElementById('prd-category')?.value || '',
      cost: Number(document.getElementById('prd-cost')?.value || 0),
      price: Number(document.getElementById('prd-price')?.value || 0),
      sku: (document.getElementById('prd-sku')?.value || '').trim(),
      barcode: (document.getElementById('prd-barcode')?.value || '').trim(),
      unit: (document.getElementById('prd-unit')?.value || 'pcs').trim(),
      color: document.getElementById('prd-color')?.value || '#10b981',
      image: this._tempProductImage || '',
      stock: Number(document.getElementById('prd-stock')?.value || 0),
      min_stock: Number(document.getElementById('prd-min-stock')?.value || 0),
      track_stock: Boolean(document.getElementById('prd-track-stock')?.checked),
      sold_by_weight: Boolean(document.getElementById('prd-by-weight')?.checked),
      modifier_ids: modIds,
      tax_ids: taxIds
    };

    await app.db.upsert('products', payload);
    await app.db.logActivity(app.currentUser, 'SAVE_PRODUCT', `Menyimpan barang ${payload.name}`);
    app.closeModal();
    app.toast(`Barang "${payload.name}" berhasil disimpan`);
    app.render();
  },

  async deleteProduct(productId) {
    const app = window.posApp;
    const p = app.db.getById('products', productId);
    if (!p) return;
    await app.db.delete('products', productId);
    await app.db.logActivity(app.currentUser, 'DELETE_PRODUCT', `Menghapus barang ${p.name}`);
    app.toast(`Barang "${p.name}" telah dihapus`);
    app.render();
  },

  printAllProductBarcodes() {
    const app = window.posApp;
    const products = app.db.getCollection('products');
    const printMount = document.getElementById('print-mount');
    if (!printMount) return;
    printMount.innerHTML = `
      <div style="padding:12px;font-family:sans-serif;">
        <h3 style="text-align:center;margin-bottom:12px;">LABEL BARCODE PRODUK - POS TIKA</h3>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
          ${products
            .map(
              (p) => `
            <div style="border:1px dashed #334155;border-radius:6px;padding:8px;text-align:center;background:#fff;">
              <div style="font-weight:800;font-size:12px;margin-bottom:2px;">${app.escapeHtml(p.name)}</div>
              <div style="font-size:11px;font-weight:700;color:#059669;margin-bottom:4px;">${app.formatIDR(p.price)}</div>
              ${app.renderBarcodeSVG(p.barcode || p.sku, 34)}
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;
    window.print();
  },

  exportProductsCSV() {
    const app = window.posApp;
    const products = app.db.getCollection('products');
    const headers = ['id', 'name', 'category_id', 'sku', 'barcode', 'cost', 'price', 'unit', 'stock', 'min_stock', 'sold_by_weight'];
    const lines = [headers.join(',')];
    for (const p of products) {
      const row = headers.map((h) => {
        const val = p[h] !== undefined && p[h] !== null ? String(p[h]) : '';
        return `"${val.replace(/"/g, '""')}"`;
      });
      lines.push(row.join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Daftar_Barang_POS_TIKA_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    app.toast('Daftar barang berhasil diekspor ke CSV/Excel');
  },

  importProductsCSV(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const app = window.posApp;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result || '';
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        app.toast('File CSV kosong atau tidak valid', 'error');
        return;
      }
      const parseCSVRow = (line) => {
        const res = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (ch === ',' && !inQuotes) {
            res.push(cur.trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        res.push(cur.trim());
        return res;
      };

      const headers = parseCSVRow(lines[0].replace(/^\uFEFF/, '')).map((h) => h.toLowerCase());
      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVRow(lines[i]);
        const obj = {};
        headers.forEach((h, idx) => {
          obj[h] = cols[idx] || '';
        });
        if (!obj.name) continue;
        await app.db.upsert('products', {
          id: obj.id || `prd_imp_${Date.now()}_${i}`,
          name: obj.name,
          category_id: obj.category_id || 'cat_minuman',
          sku: obj.sku || `SKU-${i}`,
          barcode: obj.barcode || '',
          cost: Number(obj.cost || 0),
          price: Number(obj.price || 0),
          unit: obj.unit || 'pcs',
          stock: Number(obj.stock || 0),
          min_stock: Number(obj.min_stock || 5),
          track_stock: true,
          sold_by_weight: obj.sold_by_weight === 'true',
          color: '#10b981',
          modifier_ids: [],
          tax_ids: ['tax_pb1']
        });
        imported++;
      }
      app.toast(`Berhasil mengimpor ${imported} barang dari CSV!`);
      app.render();
    };
    reader.readAsText(file);
  },

  /* ========================================================================
     3. CATEGORIES VIEW
     ======================================================================== */
  renderCategoriesView(app) {
    const categories = app.db.getCollection('categories');
    const products = app.db.getCollection('products');
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Kategori Produk (${categories.length})</h3>
          <button class="btn btn-primary" onclick="window.posModules.openCategoryModal()">+ Tambah Kategori</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Warna</th>
                <th>Nama Kategori</th>
                <th>Jumlah Barang</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${categories
                .map((c) => {
                  const count = products.filter((p) => p.category_id === c.id).length;
                  return `
                  <tr>
                    <td><span style="display:inline-block;width:24px;height:24px;border-radius:6px;background:${c.color || '#10b981'}"></span></td>
                    <td><strong>${app.escapeHtml(c.name)}</strong></td>
                    <td>${count} barang</td>
                    <td style="display:flex;gap:6px;">
                      <button class="btn btn-sm btn-secondary" onclick="window.posModules.openCategoryModal('${c.id}')">Edit</button>
                      <button class="btn btn-sm btn-danger" onclick="window.posModules.deleteCategory('${c.id}')">Hapus</button>
                    </td>
                  </tr>
                `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openCategoryModal(catId = null) {
    const app = window.posApp;
    const c = catId ? app.db.getById('categories', catId) : { id: '', name: '', color: '#10b981' };
    app.openModal(
      catId ? 'Edit Kategori' : 'Tambah Kategori Baru',
      `
        <div class="form-group">
          <label>Nama Kategori *</label>
          <input type="text" id="cat-name" class="form-control" value="${app.escapeHtml(c.name)}" />
        </div>
        <div class="form-group">
          <label>Warna Label</label>
          <input type="color" id="cat-color" class="form-control" value="${c.color || '#10b981'}" style="height:42px;" />
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveCategory('${c.id || ''}')">Simpan</button>
      `
    );
  },

  async saveCategory(id) {
    const app = window.posApp;
    const name = (document.getElementById('cat-name')?.value || '').trim();
    if (!name) return app.toast('Nama kategori wajib diisi', 'error');
    const color = document.getElementById('cat-color')?.value || '#10b981';
    await app.db.upsert('categories', {
      id: id || `cat_${Date.now()}`,
      name,
      color
    });
    app.closeModal();
    app.toast('Kategori berhasil disimpan');
    app.render();
  },

  async deleteCategory(id) {
    await window.posApp.db.delete('categories', id);
    window.posApp.toast('Kategori dihapus');
    window.posApp.render();
  },

  /* ========================================================================
     4. MODIFIERS VIEW
     ======================================================================== */
  renderModifiersView(app) {
    const modifiers = app.db.getCollection('modifiers');
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Modifier Produk (${modifiers.length})</h3>
          <button class="btn btn-primary" onclick="window.posModules.openModifierModal()">+ Tambah Grup Modifier</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Grup Modifier</th>
                <th>Pilihan Opsi & Harga Tambahan</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${modifiers
                .map(
                  (m) => `
                <tr>
                  <td><strong>${app.escapeHtml(m.name)}</strong></td>
                  <td>
                    ${(m.options || [])
                      .map((o) => `<span class="badge badge-info" style="margin-right:6px;">${app.escapeHtml(o.name)} (+${app.formatIDR(o.price)})</span>`)
                      .join('')}
                  </td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openModifierModal('${m.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="window.posModules.deleteModifier('${m.id}')">Hapus</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openModifierModal(modId = null) {
    const app = window.posApp;
    const m = modId
      ? app.db.getById('modifiers', modId)
      : { id: '', name: '', options: [{ id: 'opt_1', name: 'Opsi 1', price: 0 }, { id: 'opt_2', name: 'Opsi 2', price: 5000 }] };

    const linesText = (m.options || []).map((o) => `${o.name}:${o.price}`).join('\n');
    app.openModal(
      modId ? 'Edit Modifier' : 'Tambah Modifier Baru',
      `
        <div class="form-group">
          <label>Nama Grup Modifier (Contoh: Topping Tambahan / Ukuran Cup)</label>
          <input type="text" id="mod-name" class="form-control" value="${app.escapeHtml(m.name)}" />
        </div>
        <div class="form-group">
          <label>Daftar Opsi (Satu baris per opsi dengan format <code>Nama Opsi:Harga</code>)</label>
          <textarea id="mod-options-text" class="form-control" rows="5">${app.escapeHtml(linesText)}</textarea>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveModifier('${m.id || ''}')">Simpan Modifier</button>
      `
    );
  },

  async saveModifier(id) {
    const app = window.posApp;
    const name = (document.getElementById('mod-name')?.value || '').trim();
    const rawLines = (document.getElementById('mod-options-text')?.value || '').split(/\r?\n/).filter((l) => l.trim());
    if (!name) return app.toast('Nama modifier wajib diisi', 'error');
    const options = rawLines.map((line, idx) => {
      const parts = line.split(':');
      const optName = (parts[0] || `Opsi ${idx + 1}`).trim();
      const optPrice = Number((parts[1] || '0').trim()) || 0;
      return { id: `opt_${Date.now()}_${idx}`, name: optName, price: optPrice };
    });
    await app.db.upsert('modifiers', {
      id: id || `mod_${Date.now()}`,
      name,
      options
    });
    app.closeModal();
    app.toast('Modifier berhasil disimpan');
    app.render();
  },

  async deleteModifier(id) {
    await window.posApp.db.delete('modifiers', id);
    window.posApp.toast('Modifier dihapus');
    window.posApp.render();
  },

  /* ========================================================================
     5. DISCOUNTS VIEW
     ======================================================================== */
  renderDiscountsView(app) {
    const discounts = app.db.getCollection('discounts');
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Manajemen Diskon (${discounts.length})</h3>
          <button class="btn btn-primary" onclick="window.posModules.openDiscountModal()">+ Tambah Diskon</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Diskon</th>
                <th>Tipe</th>
                <th>Nilai Potongan</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${discounts
                .map(
                  (d) => `
                <tr>
                  <td><strong>${app.escapeHtml(d.name)}</strong></td>
                  <td>${d.type === 'PERCENTAGE' ? 'Persentase (%)' : 'Nominal Rupiah (Rp)'}</td>
                  <td><strong>${d.type === 'PERCENTAGE' ? `${d.value}%` : app.formatIDR(d.value)}</strong></td>
                  <td><span class="badge ${d.active !== false ? 'badge-success' : 'badge-danger'}">${d.active !== false ? 'Aktif' : 'Nonaktif'}</span></td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openDiscountModal('${d.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="window.posModules.deleteDiscount('${d.id}')">Hapus</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openDiscountModal(discId = null) {
    const app = window.posApp;
    const d = discId ? app.db.getById('discounts', discId) : { id: '', name: '', type: 'PERCENTAGE', value: 10, active: true };
    app.openModal(
      discId ? 'Edit Diskon' : 'Tambah Diskon Baru',
      `
        <div class="form-group">
          <label>Nama Program Diskon *</label>
          <input type="text" id="disc-name" class="form-control" value="${app.escapeHtml(d.name)}" />
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Jenis Diskon</label>
            <select id="disc-type" class="form-control">
              <option value="PERCENTAGE" ${d.type === 'PERCENTAGE' ? 'selected' : ''}>Persentase (%)</option>
              <option value="FIXED" ${d.type === 'FIXED' ? 'selected' : ''}>Potongan Nominal (Rp)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Nilai Diskon</label>
            <input type="number" id="disc-value" class="form-control" value="${d.value || 0}" />
          </div>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveDiscount('${d.id || ''}')">Simpan Diskon</button>
      `
    );
  },

  async saveDiscount(id) {
    const app = window.posApp;
    const name = (document.getElementById('disc-name')?.value || '').trim();
    if (!name) return app.toast('Nama diskon wajib diisi', 'error');
    const type = document.getElementById('disc-type')?.value || 'PERCENTAGE';
    const value = Number(document.getElementById('disc-value')?.value || 0);
    await app.db.upsert('discounts', { id: id || `disc_${Date.now()}`, name, type, value, active: true });
    app.closeModal();
    app.toast('Diskon berhasil disimpan');
    app.render();
  },

  async deleteDiscount(id) {
    await window.posApp.db.delete('discounts', id);
    window.posApp.toast('Diskon dihapus');
    window.posApp.render();
  },

  /* ========================================================================
     6. TAXES VIEW
     ======================================================================== */
  renderTaxesView(app) {
    const taxes = app.db.getCollection('taxes');
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Pengaturan Pajak Barang (${taxes.length})</h3>
          <button class="btn btn-primary" onclick="window.posModules.openTaxModal()">+ Tambah Pajak</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Pajak</th>
                <th>Tarif (%)</th>
                <th>Metode Perhitungan</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${taxes
                .map(
                  (t) => `
                <tr>
                  <td><strong>${app.escapeHtml(t.name)}</strong></td>
                  <td><strong>${t.rate}%</strong></td>
                  <td>${t.type === 'INCLUDED' ? 'Sudah Termasuk dalam Harga Barang (Inclusive)' : 'Ditambahkan ke Harga Barang (Exclusive)'}</td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openTaxModal('${t.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="window.posModules.deleteTax('${t.id}')">Hapus</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openTaxModal(taxId = null) {
    const app = window.posApp;
    const t = taxId ? app.db.getById('taxes', taxId) : { id: '', name: '', rate: 10, type: 'ADDED', active: true };
    app.openModal(
      taxId ? 'Edit Pajak' : 'Tambah Pajak Baru',
      `
        <div class="form-group">
          <label>Nama Pajak (Contoh: PB1 Restoran 10% / PPN 11%)</label>
          <input type="text" id="tax-name" class="form-control" value="${app.escapeHtml(t.name)}" />
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Tarif Pajak (%)</label>
            <input type="number" id="tax-rate" class="form-control" value="${t.rate}" step="0.1" />
          </div>
          <div class="form-group">
            <label>Tipe Pajak</label>
            <select id="tax-type" class="form-control">
              <option value="ADDED" ${t.type === 'ADDED' ? 'selected' : ''}>Ditambahkan ke Harga (Exclusive)</option>
              <option value="INCLUDED" ${t.type === 'INCLUDED' ? 'selected' : ''}>Termasuk dalam Harga (Inclusive)</option>
            </select>
          </div>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveTax('${t.id || ''}')">Simpan Pajak</button>
      `
    );
  },

  async saveTax(id) {
    const app = window.posApp;
    const name = (document.getElementById('tax-name')?.value || '').trim();
    if (!name) return app.toast('Nama pajak wajib diisi', 'error');
    const rate = Number(document.getElementById('tax-rate')?.value || 0);
    const type = document.getElementById('tax-type')?.value || 'ADDED';
    await app.db.upsert('taxes', { id: id || `tax_${Date.now()}`, name, rate, type, active: true });
    app.closeModal();
    app.toast('Pajak berhasil disimpan');
    app.render();
  },

  async deleteTax(id) {
    await window.posApp.db.delete('taxes', id);
    window.posApp.toast('Pajak dihapus');
    window.posApp.render();
  },

  /* ========================================================================
     7. INVENTORY & STOCK MOVEMENTS (BARANG MASUK, KELUAR, OPNAME, RUSAK)
     ======================================================================== */
  renderInventoryView(app) {
    const movements = app.db.getCollection('stock_movements').slice().reverse();
    const filtered = app.invFilterReason === 'ALL'
      ? movements
      : movements.filter((m) => m.reason === app.invFilterReason);

    const reasonLabels = {
      RESTOCK: { label: 'Barang Masuk (Restock)', cls: 'badge-success' },
      STOCK_OUT: { label: 'Barang Keluar', cls: 'badge-info' },
      ADJUSTMENT: { label: 'Penyesuaian Stok (Opname)', cls: 'badge-info' },
      DAMAGE: { label: 'Barang Rusak / Waste', cls: 'badge-danger' },
      SALE: { label: 'Penjualan POS', cls: 'badge-success' },
      REFUND: { label: 'Pengembalian (Refund)', cls: 'badge-warning' },
      VOID: { label: 'Pembatalan (Void)', cls: 'badge-warning' }
    };

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Manajemen Inventaris & Mutasi Stok</h3>
            <p style="font-size:12px;color:var(--text-muted)">Catat barang masuk, barang keluar, penyesuaian stok opname, dan barang rusak. Semua tersinkronisasi P2P.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="window.posModules.openStockActionModal('RESTOCK')">📥 + Barang Masuk</button>
            <button class="btn btn-secondary" onclick="window.posModules.openStockActionModal('STOCK_OUT')">📤 Barang Keluar</button>
            <button class="btn btn-secondary" onclick="window.posModules.openStockActionModal('ADJUSTMENT')">⚖️ Penyesuaian Stok</button>
            <button class="btn btn-danger" onclick="window.posModules.openStockActionModal('DAMAGE')">🗑️ Barang Rusak</button>
          </div>
        </div>

        <div class="subtabs">
          ${[
            { id: 'ALL', label: 'Semua Riwayat Stok' },
            { id: 'RESTOCK', label: 'Barang Masuk' },
            { id: 'STOCK_OUT', label: 'Barang Keluar' },
            { id: 'ADJUSTMENT', label: 'Penyesuaian Stok' },
            { id: 'DAMAGE', label: 'Barang Rusak' },
            { id: 'SALE', label: 'Penjualan Kasir' }
          ]
            .map(
              (f) => `
            <button class="subtab-btn ${app.invFilterReason === f.id ? 'active' : ''}"
              onclick="window.posApp.invFilterReason='${f.id}'; window.posApp.renderMainViewOnly()">
              ${f.label}
            </button>
          `
            )
            .join('')}
        </div>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Nama Barang</th>
                <th>Jenis Perubahan</th>
                <th>Stok Awal</th>
                <th>Perubahan</th>
                <th>Stok Akhir</th>
                <th>Karyawan</th>
                <th>Referensi / Catatan</th>
              </tr>
            </thead>
            <tbody>
              ${
                filtered.length === 0
                  ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Belum ada riwayat perubahan stok untuk filter ini</td></tr>`
                  : filtered
                      .map((m) => {
                        const rMeta = reasonLabels[m.reason] || { label: m.reason, cls: 'badge-info' };
                        const sign = Number(m.delta) > 0 ? '+' : '';
                        return `
                        <tr>
                          <td>${app.formatDateTime(m.created_at)}</td>
                          <td><strong>${app.escapeHtml(m.product_name)}</strong></td>
                          <td><span class="badge ${rMeta.cls}">${rMeta.label}</span></td>
                          <td>${m.stock_before ?? '-'}</td>
                          <td style="font-weight:800;color:${m.delta >= 0 ? 'var(--primary-dark)' : 'var(--danger)'}">${sign}${m.delta}</td>
                          <td><strong>${m.stock_after ?? '-'}</strong></td>
                          <td>${app.escapeHtml(m.employee_name || 'TIKA')}</td>
                          <td>${app.escapeHtml(m.notes || m.reference_id || '-')}</td>
                        </tr>
                      `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openStockActionModal(reasonType) {
    const app = window.posApp;
    const products = app.db.getCollection('products');
    const titles = {
      RESTOCK: 'Catat Barang Masuk (Pembelian / Restock)',
      STOCK_OUT: 'Catat Barang Keluar (Non-Penjualan)',
      ADJUSTMENT: 'Penyesuaian Stok (Stock Opname)',
      DAMAGE: 'Catat Barang Rusak / Kedaluwarsa'
    };

    app.openModal(
      titles[reasonType] || 'Mutasi Stok',
      `
        <div class="form-group">
          <label>Pilih Barang *</label>
          <select id="stk-product-id" class="form-control">
            ${products
              .map(
                (p) => `
              <option value="${p.id}">
                ${app.escapeHtml(p.name)} (Stok saat ini: ${p.stock} ${app.escapeHtml(p.unit || 'pcs')})
              </option>
            `
              )
              .join('')}
          </select>
        </div>
        <div class="form-group">
          <label>${reasonType === 'ADJUSTMENT' ? 'Stok Fisik Aktual Hasil Hitung (Opname)' : 'Jumlah Barang'}</label>
          <input type="number" id="stk-qty" class="form-control" value="10" step="0.01" min="0.001" />
        </div>
        <div class="form-group">
          <label>Catatan / Nomor Bukti / Alasan</label>
          <input type="text" id="stk-notes" class="form-control" placeholder="Contoh: Faktur Supplier #INV-092 / Barang pecah" />
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.submitStockAction('${reasonType}')">Simpan Perubahan Stok</button>
      `
    );
  },

  async submitStockAction(reasonType) {
    const app = window.posApp;
    const productId = document.getElementById('stk-product-id')?.value;
    const qtyInput = Number(document.getElementById('stk-qty')?.value || 0);
    const notes = (document.getElementById('stk-notes')?.value || '').trim();
    const product = app.db.getById('products', productId);
    if (!product) return;

    let delta = 0;
    if (reasonType === 'RESTOCK') {
      delta = Math.abs(qtyInput);
    } else if (reasonType === 'STOCK_OUT' || reasonType === 'DAMAGE') {
      delta = -Math.abs(qtyInput);
    } else if (reasonType === 'ADJUSTMENT') {
      delta = qtyInput - Number(product.stock || 0);
    }

    await app.db.adjustStock({
      product_id: product.id,
      delta,
      reason: reasonType,
      reference_id: `MAN-${Date.now().toString().slice(-5)}`,
      notes: notes || reasonType,
      employee_id: app.currentUser?.id || 'emp_tika',
      employee_name: app.currentUser?.name || 'TIKA'
    });

    await app.db.logActivity(app.currentUser, `STOCK_${reasonType}`, `${product.name} (${delta >= 0 ? '+' : ''}${delta})`);
    app.closeModal();
    app.toast(`Stok ${product.name} berhasil diperbarui!`);
    app.render();
  },

  /* ========================================================================
     8. EMPLOYEES, TIMECARDS (JAM KERJA) & ACTIVITY LOGS
     ======================================================================== */
  renderEmployeesView(app) {
    const employees = app.db.getCollection('employees');
    const timecards = app.db.getCollection('timecards');
    const activities = app.db.getCollection('activity_logs').slice(-25).reverse();

    const activeTimecard = timecards.find(
      (tc) => tc.employee_id === app.currentUser?.id && !tc.clock_out
    );

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Daftar Karyawan & Jam Kerja (${employees.length} Staf)</h3>
            <p style="font-size:12px;color:var(--text-muted)">Pemilik utama: <strong>TIKA</strong> (Owner). Login menggunakan PIN 4 digit.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${
              app.db.getSettings().features?.timecard !== false
                ? activeTimecard
                  ? `<button class="btn btn-warning" onclick="window.posModules.clockOutEmployee()">⏱️ Clock Out Jam Kerja (${app.escapeHtml(app.currentUser.name)})</button>`
                  : `<button class="btn btn-secondary" onclick="window.posModules.clockInEmployee()">⏱️ Clock In Jam Kerja (${app.escapeHtml(app.currentUser.name)})</button>`
                : ''
            }
            <button class="btn btn-primary" onclick="window.posModules.openEmployeeModal()">+ Tambah Karyawan</button>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Karyawan</th>
                <th>Role / Jabatan</th>
                <th>PIN Login</th>
                <th>Telepon / Email</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${employees
                .map(
                  (e) => `
                <tr>
                  <td>
                    <strong>${app.escapeHtml(e.name)}</strong>
                    ${e.is_owner ? `<span class="badge badge-success" style="margin-left:6px;">Pemilik Utama</span>` : ''}
                  </td>
                  <td><span class="badge badge-info">${app.escapeHtml(e.role)}</span></td>
                  <td><code>${app.escapeHtml(e.pin)}</code></td>
                  <td>${app.escapeHtml(e.phone || '-')} / ${app.escapeHtml(e.email || '-')}</td>
                  <td><span class="badge ${e.active !== false ? 'badge-success' : 'badge-danger'}">${e.active !== false ? 'Aktif' : 'Nonaktif'}</span></td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openEmployeeModal('${e.id}')">Edit</button>
                    ${
                      !e.is_owner
                        ? `<button class="btn btn-sm btn-danger" onclick="window.posModules.deleteEmployee('${e.id}')">Hapus</button>`
                        : ''
                    }
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Riwayat Aktivitas Karyawan Terbaru</h3>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Karyawan</th>
                <th>Role</th>
                <th>Aktivitas</th>
                <th>Detail</th>
                <th>Perangkat</th>
              </tr>
            </thead>
            <tbody>
              ${
                activities.length === 0
                  ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Belum ada riwayat aktivitas</td></tr>`
                  : activities
                      .map(
                        (a) => `
                  <tr>
                    <td>${app.formatDateTime(a.created_at)}</td>
                    <td><strong>${app.escapeHtml(a.employee_name)}</strong></td>
                    <td>${app.escapeHtml(a.role)}</td>
                    <td><span class="badge badge-info">${app.escapeHtml(a.action)}</span></td>
                    <td>${app.escapeHtml(a.details)}</td>
                    <td>${app.escapeHtml(a.device_name || a.device_id)}</td>
                  </tr>
                `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openEmployeeModal(empId = null) {
    const app = window.posApp;
    const e = empId
      ? app.db.getById('employees', empId)
      : { id: '', name: '', role: 'Cashier', role_id: 'role_cashier', pin: '', phone: '', email: '', active: true, is_owner: false };

    const roles = app.db.getCollection('roles');
    app.openModal(
      empId ? `Edit Karyawan: ${app.escapeHtml(e.name)}` : 'Tambah Karyawan Baru',
      `
        <div class="form-grid">
          <div class="form-group">
            <label>Nama Lengkap *</label>
            <input type="text" id="emp-name" class="form-control" value="${app.escapeHtml(e.name)}" ${e.is_owner ? 'readonly' : ''} />
          </div>
          <div class="form-group">
            <label>Role / Jabatan</label>
            <select id="emp-role-id" class="form-control" ${e.is_owner ? 'disabled' : ''}>
              ${roles.map((r) => `<option value="${r.id}" ${e.role_id === r.id ? 'selected' : ''}>${app.escapeHtml(r.name)} (${app.escapeHtml(r.label || '')})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>PIN Login (4 Digit Angka) *</label>
            <input type="text" id="emp-pin" class="form-control" maxlength="6" value="${app.escapeHtml(e.pin)}" placeholder="Contoh: 4444" />
          </div>
          <div class="form-group">
            <label>Nomor Telepon</label>
            <input type="text" id="emp-phone" class="form-control" value="${app.escapeHtml(e.phone || '')}" />
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="emp-email" class="form-control" value="${app.escapeHtml(e.email || '')}" />
          </div>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveEmployee('${e.id || ''}', ${Boolean(e.is_owner)})">Simpan Karyawan</button>
      `
    );
  },

  async saveEmployee(id, isOwner) {
    const app = window.posApp;
    const name = (document.getElementById('emp-name')?.value || '').trim();
    const roleId = isOwner ? 'role_owner' : document.getElementById('emp-role-id')?.value || 'role_cashier';
    const roleObj = app.db.getById('roles', roleId);
    const pin = (document.getElementById('emp-pin')?.value || '').trim();
    const phone = (document.getElementById('emp-phone')?.value || '').trim();
    const email = (document.getElementById('emp-email')?.value || '').trim();

    if (!name || !pin) return app.toast('Nama dan PIN karyawan wajib diisi!', 'error');

    await app.db.upsert('employees', {
      id: id || `emp_${Date.now()}`,
      name,
      role_id: roleId,
      role: roleObj ? roleObj.name : 'Cashier',
      pin,
      phone,
      email,
      active: true,
      is_owner: isOwner
    });
    app.closeModal();
    app.toast('Data karyawan berhasil disimpan');
    app.render();
  },

  async deleteEmployee(id) {
    const app = window.posApp;
    const e = app.db.getById('employees', id);
    if (e && e.is_owner) return app.toast('Akun pemilik utama TIKA tidak dapat dihapus!', 'error');
    await app.db.delete('employees', id);
    app.toast('Karyawan dihapus');
    app.render();
  },

  async clockInEmployee() {
    const app = window.posApp;
    const now = app.db.nowJakartaISO();
    await app.db.upsert('timecards', {
      id: `tc_${Date.now()}`,
      employee_id: app.currentUser.id,
      employee_name: app.currentUser.name,
      role: app.currentUser.role,
      clock_in: now,
      clock_out: null,
      duration_minutes: 0,
      duration_label: 'Sedang Bekerja',
      notes: 'Hadir tepat waktu'
    });
    await app.db.logActivity(app.currentUser, 'CLOCK_IN', `Mencatat jam masuk kerja`);
    app.toast(`Clock In berhasil dicatat untuk ${app.currentUser.name}`);
    app.render();
  },

  async clockOutEmployee() {
    const app = window.posApp;
    const timecards = app.db.getCollection('timecards');
    const active = timecards.find((tc) => tc.employee_id === app.currentUser.id && !tc.clock_out);
    if (!active) return;
    const now = app.db.nowJakartaISO();
    const diffMs = Math.max(0, new Date(now).getTime() - new Date(active.clock_in).getTime());
    const mins = Math.max(1, Math.round(diffMs / 60000));
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    active.clock_out = now;
    active.duration_minutes = mins;
    active.duration_label = `${hrs} jam ${remMins} menit`;
    await app.db.upsert('timecards', active);
    await app.db.logActivity(app.currentUser, 'CLOCK_OUT', `Mencatat jam pulang kerja (${active.duration_label})`);
    app.toast(`Clock Out berhasil dicatat (${active.duration_label})`);
    app.render();
  },

  /* ========================================================================
     9. PERMISSIONS / HAK AKSES MATRIX VIEW
     ======================================================================== */
  renderPermissionsView(app) {
    const roles = app.db.getCollection('roles');
    const permList = [
      { key: 'pos_access', label: 'Akses Halaman Kasir (POS)' },
      { key: 'edit_price', label: 'Mengubah Harga Barang di Keranjang Kasir' },
      { key: 'apply_discount', label: 'Memberikan Diskon Transaksi' },
      { key: 'void_refund', label: 'Pembatalan Transaksi (Void) & Pengembalian Barang (Refund)' },
      { key: 'manage_open_tickets', label: 'Mengelola Tiket Terbuka (Open Tickets)' },
      { key: 'view_reports', label: 'Melihat Dashboard & Laporan Keuangan' },
      { key: 'manage_items', label: 'Mengelola Barang, Kategori, Modifier, Diskon & Pajak' },
      { key: 'manage_inventory', label: 'Mengelola Inventaris & Penyesuaian Stok' },
      { key: 'manage_employees', label: 'Mengelola Karyawan & Hak Akses' },
      { key: 'manage_customers', label: 'Mengelola Data Pelanggan' },
      { key: 'manage_devices', label: 'Mengelola Perangkat Terhubung' },
      { key: 'manage_settings', label: 'Mengubah Pengaturan Aplikasi' },
      { key: 'manage_backup', label: 'Backup & Restore Database Bisnis' }
    ];

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Matriks Hak Akses Role (Owner, Admin, Manager, Cashier, Kitchen Staff)</h3>
            <p style="font-size:12px;color:var(--text-muted)">Akun pemilik utama bernama <strong>TIKA</strong> (Owner) selalu memiliki akses penuh.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Hak Akses Fitur</th>
                ${roles.map((r) => `<th style="text-align:center;">${app.escapeHtml(r.name)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${permList
                .map(
                  (p) => `
                <tr>
                  <td><strong>${p.label}</strong></td>
                  ${roles
                    .map((r) => {
                      const isOwner = r.name === 'Owner' || r.id === 'role_owner';
                      const checked = isOwner || (r.permissions && r.permissions[p.key]);
                      return `
                      <td style="text-align:center;">
                        <input type="checkbox" style="width:18px;height:18px;cursor:pointer;"
                          ${checked ? 'checked' : ''}
                          ${isOwner ? 'disabled' : ''}
                          onchange="window.posModules.toggleRolePermission('${r.id}', '${p.key}', this.checked)" />
                      </td>
                    `;
                    })
                    .join('')}
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async toggleRolePermission(roleId, permKey, checked) {
    const app = window.posApp;
    const role = app.db.getById('roles', roleId);
    if (!role || role.name === 'Owner') return;
    if (!role.permissions) role.permissions = {};
    role.permissions[permKey] = Boolean(checked);
    await app.db.upsert('roles', role);
    app.toast(`Hak akses ${role.name} diperbarui`);
  },

  /* ========================================================================
     10. CUSTOMERS MANAGEMENT & PURCHASE HISTORY
     ======================================================================== */
  renderCustomersView(app) {
    const customers = app.db.getCollection('customers');
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Manajemen Pelanggan (${customers.length})</h3>
          <button class="btn btn-primary" onclick="window.posModules.openCustomerModal()">+ Tambah Pelanggan</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Pelanggan</th>
                <th>No. Telepon</th>
                <th>Alamat</th>
                <th>Catatan Pelanggan</th>
                <th>Total Transaksi</th>
                <th>Total Belanja</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${customers
                .map(
                  (c) => `
                <tr>
                  <td><strong>${app.escapeHtml(c.name)}</strong></td>
                  <td>${app.escapeHtml(c.phone || '-')}</td>
                  <td>${app.escapeHtml(c.address || '-')}</td>
                  <td>${app.escapeHtml(c.notes || '-')}</td>
                  <td>${c.total_transactions || 0}x</td>
                  <td><strong>${app.formatIDR(c.total_spent || 0)}</strong></td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openCustomerHistoryModal('${c.id}')">Riwayat Beli</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.posModules.openCustomerModal('${c.id}')">Edit</button>
                    ${c.id !== 'cust_umum' ? `<button class="btn btn-sm btn-danger" onclick="window.posModules.deleteCustomer('${c.id}')">Hapus</button>` : ''}
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openCustomerModal(custId = null) {
    const app = window.posApp;
    const c = custId
      ? app.db.getById('customers', custId)
      : { id: '', name: '', phone: '', email: '', address: '', notes: '', total_transactions: 0, total_spent: 0 };

    app.openModal(
      custId ? `Edit Pelanggan: ${app.escapeHtml(c.name)}` : 'Tambah Pelanggan Baru',
      `
        <div class="form-grid">
          <div class="form-group">
            <label>Nama Pelanggan *</label>
            <input type="text" id="cust-name" class="form-control" value="${app.escapeHtml(c.name)}" />
          </div>
          <div class="form-group">
            <label>Nomor Telepon</label>
            <input type="text" id="cust-phone" class="form-control" value="${app.escapeHtml(c.phone || '')}" />
          </div>
        </div>
        <div class="form-group">
          <label>Alamat Lengkap</label>
          <input type="text" id="cust-address" class="form-control" value="${app.escapeHtml(c.address || '')}" />
        </div>
        <div class="form-group">
          <label>Catatan Pelanggan (Preferensi Pesanan / Member)</label>
          <textarea id="cust-notes" class="form-control" rows="2">${app.escapeHtml(c.notes || '')}</textarea>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveCustomer('${c.id || ''}')">Simpan Pelanggan</button>
      `
    );
  },

  async saveCustomer(id) {
    const app = window.posApp;
    const name = (document.getElementById('cust-name')?.value || '').trim();
    if (!name) return app.toast('Nama pelanggan wajib diisi', 'error');
    const existing = id ? app.db.getById('customers', id) : null;
    const newCust = {
      id: id || `cust_${Date.now()}`,
      name,
      phone: (document.getElementById('cust-phone')?.value || '').trim(),
      address: (document.getElementById('cust-address')?.value || '').trim(),
      notes: (document.getElementById('cust-notes')?.value || '').trim(),
      total_transactions: existing ? existing.total_transactions : 0,
      total_spent: existing ? existing.total_spent : 0
    };
    await app.db.upsert('customers', newCust);
    app.cartCustomerId = newCust.id;
    app.closeModal();
    app.toast(`Pelanggan "${name}" berhasil disimpan`);
    app.render();
  },

  async deleteCustomer(id) {
    await window.posApp.db.delete('customers', id);
    window.posApp.toast('Data pelanggan dihapus');
    window.posApp.render();
  },

  openCustomerHistoryModal(custId) {
    const app = window.posApp;
    const c = app.db.getById('customers', custId);
    if (!c) return;
    const txs = app.db
      .getCollection('transactions')
      .filter((t) => t.customer_id === custId)
      .reverse();

    app.openModal(
      `Riwayat Pembelian Pelanggan: ${app.escapeHtml(c.name)}`,
      `
        <div style="margin-bottom:12px;display:flex;gap:16px;">
          <span>Total Transaksi: <strong>${txs.length}</strong></span>
          <span>Total Belanja: <strong>${app.formatIDR(c.total_spent || 0)}</strong></span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>No. Struk</th>
                <th>Tanggal</th>
                <th>Barang Dibeli</th>
                <th>Metode Bayar</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${
                txs.length === 0
                  ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Belum ada riwayat pembelian untuk pelanggan ini</td></tr>`
                  : txs
                      .map(
                        (t) => `
                  <tr style="cursor:pointer;" onclick="window.posApp.showReceiptModal('${t.id}')">
                    <td><strong>${app.escapeHtml(t.receipt_number)}</strong></td>
                    <td>${app.formatDateTime(t.created_at)}</td>
                    <td>${(t.items || []).map((i) => `${i.qty}x ${app.escapeHtml(i.name)}`).join(', ')}</td>
                    <td>${app.escapeHtml(t.payment_method)}</td>
                    <td><strong>${app.formatIDR(t.total)}</strong></td>
                  </tr>
                `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      `,
      `<button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup</button>`,
      true
    );
  },

  /* ========================================================================
     11. DEVICE MANAGEMENT & QR PAIRING (TERMASUK BEDA JARINGAN / INTERNET)
     ======================================================================== */
  renderDevicesView(app) {
    const devices = app.db.getCollection('devices');
    const settings = app.db.getSettings();
    const st = app.sync.getStatusSummary();
    const mergedPeers = app.sync.getMergedActivePeers();
    const activePeerIds = new Set(mergedPeers.map((p) => p.device_id));
    activePeerIds.add(app.db.deviceId);

    const pubUrl = st.tunnelUrl || app.sync.relayUrl || '';
    const lanUrl = (st.lanUrls && st.lanUrls[0]) || window.location.origin;

    return `
      <div class="card" style="border:2px solid var(--primary);background:#f0fdf4;">
        <div class="card-header" style="margin-bottom:8px;">
          <div>
            <h3 class="card-title" style="color:var(--primary-darker);">🌐 Akses Semua Perangkat (Walaupun Berbeda Jaringan / 4G / 5G / Wi-Fi Lain)</h3>
            <p style="font-size:12.5px;color:#065f46;">
              Gunakan <strong>Link Publik Internet (HTTPS)</strong> di bawah ini untuk membuka POS TIKA dari HP/Tablet/Laptop di jaringan mana pun,
              atau hubungkan via <strong>Cloud P2P Lintas Jaringan</strong> dengan ID Bisnis <code>${app.escapeHtml(settings.business_id || 'BIZ-POSTIKA-01')}</code>.
            </p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${
              pubUrl
                ? `<button class="btn btn-sm btn-secondary" onclick="navigator.clipboard?.writeText('${app.escapeHtml(pubUrl)}'); window.posApp.toast('Link Publik disalin!')">📋 Salin Link Publik</button>`
                : `<button class="btn btn-sm btn-primary" onclick="window.posModules.activatePublicTunnel()">🚀 Aktifkan Link Publik Internet</button>`
            }
            <button class="btn btn-sm btn-primary" onclick="window.posModules.openAddDeviceModal()">📱 QR Code Pairing Perangkat</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;">
          <div style="background:#fff;padding:12px;border-radius:10px;border:1px solid #bbf7d0;">
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);">1. LINK INTERNET PUBLIK (BEDA JARINGAN / 4G / LUAR KOTA)</div>
            <div style="font-size:13.5px;font-weight:800;color:var(--primary-dark);margin:4px 0;word-break:break-all;">
              ${
                pubUrl
                  ? `<a href="${app.escapeHtml(pubUrl)}" target="_blank" style="color:var(--primary-dark);">${app.escapeHtml(pubUrl)}</a>`
                  : st.tunnelStatus === 'starting'
                  ? '⏳ Sedang menyiapkan Link Publik HTTPS...'
                  : 'Klik "🚀 Aktifkan Link Publik Internet" di atas'
              }
            </div>
            <div style="font-size:11px;color:var(--text-muted);">Bisa dibuka dari HP/Tablet menggunakan paket data seluler (4G/5G) & kamera barcode langsung aktif (HTTPS).</div>
          </div>

          <div style="background:#fff;padding:12px;border-radius:10px;border:1px solid #bbf7d0;">
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);">2. CLOUD P2P LINTAS JARINGAN (TANPA PORT FORWARDING)</div>
            <div style="font-size:13.5px;font-weight:800;color:${st.cloudConnected ? '#059669' : '#d97706'};margin:4px 0;">
              ${st.cloudConnected ? '✅ TERHUBUNG (Cloud P2P Broker Aktif)' : '🔄 Menghubungkan ke Cloud P2P...'}
            </div>
            <div style="font-size:11px;color:var(--text-muted);">
              ID Bisnis: <code>${app.escapeHtml(settings.business_id || 'BIZ-POSTIKA-01')}</code> • Key: <code>${app.escapeHtml(settings.pairing_key || 'TIKA-SYNC-2026')}</code>
            </div>
          </div>

          <div style="background:#fff;padding:12px;border-radius:10px;border:1px solid #bbf7d0;">
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);">3. LINK WI-FI LOKAL (SATU JARINGAN WI-FI / HOTSPOT)</div>
            <div style="font-size:13.5px;font-weight:800;color:#0f172a;margin:4px 0;word-break:break-all;">
              ${app.escapeHtml(lanUrl)}
            </div>
            <div style="font-size:11px;color:var(--text-muted);">Gunakan alamat ini jika semua perangkat terhubung ke Wi-Fi / Hotspot HP yang sama.</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Pengelolaan Perangkat Terhubung (${devices.length} Perangkat)</h3>
            <p style="font-size:12px;color:var(--text-muted)">Identitas Bisnis: <strong>${app.escapeHtml(settings.business_id || 'BIZ-POSTIKA-01')}</strong> • Pemilik: <strong>TIKA</strong></p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" onclick="window.posModules.openRenameCurrentDeviceModal()">✏️ Ubah Nama Perangkat Ini</button>
            <button class="btn btn-primary" onclick="window.posModules.openAddDeviceModal()">📱 + Tambah / Hubungkan Perangkat (QR Code)</button>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Perangkat</th>
                <th>ID Perangkat</th>
                <th>Platform</th>
                <th>Status Koneksi</th>
                <th>Sinkronisasi Terakhir</th>
                <th>Hak Akses</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${devices
                .map((d) => {
                  const isCurrent = d.id === app.db.deviceId;
                  const isOnline = d.authorized !== false && (activePeerIds.has(d.id) || d.id === 'DEV-MASTER-PC');
                  return `
                  <tr>
                    <td>
                      <strong>${app.escapeHtml(d.name)}</strong>
                      ${isCurrent ? `<span class="badge badge-info" style="margin-left:6px;">Perangkat Ini</span>` : ''}
                    </td>
                    <td><code>${app.escapeHtml(d.id)}</code></td>
                    <td>${app.escapeHtml(d.platform || 'Browser PWA')}</td>
                    <td>
                      <span class="badge ${isOnline ? 'badge-success' : 'badge-warning'}">
                        ${isOnline ? 'ONLINE' : 'OFFLINE'}
                      </span>
                    </td>
                    <td>${app.formatDateTime(d.last_sync)}</td>
                    <td>
                      <span class="badge ${d.authorized !== false ? 'badge-success' : 'badge-danger'}">
                        ${d.authorized !== false ? 'Diizinkan' : 'Dicabut (Revoked)'}
                      </span>
                    </td>
                    <td style="display:flex;gap:6px;">
                      ${
                        d.authorized !== false
                          ? `<button class="btn btn-sm btn-warning" onclick="window.posModules.disconnectDevice('${d.id}')">Putuskan</button>
                             <button class="btn btn-sm btn-danger" onclick="window.posModules.revokeDevice('${d.id}')">Cabut Akses</button>`
                          : `<button class="btn btn-sm btn-primary" onclick="window.posModules.reauthorizeDevice('${d.id}')">Pulihkan Akses</button>`
                      }
                    </td>
                  </tr>
                `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async activatePublicTunnel() {
    const app = window.posApp;
    app.toast('Menyiapkan Link Publik HTTPS untuk akses beda jaringan...');
    const res = await app.sync.startPublicTunnel();
    if (res && res.public_url) {
      app.toast(`Link Publik Aktif: ${res.public_url}`);
    } else if (res && res.error) {
      app.toast(`Info Tunnel: ${res.error}`, 'error');
    } else {
      app.toast('Tunnel sedang berjalan di latar belakang, tunggu beberapa detik...');
    }
    app.render();
  },

  openRenameCurrentDeviceModal() {
    const app = window.posApp;
    app.openModal(
      'Ubah Nama Perangkat Ini',
      `
        <div class="form-group">
          <label>ID Perangkat</label>
          <input type="text" class="form-control" value="${app.escapeHtml(app.db.deviceId)}" readonly />
        </div>
        <div class="form-group">
          <label>Nama Perangkat (Contoh: Kasir Depan / Tablet Dapur / iPhone TIKA)</label>
          <input type="text" id="cur-dev-name" class="form-control" value="${app.escapeHtml(app.db.deviceName)}" />
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posModules.saveCurrentDeviceName()">Simpan</button>
      `
    );
  },

  async saveCurrentDeviceName() {
    const app = window.posApp;
    const name = (document.getElementById('cur-dev-name')?.value || '').trim();
    if (!name) return;
    app.db.deviceName = name;
    localStorage.setItem('postika_device_name', name);
    const dev = app.db.getById('devices', app.db.deviceId) || { id: app.db.deviceId };
    dev.name = name;
    dev.platform = app.db.detectPlatform();
    dev.last_sync = app.db.nowJakartaISO();
    dev.authorized = true;
    await app.db.upsert('devices', dev);
    app.closeModal();
    app.toast('Nama perangkat diperbarui');
    app.render();
  },

  openAddDeviceModal() {
    const app = window.posApp;
    const settings = app.db.getSettings();
    const st = app.sync.getStatusSummary();
    const baseOrigin = st.tunnelUrl || app.sync.relayUrl || (st.lanUrls && st.lanUrls[0]) || window.location.origin;
    const pairUrl = `${baseOrigin.replace(/\/+$/, '')}/?pair_biz=${encodeURIComponent(settings.business_id || 'BIZ-POSTIKA-01')}&pair_key=${encodeURIComponent(settings.pairing_key || 'TIKA-SYNC-2026')}&pair_relay=${encodeURIComponent(baseOrigin.replace(/\/+$/, ''))}`;

    app.openModal(
      'Hubungkan Perangkat Baru (Satu Wi-Fi maupun Beda Jaringan / 4G)',
      `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;align-items:start;">
          <div style="text-align:center;padding:16px;background:#f8fafc;border:1px solid var(--border);border-radius:12px;">
            <canvas id="device-pairing-qr" width="180" height="180" style="background:#fff;padding:8px;border:1px solid var(--border);border-radius:8px;"></canvas>
            <div style="font-size:12.5px;font-weight:700;margin-top:8px;">Link & QR Pairing Otomatis</div>
            <div style="font-size:11px;color:var(--primary-dark);font-weight:700;word-break:break-all;margin:6px 0;">${app.escapeHtml(pairUrl)}</div>
            <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:8px;">
              <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard?.writeText('${app.escapeHtml(pairUrl)}'); window.posApp.toast('Link Pairing disalin!')">📋 Salin Link Pairing</button>
              ${
                !st.tunnelUrl
                  ? `<button class="btn btn-sm btn-primary" onclick="window.posModules.activatePublicTunnel(); window.posApp.closeModal();">🌐 Buat Link Beda Jaringan</button>`
                  : ''
              }
            </div>
          </div>
          <div>
            <h4 style="margin-bottom:8px;">Daftarkan Perangkat Baru / Gabung Kode Bisnis</h4>
            <div class="form-group">
              <label>Nama Perangkat Baru</label>
              <input type="text" id="new-dev-name" class="form-control" placeholder="Contoh: Tablet Kasir 2 / HP Android TIKA" />
            </div>
            <div class="form-group">
              <label>Platform Perangkat</label>
              <select id="new-dev-platform" class="form-control">
                <option value="Android">Android</option>
                <option value="iPhone / iOS">iPhone / iOS</option>
                <option value="Tablet">Tablet</option>
                <option value="Windows PC">Windows PC</option>
                <option value="Laptop">Laptop</option>
              </select>
            </div>
            <button class="btn btn-primary" onclick="window.posModules.registerManualDevice()">+ Daftarkan Perangkat</button>
          </div>
        </div>
      `,
      `<button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup</button>`,
      true
    );

    setTimeout(() => {
      app.drawQRCodeCanvas('device-pairing-qr', pairUrl);
    }, 30);
  },

  async registerManualDevice() {
    const app = window.posApp;
    const name = (document.getElementById('new-dev-name')?.value || '').trim();
    const platform = document.getElementById('new-dev-platform')?.value || 'Android';
    if (!name) return app.toast('Masukkan nama perangkat baru!', 'error');
    const id = `DEV-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const now = app.db.nowJakartaISO();
    await app.db.upsert('devices', {
      id,
      name,
      platform,
      business_id: app.db.getSettings().business_id || 'BIZ-POSTIKA-01',
      status: 'online',
      authorized: true,
      last_sync: now,
      created_at: now
    });
    app.closeModal();
    app.toast(`Perangkat "${name}" (${id}) berhasil didaftarkan!`);
    app.render();
  },

  async disconnectDevice(devId) {
    const app = window.posApp;
    const d = app.db.getById('devices', devId);
    if (!d) return;
    d.status = 'offline';
    await app.db.upsert('devices', d);
    app.toast(`Koneksi perangkat "${d.name}" diputuskan sementara`);
    app.render();
  },

  async revokeDevice(devId) {
    const app = window.posApp;
    const d = app.db.getById('devices', devId);
    if (!d) return;
    d.authorized = false;
    d.status = 'revoked';
    await app.db.upsert('devices', d);
    await app.db.logActivity(app.currentUser, 'REVOKE_DEVICE', `Mencabut akses perangkat ${d.name} (${d.id})`);
    app.toast(`Akses perangkat "${d.name}" telah dicabut!`, 'error');
    app.render();
  },

  async reauthorizeDevice(devId) {
    const app = window.posApp;
    const d = app.db.getById('devices', devId);
    if (!d) return;
    d.authorized = true;
    d.status = 'online';
    await app.db.upsert('devices', d);
    app.toast(`Akses perangkat "${d.name}" dipulihkan`);
    app.render();
  },

  /* ========================================================================
     12. P2P & RELAY SYNCHRONIZATION VIEW
     ======================================================================== */
  renderSyncView(app) {
    const st = app.sync.getStatusSummary();
    const settings = app.db.getSettings();
    const logs = app.sync.syncHistory || [];

    return `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Status Jaringan & Database</div>
          <div class="kpi-value" style="font-size:17px;color:${st.online ? 'var(--primary-dark)' : 'var(--warning)'}">
            ${st.online ? 'ONLINE (Tersinkronisasi)' : 'OFFLINE (Penyimpanan Lokal)'}
          </div>
          <div class="kpi-sub">Cloud P2P Lintas Jaringan: <strong>${st.cloudConnected ? 'AKTIF ✅' : 'OFFLINE'}</strong></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Koneksi P2P & Perangkat Terdeteksi</div>
          <div class="kpi-value">${st.discoveredPeers} Perangkat Lain</div>
          <div class="kpi-sub">WebRTC DataChannel: ${st.webrtcPeers} terbuka</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Link Publik Internet (Beda Jaringan)</div>
          <div class="kpi-value" style="font-size:13px;word-break:break-all;color:var(--primary-dark)">
            ${st.tunnelUrl ? app.escapeHtml(st.tunnelUrl) : 'Belum Diaktifkan'}
          </div>
          <div class="kpi-sub">
            ${
              st.tunnelUrl
                ? `<button class="btn btn-sm btn-secondary" style="margin-top:4px;" onclick="navigator.clipboard?.writeText('${app.escapeHtml(st.tunnelUrl)}'); window.posApp.toast('Link Publik disalin!')">📋 Salin Link</button>`
                : `<button class="btn btn-sm btn-primary" style="margin-top:4px;" onclick="window.posModules.activatePublicTunnel()">🚀 Aktifkan Link Publik</button>`
            }
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Waktu Sinkronisasi Terakhir</div>
          <div class="kpi-value" style="font-size:15px;">${app.formatDateTime(st.lastSync)}</div>
          <div class="kpi-sub">HLC Clock: <code>${app.escapeHtml((app.db.lastHlc || '').slice(0, 20))}</code></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Kontrol Sinkronisasi Lintas Jaringan (Cloud P2P + WebRTC + Public Tunnel + Relay)</h3>
            <p style="font-size:12px;color:var(--text-muted)">
              Semua perangkat dengan <strong>ID Bisnis</strong> dan <strong>Kunci Pairing</strong> yang sama otomatis tersinkronisasi meskipun menggunakan jaringan Wi-Fi atau paket data seluler (4G/5G) yang berbeda.
            </p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn ${st.simulatedOffline ? 'btn-warning' : 'btn-secondary'}"
              onclick="window.posApp.sync.setSimulatedOffline(${!st.simulatedOffline}); window.posApp.render()">
              ${st.simulatedOffline ? '🔌 Matikan Simulasi Offline (Kembali Online)' : '✈️ Uji Mode Tanpa Internet (Simulasi Offline)'}
            </button>
            <button class="btn btn-primary" onclick="window.posModules.triggerManualSync()">🔄 Sinkronkan Sekarang</button>
          </div>
        </div>

        <div class="form-grid" style="margin-top:10px;">
          <div class="form-group">
            <label>ID Bisnis (Harus Sama di Semua Perangkat)</label>
            <input type="text" id="sync-biz-id" class="form-control" value="${app.escapeHtml(localStorage.getItem('postika_pair_biz') || settings.business_id || 'BIZ-POSTIKA-01')}" />
          </div>
          <div class="form-group">
            <label>Kunci Pairing Rahasia (Pairing Key)</label>
            <input type="text" id="sync-pair-key" class="form-control" value="${app.escapeHtml(localStorage.getItem('postika_pair_key') || settings.pairing_key || 'TIKA-SYNC-2026')}" />
          </div>
          <div class="form-group">
            <label>URL Server / Tunnel Utama (Opsional jika beda jaringan)</label>
            <input type="text" id="sync-relay-url" class="form-control" value="${app.escapeHtml(app.sync.relayUrl)}"
              placeholder="Kosongkan di PC Utama, atau isi https://xxxx.lhr.life di HP" />
          </div>
          <div class="form-group">
            <label>Server STUN / TURN (WebRTC ICE Servers)</label>
            <input type="text" id="sync-stun-url" class="form-control"
              value="${app.escapeHtml(settings.rtc_config?.iceServers?.[0]?.urls || 'stun:stun.l.google.com:19302')}" />
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.posModules.saveSyncConfig()">💾 Simpan & Hubungkan Jaringan P2P</button>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Riwayat Sinkronisasi Antar Perangkat (${logs.length})</h3>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Perangkat</th>
                <th>Metode Sinkronisasi</th>
                <th>Op Diterima</th>
                <th>Op Dikirim</th>
                <th>Status</th>
                <th>Keterangan</th>
              </tr>
            </thead>
            <tbody>
              ${
                logs.length === 0
                  ? `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">Belum ada riwayat sinkronisasi</td></tr>`
                  : logs
                      .map(
                        (l) => `
                  <tr>
                    <td>${app.formatDateTime(l.timestamp)}</td>
                    <td><strong>${app.escapeHtml(l.device_name)}</strong></td>
                    <td><span class="badge badge-info">${app.escapeHtml(l.mode)}</span></td>
                    <td>+${l.ops_received}</td>
                    <td>+${l.ops_sent}</td>
                    <td><span class="badge badge-success">${app.escapeHtml(l.status)}</span></td>
                    <td>${app.escapeHtml(l.details)}</td>
                  </tr>
                `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async triggerManualSync() {
    const app = window.posApp;
    const res = await app.sync.syncNow('Manual-Sync');
    if (res.ok) {
      app.toast(`Sinkronisasi selesai: Terkirim ${res.sent} op, Diterima ${res.received} op`);
    } else if (res.offline) {
      app.toast('Perangkat sedang dalam mode Offline. Data disimpan aman di database lokal.', 'error');
    } else {
      app.toast('Sinkronisasi lokal tercatat', 'success');
    }
    app.render();
  },

  async saveSyncConfig() {
    const app = window.posApp;
    const bizId = (document.getElementById('sync-biz-id')?.value || 'BIZ-POSTIKA-01').trim();
    const pairKey = (document.getElementById('sync-pair-key')?.value || 'TIKA-SYNC-2026').trim();
    const relayUrl = (document.getElementById('sync-relay-url')?.value || '').trim().replace(/\/+$/, '');
    const stunUrl = (document.getElementById('sync-stun-url')?.value || 'stun:stun.l.google.com:19302').trim();

    localStorage.setItem('postika_pair_biz', bizId);
    localStorage.setItem('postika_pair_key', pairKey);
    localStorage.setItem('postika_relay_url', relayUrl);
    app.sync.relayUrl = relayUrl;

    const settings = app.db.getSettings();
    settings.business_id = bizId;
    settings.pairing_key = pairKey;
    settings.rtc_config = {
      iceServers: [{ urls: stunUrl }],
      relay_enabled: true
    };
    await app.db.upsert('settings', settings);

    // Reconnect Cloud P2P Bridge with updated business topic
    if (app.sync.mqttWs) {
      try {
        app.sync.mqttWs.close();
      } catch (_) {}
      app.sync.mqttWs = null;
      app.sync.mqttConnected = false;
    }
    app.sync.connectCloudMqttBridge();
    app.sync.syncNow('Config-Updated');
    app.toast('Konfigurasi P2P Lintas Jaringan berhasil disimpan & dihubungkan!');
    app.render();
  },

  /* ========================================================================
     13. INTEGRATIONS VIEW (PRINTER, BARCODE, CUSTOMER DISPLAY, SCALE)
     ======================================================================== */
  renderIntegrationsView(app) {
    const settings = app.db.getSettings();
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;">
        <div class="card">
          <h3 class="card-title" style="margin-bottom:8px;">🖨️ Printer Struk Thermal & Printer Dapur</h3>
          <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">
            Mendukung printer thermal 58mm & 80mm melalui driver cetak sistem, Bluetooth, atau USB.
          </p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="window.posModules.testThermalPrint()">🖨️ Uji Cetak Struk Kasir</button>
            <button class="btn btn-secondary" onclick="window.posApp.sendToKitchenPrinter({name:'Meja Uji 01', dining_option:'Dine In', items:[{name:'Es Kopi Susu Gula Aren TIKA', qty:2, modifiers:[{name:'Less Sugar'}]}]})">🍳 Uji Cetak Printer Dapur</button>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title" style="margin-bottom:8px;">🖥️ Layar Tampilan Pelanggan (Customer Display)</h3>
          <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">
            Buka layar kedua untuk pelanggan yang menampilkan item keranjang, diskon, pajak, total tagihan, dan QRIS secara real-time.
          </p>
          <a href="/?mode=customer_display" target="_blank" class="btn btn-primary" style="text-decoration:none;">
            🚀 Buka Layar Tampilan Pelanggan (Tab / Monitor Kedua)
          </a>
        </div>

        <div class="card">
          <h3 class="card-title" style="margin-bottom:8px;">⚖️ Weight-Embedded Barcodes (Timbangan Digital)</h3>
          <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">
            Format EAN-13 Prefix <strong>${(settings.weight_barcode_config?.prefixes || ['20']).join(', ')}</strong>:
            <code>20 [5 Digit SKU] [5 Digit Berat Gram] [Check]</code>.
          </p>
          <button class="btn btn-secondary" onclick="window.posApp.openBarcodeScannerModal()">📷 Buka Simulator & Scanner Barcode Timbangan</button>
        </div>
      </div>
    `;
  },

  testThermalPrint() {
    const app = window.posApp;
    const sampleTx = {
      receipt_number: 'TEST-PRINT-001',
      created_at: app.db.nowJakartaISO(),
      employee_name: app.currentUser?.name || 'TIKA',
      customer_name: 'Pelanggan Uji Coba',
      dining_option: 'Dine In',
      items: [{ name: 'Es Kopi Susu Gula Aren TIKA', qty: 1, price: 22000, modifier_total_unit: 0, line_discount: 0, modifiers: [] }],
      subtotal: 22000,
      discount_total: 0,
      taxes_applied: [{ name: 'PB1 (10%)', amount: 2200 }],
      total: 24200,
      payments: [{ method: 'TUNAI', amount: 25000 }],
      change_amount: 800
    };
    const printMount = document.getElementById('print-mount');
    if (printMount) {
      printMount.innerHTML = app.buildReceiptHTML(sampleTx);
      window.print();
    }
  },

  /* ========================================================================
     14. SETTINGS & 9 FEATURE TOGGLES ON/OFF (LOYVERSE STYLE)
     ======================================================================== */
  renderSettingsView(app) {
    const s = app.db.getSettings();
    const f = s.features || {};

    const featureList = [
      { key: 'shift', title: 'Shift', desc: 'Mencatat modal awal, uang masuk dan keluar dari laci kasir, serta rekonsiliasi tutup shift.' },
      { key: 'timecard', title: 'Jam Kerja', desc: 'Mencatat jam masuk (clock in) dan jam keluar (clock out) karyawan beserta durasi kerja.' },
      { key: 'open_tickets', title: 'Tiket Terbuka', desc: 'Menyimpan pesanan yang belum dibayar (open tickets / meja) untuk diselesaikan nanti.' },
      { key: 'kitchen_printer', title: 'Printer Dapur', desc: 'Mengirim dan mencetak pesanan ke printer atau layar dapur.' },
      { key: 'customer_display', title: 'Tampilan Pelanggan', desc: 'Menampilkan rincian pesanan dan QRIS secara langsung kepada pelanggan di layar kedua.' },
      { key: 'dining_options', title: 'Jenis Pesanan', desc: 'Memilih jenis pesanan di kasir: Dine In (Makan di Tempat), Takeaway (Bungkus), dan Delivery.' },
      { key: 'low_stock_alert', title: 'Pemberitahuan Stok Rendah', desc: 'Menampilkan lencana peringatan ketika stok barang mencapai atau di bawah batas stok minimum.' },
      { key: 'negative_stock_warning', title: 'Peringatan Stok Tidak Mencukupi', desc: 'Memberikan peringatan kepada kasir ketika jumlah penjualan melebihi stok yang tersedia.' },
      { key: 'weight_barcodes', title: 'Weight Embedded Barcodes', desc: 'Memindai barcode timbangan digital (EAN-13 prefix 20-29) dengan berat barang otomatis.' }
    ];

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Pengaturan Fitur Aplikasi (ON / OFF)</h3>
            <p style="font-size:12px;color:var(--text-muted)">Semua pengaturan dapat diubah oleh pemilik (<strong>TIKA</strong>) dan langsung diterapkan ke seluruh perangkat.</p>
          </div>
        </div>

        <div>
          ${featureList
            .map(
              (item) => `
            <div class="toggle-row">
              <div class="toggle-info">
                <h4>${item.title}</h4>
                <p>${item.desc}</p>
              </div>
              <label class="switch">
                <input type="checkbox" ${f[item.key] !== false ? 'checked' : ''}
                  onchange="window.posModules.toggleFeatureSetting('${item.key}', this.checked)" />
                <span class="slider"></span>
              </label>
            </div>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Identitas Bisnis & Pengaturan Struk POS TIKA</h3>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Nama Aplikasi</label>
            <input type="text" id="set-app-name" class="form-control" value="${app.escapeHtml(s.app_name || 'POS TIKA')}" />
          </div>
          <div class="form-group">
            <label>Nama Pemilik Bisnis</label>
            <input type="text" id="set-owner-name" class="form-control" value="${app.escapeHtml(s.owner_name || 'TIKA')}" />
          </div>
          <div class="form-group">
            <label>Nama Toko / Cabang</label>
            <input type="text" id="set-store-name" class="form-control" value="${app.escapeHtml(s.store_name || '')}" />
          </div>
          <div class="form-group">
            <label>Nomor Telepon Toko</label>
            <input type="text" id="set-store-phone" class="form-control" value="${app.escapeHtml(s.store_phone || '')}" />
          </div>
          <div class="form-group">
            <label>Alamat Toko</label>
            <input type="text" id="set-store-address" class="form-control" value="${app.escapeHtml(s.store_address || '')}" />
          </div>
          <div class="form-group">
            <label>Catatan Kaki Struk (Footer Struk)</label>
            <input type="text" id="set-receipt-footer" class="form-control" value="${app.escapeHtml(s.receipt_footer || '')}" />
          </div>
        </div>
        <button class="btn btn-primary" onclick="window.posModules.saveBusinessIdentitySettings()">💾 Simpan Identitas Bisnis</button>
      </div>
    `;
  },

  async toggleFeatureSetting(featureKey, enabled) {
    const app = window.posApp;
    const s = app.db.getSettings();
    if (!s.features) s.features = {};
    s.features[featureKey] = Boolean(enabled);
    await app.db.upsert('settings', s);
    await app.db.logActivity(app.currentUser, 'TOGGLE_FEATURE', `Mengubah fitur ${featureKey} menjadi ${enabled ? 'ON' : 'OFF'}`);
    app.toast(`Fitur "${featureKey}" diubah menjadi ${enabled ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}`);
    app.render();
  },

  async saveBusinessIdentitySettings() {
    const app = window.posApp;
    const s = app.db.getSettings();
    s.app_name = (document.getElementById('set-app-name')?.value || 'POS TIKA').trim();
    s.owner_name = (document.getElementById('set-owner-name')?.value || 'TIKA').trim();
    s.store_name = (document.getElementById('set-store-name')?.value || '').trim();
    s.store_phone = (document.getElementById('set-store-phone')?.value || '').trim();
    s.store_address = (document.getElementById('set-store-address')?.value || '').trim();
    s.receipt_footer = (document.getElementById('set-receipt-footer')?.value || '').trim();
    await app.db.upsert('settings', s);
    app.toast('Identitas bisnis POS TIKA berhasil disimpan');
    app.render();
  },

  /* ========================================================================
     15. BACKUP, RESTORE & ENCRYPTED DATA OWNERSHIP (AES-256-GCM)
     ======================================================================== */
  renderBackupView(app) {
    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">🛡️ Backup, Restore & Kepemilikan Data Penuh (Milik TIKA)</h3>
            <p style="font-size:12px;color:var(--text-muted)">
              Seluruh data bisnis berada di bawah kendali Anda sepenuhnya. Tidak terkunci pada penyedia layanan cloud mana pun.
            </p>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;">
          <div class="card" style="background:#f8fafc;margin-bottom:0;">
            <h4 style="margin-bottom:8px;">1. Backup & Export Seluruh Database (JSON Standar)</h4>
            <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">
              Unduh seluruh data barang, inventaris, transaksi, struk, pelanggan, karyawan, shift, dan log sinkronisasi ke file di perangkat Anda.
            </p>
            <button class="btn btn-primary" onclick="window.posModules.downloadPlainBackup()">📥 Download Backup Database (.json)</button>
          </div>

          <div class="card" style="background:#f8fafc;margin-bottom:0;">
            <h4 style="margin-bottom:8px;">2. Backup Terenkripsi (AES-256-GCM)</h4>
            <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">
              Enkripsi seluruh database dengan kata sandi pemilik menggunakan standar kriptografi AES-256-GCM.
            </p>
            <div class="form-group">
              <input type="password" id="backup-enc-pass" class="form-control" placeholder="Masukkan kata sandi enkripsi backup..." />
            </div>
            <button class="btn btn-primary" onclick="window.posModules.downloadEncryptedBackup()">🔐 Download Backup Terenkripsi (.tika.enc)</button>
          </div>

          <div class="card" style="background:#f8fafc;margin-bottom:0;">
            <h4 style="margin-bottom:8px;">3. Restore / Import Database</h4>
            <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">
              Pulihkan database dari file backup standar (<code>.json</code>) maupun file backup terenkripsi (<code>.enc</code>).
            </p>
            <div class="form-group">
              <label>Mode Pemulihan</label>
              <select id="restore-mode-select" class="form-control">
                <option value="merge">Gabungkan dengan Data Saat Ini (Merge Tanpa Kehilangan Data)</option>
                <option value="replace">Ganti Seluruh Database (Replace)</option>
              </select>
            </div>
            <div class="form-group">
              <label>Kata Sandi Dekripsi (Isi jika file terenkripsi)</label>
              <input type="password" id="restore-dec-pass" class="form-control" placeholder="Kata sandi backup terenkripsi (opsional)" />
            </div>
            <label class="btn btn-warning" style="cursor:pointer;">
              📤 Pilih File Backup untuk Restore
              <input type="file" accept=".json,.enc,.tika" style="display:none" onchange="window.posModules.handleRestoreFile(event)" />
            </label>
          </div>
        </div>
      </div>
    `;
  },

  async downloadPlainBackup() {
    const app = window.posApp;
    const fullData = await app.db.exportFullDatabase();
    const blob = new Blob([JSON.stringify(fullData, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `POS_TIKA_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await app.db.logActivity(app.currentUser, 'BACKUP_PLAIN', 'Mengunduh file backup database JSON');
    app.toast('File backup database berhasil diunduh!');
  },

  async downloadEncryptedBackup() {
    const app = window.posApp;
    const pass = (document.getElementById('backup-enc-pass')?.value || '').trim();
    if (!pass || pass.length < 4) {
      return app.toast('Masukkan kata sandi enkripsi minimal 4 karakter!', 'error');
    }
    const fullData = await app.db.exportFullDatabase();
    const encData = await app.db.encryptBackupData(fullData, pass);
    const blob = new Blob([JSON.stringify(encData, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `POS_TIKA_Encrypted_${new Date().toISOString().slice(0, 10)}.tika.enc.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await app.db.logActivity(app.currentUser, 'BACKUP_ENCRYPTED', 'Mengunduh file backup terenkripsi AES-256-GCM');
    app.toast('Backup terenkripsi AES-256-GCM berhasil diunduh!');
  },

  handleRestoreFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const app = window.posApp;
    const mode = document.getElementById('restore-mode-select')?.value || 'merge';
    const pass = (document.getElementById('restore-dec-pass')?.value || '').trim();

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        let parsed = JSON.parse(e.target.result);
        if (parsed.format === 'POS_TIKA_ENCRYPTED_BACKUP_V1') {
          if (!pass) {
            app.toast('File ini terenkripsi! Masukkan kata sandi dekripsi terlebih dahulu.', 'error');
            return;
          }
          parsed = await app.db.decryptBackupData(parsed, pass);
        }
        await app.db.restoreDatabase(parsed, mode);
        await app.db.logActivity(app.currentUser, 'RESTORE_DB', `Restore database (${mode})`);
        app.toast('Database POS TIKA berhasil dipulihkan!');
        app.render();
      } catch (err) {
        app.toast('Gagal memulihkan backup: Kata sandi salah atau format file tidak valid.', 'error');
      }
    };
    reader.readAsText(file);
  },

  /* ========================================================================
     16. HELP & DOCUMENTATION VIEW + CUSTOMER DISPLAY SCREEN
     ======================================================================== */
  renderHelpView(app) {
    return `
      <div class="card">
        <h3 class="card-title" style="margin-bottom:10px;">Panduan Operasional POS TIKA</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;font-size:13px;">
          <div style="padding:14px;background:#f8fafc;border-radius:10px;border:1px solid var(--border);">
            <h4 style="margin-bottom:6px;color:var(--primary-dark)">🔑 1. Akun & PIN Default</h4>
            <p>• <strong>TIKA (Owner):</strong> PIN <code>1234</code> (Akses Penuh)</p>
            <p>• <strong>Rina (Admin):</strong> PIN <code>2222</code></p>
            <p>• <strong>Budi (Manager):</strong> PIN <code>3333</code></p>
            <p>• <strong>Siti (Cashier):</strong> PIN <code>4444</code></p>
            <p>• <strong>Andi (Kitchen Staff):</strong> PIN <code>5555</code></p>
          </div>
          <div style="padding:14px;background:#f8fafc;border-radius:10px;border:1px solid var(--border);">
            <h4 style="margin-bottom:6px;color:var(--primary-dark)">🔄 2. Cara Kerja Offline & P2P Sync</h4>
            <p>Setiap transaksi disimpan terlebih dahulu di database lokal perangkat (IndexedDB + SQLite). Saat internet menyala, sistem otomatis menyinkronkan operasi via WebRTC DataChannel dan Relay tanpa transaksi ganda.</p>
          </div>
          <div style="padding:14px;background:#f8fafc;border-radius:10px;border:1px solid var(--border);">
            <h4 style="margin-bottom:6px;color:var(--primary-dark)">⚖️ 3. Barcode Timbangan (Weight Barcode)</h4>
            <p>Gunakan barcode EAN-13 berawalan <code>20</code>-<code>29</code>. Contoh: <code>2010001007505</code> akan otomatis memilih barang berkode <code>10001</code> (Kopi Gayo) seberat <code>0.750 kg</code>.</p>
          </div>
        </div>
      </div>
    `;
  },

  renderCustomerDisplayScreen(app) {
    let state = app._latestCustomerDisplayCart;
    if (!state) {
      try {
        state = JSON.parse(localStorage.getItem('postika_customer_display_cart') || 'null');
      } catch (_) {}
    }
    const settings = app.db.getSettings();
    const items = state?.items || [];
    const totals = state?.totals || { subtotal: 0, discount_total: 0, tax_total: 0, total: 0 };

    return `
      <div style="height:100vh;display:grid;grid-template-columns:1.3fr 1fr;background:#0f172a;color:#fff;">
        <div style="padding:32px;display:flex;flex-direction:column;border-right:1px solid rgba(255,255,255,0.1);overflow-y:auto;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div>
              <h1 style="font-size:26px;font-weight:800;color:#10b981;">${app.escapeHtml(settings.app_name || 'POS TIKA')}</h1>
              <p style="color:#94a3b8;">Selamat Datang, <strong>${app.escapeHtml(state?.customer_name || 'Pelanggan Setia')}</strong> (${app.escapeHtml(state?.dining_option || 'Dine In')})</p>
            </div>
            <div style="background:#1e293b;padding:8px 14px;border-radius:999px;font-size:13px;color:#34d399;">Layar Pelanggan Real-Time</div>
          </div>

          <div style="flex:1;overflow-y:auto;">
            ${
              items.length === 0
                ? `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:18px;">Silakan pesan menu favorit Anda di kasir POS TIKA ✨</div>`
                : items
                    .map((it) => {
                      const unitFull = Number(it.price || 0) + Number(it.modifier_total_unit || 0);
                      const lineTotal = unitFull * Number(it.qty || 0) - Number(it.line_discount || 0);
                      return `
                      <div style="display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:16px;">
                        <div>
                          <div style="font-weight:700;">${it.qty}x ${app.escapeHtml(it.name)}</div>
                          ${(it.modifiers || []).map((m) => `<div style="font-size:13px;color:#94a3b8;">+ ${app.escapeHtml(m.name)}</div>`).join('')}
                        </div>
                        <div style="font-weight:700;color:#34d399;">${app.formatIDR(lineTotal)}</div>
                      </div>
                    `;
                    })
                    .join('')
            }
          </div>
        </div>

        <div style="padding:36px;display:flex;flex-direction:column;justify-content:space-between;background:#1e293b;">
          <div>
            <h2 style="font-size:20px;margin-bottom:20px;color:#cbd5e1;">Ringkasan Pembayaran</h2>
            <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:16px;color:#94a3b8;">
              <span>Subtotal</span><span>${app.formatIDR(totals.subtotal)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:16px;color:#f87171;">
              <span>Diskon</span><span>-${app.formatIDR(totals.discount_total)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:16px;font-size:16px;color:#94a3b8;">
              <span>Pajak</span><span>${app.formatIDR(totals.tax_total)}</span>
            </div>
            <div style="padding-top:16px;border-top:2px dashed rgba(255,255,255,0.15);display:flex;justify-content:space-between;font-size:28px;font-weight:800;color:#10b981;">
              <span>TOTAL</span><span>${app.formatIDR(totals.total)}</span>
            </div>
          </div>

          <div style="text-align:center;background:#0f172a;padding:24px;border-radius:16px;">
            <div style="font-weight:700;margin-bottom:6px;">Pembayaran QRIS tersedia di Kasir</div>
            <div style="font-size:12px;color:#94a3b8;">Terima kasih telah berbelanja di POS TIKA!</div>
          </div>
        </div>
      </div>
    `;
  }
};

window.posModules = posModules;
