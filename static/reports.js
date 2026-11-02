/**
 * POS TIKA - Complete 14-Module Analytics & Reporting Engine + Excel/PDF Exporter
 * Pemilik: TIKA | Zona Waktu: Asia/Jakarta | Mata Uang: Rupiah (IDR)
 */

class POSTikaReports {
  constructor(app) {
    this.app = app;
    this.activeReportTab = 'summary';
    this.periodFilter = 'month'; // 'today', 'week', 'month', 'year', 'all', 'custom'
    this.customStart = '';
    this.customEnd = '';
  }

  formatIDR(val) {
    return this.app.formatIDR(val);
  }

  getDateRange() {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (this.periodFilter === 'today') {
      start.setHours(0, 0, 0, 0);
    } else if (this.periodFilter === 'week') {
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    } else if (this.periodFilter === 'month') {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else if (this.periodFilter === 'year') {
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
    } else if (this.periodFilter === 'custom' && this.customStart && this.customEnd) {
      return {
        start: new Date(`${this.customStart}T00:00:00`),
        end: new Date(`${this.customEnd}T23:59:59`)
      };
    } else {
      return { start: new Date(2000, 0, 1), end: new Date(2100, 0, 1) };
    }
    return { start, end };
  }

  filterByPeriod(list, dateField = 'created_at') {
    const { start, end } = this.getDateRange();
    return list.filter((item) => {
      const ts = item[dateField] || item.timestamp || item.opened_at;
      if (!ts) return true;
      const d = new Date(ts);
      return d >= start && d <= end;
    });
  }

  computeMetrics() {
    const db = this.app.db;
    const allTx = this.filterByPeriod(db.getCollection('transactions'));
    const validTx = allTx.filter((t) => t.status !== 'VOIDED');

    let grossSales = 0;
    let netSales = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    let totalCogs = 0;
    let totalRefunds = 0;
    let txCount = 0;

    const byItem = {};
    const byCategory = {};
    const byEmployee = {};
    const byPayment = {};
    const byModifier = {};
    const byDiscount = {};
    const byTax = {};
    const byDay = {};

    const categoriesMap = {};
    db.getCollection('categories').forEach((c) => {
      categoriesMap[c.id] = c.name;
    });

    for (const tx of validTx) {
      const isRefund = tx.type === 'REFUND';
      const sign = isRefund ? -1 : 1;
      if (!isRefund) txCount += 1;

      const txSubtotal = Number(tx.subtotal || 0) * sign;
      const txDisc = Number(tx.discount_total || 0) * sign;
      const txTax = Number(tx.tax_total || 0) * sign;
      const txTotal = Number(tx.total || 0) * sign;

      grossSales += txSubtotal;
      totalDiscount += txDisc;
      totalTax += txTax;
      netSales += txTotal - txTax;
      if (isRefund) totalRefunds += Math.abs(Number(tx.total || 0));

      const dayKey = (tx.created_at || '').slice(0, 10) || 'Hari Ini';
      if (!byDay[dayKey]) {
        byDay[dayKey] = { date: dayKey, count: 0, gross: 0, discount: 0, tax: 0, total: 0, cogs: 0 };
      }
      if (!isRefund) byDay[dayKey].count += 1;
      byDay[dayKey].gross += txSubtotal;
      byDay[dayKey].discount += txDisc;
      byDay[dayKey].tax += txTax;
      byDay[dayKey].total += txTotal;

      // Employee breakdown
      const empKey = tx.employee_id || 'emp_tika';
      if (!byEmployee[empKey]) {
        byEmployee[empKey] = {
          id: empKey,
          name: tx.employee_name || 'TIKA',
          tx_count: 0,
          gross: 0,
          discount: 0,
          total: 0
        };
      }
      if (!isRefund) byEmployee[empKey].tx_count += 1;
      byEmployee[empKey].gross += txSubtotal;
      byEmployee[empKey].discount += txDisc;
      byEmployee[empKey].total += txTotal;

      // Payment breakdown
      const payments = Array.isArray(tx.payments) && tx.payments.length > 0
        ? tx.payments
        : [{ method: tx.payment_method || 'TUNAI', amount: Math.abs(txTotal) }];

      for (const p of payments) {
        const mName = p.method || 'TUNAI';
        if (!byPayment[mName]) {
          byPayment[mName] = { method: mName, count: 0, total: 0 };
        }
        if (!isRefund) byPayment[mName].count += 1;
        byPayment[mName].total += Number(p.amount || 0) * sign;
      }

      // Discount breakdown
      if (tx.discount_total > 0) {
        const dName = tx.discount_name || 'Diskon Manual / Item';
        if (!byDiscount[dName]) {
          byDiscount[dName] = { name: dName, count: 0, amount: 0 };
        }
        byDiscount[dName].count += 1;
        byDiscount[dName].amount += txDisc;
      }

      // Tax breakdown
      if (Array.isArray(tx.taxes_applied)) {
        for (const t of tx.taxes_applied) {
          const tKey = t.name || 'Pajak';
          if (!byTax[tKey]) {
            byTax[tKey] = { name: tKey, rate: t.rate || 0, type: t.type || 'ADDED', taxable: 0, amount: 0 };
          }
          byTax[tKey].taxable += txSubtotal - txDisc;
          byTax[tKey].amount += Number(t.amount || 0) * sign;
        }
      }

      // Items & Modifiers & COGS
      for (const item of tx.items || []) {
        const qty = Number(item.qty || 0) * sign;
        const unitCost = Number(item.cost || 0);
        const unitPrice = Number(item.price || 0);
        const modPrice = Number(item.modifier_total_unit || 0);
        const lineGross = (unitPrice + modPrice) * qty;
        const lineDisc = Number(item.line_discount || 0) * sign;
        const lineNet = lineGross - lineDisc;
        const lineCogs = unitCost * qty;

        totalCogs += lineCogs;
        byDay[dayKey].cogs += lineCogs;

        const pid = item.product_id || item.name;
        if (!byItem[pid]) {
          byItem[pid] = {
            id: pid,
            name: item.name,
            sku: item.sku || '-',
            category_name: categoriesMap[item.category_id] || 'Umum',
            qty: 0,
            gross: 0,
            discount: 0,
            net: 0,
            cogs: 0,
            profit: 0
          };
        }
        byItem[pid].qty = Math.round((byItem[pid].qty + qty) * 1000) / 1000;
        byItem[pid].gross += lineGross;
        byItem[pid].discount += lineDisc;
        byItem[pid].net += lineNet;
        byItem[pid].cogs += lineCogs;
        byItem[pid].profit += lineNet - lineCogs;

        const catId = item.category_id || 'cat_umum';
        const catName = categoriesMap[catId] || 'Umum';
        if (!byCategory[catId]) {
          byCategory[catId] = { id: catId, name: catName, qty: 0, gross: 0, net: 0, cogs: 0, profit: 0 };
        }
        byCategory[catId].qty = Math.round((byCategory[catId].qty + qty) * 1000) / 1000;
        byCategory[catId].gross += lineGross;
        byCategory[catId].net += lineNet;
        byCategory[catId].cogs += lineCogs;
        byCategory[catId].profit += lineNet - lineCogs;

        if (Array.isArray(item.modifiers)) {
          for (const m of item.modifiers) {
            const mKey = `${m.group_name || 'Modifier'}: ${m.name}`;
            if (!byModifier[mKey]) {
              byModifier[mKey] = { name: mKey, qty: 0, revenue: 0 };
            }
            byModifier[mKey].qty += qty;
            byModifier[mKey].revenue += Number(m.price || 0) * qty;
          }
        }
      }
    }

    const totalRevenue = grossSales - totalDiscount + totalTax;
    const grossProfit = (grossSales - totalDiscount) - totalCogs;
    const avgTx = txCount > 0 ? totalRevenue / txCount : 0;

    const sortedItems = Object.values(byItem).sort((a, b) => b.qty - a.qty);
    const bestSeller = sortedItems.length > 0 ? `${sortedItems[0].name} (${sortedItems[0].qty})` : 'Belum ada transaksi';

    return {
      allTx,
      validTx,
      txCount,
      grossSales,
      netSales: grossSales - totalDiscount,
      totalRevenue,
      totalDiscount,
      totalTax,
      totalCogs,
      totalRefunds,
      grossProfit,
      avgTx,
      bestSeller,
      byItem: sortedItems,
      byCategory: Object.values(byCategory).sort((a, b) => b.net - a.net),
      byEmployee: Object.values(byEmployee).sort((a, b) => b.total - a.total),
      byPayment: Object.values(byPayment).sort((a, b) => b.total - a.total),
      byModifier: Object.values(byModifier).sort((a, b) => b.qty - a.qty),
      byDiscount: Object.values(byDiscount).sort((a, b) => b.amount - a.amount),
      byTax: Object.values(byTax),
      byDay: Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1))
    };
  }

  renderReportsPage() {
    const m = this.computeMetrics();
    const tabs = [
      { id: 'summary', label: '1. Ringkasan Penjualan' },
      { id: 'by_item', label: '2. Penjualan per Barang' },
      { id: 'by_category', label: '3. Penjualan per Kategori' },
      { id: 'by_employee', label: '4. Penjualan per Karyawan' },
      { id: 'by_payment', label: '5. Jenis Pembayaran' },
      { id: 'receipts', label: '6. Struk' },
      { id: 'by_modifier', label: '7. Modifier' },
      { id: 'discounts', label: '8. Diskon' },
      { id: 'taxes', label: '9. Pajak Barang' },
      { id: 'items_list', label: '10. Daftar Barang' },
      { id: 'inventory', label: '11. Laporan Inventaris' },
      { id: 'profit', label: '12. Laporan Keuntungan' },
      { id: 'shifts', label: '13. Laporan Shift' },
      { id: 'timecards', label: '14. Laporan Jam Kerja' }
    ];

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Pusat Laporan Bisnis POS TIKA</h3>
            <p style="font-size:12px;color:var(--text-muted)">Pemilik: TIKA • Zona Waktu: Asia/Jakarta • Mata Uang: Rupiah (IDR)</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <select class="form-control" style="width:auto;" onchange="window.posApp.reports.setPeriod(this.value)">
              <option value="today" ${this.periodFilter === 'today' ? 'selected' : ''}>Hari Ini (Harian)</option>
              <option value="week" ${this.periodFilter === 'week' ? 'selected' : ''}>7 Hari Terakhir (Mingguan)</option>
              <option value="month" ${this.periodFilter === 'month' ? 'selected' : ''}>Bulan Ini (Bulanan)</option>
              <option value="year" ${this.periodFilter === 'year' ? 'selected' : ''}>Tahun Ini (Tahunan)</option>
              <option value="all" ${this.periodFilter === 'all' ? 'selected' : ''}>Semua Waktu</option>
              <option value="custom" ${this.periodFilter === 'custom' ? 'selected' : ''}>Rentang Tanggal Kustom</option>
            </select>
            ${
              this.periodFilter === 'custom'
                ? `
              <input type="date" class="form-control" value="${this.customStart}" onchange="window.posApp.reports.setCustomDate('start', this.value)" />
              <input type="date" class="form-control" value="${this.customEnd}" onchange="window.posApp.reports.setCustomDate('end', this.value)" />
            `
                : ''
            }
            <button class="btn btn-secondary" onclick="window.posApp.reports.exportCurrentReportCSV()">📥 Export Excel (CSV)</button>
            <button class="btn btn-primary" onclick="window.posApp.reports.exportCurrentReportPDF()">🖨️ Export PDF / Cetak</button>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Total Omzet (Pendapatan)</div>
            <div class="kpi-value">${this.formatIDR(m.totalRevenue)}</div>
            <div class="kpi-sub">Penjualan Bersih: ${this.formatIDR(m.netSales)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Jumlah Transaksi</div>
            <div class="kpi-value">${m.txCount}</div>
            <div class="kpi-sub">Rata-rata: ${this.formatIDR(m.avgTx)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Produk Terlaris</div>
            <div class="kpi-value" style="font-size:15px;">${this.app.escapeHtml(m.bestSeller)}</div>
            <div class="kpi-sub">Berdasarkan kuantitas terjual</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total Diskon & Pajak</div>
            <div class="kpi-value">${this.formatIDR(m.totalDiscount)}</div>
            <div class="kpi-sub">Total Pajak: ${this.formatIDR(m.totalTax)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Estimasi Keuntungan Kotor</div>
            <div class="kpi-value" style="color:var(--primary-dark)">${this.formatIDR(m.grossProfit)}</div>
            <div class="kpi-sub">HPP: ${this.formatIDR(m.totalCogs)}</div>
          </div>
        </div>

        <div class="subtabs">
          ${tabs
            .map(
              (t) => `
            <button class="subtab-btn ${this.activeReportTab === t.id ? 'active' : ''}" onclick="window.posApp.reports.setTab('${t.id}')">
              ${t.label}
            </button>
          `
            )
            .join('')}
        </div>

        <div id="report-active-table-container">
          ${this.renderActiveTabContent(m)}
        </div>
      </div>
    `;
  }

  setPeriod(val) {
    this.periodFilter = val;
    this.app.render();
  }

  setCustomDate(which, val) {
    if (which === 'start') this.customStart = val;
    else this.customEnd = val;
    this.app.render();
  }

  setTab(tabId) {
    this.activeReportTab = tabId;
    this.app.render();
  }

  renderActiveTabContent(m) {
    const db = this.app.db;
    switch (this.activeReportTab) {
      case 'summary':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Tanggal</th>
                  <th>Jumlah Transaksi</th>
                  <th>Penjualan Kotor</th>
                  <th>Diskon</th>
                  <th>Pajak</th>
                  <th>Total Omzet</th>
                  <th>HPP (Modal)</th>
                  <th>Laba Kotor</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byDay.length === 0
                    ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Belum ada data penjualan pada periode ini</td></tr>`
                    : m.byDay
                        .map(
                          (d) => `
                  <tr>
                    <td><strong>${d.date}</strong></td>
                    <td>${d.count}</td>
                    <td>${this.formatIDR(d.gross)}</td>
                    <td>${this.formatIDR(d.discount)}</td>
                    <td>${this.formatIDR(d.tax)}</td>
                    <td><strong>${this.formatIDR(d.total)}</strong></td>
                    <td>${this.formatIDR(d.cogs)}</td>
                    <td style="color:var(--primary-dark);font-weight:700">${this.formatIDR(d.gross - d.discount - d.cogs)}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'by_item':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Nama Barang</th>
                  <th>SKU</th>
                  <th>Kategori</th>
                  <th>Qty Terjual</th>
                  <th>Penjualan Kotor</th>
                  <th>Diskon</th>
                  <th>Penjualan Bersih</th>
                  <th>HPP</th>
                  <th>Keuntungan</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byItem.length === 0
                    ? `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Belum ada penjualan barang</td></tr>`
                    : m.byItem
                        .map(
                          (it) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(it.name)}</strong></td>
                    <td>${this.app.escapeHtml(it.sku)}</td>
                    <td>${this.app.escapeHtml(it.category_name)}</td>
                    <td>${it.qty}</td>
                    <td>${this.formatIDR(it.gross)}</td>
                    <td>${this.formatIDR(it.discount)}</td>
                    <td>${this.formatIDR(it.net)}</td>
                    <td>${this.formatIDR(it.cogs)}</td>
                    <td style="color:var(--primary-dark);font-weight:700">${this.formatIDR(it.profit)}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'by_category':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Kategori</th>
                  <th>Barang Terjual</th>
                  <th>Penjualan Kotor</th>
                  <th>Penjualan Bersih</th>
                  <th>HPP</th>
                  <th>Keuntungan Kotor</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byCategory.length === 0
                    ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Belum ada data kategori</td></tr>`
                    : m.byCategory
                        .map(
                          (c) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(c.name)}</strong></td>
                    <td>${c.qty}</td>
                    <td>${this.formatIDR(c.gross)}</td>
                    <td>${this.formatIDR(c.net)}</td>
                    <td>${this.formatIDR(c.cogs)}</td>
                    <td style="color:var(--primary-dark);font-weight:700">${this.formatIDR(c.profit)}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'by_employee':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Nama Karyawan</th>
                  <th>Jumlah Transaksi</th>
                  <th>Penjualan Kotor</th>
                  <th>Total Diskon</th>
                  <th>Total Omzet</th>
                  <th>Rata-rata Transaksi</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byEmployee.length === 0
                    ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Belum ada transaksi karyawan</td></tr>`
                    : m.byEmployee
                        .map(
                          (e) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(e.name)}</strong></td>
                    <td>${e.tx_count}</td>
                    <td>${this.formatIDR(e.gross)}</td>
                    <td>${this.formatIDR(e.discount)}</td>
                    <td><strong>${this.formatIDR(e.total)}</strong></td>
                    <td>${this.formatIDR(e.tx_count > 0 ? e.total / e.tx_count : 0)}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'by_payment':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Jenis Pembayaran</th>
                  <th>Jumlah Transaksi</th>
                  <th>Total Nominal Pembayaran</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byPayment.length === 0
                    ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">Belum ada pembayaran tercatat</td></tr>`
                    : m.byPayment
                        .map(
                          (p) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(p.method)}</strong></td>
                    <td>${p.count}</td>
                    <td><strong>${this.formatIDR(p.total)}</strong></td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'receipts':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>No. Struk</th>
                  <th>Waktu</th>
                  <th>Jenis</th>
                  <th>Pelanggan</th>
                  <th>Kasir</th>
                  <th>Metode Bayar</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.allTx.length === 0
                    ? `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Belum ada struk transaksi</td></tr>`
                    : m.allTx
                        .slice()
                        .reverse()
                        .map(
                          (t) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(t.receipt_number)}</strong></td>
                    <td>${this.app.formatDateTime(t.created_at)}</td>
                    <td>${this.app.escapeHtml(t.dining_option || 'Dine In')}</td>
                    <td>${this.app.escapeHtml(t.customer_name || 'Pelanggan Umum')}</td>
                    <td>${this.app.escapeHtml(t.employee_name || 'TIKA')}</td>
                    <td>${this.app.escapeHtml(t.payment_method || 'TUNAI')}</td>
                    <td><strong>${this.formatIDR(t.total)}</strong></td>
                    <td>
                      <span class="badge ${t.status === 'VOIDED' ? 'badge-danger' : t.type === 'REFUND' ? 'badge-warning' : 'badge-success'}">
                        ${t.status === 'VOIDED' ? 'DIBATALKAN' : t.type === 'REFUND' ? 'REFUND' : 'LUNAS'}
                      </span>
                    </td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="window.posApp.showReceiptModal('${t.id}')">Lihat Struk</button>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'by_modifier':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Modifier / Opsi Tambahan</th>
                  <th>Jumlah Terjual</th>
                  <th>Total Pendapatan Modifier</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byModifier.length === 0
                    ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">Belum ada penjualan modifier</td></tr>`
                    : m.byModifier
                        .map(
                          (mod) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(mod.name)}</strong></td>
                    <td>${mod.qty}</td>
                    <td><strong>${this.formatIDR(mod.revenue)}</strong></td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'discounts':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Nama Diskon</th>
                  <th>Jumlah Penggunaan</th>
                  <th>Total Potongan Diskon</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byDiscount.length === 0
                    ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">Belum ada diskon digunakan</td></tr>`
                    : m.byDiscount
                        .map(
                          (d) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(d.name)}</strong></td>
                    <td>${d.count}</td>
                    <td><strong>${this.formatIDR(d.amount)}</strong></td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'taxes':
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Nama Pajak</th>
                  <th>Tarif (%)</th>
                  <th>Tipe</th>
                  <th>Penjualan Kena Pajak</th>
                  <th>Total Pajak Terkumpul</th>
                </tr>
              </thead>
              <tbody>
                ${
                  m.byTax.length === 0
                    ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Belum ada pajak tercatat</td></tr>`
                    : m.byTax
                        .map(
                          (t) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(t.name)}</strong></td>
                    <td>${t.rate}%</td>
                    <td>${t.type === 'INCLUDED' ? 'Termasuk Harga' : 'Ditambahkan'}</td>
                    <td>${this.formatIDR(t.taxable)}</td>
                    <td><strong>${this.formatIDR(t.amount)}</strong></td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;

      case 'items_list': {
        const prods = db.getCollection('products');
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>Nama Barang</th>
                  <th>Satuan</th>
                  <th>Harga Beli (HPP)</th>
                  <th>Harga Jual</th>
                  <th>Margin (%)</th>
                  <th>Stok Saat Ini</th>
                </tr>
              </thead>
              <tbody>
                ${prods
                  .map((p) => {
                    const margin = p.price > 0 ? (((p.price - p.cost) / p.price) * 100).toFixed(1) : '0.0';
                    return `
                    <tr>
                      <td>${this.app.escapeHtml(p.sku || '-')}</td>
                      <td>${this.app.escapeHtml(p.barcode || '-')}</td>
                      <td><strong>${this.app.escapeHtml(p.name)}</strong></td>
                      <td>${this.app.escapeHtml(p.unit || 'pcs')}</td>
                      <td>${this.formatIDR(p.cost)}</td>
                      <td>${this.formatIDR(p.price)}</td>
                      <td>${margin}%</td>
                      <td><strong>${p.stock}</strong></td>
                    </tr>
                  `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      case 'inventory': {
        const prods = db.getCollection('products');
        let totalCostVal = 0;
        let totalRetailVal = 0;
        const rowsHtml = prods
          .map((p) => {
            const stk = Number(p.stock || 0);
            const cVal = stk * Number(p.cost || 0);
            const rVal = stk * Number(p.price || 0);
            totalCostVal += cVal;
            totalRetailVal += rVal;
            return `
            <tr>
              <td><strong>${this.app.escapeHtml(p.name)}</strong></td>
              <td>${this.app.escapeHtml(p.sku || '-')}</td>
              <td>${stk} ${this.app.escapeHtml(p.unit || 'pcs')}</td>
              <td>${p.min_stock || 0}</td>
              <td>${this.formatIDR(p.cost)}</td>
              <td>${this.formatIDR(cVal)}</td>
              <td>${this.formatIDR(rVal)}</td>
              <td style="color:var(--primary-dark);font-weight:700">${this.formatIDR(rVal - cVal)}</td>
            </tr>
          `;
          })
          .join('');
        return `
          <div style="margin-bottom:12px;display:flex;gap:20px;flex-wrap:wrap;font-size:13px;">
            <span>Total Nilai Modal Stok: <strong>${this.formatIDR(totalCostVal)}</strong></span>
            <span>Total Nilai Jual Stok: <strong>${this.formatIDR(totalRetailVal)}</strong></span>
            <span>Potensi Laba Stok: <strong style="color:var(--primary-dark)">${this.formatIDR(totalRetailVal - totalCostVal)}</strong></span>
          </div>
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Barang</th>
                  <th>SKU</th>
                  <th>Stok Tersedia</th>
                  <th>Stok Minimum</th>
                  <th>Harga Beli</th>
                  <th>Nilai Modal Stok</th>
                  <th>Nilai Jual Stok</th>
                  <th>Potensi Keuntungan</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        `;
      }

      case 'profit': {
        const marginPct = m.netSales > 0 ? ((m.grossProfit / m.netSales) * 100).toFixed(2) : '0.00';
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Komponen Keuangan</th>
                  <th>Nominal (IDR)</th>
                  <th>Keterangan</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>1. Penjualan Kotor (Gross Sales)</strong></td>
                  <td><strong>${this.formatIDR(m.grossSales)}</strong></td>
                  <td>Total harga barang & modifier sebelum diskon</td>
                </tr>
                <tr>
                  <td>2. Total Diskon Penjualan</td>
                  <td style="color:var(--danger)">- ${this.formatIDR(m.totalDiscount)}</td>
                  <td>Potongan diskon pelanggan & item</td>
                </tr>
                <tr>
                  <td><strong>3. Penjualan Bersih (Net Sales)</strong></td>
                  <td><strong>${this.formatIDR(m.netSales)}</strong></td>
                  <td>Penjualan kotor dikurangi diskon</td>
                </tr>
                <tr>
                  <td>4. Harga Pokok Penjualan (HPP / COGS)</td>
                  <td style="color:var(--danger)">- ${this.formatIDR(m.totalCogs)}</td>
                  <td>Akumulasi harga beli barang yang terjual</td>
                </tr>
                <tr>
                  <td><strong>5. Estimasi Keuntungan Kotor (Gross Profit)</strong></td>
                  <td style="color:var(--primary-dark);font-weight:800;font-size:15px;">${this.formatIDR(m.grossProfit)}</td>
                  <td>Margin Keuntungan Kotor: <strong>${marginPct}%</strong></td>
                </tr>
                <tr>
                  <td>6. Pajak Terkumpul (PB1 / PPN)</td>
                  <td>${this.formatIDR(m.totalTax)}</td>
                  <td>Pajak yang dipungut dari transaksi</td>
                </tr>
                <tr>
                  <td><strong>7. Total Penerimaan Kasir (Total Omzet)</strong></td>
                  <td><strong>${this.formatIDR(m.totalRevenue)}</strong></td>
                  <td>Total pembayaran yang diterima dari pelanggan</td>
                </tr>
              </tbody>
            </table>
          </div>
        `;
      }

      case 'shifts': {
        const shifts = this.filterByPeriod(db.getCollection('shifts'), 'opened_at');
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Waktu Buka</th>
                  <th>Waktu Tutup</th>
                  <th>Karyawan</th>
                  <th>Modal Awal</th>
                  <th>Kas Masuk/Keluar</th>
                  <th>Kas Diharapkan</th>
                  <th>Kas Aktual</th>
                  <th>Selisih</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${
                  shifts.length === 0
                    ? `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Belum ada riwayat shift kasir</td></tr>`
                    : shifts
                        .slice()
                        .reverse()
                        .map((s) => {
                          const cashIn = (s.cash_movements || [])
                            .filter((c) => c.type === 'IN')
                            .reduce((a, b) => a + Number(b.amount || 0), 0);
                          const cashOut = (s.cash_movements || [])
                            .filter((c) => c.type === 'OUT')
                            .reduce((a, b) => a + Number(b.amount || 0), 0);
                          return `
                          <tr>
                            <td>${this.app.formatDateTime(s.opened_at)}</td>
                            <td>${s.closed_at ? this.app.formatDateTime(s.closed_at) : '-'}</td>
                            <td><strong>${this.app.escapeHtml(s.employee_name || 'TIKA')}</strong></td>
                            <td>${this.formatIDR(s.opening_cash || 0)}</td>
                            <td>+${this.formatIDR(cashIn)} / -${this.formatIDR(cashOut)}</td>
                            <td>${this.formatIDR(s.expected_cash || 0)}</td>
                            <td>${s.actual_cash !== undefined && s.actual_cash !== null ? this.formatIDR(s.actual_cash) : '-'}</td>
                            <td>${s.difference !== undefined && s.difference !== null ? this.formatIDR(s.difference) : '-'}</td>
                            <td><span class="badge ${s.status === 'OPEN' ? 'badge-success' : 'badge-info'}">${s.status}</span></td>
                          </tr>
                        `;
                        })
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;
      }

      case 'timecards': {
        const cards = this.filterByPeriod(db.getCollection('timecards'), 'clock_in');
        return `
          <div class="table-wrap">
            <table class="data-table" id="current-report-table">
              <thead>
                <tr>
                  <th>Nama Karyawan</th>
                  <th>Role</th>
                  <th>Jam Masuk (Clock In)</th>
                  <th>Jam Keluar (Clock Out)</th>
                  <th>Total Durasi Kerja</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                ${
                  cards.length === 0
                    ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Belum ada data jam kerja karyawan</td></tr>`
                    : cards
                        .slice()
                        .reverse()
                        .map(
                          (tc) => `
                  <tr>
                    <td><strong>${this.app.escapeHtml(tc.employee_name)}</strong></td>
                    <td>${this.app.escapeHtml(tc.role || '-')}</td>
                    <td>${this.app.formatDateTime(tc.clock_in)}</td>
                    <td>${tc.clock_out ? this.app.formatDateTime(tc.clock_out) : '<span class="badge badge-success">Sedang Bekerja</span>'}</td>
                    <td><strong>${tc.duration_label || '-'}</strong></td>
                    <td>${this.app.escapeHtml(tc.notes || '-')}</td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        `;
      }
    }
    return '';
  }

  exportCurrentReportCSV() {
    const table = document.getElementById('current-report-table');
    if (!table) {
      this.app.toast('Tidak ada tabel laporan untuk diekspor', 'error');
      return;
    }
    const rows = Array.from(table.querySelectorAll('tr'));
    const csvLines = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      return cells
        .map((c) => {
          const text = (c.innerText || '').replace(/\r?\n|\r/g, ' ').trim();
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(',');
    });
    const csvContent = '\uFEFF' + csvLines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Laporan_POS_TIKA_${this.activeReportTab}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.app.toast('Laporan berhasil diekspor ke Excel (CSV)');
  }

  exportCurrentReportPDF() {
    const container = document.getElementById('report-active-table-container');
    if (!container) return;
    const settings = this.app.db.getSettings();
    const printMount = document.getElementById('print-mount');
    printMount.innerHTML = `
      <div style="padding:24px;font-family:Arial,sans-serif;color:#000;">
        <h2 style="margin-bottom:4px;">${this.app.escapeHtml(settings.app_name || 'POS TIKA')} - Laporan Resmi</h2>
        <p style="font-size:12px;color:#444;margin-bottom:16px;">
          Pemilik: ${this.app.escapeHtml(settings.owner_name || 'TIKA')} | Dicetak: ${this.app.formatDateTime(this.app.db.nowJakartaISO())} WIB
        </p>
        ${container.innerHTML}
      </div>
    `;
    window.print();
  }
}

window.POSTikaReports = POSTikaReports;
