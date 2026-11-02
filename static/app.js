/**
 * POS TIKA - Main Application Controller (Auth, POS Cashier, Cart, Payments, Receipts, Barcode, Shifts)
 * Pemilik: TIKA | Bahasa: Indonesia | Mata Uang: IDR | Zona Waktu: Asia/Jakarta
 */

class POSTikaApp {
  constructor() {
    this.db = window.posDB;
    this.sync = null;
    this.reports = null;
    this.currentUser = null;
    this.pinBuffer = '';
    this.activeMenu = 'pos'; // 'dashboard','pos','reports','items','categories','modifiers','discounts','taxes','inventory','employees','permissions','customers','devices','sync','integrations','settings','backup','help'
    this.sidebarOpen = false;
    this.isCustomerDisplayMode = new URLSearchParams(window.location.search).get('mode') === 'customer_display';

    // POS State
    this.posSearch = '';
    this.posCategory = 'ALL';
    this.cart = [];
    this.cartCustomerId = 'cust_umum';
    this.cartDiningOption = 'Dine In'; // 'Dine In', 'Takeaway', 'Delivery'
    this.cartDiscountId = '';
    this.cartManualDiscount = 0; // Nominal Rp
    this.cartNotes = '';
    this.activeOpenTicketId = null;
    this.activeOpenTicketName = '';

    // Inventory filter state
    this.invFilterReason = 'ALL';
  }

  async init() {
    await this.db.init();
    this.sync = new window.POSTikaSyncEngine(this.db);
    window.posSync = this.sync;
    this.reports = new window.POSTikaReports(this);

    // Check URL pairing parameters (?pair_biz=...&pair_relay=...)
    const params = new URLSearchParams(window.location.search);
    if (params.get('pair_relay')) {
      localStorage.setItem('postika_relay_url', params.get('pair_relay'));
      this.sync.relayUrl = params.get('pair_relay');
    }

    // Restore logged-in session if saved
    const savedEmpId = sessionStorage.getItem('postika_emp_id');
    if (savedEmpId) {
      const emp = this.db.getById('employees', savedEmpId);
      if (emp && emp.active !== false) {
        this.currentUser = emp;
      }
    }

    this.db.onChange(() => {
      if (!this.modalOpen) {
        this.renderMainViewOnly();
      }
    });

    this.sync.onStatusChange(() => {
      this.updateSyncTopbarPill();
    });

    this.sync.start();
    this.setupHardwareBarcodeListener();

    // Register Service Worker for Offline PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    this.render();
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  formatIDR(val) {
    const num = Math.round(Number(val || 0));
    const sign = num < 0 ? '-' : '';
    const absStr = Math.abs(num)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}Rp ${absStr}`;
  }

  formatDateTime(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return isoStr;
    }
  }

  toast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`;
    el.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'}</span><span>${this.escapeHtml(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  hasPermission(permKey) {
    if (!this.currentUser) return false;
    if (this.currentUser.is_owner || this.currentUser.role === 'Owner' || this.currentUser.name === 'TIKA') {
      return true;
    }
    const roleObj =
      this.db.getById('roles', this.currentUser.role_id) ||
      this.db.getCollection('roles').find((r) => r.name === this.currentUser.role);
    if (!roleObj || !roleObj.permissions) return false;
    return Boolean(roleObj.permissions[permKey]);
  }

  requirePermissionOrSupervisorPin(permKey, actionLabel, callback) {
    if (this.hasPermission(permKey)) {
      callback();
      return;
    }
    this.openModal(
      `Otorisasi PIN Supervisor / Pemilik (TIKA)`,
      `
        <p style="margin-bottom:12px;color:var(--text-muted)">
          Peran Anda (<strong>${this.escapeHtml(this.currentUser?.role || '')}</strong>) membutuhkan otorisasi untuk: <strong>${this.escapeHtml(actionLabel)}</strong>.
        </p>
        <div class="form-group">
          <label>Masukkan PIN Owner (TIKA) / Manager / Admin</label>
          <input type="password" id="supervisor-pin-input" class="form-control" placeholder="Contoh: 1234" autofocus />
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posApp.verifySupervisorPin('${permKey}')">Verifikasi Otorisasi</button>
      `
    );
    this._pendingSupervisorCallback = callback;
  }

  verifySupervisorPin(permKey) {
    const pin = (document.getElementById('supervisor-pin-input')?.value || '').trim();
    const emps = this.db.getCollection('employees').filter((e) => e.active !== false);
    const sup = emps.find((e) => e.pin === pin);
    if (!sup) {
      this.toast('PIN tidak valid!', 'error');
      return;
    }
    const roleObj = this.db.getById('roles', sup.role_id);
    const allowed = sup.is_owner || sup.role === 'Owner' || (roleObj && roleObj.permissions && roleObj.permissions[permKey]);
    if (!allowed) {
      this.toast(`Karyawan ${sup.name} tidak memiliki izin tersebut`, 'error');
      return;
    }
    const cb = this._pendingSupervisorCallback;
    this._pendingSupervisorCallback = null;
    this.closeModal();
    this.toast(`Diotorisasi oleh ${sup.name}`);
    if (cb) cb();
  }

  handleDeviceRevoked(msg) {
    this.currentUser = null;
    sessionStorage.removeItem('postika_emp_id');
    this.toast(msg || 'Akses perangkat ini telah dicabut oleh TIKA', 'error');
    this.render();
  }

  /* ========================================================================
     PIN LOGIN & EMPLOYEE AUTHENTICATION
     ======================================================================== */
  pressPin(digit) {
    if (digit === 'C') {
      this.pinBuffer = '';
    } else if (digit === 'BS') {
      this.pinBuffer = this.pinBuffer.slice(0, -1);
    } else if (this.pinBuffer.length < 6) {
      this.pinBuffer += String(digit);
    }
    this.updatePinDots();
    if (this.pinBuffer.length === 4) {
      this.submitPinLogin();
    }
  }

  quickFillPin(pin) {
    this.pinBuffer = String(pin);
    this.updatePinDots();
    this.submitPinLogin();
  }

  updatePinDots() {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById(`pin-dot-${i}`);
      if (dot) {
        dot.classList.toggle('filled', i < this.pinBuffer.length);
      }
    }
  }

  async submitPinLogin() {
    const pin = this.pinBuffer;
    const employees = this.db.getCollection('employees').filter((e) => e.active !== false);
    const matched = employees.find((e) => String(e.pin) === String(pin));
    if (!matched) {
      this.pinBuffer = '';
      this.updatePinDots();
      this.toast('PIN salah atau akun tidak aktif!', 'error');
      return;
    }
    this.currentUser = matched;
    this.pinBuffer = '';
    sessionStorage.setItem('postika_emp_id', matched.id);
    await this.db.logActivity(matched, 'LOGIN', `Login ke POS TIKA menggunakan PIN (${matched.role})`);
    this.toast(`Selamat datang, ${matched.name} (${matched.role})`);
    this.render();
  }

  async logout() {
    if (this.currentUser) {
      await this.db.logActivity(this.currentUser, 'LOGOUT', `Keluar dari sesi POS TIKA`);
    }
    this.currentUser = null;
    this.pinBuffer = '';
    sessionStorage.removeItem('postika_emp_id');
    this.render();
  }

  /* ========================================================================
     BARCODE SCANNER (PHYSICAL USB/BLE + WEIGHT-EMBEDDED EAN-13 + LIVE CAMERA)
     ======================================================================== */
  playScannerBeep(success = true) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this._audioCtx) this._audioCtx = new AudioCtx();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = success ? 'sine' : 'sawtooth';
      osc.frequency.setValueAtTime(success ? 1850 : 320, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (success ? 0.12 : 0.28));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (success ? 0.12 : 0.28));
    } catch (_) {}
  }

  setupHardwareBarcodeListener() {
    let scanBuffer = '';
    let lastKeyTime = 0;
    window.addEventListener('keydown', (e) => {
      if (!this.currentUser) {
        if (e.key >= '0' && e.key <= '9') this.pressPin(e.key);
        else if (e.key === 'Backspace') this.pressPin('BS');
        return;
      }

      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) {
        return;
      }

      const activeEl = e.target || document.activeElement;
      const tag = (activeEl && activeEl.tagName) || '';
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // If user is inside the POS search box, let handlePosSearchKeydown handle Enter
      if (isInput && activeEl.classList && activeEl.classList.contains('pos-search-input')) {
        return;
      }

      // If user is focused inside another input field (like manual-barcode-input or prd-barcode), let native input work
      if (isInput) return;

      const now = Date.now();
      if (now - lastKeyTime > 450) {
        scanBuffer = '';
      }
      lastKeyTime = now;

      if (e.key === 'Enter' && scanBuffer.length >= 3) {
        e.preventDefault();
        const code = scanBuffer.trim();
        scanBuffer = '';
        // If Product Modal is open and has #prd-barcode, fill it automatically
        const prdBarcodeInput = document.getElementById('prd-barcode');
        if (prdBarcodeInput && this.modalOpen) {
          prdBarcodeInput.value = code;
          this.playScannerBeep(true);
          this.toast(`Barcode "${code}" dimasukkan ke kolom Barcode Barang`);
          return;
        }
        this.processBarcodeScan(code);
      } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        scanBuffer += e.key;
      }
    });
  }

  processBarcodeScan(rawCode, targetInputId = null) {
    const code = String(rawCode || '').trim();
    if (!code) return false;

    // 0. If scanning into a target input (e.g. #prd-barcode when adding/editing a product)
    const targetId = targetInputId || this._barcodeTargetInputId;
    if (targetId) {
      this._barcodeTargetInputId = null;
      const inputEl = document.getElementById(targetId);
      if (inputEl) {
        inputEl.value = code;
        this.playScannerBeep(true);
        this.toast(`Barcode berhasil dipindai: ${code}`);
        return true;
      }
    }

    // Check if scanned QR code is a Device Pairing URL
    if (code.includes('pair_biz=') || code.includes('pair_relay=')) {
      try {
        const u = new URL(code, window.location.origin);
        if (u.searchParams.get('pair_relay')) {
          const rUrl = u.searchParams.get('pair_relay').replace(/\/+$/, '');
          localStorage.setItem('postika_relay_url', rUrl);
          this.sync.relayUrl = rUrl;
        }
        if (u.searchParams.get('pair_biz')) {
          localStorage.setItem('postika_pair_biz', u.searchParams.get('pair_biz'));
        }
        if (u.searchParams.get('pair_key')) {
          localStorage.setItem('postika_pair_key', u.searchParams.get('pair_key'));
        }
        this.playScannerBeep(true);
        this.toast('QR Pairing Perangkat berhasil dipindai! Menyinkronkan data...');
        this.sync.connectCloudMqttBridge();
        this.sync.syncNow('QR-Pairing');
        return true;
      } catch (_) {}
    }

    const settings = this.db.getSettings();
    const products = this.db.getCollection('products');

    // 1. Check Weight-Embedded Barcodes (EAN-13 / 12-13 digits starting with 20..29)
    // Format: PP (2 digits prefix, e.g. 20) + IIIII (5 digits item SKU/barcode) + WWWWW (5 digits weight in grams) + C (1 check digit)
    if (settings.features?.weight_barcodes !== false && (code.length === 12 || code.length === 13) && /^\d+$/.test(code)) {
      const prefix = code.slice(0, 2);
      const validPrefixes = settings.weight_barcode_config?.prefixes || ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];
      if (validPrefixes.includes(prefix)) {
        const itemCodeRaw = code.slice(2, 7);
        const itemCodeStripped = itemCodeRaw.replace(/^0+/, '') || itemCodeRaw;
        const weightRaw = code.slice(7, 12);
        const weightKg = Number(weightRaw) / 1000;

        const weightProduct = products.find(
          (p) =>
            String(p.barcode || '') === itemCodeRaw ||
            String(p.sku || '') === itemCodeRaw ||
            String(p.barcode || '') === itemCodeStripped ||
            String(p.sku || '') === itemCodeStripped
        );
        if (weightProduct && weightKg > 0) {
          this.playScannerBeep(true);
          this.addProductToCart(weightProduct, weightKg);
          this.toast(`Barcode Timbangan: ${weightProduct.name} (${weightKg.toFixed(3)} ${weightProduct.unit || 'kg'})`);
          return true;
        }
      }
    }

    // 2. Standard Barcode or SKU exact lookup (also supports leading-zero stripped EAN-13/UPC-A match)
    const cleanCode = code.toLowerCase();
    const strippedCode = cleanCode.replace(/^0+/, '');
    const found = products.find((p) => {
      const b = String(p.barcode || '').trim().toLowerCase();
      const s = String(p.sku || '').trim().toLowerCase();
      if (!b && !s) return false;
      return (
        b === cleanCode ||
        s === cleanCode ||
        (strippedCode && b.replace(/^0+/, '') === strippedCode) ||
        (strippedCode && s.replace(/^0+/, '') === strippedCode)
      );
    });

    if (found) {
      this.playScannerBeep(true);
      this.handleProductTileClick(found.id);
      this.toast(`Scan Barcode: ${found.name} (${this.formatIDR(found.price)})`);
      return true;
    } else {
      this.playScannerBeep(false);
      this.toast(`Barang dengan kode/barcode "${code}" tidak ditemukan`, 'error');
      return false;
    }
  }

  onPosSearchInput(val) {
    this.posSearch = val;
    const gridMount = document.getElementById('pos-products-grid-mount');
    if (gridMount) {
      gridMount.innerHTML = this.renderPOSProductsGridItems();
    }
  }

  onPosSearchKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const raw = (event.target?.value || this.posSearch || '').trim();
    if (!raw) return;

    // First try exact barcode / SKU / weight barcode scan
    const matchedBarcode = this.processBarcodeScan(raw);
    if (matchedBarcode) {
      this.posSearch = '';
      if (event.target) event.target.value = '';
      this.onPosSearchInput('');
      return;
    }

    // If not an exact barcode, check if only 1 product matches the search filter
    const q = raw.toLowerCase();
    const matches = this.db.getCollection('products').filter((p) => {
      if (this.posCategory !== 'ALL' && p.category_id !== this.posCategory) return false;
      return (
        (p.name || '').toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.barcode || '').toLowerCase().includes(q)
      );
    });
    if (matches.length === 1) {
      this.playScannerBeep(true);
      this.handleProductTileClick(matches[0].id);
      this.posSearch = '';
      if (event.target) event.target.value = '';
      this.onPosSearchInput('');
    }
  }

  /* ========================================================================
     1D BARCODE (CODE-128B SVG) & CAMERA SCANNER ENGINE
     ======================================================================== */
  renderBarcodeSVG(codeStr, height = 38) {
    const text = String(codeStr || 'POSTIKA').trim();
    if (!text) return '';
    // Standard Code-128 Set B patterns (values 0..106)
    const PATTERNS = [
      '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
      '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
      '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
      '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
      '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
      '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
      '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
      '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
      '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
      '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
      '114131','311141','411131','211412','211214','211232','2331112'
    ];
    const codes = [104]; // Start Code B
    let checksum = 104;
    for (let i = 0; i < text.length; i++) {
      let cc = text.charCodeAt(i) - 32;
      if (cc < 0 || cc > 94) cc = 0;
      codes.push(cc);
      checksum += cc * (i + 1);
    }
    codes.push(checksum % 103);
    codes.push(106); // Stop

    let x = 10;
    const rects = [];
    for (const c of codes) {
      const pat = PATTERNS[c] || PATTERNS[0];
      for (let i = 0; i < pat.length; i++) {
        const w = Number(pat[i]) * 1.6;
        if (i % 2 === 0) {
          rects.push(`<rect x="${x.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="${height}" fill="#0f172a" />`);
        }
        x += w;
      }
    }
    const totalW = Math.ceil(x + 10);
    return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${height + 22}" style="max-width:100%;height:${height + 22}px;background:#fff;border-radius:6px;border:1px solid #e2e8f0;padding:2px;">
        ${rects.join('')}
        <text x="${(totalW / 2).toFixed(1)}" y="${height + 17}" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="#0f172a">${this.escapeHtml(text)}</text>
      </svg>
    `;
  }

  openBarcodeScannerModal(targetInputId = null) {
    this.stopCameraBarcodeScanner();
    this._barcodeTargetInputId = targetInputId || null;
    const products = this.db.getCollection('products').slice(0, 6);

    this.openModal(
      targetInputId ? '📷 Scan Barcode Barang via Kamera / USB' : '📷 Scan Barcode / QR Code (Kamera & Scanner USB)',
      `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
          <!-- Left: Live Camera Viewfinder -->
          <div style="background:#0f172a;border-radius:12px;padding:12px;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;min-height:240px;">
            <div id="camera-scanner-viewport" style="width:100%;position:relative;overflow:hidden;border-radius:8px;background:#020617;min-height:200px;display:flex;align-items:center;justify-content:center;">
              <video id="barcode-camera-video" autoplay playsinline muted style="width:100%;max-height:240px;object-fit:cover;display:none;"></video>
              <div id="barcode-laser-line" style="display:none;position:absolute;left:8%;right:8%;top:50%;height:2px;background:#ef4444;box-shadow:0 0 8px 2px #ef4444;pointer-events:none;"></div>
              <div id="camera-scanner-status" style="padding:16px;text-align:center;font-size:12.5px;color:#94a3b8;">
                Menyiapkan kamera pemindai barcode...
              </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;width:100%;justify-content:center;">
              <button class="btn btn-sm btn-primary" onclick="window.posApp.startCameraBarcodeScanner()">📹 Aktifkan Kamera</button>
              <button class="btn btn-sm btn-secondary" onclick="window.posApp.switchCameraFacingMode()">🔄 Ganti Kamera</button>
              <label class="btn btn-sm btn-warning" style="cursor:pointer;margin:0;">
                📸 Foto Barcode
                <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="window.posApp.scanBarcodeFromImageFile(event)" />
              </label>
            </div>
          </div>

          <!-- Right: Manual / USB Input & Visual Test Barcodes -->
          <div>
            <div class="form-group">
              <label>Ketik atau Scan dengan Alat Scanner USB / Bluetooth</label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="manual-barcode-input" class="form-control"
                  placeholder="Contoh: 8991001000011 atau 2010001007505" autofocus
                  onkeydown="if(event.key==='Enter'){event.preventDefault();window.posApp.submitManualBarcode();}" />
                <button class="btn btn-primary" onclick="window.posApp.submitManualBarcode()">Proses</button>
              </div>
              <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">
                💡 Arahkan kamera ke barcode produk, atau langsung tembak barcode menggunakan scanner fisik USB/Bluetooth lalu tekan Enter.
              </div>
            </div>

            <div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:10px;font-size:12px;">
              <strong>🏷️ Klik Barcode Produk untuk Uji Scan Cepat:</strong>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:8px;margin-top:8px;max-height:195px;overflow-y:auto;">
                ${products
                  .map(
                    (p) => `
                  <div onclick="window.posApp.testScanCode('${this.escapeHtml(p.barcode || p.sku)}')"
                    style="cursor:pointer;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px;text-align:center;transition:0.15s;"
                    title="Klik untuk memindai ${this.escapeHtml(p.name)}">
                    <div style="font-weight:700;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;">
                      ${this.escapeHtml(p.name)}
                    </div>
                    ${this.renderBarcodeSVG(p.barcode || p.sku, 26)}
                  </div>
                `
                  )
                  .join('')}
                <div onclick="window.posApp.testScanCode('2010001007505')"
                  style="cursor:pointer;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px;text-align:center;">
                  <div style="font-weight:700;font-size:11px;color:#db2777;margin-bottom:4px;">⚖️ Kopi Gayo 0.750kg</div>
                  ${this.renderBarcodeSVG('2010001007505', 26)}
                </div>
              </div>
            </div>
          </div>
        </div>
      `,
      `<button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup Pemindai</button>`,
      true
    );

    setTimeout(() => {
      this.startCameraBarcodeScanner();
    }, 80);
  }

  async switchCameraFacingMode() {
    this._cameraFacingMode = this._cameraFacingMode === 'user' ? 'environment' : 'user';
    await this.startCameraBarcodeScanner();
  }

  stopCameraBarcodeScanner() {
    if (this._scanAnimFrame) {
      cancelAnimationFrame(this._scanAnimFrame);
      this._scanAnimFrame = null;
    }
    if (this._cameraStream) {
      try {
        this._cameraStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      this._cameraStream = null;
    }
  }

  async startCameraBarcodeScanner() {
    this.stopCameraBarcodeScanner();
    const video = document.getElementById('barcode-camera-video');
    const laser = document.getElementById('barcode-laser-line');
    const statusEl = document.getElementById('camera-scanner-status');
    if (!video || !statusEl) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isInsecureOrigin = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
      statusEl.innerHTML = isInsecureOrigin
        ? `<div style="color:#fbbf24;margin-bottom:6px;">⚠️ Browser membatasi kamera langsung pada koneksi HTTP lokal (${this.escapeHtml(location.origin)}).</div>
           <div>Gunakan tombol <strong>📸 Foto Barcode</strong> di bawah, atau buka melalui <strong>Link Publik HTTPS</strong> di menu Sinkronisasi.</div>`
        : `Kamera tidak tersedia di perangkat ini. Gunakan tombol <strong>📸 Foto Barcode</strong> atau scanner USB/Bluetooth.`;
      return;
    }

    try {
      const facing = this._cameraFacingMode || 'environment';
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      this._cameraStream = stream;
      video.srcObject = stream;
      video.style.display = 'block';
      if (laser) laser.style.display = 'block';
      statusEl.style.display = 'none';
      await video.play();

      // Prepare native BarcodeDetector if available, or fallback canvas scanline decoder
      let detector = null;
      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'itf', 'codabar']
          });
        } catch (_) {
          try {
            detector = new window.BarcodeDetector();
          } catch (_) {}
        }
      }

      const offCanvas = document.createElement('canvas');
      const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

      const scanFrame = async () => {
        if (!this._cameraStream || !this.modalOpen) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            if (detector) {
              const results = await detector.detect(video);
              if (results && results.length > 0 && results[0].rawValue) {
                const rawVal = results[0].rawValue;
                this.stopCameraBarcodeScanner();
                this.closeModal();
                this.processBarcodeScan(rawVal);
                return;
              }
            }
            // Also run lightweight 1D EAN-13 scanline decoder on center strip
            const decoded1D = this.decodeEAN13FromVideoOrImage(video, offCanvas, offCtx);
            if (decoded1D) {
              this.stopCameraBarcodeScanner();
              this.closeModal();
              this.processBarcodeScan(decoded1D);
              return;
            }
          } catch (_) {}
        }
        this._scanAnimFrame = requestAnimationFrame(scanFrame);
      };

      this._scanAnimFrame = requestAnimationFrame(scanFrame);
    } catch (err) {
      video.style.display = 'none';
      if (laser) laser.style.display = 'none';
      statusEl.style.display = 'block';
      statusEl.innerHTML = `
        <div style="color:#f87171;margin-bottom:6px;">Tidak dapat mengakses kamera (${this.escapeHtml(err.message || 'Izin ditolak')}).</div>
        <div>Klik <strong>📸 Foto Barcode</strong> di bawah atau ketik/scan kode barcode secara langsung.</div>
      `;
    }
  }

  async scanBarcodeFromImageFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const targetId = this._barcodeTargetInputId;
    const applyScanned = (code) => {
      if (targetId && document.getElementById(targetId)) {
        const inp = document.getElementById(targetId);
        inp.value = code;
        const prev = document.getElementById('prd-barcode-preview');
        if (prev) prev.innerHTML = this.renderBarcodeSVG(code, 28);
        this._barcodeTargetInputId = null;
        this.playScannerBeep(true);
        this.toast(`Barcode berhasil dipindai: ${code}`);
      } else {
        this.closeModal();
        this.processBarcodeScan(code);
      }
    };

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      URL.revokeObjectURL(url);
      // 1. Try native BarcodeDetector first
      if ('BarcodeDetector' in window) {
        try {
          const det = new window.BarcodeDetector();
          const res = await det.detect(img);
          if (res && res.length > 0 && res[0].rawValue) {
            applyScanned(res[0].rawValue);
            return;
          }
        } catch (_) {}
      }
      // 2. Try built-in 1D EAN-13 scanline decoder across multiple horizontal lines
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const code = this.decodeEAN13FromVideoOrImage(img, canvas, ctx);
      if (code) {
        applyScanned(code);
        return;
      }
      this.toast('Barcode pada gambar kurang jelas. Pastikan barcode fokus dan terang, atau ketik kodenya.', 'error');
    };
    img.src = url;
  }

  decodeEAN13FromVideoOrImage(source, canvas, ctx) {
    const w = source.videoWidth || source.naturalWidth || source.width || 0;
    const h = source.videoHeight || source.naturalHeight || source.height || 0;
    if (w < 100 || h < 40) return null;

    canvas.width = Math.min(w, 640);
    canvas.height = Math.min(h, 360);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const L_CODES = {
      '0001101': 0, '0011001': 1, '0010011': 2, '0111101': 3, '0100011': 4,
      '0110001': 5, '0101111': 6, '0111011': 7, '0110111': 8, '0001011': 9
    };
    const G_CODES = {
      '0100111': 0, '0110011': 1, '0011011': 2, '0100001': 3, '0011101': 4,
      '0111001': 5, '0000101': 6, '0010001': 7, '0001001': 8, '0010111': 9
    };
    const R_CODES = {
      '1110010': 0, '1100110': 1, '1101100': 2, '1000010': 3, '1011100': 4,
      '1001110': 5, '1010000': 6, '1000100': 7, '1001000': 8, '1110100': 9
    };
    const PARITY = {
      'LLLLLL': 0, 'LLGLGG': 1, 'LLGGLG': 2, 'LLGGGL': 3, 'LGLLGG': 4,
      'LGGLLG': 5, 'LGGGLL': 6, 'LGLGLG': 7, 'LGLGGL': 8, 'LGGLGL': 9
    };

    const scanRows = [0.5, 0.4, 0.6, 0.3, 0.7];
    for (const ratio of scanRows) {
      const y = Math.floor(canvas.height * ratio);
      const imgData = ctx.getImageData(0, y, canvas.width, 1).data;
      const gray = new Uint8Array(canvas.width);
      let min = 255;
      let max = 0;
      for (let x = 0; x < canvas.width; x++) {
        const g = (imgData[x * 4] * 77 + imgData[x * 4 + 1] * 150 + imgData[x * 4 + 2] * 29) >> 8;
        gray[x] = g;
        if (g < min) min = g;
        if (g > max) max = g;
      }
      if (max - min < 50) continue;
      const threshold = (min + max) >> 1;
      const bits = new Uint8Array(canvas.width);
      for (let x = 0; x < canvas.width; x++) {
        bits[x] = gray[x] < threshold ? 1 : 0; // 1 = black bar, 0 = white space
      }

      // Extract run lengths
      const runs = [];
      let curBit = bits[0];
      let runLen = 1;
      for (let x = 1; x < canvas.width; x++) {
        if (bits[x] === curBit) {
          runLen++;
        } else {
          runs.push({ bit: curBit, len: runLen });
          curBit = bits[x];
          runLen = 1;
        }
      }
      runs.push({ bit: curBit, len: runLen });

      // Look for EAN-13 start guard (101 = 3 runs: black, white, black of similar width) then 59 total runs
      for (let i = 0; i + 59 <= runs.length; i++) {
        if (runs[i].bit !== 1) continue;
        const r1 = runs[i].len;
        const r2 = runs[i + 1].len;
        const r3 = runs[i + 2].len;
        const unit = (r1 + r2 + r3) / 3;
        if (unit < 0.8 || Math.abs(r1 - unit) > unit * 0.7 || Math.abs(r2 - unit) > unit * 0.7 || Math.abs(r3 - unit) > unit * 0.7) {
          continue;
        }
        // Build 95-module bit string from 59 runs
        let bitStr = '';
        for (let k = 0; k < 59; k++) {
          const modCount = Math.max(1, Math.min(4, Math.round(runs[i + k].len / unit)));
          bitStr += String(runs[i + k].bit).repeat(modCount);
        }
        if (bitStr.length !== 95) continue;
        if (!bitStr.startsWith('101') || bitStr.slice(45, 50) !== '01010' || !bitStr.endsWith('101')) continue;

        let parityStr = '';
        let leftDigits = '';
        let valid = true;
        for (let d = 0; d < 6; d++) {
          const seg = bitStr.slice(3 + d * 7, 3 + (d + 1) * 7);
          if (L_CODES[seg] !== undefined) {
            parityStr += 'L';
            leftDigits += L_CODES[seg];
          } else if (G_CODES[seg] !== undefined) {
            parityStr += 'G';
            leftDigits += G_CODES[seg];
          } else {
            valid = false;
            break;
          }
        }
        if (!valid || PARITY[parityStr] === undefined) continue;

        let rightDigits = '';
        for (let d = 0; d < 6; d++) {
          const seg = bitStr.slice(50 + d * 7, 50 + (d + 1) * 7);
          if (R_CODES[seg] !== undefined) {
            rightDigits += R_CODES[seg];
          } else {
            valid = false;
            break;
          }
        }
        if (!valid) continue;

        const fullCode = `${PARITY[parityStr]}${leftDigits}${rightDigits}`;
        // Verify EAN-13 checksum
        let sum = 0;
        for (let c = 0; c < 12; c++) {
          sum += Number(fullCode[c]) * (c % 2 === 0 ? 1 : 3);
        }
        const check = (10 - (sum % 10)) % 10;
        if (check === Number(fullCode[12])) {
          return fullCode;
        }
      }
    }
    return null;
  }

  submitManualBarcode() {
    const val = document.getElementById('manual-barcode-input')?.value || '';
    if (!val.trim()) return;
    const targetInputId = this._barcodeTargetInputId;
    this.closeModal();
    this.processBarcodeScan(val.trim(), targetInputId);
  }

  testScanCode(code) {
    const targetInputId = this._barcodeTargetInputId;
    this.closeModal();
    this.processBarcodeScan(code, targetInputId);
  }

  /* ========================================================================
     POS CART, MODIFIERS, DISCOUNTS, TAXES & STOCK WARNINGS
     ======================================================================== */
  handleProductTileClick(productId) {
    const product = this.db.getById('products', productId);
    if (!product) return;

    const modIds = product.modifier_ids || [];
    const availableMods = modIds
      .map((id) => this.db.getById('modifiers', id))
      .filter(Boolean);

    if (availableMods.length > 0 || product.sold_by_weight) {
      this.openProductOptionsModal(product, availableMods);
    } else {
      this.addProductToCart(product, 1, []);
    }
  }

  openProductOptionsModal(product, availableMods) {
    const modsHtml = availableMods
      .map(
        (mod) => `
        <div class="form-group" style="margin-bottom:14px;">
          <label>${this.escapeHtml(mod.name)}</label>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:4px;">
            ${(mod.options || [])
              .map(
                (opt) => `
              <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-weight:500;">
                <input type="checkbox" class="pos-mod-checkbox"
                  data-group="${this.escapeHtml(mod.name)}"
                  data-id="${this.escapeHtml(opt.id)}"
                  data-name="${this.escapeHtml(opt.name)}"
                  data-price="${Number(opt.price || 0)}" />
                <span>${this.escapeHtml(opt.name)} ${opt.price > 0 ? `(+${this.formatIDR(opt.price)})` : ''}</span>
              </label>
            `
              )
              .join('')}
          </div>
        </div>
      `
      )
      .join('');

    this.openModal(
      `Tambah ke Keranjang: ${this.escapeHtml(product.name)}`,
      `
        <div class="form-grid">
          <div class="form-group">
            <label>Jumlah (${this.escapeHtml(product.unit || 'pcs')})</label>
            <input type="number" id="modal-item-qty" class="form-control" value="1" step="${product.sold_by_weight ? '0.05' : '1'}" min="0.001" />
          </div>
          <div class="form-group">
            <label>Catatan Item (Opsional)</label>
            <input type="text" id="modal-item-note" class="form-control" placeholder="Contoh: Pisah sambal / Es sedikit" />
          </div>
        </div>
        ${modsHtml}
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posApp.confirmAddWithModifiers('${product.id}')">Tambahkan ke Keranjang</button>
      `
    );
  }

  confirmAddWithModifiers(productId) {
    const product = this.db.getById('products', productId);
    if (!product) return;
    const qty = Math.max(0.001, Number(document.getElementById('modal-item-qty')?.value || 1));
    const note = (document.getElementById('modal-item-note')?.value || '').trim();
    const checks = Array.from(document.querySelectorAll('.pos-mod-checkbox:checked'));
    const chosenMods = checks.map((c) => ({
      id: c.dataset.id,
      group_name: c.dataset.group,
      name: c.dataset.name,
      price: Number(c.dataset.price || 0)
    }));
    this.closeModal();
    this.addProductToCart(product, qty, chosenMods, note);
  }

  addProductToCart(product, qty = 1, modifiers = [], note = '') {
    const settings = this.db.getSettings();
    const modKey = modifiers
      .map((m) => m.id)
      .sort()
      .join('|');
    const existingIdx = this.cart.findIndex(
      (c) => c.product_id === product.id && c.mod_key === modKey && c.note === note && c.price === Number(product.price)
    );

    const currentQtyInCart = this.cart
      .filter((c) => c.product_id === product.id)
      .reduce((acc, c) => acc + Number(c.qty || 0), 0);

    if (
      settings.features?.negative_stock_warning !== false &&
      product.track_stock !== false &&
      currentQtyInCart + qty > Number(product.stock || 0)
    ) {
      this.toast(
        `Peringatan Stok Tidak Mencukupi: Sisa stok ${product.name} hanya ${product.stock} ${product.unit || 'pcs'}!`,
        'error'
      );
      if (Number(product.stock || 0) <= 0) {
        return;
      }
    }

    const modTotalUnit = modifiers.reduce((a, b) => a + Number(b.price || 0), 0);

    if (existingIdx >= 0) {
      this.cart[existingIdx].qty = Math.round((this.cart[existingIdx].qty + qty) * 1000) / 1000;
    } else {
      this.cart.push({
        cart_line_id: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        product_id: product.id,
        name: product.name,
        sku: product.sku || '',
        category_id: product.category_id || '',
        unit: product.unit || 'pcs',
        cost: Number(product.cost || 0),
        price: Number(product.price || 0),
        original_price: Number(product.price || 0),
        qty: Math.round(qty * 1000) / 1000,
        modifiers,
        mod_key: modKey,
        modifier_total_unit: modTotalUnit,
        line_discount: 0,
        tax_ids: product.tax_ids || [],
        note
      });
    }

    this.syncCartWithCustomerDisplay();
    this.renderMainViewOnly();
  }

  changeCartQty(lineId, delta) {
    const idx = this.cart.findIndex((c) => c.cart_line_id === lineId);
    if (idx < 0) return;
    const item = this.cart[idx];
    const newQty = Math.round((item.qty + delta) * 1000) / 1000;
    if (newQty <= 0) {
      this.cart.splice(idx, 1);
    } else {
      const product = this.db.getById('products', item.product_id);
      const settings = this.db.getSettings();
      if (
        delta > 0 &&
        settings.features?.negative_stock_warning !== false &&
        product &&
        product.track_stock !== false &&
        newQty > Number(product.stock || 0)
      ) {
        this.toast(`Peringatan: Stok tersedia ${product.name} hanya ${product.stock}`, 'error');
      }
      item.qty = newQty;
    }
    this.syncCartWithCustomerDisplay();
    this.renderMainViewOnly();
  }

  openCartItemEditModal(lineId) {
    const item = this.cart.find((c) => c.cart_line_id === lineId);
    if (!item) return;
    const canEditPrice = this.hasPermission('edit_price');

    this.openModal(
      `Edit Item Keranjang: ${this.escapeHtml(item.name)}`,
      `
        <div class="form-grid">
          <div class="form-group">
            <label>Jumlah (${this.escapeHtml(item.unit || 'pcs')})</label>
            <input type="number" id="edit-cart-qty" class="form-control" value="${item.qty}" step="0.01" min="0.001" />
          </div>
          <div class="form-group">
            <label>Harga Satuan (Rp) ${!canEditPrice ? '<span class="badge badge-warning">Butuh Hak Akses</span>' : ''}</label>
            <input type="number" id="edit-cart-price" class="form-control" value="${item.price}" />
          </div>
          <div class="form-group">
            <label>Diskon Item (Nominal Rp)</label>
            <input type="number" id="edit-cart-disc" class="form-control" value="${item.line_discount || 0}" min="0" />
          </div>
          <div class="form-group">
            <label>Catatan Item</label>
            <input type="text" id="edit-cart-note" class="form-control" value="${this.escapeHtml(item.note || '')}" />
          </div>
        </div>
      `,
      `
        <button class="btn btn-danger" onclick="window.posApp.removeCartLine('${lineId}')">Hapus Item</button>
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posApp.saveCartItemEdit('${lineId}')">Simpan Perubahan</button>
      `
    );
  }

  removeCartLine(lineId) {
    this.cart = this.cart.filter((c) => c.cart_line_id !== lineId);
    this.closeModal();
    this.syncCartWithCustomerDisplay();
    this.renderMainViewOnly();
  }

  saveCartItemEdit(lineId) {
    const item = this.cart.find((c) => c.cart_line_id === lineId);
    if (!item) return;
    const newQty = Math.max(0.001, Number(document.getElementById('edit-cart-qty')?.value || 1));
    const newPrice = Math.max(0, Number(document.getElementById('edit-cart-price')?.value || 0));
    const newDisc = Math.max(0, Number(document.getElementById('edit-cart-disc')?.value || 0));
    const newNote = (document.getElementById('edit-cart-note')?.value || '').trim();

    const applyChanges = () => {
      item.qty = newQty;
      item.price = newPrice;
      item.line_discount = newDisc;
      item.note = newNote;
      this.closeModal();
      this.syncCartWithCustomerDisplay();
      this.renderMainViewOnly();
      this.toast('Item keranjang diperbarui');
    };

    if (newPrice !== item.price && !this.hasPermission('edit_price')) {
      this.closeModal();
      this.requirePermissionOrSupervisorPin('edit_price', `Mengubah harga ${item.name} menjadi ${this.formatIDR(newPrice)}`, applyChanges);
      return;
    }
    applyChanges();
  }

  calculateCartTotals() {
    let subtotal = 0;
    let lineDiscountsTotal = 0;

    for (const item of this.cart) {
      const unitFull = Number(item.price || 0) + Number(item.modifier_total_unit || 0);
      const lineSub = unitFull * Number(item.qty || 0);
      subtotal += lineSub;
      lineDiscountsTotal += Number(item.line_discount || 0);
    }

    let orderDiscount = Number(this.cartManualDiscount || 0);
    let discountName = orderDiscount > 0 ? 'Diskon Manual' : '';
    if (this.cartDiscountId) {
      const dObj = this.db.getById('discounts', this.cartDiscountId);
      if (dObj && dObj.active !== false) {
        discountName = dObj.name;
        const baseForOrderDisc = Math.max(0, subtotal - lineDiscountsTotal);
        if (dObj.type === 'PERCENTAGE') {
          orderDiscount += Math.round((baseForOrderDisc * Number(dObj.value || 0)) / 100);
        } else {
          orderDiscount += Number(dObj.value || 0);
        }
      }
    }

    const discountTotal = Math.min(subtotal, lineDiscountsTotal + orderDiscount);
    const netAfterDiscount = Math.max(0, subtotal - discountTotal);

    // Calculate taxes per item or active default taxes
    const allTaxes = this.db.getCollection('taxes').filter((t) => t.active !== false);
    const taxesMap = {};
    let addedTaxTotal = 0;
    let includedTaxTotal = 0;

    for (const item of this.cart) {
      const unitFull = Number(item.price || 0) + Number(item.modifier_total_unit || 0);
      const itemGross = unitFull * Number(item.qty || 0);
      const shareRatio = subtotal > 0 ? itemGross / subtotal : 0;
      const itemNet = Math.max(0, itemGross - discountTotal * shareRatio);

      const itemTaxIds = Array.isArray(item.tax_ids) && item.tax_ids.length > 0
        ? item.tax_ids
        : allTaxes.filter((t) => t.is_default).map((t) => t.id);

      for (const tid of itemTaxIds) {
        const tObj = allTaxes.find((t) => t.id === tid);
        if (!tObj) continue;
        const rate = Number(tObj.rate || 0);
        let taxAmt = 0;
        if (tObj.type === 'INCLUDED') {
          taxAmt = Math.round(itemNet - itemNet / (1 + rate / 100));
          includedTaxTotal += taxAmt;
        } else {
          taxAmt = Math.round((itemNet * rate) / 100);
          addedTaxTotal += taxAmt;
        }
        if (!taxesMap[tObj.id]) {
          taxesMap[tObj.id] = { id: tObj.id, name: tObj.name, rate, type: tObj.type, amount: 0 };
        }
        taxesMap[tObj.id].amount += taxAmt;
      }
    }

    const total = Math.round(netAfterDiscount + addedTaxTotal);
    return {
      subtotal: Math.round(subtotal),
      discount_total: Math.round(discountTotal),
      discount_name: discountName,
      tax_total: Math.round(addedTaxTotal + includedTaxTotal),
      added_tax_total: Math.round(addedTaxTotal),
      included_tax_total: Math.round(includedTaxTotal),
      taxes_applied: Object.values(taxesMap),
      total
    };
  }

  clearCart() {
    this.cart = [];
    this.cartDiscountId = '';
    this.cartManualDiscount = 0;
    this.cartNotes = '';
    this.activeOpenTicketId = null;
    this.activeOpenTicketName = '';
    this.syncCartWithCustomerDisplay();
    this.renderMainViewOnly();
  }

  syncCartWithCustomerDisplay() {
    const settings = this.db.getSettings();
    if (settings.features?.customer_display === false) return;
    const totals = this.calculateCartTotals();
    const cust = this.db.getById('customers', this.cartCustomerId);
    const payload = {
      items: this.cart,
      totals,
      customer_name: cust ? cust.name : 'Pelanggan Umum',
      dining_option: this.cartDiningOption,
      store_name: settings.store_name || 'POS TIKA',
      qris_merchant_name: settings.qris_merchant_name || 'POS TIKA',
      updated_at: this.db.nowJakartaISO()
    };
    this.sync.broadcastCartToCustomerDisplay(payload);
  }

  onCustomerDisplayUpdate(cartState) {
    this._latestCustomerDisplayCart = cartState;
    if (this.isCustomerDisplayMode) {
      this.render();
    }
  }

  /* ========================================================================
     OPEN TICKETS (TIKET TERBUKA) & KITCHEN PRINTER
     ======================================================================== */
  openSaveTicketModal() {
    if (this.cart.length === 0) {
      this.toast('Keranjang masih kosong!', 'error');
      return;
    }
    this.openModal(
      'Simpan Tiket Terbuka (Pesanan Belum Dibayar)',
      `
        <div class="form-group">
          <label>Nama Tiket / Nomor Meja / Nama Pelanggan</label>
          <input type="text" id="open-ticket-name" class="form-control" value="${this.escapeHtml(this.activeOpenTicketName || 'Meja 01')}" placeholder="Contoh: Meja 05 - Bapak Hendra" autofocus />
        </div>
        <div class="form-group">
          <label>Catatan Pesanan / Dapur</label>
          <textarea id="open-ticket-notes" class="form-control" rows="2" placeholder="Catatan untuk dapur atau kasir">${this.escapeHtml(this.cartNotes || '')}</textarea>
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="window.posApp.saveOpenTicket(false)">💾 Simpan Tiket</button>
        ${
          this.db.getSettings().features?.kitchen_printer !== false
            ? `<button class="btn btn-warning" onclick="window.posApp.saveOpenTicket(true)">🍳 Simpan & Cetak Dapur</button>`
            : ''
        }
      `
    );
  }

  async saveOpenTicket(printKitchen = false) {
    const name = (document.getElementById('open-ticket-name')?.value || '').trim() || 'Tiket Tanpa Nama';
    const notes = (document.getElementById('open-ticket-notes')?.value || '').trim();
    const totals = this.calculateCartTotals();
    const cust = this.db.getById('customers', this.cartCustomerId);

    const ticketObj = {
      id: this.activeOpenTicketId || `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      customer_id: this.cartCustomerId,
      customer_name: cust ? cust.name : 'Pelanggan Umum',
      dining_option: this.cartDiningOption,
      items: JSON.parse(JSON.stringify(this.cart)),
      discount_id: this.cartDiscountId,
      manual_discount: this.cartManualDiscount,
      notes,
      total: totals.total,
      employee_id: this.currentUser?.id || 'emp_tika',
      employee_name: this.currentUser?.name || 'TIKA',
      created_at: this.db.nowJakartaISO()
    };

    await this.db.upsert('open_tickets', ticketObj);
    if (printKitchen) {
      await this.sendToKitchenPrinter(ticketObj);
    }
    this.closeModal();
    this.clearCart();
    this.toast(`Tiket "${name}" berhasil disimpan`);
  }

  async sendToKitchenPrinter(ticketOrOrder) {
    const kOrder = {
      id: `kit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ticket_name: ticketOrOrder.name || ticketOrOrder.receipt_number || 'Pesanan Baru',
      dining_option: ticketOrOrder.dining_option || this.cartDiningOption,
      items: ticketOrOrder.items || this.cart,
      notes: ticketOrOrder.notes || this.cartNotes,
      waiter_name: this.currentUser?.name || 'TIKA',
      status: 'PRINTED',
      created_at: this.db.nowJakartaISO()
    };
    await this.db.upsert('kitchen_orders', kOrder);

    const printMount = document.getElementById('print-mount');
    if (printMount) {
      printMount.innerHTML = `
        <div class="receipt-paper">
          <div class="receipt-center">
            <h3 style="font-size:15px;font-weight:800;">TIKET DAPUR - POS TIKA</h3>
            <p><strong>${this.escapeHtml(kOrder.ticket_name)}</strong> (${this.escapeHtml(kOrder.dining_option)})</p>
            <p>${this.formatDateTime(kOrder.created_at)}</p>
          </div>
          <div class="receipt-divider"></div>
          ${(kOrder.items || [])
            .map(
              (it) => `
            <div style="margin-bottom:6px;">
              <div style="font-weight:800;font-size:14px;">${it.qty}x ${this.escapeHtml(it.name)}</div>
              ${(it.modifiers || []).map((m) => `<div style="font-size:11px;">  + ${this.escapeHtml(m.name)}</div>`).join('')}
              ${it.note ? `<div style="font-size:11px;font-style:italic;">  Catatan: ${this.escapeHtml(it.note)}</div>` : ''}
            </div>
          `
            )
            .join('')}
          ${kOrder.notes ? `<div class="receipt-divider"></div><div>Catatan: ${this.escapeHtml(kOrder.notes)}</div>` : ''}
        </div>
      `;
      window.print();
    }
  }

  openTicketsListModal() {
    const tickets = this.db.getCollection('open_tickets');
    this.openModal(
      `Daftar Tiket Terbuka (${tickets.length} Pesanan Belum Dibayar)`,
      `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Tiket / Meja</th>
                <th>Jenis</th>
                <th>Pelanggan</th>
                <th>Total</th>
                <th>Waktu</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${
                tickets.length === 0
                  ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Tidak ada tiket terbuka saat ini</td></tr>`
                  : tickets
                      .map(
                        (t) => `
                <tr>
                  <td><strong>${this.escapeHtml(t.name)}</strong></td>
                  <td>${this.escapeHtml(t.dining_option || 'Dine In')}</td>
                  <td>${this.escapeHtml(t.customer_name || '-')}</td>
                  <td><strong>${this.formatIDR(t.total)}</strong></td>
                  <td>${this.formatDateTime(t.created_at)}</td>
                  <td style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-primary" onclick="window.posApp.loadOpenTicket('${t.id}')">Buka / Bayar</button>
                    <button class="btn btn-sm btn-danger" onclick="window.posApp.deleteOpenTicket('${t.id}')">Hapus</button>
                  </td>
                </tr>
              `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      `,
      `<button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup</button>`
    );
  }

  loadOpenTicket(ticketId) {
    const t = this.db.getById('open_tickets', ticketId);
    if (!t) return;
    this.cart = JSON.parse(JSON.stringify(t.items || []));
    this.cartCustomerId = t.customer_id || 'cust_umum';
    this.cartDiningOption = t.dining_option || 'Dine In';
    this.cartDiscountId = t.discount_id || '';
    this.cartManualDiscount = Number(t.manual_discount || 0);
    this.cartNotes = t.notes || '';
    this.activeOpenTicketId = t.id;
    this.activeOpenTicketName = t.name;
    this.closeModal();
    this.syncCartWithCustomerDisplay();
    this.renderMainViewOnly();
    this.toast(`Tiket "${t.name}" dimuat ke keranjang`);
  }

  async deleteOpenTicket(ticketId) {
    await this.db.delete('open_tickets', ticketId);
    this.openTicketsListModal();
    this.renderMainViewOnly();
  }

  /* ========================================================================
     PAYMENT CHECKOUT (TUNAI, TRANSFER, QRIS, CAMPURAN / SPLIT PAYMENT)
     ======================================================================== */
  openPaymentModal() {
    if (this.cart.length === 0) {
      this.toast('Pilih minimal 1 barang untuk melakukan pembayaran!', 'error');
      return;
    }
    const totals = this.calculateCartTotals();
    const settings = this.db.getSettings();
    const banks = settings.bank_accounts || [{ bank: 'BCA', number: '8720192831', holder: 'TIKA' }];

    this.paymentState = {
      method: 'TUNAI', // 'TUNAI', 'TRANSFER', 'QRIS', 'CAMPURAN'
      cashReceived: totals.total,
      bankName: banks[0]?.bank || 'BCA',
      bankRef: '',
      splitCash: Math.round(totals.total / 2),
      splitNonCashMethod: 'QRIS',
      splitNonCashAmount: totals.total - Math.round(totals.total / 2)
    };

    this.renderPaymentModalContent(totals, settings);
  }

  renderPaymentModalContent(totals, settings) {
    const st = this.paymentState;
    const change = Math.max(0, Number(st.cashReceived || 0) - totals.total);

    let methodDetailHtml = '';
    if (st.method === 'TUNAI') {
      const quickAmounts = [
        totals.total,
        Math.ceil(totals.total / 10000) * 10000,
        50000,
        100000,
        200000
      ].filter((v, idx, arr) => v >= totals.total && arr.indexOf(v) === idx);

      methodDetailHtml = `
        <div class="form-group">
          <label>Uang Tunai Diterima (Rp)</label>
          <input type="number" id="pay-cash-input" class="form-control" style="font-size:18px;font-weight:800;"
            value="${st.cashReceived}" oninput="window.posApp.updateCashReceived(this.value)" />
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
          ${quickAmounts
            .map(
              (amt) => `
            <button class="btn btn-sm btn-secondary" onclick="window.posApp.setQuickCash(${amt})">
              ${amt === totals.total ? 'Uang Pas (' + this.formatIDR(amt) + ')' : this.formatIDR(amt)}
            </button>
          `
            )
            .join('')}
        </div>
        <div style="background:var(--primary-soft);border:1px solid var(--primary);padding:14px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;color:var(--primary-darker)">Uang Kembalian:</span>
          <span id="pay-change-display" style="font-size:20px;font-weight:800;color:var(--primary-dark)">${this.formatIDR(change)}</span>
        </div>
      `;
    } else if (st.method === 'TRANSFER') {
      const banks = settings.bank_accounts || [{ bank: 'BCA', number: '8720192831', holder: 'TIKA' }];
      methodDetailHtml = `
        <div class="form-group">
          <label>Pilih Rekening Bank Tujuan (a.n. TIKA)</label>
          <select id="pay-bank-select" class="form-control" onchange="window.posApp.paymentState.bankName=this.value">
            ${banks
              .map(
                (b) => `
              <option value="${this.escapeHtml(b.bank)}" ${st.bankName === b.bank ? 'selected' : ''}>
                Bank ${this.escapeHtml(b.bank)} - ${this.escapeHtml(b.number)} (a.n. ${this.escapeHtml(b.holder)})
              </option>
            `
              )
              .join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Nomor Referensi / Catatan Transfer (Opsional)</label>
          <input type="text" id="pay-bank-ref" class="form-control" value="${this.escapeHtml(st.bankRef)}"
            oninput="window.posApp.paymentState.bankRef=this.value" placeholder="Contoh: TRF-998123" />
        </div>
      `;
    } else if (st.method === 'QRIS') {
      methodDetailHtml = `
        <div style="text-align:center;padding:12px;background:#f8fafc;border:1px solid var(--border);border-radius:12px;">
          <div style="font-weight:800;font-size:15px;color:#0f172a;">${this.escapeHtml(settings.qris_merchant_name || 'POS TIKA OFFICIAL')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">NMID: ${this.escapeHtml(settings.qris_nmid || 'ID1026000889901')}</div>
          <canvas id="qris-payment-canvas" width="180" height="180" style="background:#fff;padding:8px;border:1px solid var(--border);border-radius:8px;"></canvas>
          <div style="margin-top:8px;font-weight:800;font-size:16px;color:var(--primary-dark);">Nominal QRIS: ${this.formatIDR(totals.total)}</div>
        </div>
      `;
    } else if (st.method === 'CAMPURAN') {
      methodDetailHtml = `
        <div class="form-grid">
          <div class="form-group">
            <label>Nominal Pembayaran 1: TUNAI (Rp)</label>
            <input type="number" id="split-cash-input" class="form-control" value="${st.splitCash}"
              oninput="window.posApp.updateSplitCash(this.value, ${totals.total})" />
          </div>
          <div class="form-group">
            <label>Metode Pembayaran 2 (Non-Tunai)</label>
            <select class="form-control" onchange="window.posApp.paymentState.splitNonCashMethod=this.value">
              <option value="QRIS" ${st.splitNonCashMethod === 'QRIS' ? 'selected' : ''}>QRIS</option>
              <option value="TRANSFER" ${st.splitNonCashMethod === 'TRANSFER' ? 'selected' : ''}>Transfer Bank</option>
            </select>
          </div>
        </div>
        <div style="background:#f8fafc;border:1px solid var(--border);padding:12px;border-radius:10px;display:flex;justify-content:space-between;">
          <span>Sisa Tagihan Non-Tunai (${st.splitNonCashMethod}):</span>
          <strong id="split-noncash-display" style="font-size:16px;color:var(--primary-dark)">${this.formatIDR(st.splitNonCashAmount)}</strong>
        </div>
      `;
    }

    this.openModal(
      `Pembayaran Transaksi - Total ${this.formatIDR(totals.total)}`,
      `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">
          ${['TUNAI', 'QRIS', 'TRANSFER', 'CAMPURAN']
            .map(
              (m) => `
            <button class="btn ${st.method === m ? 'btn-primary' : 'btn-secondary'}" onclick="window.posApp.selectPaymentMethod('${m}')">
              ${m === 'TUNAI' ? '💵 Tunai' : m === 'QRIS' ? '📱 QRIS' : m === 'TRANSFER' ? '🏦 Transfer' : '🔀 Campuran'}
            </button>
          `
            )
            .join('')}
        </div>
        ${methodDetailHtml}
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
        <button class="btn btn-primary btn-lg" onclick="window.posApp.completeTransaction()">✅ Selesaikan Pembayaran (${this.formatIDR(totals.total)})</button>
      `
    );

    if (st.method === 'QRIS') {
      setTimeout(() => {
        this.drawQRCodeCanvas('qris-payment-canvas', `00020101021226580014ID.CO.POSTIKA.WWW0118936009143123456789520458125303360540${totals.total}5802ID5908POS TIKA6007JAKARTA6304TIKA`);
      }, 30);
    }
  }

  selectPaymentMethod(method) {
    this.paymentState.method = method;
    this.renderPaymentModalContent(this.calculateCartTotals(), this.db.getSettings());
  }

  updateCashReceived(val) {
    const totals = this.calculateCartTotals();
    this.paymentState.cashReceived = Number(val || 0);
    const change = Math.max(0, this.paymentState.cashReceived - totals.total);
    const el = document.getElementById('pay-change-display');
    if (el) el.textContent = this.formatIDR(change);
  }

  setQuickCash(amt) {
    this.paymentState.cashReceived = amt;
    this.renderPaymentModalContent(this.calculateCartTotals(), this.db.getSettings());
  }

  updateSplitCash(val, total) {
    const cash = Math.max(0, Math.min(total, Number(val || 0)));
    this.paymentState.splitCash = cash;
    this.paymentState.splitNonCashAmount = Math.max(0, total - cash);
    const el = document.getElementById('split-noncash-display');
    if (el) el.textContent = this.formatIDR(this.paymentState.splitNonCashAmount);
  }

  async completeTransaction() {
    const totals = this.calculateCartTotals();
    const st = this.paymentState;

    if (st.method === 'TUNAI' && Number(st.cashReceived || 0) < totals.total) {
      this.toast('Uang tunai yang diterima kurang dari total tagihan!', 'error');
      return;
    }

    let payments = [];
    let cashReceived = totals.total;
    let changeAmount = 0;

    if (st.method === 'TUNAI') {
      cashReceived = Number(st.cashReceived || totals.total);
      changeAmount = Math.max(0, cashReceived - totals.total);
      payments = [{ method: 'TUNAI', amount: totals.total, received: cashReceived, change: changeAmount }];
    } else if (st.method === 'TRANSFER') {
      payments = [{ method: `TRANSFER (${st.bankName})`, amount: totals.total, ref: st.bankRef || '' }];
    } else if (st.method === 'QRIS') {
      payments = [{ method: 'QRIS', amount: totals.total }];
    } else if (st.method === 'CAMPURAN') {
      payments = [
        { method: 'TUNAI', amount: Number(st.splitCash || 0) },
        { method: st.splitNonCashMethod, amount: Number(st.splitNonCashAmount || 0) }
      ];
    }

    const now = this.db.nowJakartaISO();
    const dateCompact = now.slice(0, 10).replace(/-/g, '');
    const seq = String(this.db.getCollection('transactions').length + 1).padStart(4, '0');
    const receiptNumber = `TIKA-${this.db.deviceId.slice(-4)}-${dateCompact}-${seq}`;
    const cust = this.db.getById('customers', this.cartCustomerId);

    const txObj = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      receipt_number: receiptNumber,
      type: 'SALE',
      status: 'COMPLETED',
      dining_option: this.cartDiningOption,
      customer_id: this.cartCustomerId,
      customer_name: cust ? cust.name : 'Pelanggan Umum',
      employee_id: this.currentUser?.id || 'emp_tika',
      employee_name: this.currentUser?.name || 'TIKA',
      device_id: this.db.deviceId,
      device_name: this.db.deviceName,
      items: JSON.parse(JSON.stringify(this.cart)),
      subtotal: totals.subtotal,
      discount_id: this.cartDiscountId,
      discount_name: totals.discount_name,
      discount_total: totals.discount_total,
      tax_total: totals.tax_total,
      taxes_applied: totals.taxes_applied,
      total: totals.total,
      payment_method: st.method,
      payments,
      cash_received: cashReceived,
      change_amount: changeAmount,
      notes: this.cartNotes,
      created_at: now
    };

    // 1. Save Transaction
    await this.db.upsert('transactions', txObj);

    // 2. Deduct stock automatically via atomic STOCK_DELTA operations
    for (const item of this.cart) {
      const prod = this.db.getById('products', item.product_id);
      if (prod && prod.track_stock !== false) {
        await this.db.adjustStock({
          product_id: prod.id,
          delta: -Number(item.qty || 0),
          reason: 'SALE',
          reference_id: receiptNumber,
          notes: `Penjualan Struk ${receiptNumber}`,
          employee_id: txObj.employee_id,
          employee_name: txObj.employee_name
        });
      }
    }

    // 3. Update Customer purchase statistics
    if (cust) {
      cust.total_transactions = Number(cust.total_transactions || 0) + 1;
      cust.total_spent = Number(cust.total_spent || 0) + totals.total;
      cust.points = Number(cust.points || 0) + Math.floor(totals.total / 10000);
      cust.last_visit = now;
      await this.db.upsert('customers', cust);
    }

    // 4. Update active Shift cash if paid with TUNAI or CAMPURAN
    const cashPortion = payments
      .filter((p) => p.method === 'TUNAI')
      .reduce((acc, p) => acc + Number(p.amount || 0), 0);
    if (cashPortion > 0) {
      const openShift = this.getActiveShift();
      if (openShift) {
        openShift.cash_sales = Number(openShift.cash_sales || 0) + cashPortion;
        openShift.expected_cash = Number(openShift.expected_cash || 0) + cashPortion;
        await this.db.upsert('shifts', openShift);
      }
    }

    // 5. Remove open ticket if this checkout came from an open ticket
    if (this.activeOpenTicketId) {
      await this.db.delete('open_tickets', this.activeOpenTicketId);
    }

    await this.db.logActivity(this.currentUser, 'SALE', `Transaksi ${receiptNumber} senilai ${this.formatIDR(totals.total)}`);

    this.clearCart();
    this.showReceiptModal(txObj.id);
    this.toast(`Transaksi ${receiptNumber} berhasil disimpan!`);
  }

  /* ========================================================================
     RECEIPT PREVIEW, THERMAL PRINTING, VOID & REFUND
     ======================================================================== */
  buildReceiptHTML(tx) {
    const settings = this.db.getSettings();
    return `
      <div class="receipt-paper" id="printable-receipt">
        <div class="receipt-center">
          <div style="font-size:16px;font-weight:800;">${this.escapeHtml(settings.store_name || 'POS TIKA')}</div>
          <div>${this.escapeHtml(settings.store_address || '')}</div>
          <div>Telp: ${this.escapeHtml(settings.store_phone || '')}</div>
          <div style="margin-top:4px;font-weight:700;">Pemilik: ${this.escapeHtml(settings.owner_name || 'TIKA')}</div>
        </div>
        <div class="receipt-divider"></div>
        <div class="receipt-line"><span>No. Struk:</span><strong>${this.escapeHtml(tx.receipt_number)}</strong></div>
        <div class="receipt-line"><span>Waktu:</span><span>${this.formatDateTime(tx.created_at)}</span></div>
        <div class="receipt-line"><span>Kasir:</span><span>${this.escapeHtml(tx.employee_name)}</span></div>
        <div class="receipt-line"><span>Pelanggan:</span><span>${this.escapeHtml(tx.customer_name || 'Pelanggan Umum')}</span></div>
        <div class="receipt-line"><span>Pesanan:</span><strong>${this.escapeHtml(tx.dining_option || 'Dine In')}</strong></div>
        ${tx.status === 'VOIDED' ? `<div style="text-align:center;font-weight:800;color:red;margin-top:4px;">*** TRANSAKSI DIBATALKAN (VOID) ***</div>` : ''}
        ${tx.type === 'REFUND' ? `<div style="text-align:center;font-weight:800;margin-top:4px;">*** STRUK PENGEMBALIAN (REFUND) ***</div>` : ''}
        <div class="receipt-divider"></div>
        ${(tx.items || [])
          .map((it) => {
            const unitFull = Number(it.price || 0) + Number(it.modifier_total_unit || 0);
            const lineTotal = unitFull * Number(it.qty || 0) - Number(it.line_discount || 0);
            return `
            <div style="margin-bottom:5px;">
              <div><strong>${this.escapeHtml(it.name)}</strong></div>
              ${(it.modifiers || []).map((m) => `<div style="font-size:11px;">+ ${this.escapeHtml(m.name)} (${this.formatIDR(m.price)})</div>`).join('')}
              <div class="receipt-line">
                <span>${it.qty} x ${this.formatIDR(unitFull)}</span>
                <span>${this.formatIDR(lineTotal)}</span>
              </div>
              ${it.line_discount > 0 ? `<div class="receipt-line" style="font-size:11px;"><span>Diskon Item</span><span>-${this.formatIDR(it.line_discount)}</span></div>` : ''}
            </div>
          `;
          })
          .join('')}
        <div class="receipt-divider"></div>
        <div class="receipt-line"><span>Subtotal</span><span>${this.formatIDR(tx.subtotal)}</span></div>
        ${tx.discount_total > 0 ? `<div class="receipt-line"><span>Diskon (${this.escapeHtml(tx.discount_name || 'Total')})</span><span>-${this.formatIDR(tx.discount_total)}</span></div>` : ''}
        ${(tx.taxes_applied || [])
          .map(
            (t) => `
          <div class="receipt-line">
            <span>${this.escapeHtml(t.name)}</span>
            <span>${this.formatIDR(t.amount)}</span>
          </div>
        `
          )
          .join('')}
        <div class="receipt-divider"></div>
        <div class="receipt-line" style="font-size:14px;font-weight:800;">
          <span>TOTAL</span>
          <span>${this.formatIDR(tx.total)}</span>
        </div>
        ${(tx.payments || [])
          .map(
            (p) => `
          <div class="receipt-line">
            <span>Bayar (${this.escapeHtml(p.method)})</span>
            <span>${this.formatIDR(p.amount)}</span>
          </div>
        `
          )
          .join('')}
        ${tx.change_amount > 0 ? `<div class="receipt-line"><span>Kembalian</span><span>${this.formatIDR(tx.change_amount)}</span></div>` : ''}
        <div class="receipt-divider"></div>
        <div class="receipt-center" style="white-space:pre-line;font-size:11px;">${this.escapeHtml(settings.receipt_footer || 'Terima kasih atas kunjungan Anda!')}</div>
      </div>
    `;
  }

  showReceiptModal(txId) {
    const tx = this.db.getById('transactions', txId);
    if (!tx) return;
    const canVoidRefund = tx.status !== 'VOIDED' && tx.type !== 'REFUND';

    this.openModal(
      `Detail Struk ${this.escapeHtml(tx.receipt_number)}`,
      this.buildReceiptHTML(tx),
      `
        ${
          canVoidRefund
            ? `
          <button class="btn btn-warning" onclick="window.posApp.promptRefundTransaction('${tx.id}')">↩️ Refund Barang</button>
          <button class="btn btn-danger" onclick="window.posApp.promptVoidTransaction('${tx.id}')">🚫 Batalkan (Void)</button>
        `
            : ''
        }
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup</button>
        <button class="btn btn-primary" onclick="window.posApp.printReceipt('${tx.id}')">🖨️ Cetak Struk</button>
      `
    );
  }

  printReceipt(txId) {
    const tx = this.db.getById('transactions', txId);
    if (!tx) return;
    const printMount = document.getElementById('print-mount');
    if (printMount) {
      printMount.innerHTML = this.buildReceiptHTML(tx);
      window.print();
    }
  }

  promptVoidTransaction(txId) {
    const tx = this.db.getById('transactions', txId);
    if (!tx) return;
    this.closeModal();
    this.requirePermissionOrSupervisorPin('void_refund', `Membatalkan Struk ${tx.receipt_number}`, async () => {
      tx.status = 'VOIDED';
      tx.voided_at = this.db.nowJakartaISO();
      tx.voided_by = this.currentUser?.name || 'TIKA';
      await this.db.upsert('transactions', tx);

      // Restore stock automatically
      for (const item of tx.items || []) {
        await this.db.adjustStock({
          product_id: item.product_id,
          delta: Number(item.qty || 0),
          reason: 'VOID',
          reference_id: tx.receipt_number,
          notes: `Pembatalan (Void) Struk ${tx.receipt_number}`,
          employee_id: this.currentUser?.id || 'emp_tika',
          employee_name: this.currentUser?.name || 'TIKA'
        });
      }
      await this.db.logActivity(this.currentUser, 'VOID_TX', `Membatalkan transaksi ${tx.receipt_number}`);
      this.toast(`Transaksi ${tx.receipt_number} telah dibatalkan dan stok dikembalikan`);
      this.render();
    });
  }

  promptRefundTransaction(txId) {
    const tx = this.db.getById('transactions', txId);
    if (!tx) return;
    this.closeModal();
    this.requirePermissionOrSupervisorPin('void_refund', `Pengembalian Barang (Refund) Struk ${tx.receipt_number}`, () => {
      this.openModal(
        `Pengembalian Barang (Refund) - ${this.escapeHtml(tx.receipt_number)}`,
        `
          <p style="margin-bottom:12px;color:var(--text-muted)">Pilih jumlah barang yang dikembalikan oleh pelanggan. Stok akan otomatis bertambah kembali.</p>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Barang</th>
                  <th>Dibeli</th>
                  <th>Harga Satuan</th>
                  <th>Jumlah Refund</th>
                </tr>
              </thead>
              <tbody>
                ${(tx.items || [])
                  .map(
                    (it, idx) => `
                  <tr>
                    <td><strong>${this.escapeHtml(it.name)}</strong></td>
                    <td>${it.qty}</td>
                    <td>${this.formatIDR(Number(it.price || 0) + Number(it.modifier_total_unit || 0))}</td>
                    <td>
                      <input type="number" class="form-control refund-qty-input" data-idx="${idx}"
                        value="${it.qty}" min="0" max="${it.qty}" step="0.01" style="width:90px;" />
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="form-group" style="margin-top:12px;">
            <label>Alasan Pengembalian Barang</label>
            <input type="text" id="refund-reason-input" class="form-control" placeholder="Contoh: Permintaan pelanggan / Tukar ukuran" />
          </div>
        `,
        `
          <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
          <button class="btn btn-primary" onclick="window.posApp.executeRefund('${tx.id}')">Proses Refund & Kembalikan Stok</button>
        `
      );
    });
  }

  async executeRefund(txId) {
    const origTx = this.db.getById('transactions', txId);
    if (!origTx) return;
    const inputs = Array.from(document.querySelectorAll('.refund-qty-input'));
    const reason = (document.getElementById('refund-reason-input')?.value || 'Refund Pelanggan').trim();

    const refundItems = [];
    let refundSubtotal = 0;

    for (const inp of inputs) {
      const idx = Number(inp.dataset.idx);
      const qty = Math.max(0, Number(inp.value || 0));
      const origItem = origTx.items[idx];
      if (origItem && qty > 0) {
        const cappedQty = Math.min(qty, Number(origItem.qty));
        const unitFull = Number(origItem.price || 0) + Number(origItem.modifier_total_unit || 0);
        refundSubtotal += unitFull * cappedQty;
        refundItems.push({
          ...origItem,
          qty: cappedQty
        });
      }
    }

    if (refundItems.length === 0) {
      this.toast('Pilih minimal 1 barang untuk direfund', 'error');
      return;
    }

    const ratio = origTx.subtotal > 0 ? refundSubtotal / origTx.subtotal : 1;
    const refundDiscount = Math.round((origTx.discount_total || 0) * ratio);
    const refundTax = Math.round((origTx.tax_total || 0) * ratio);
    const refundTotal = Math.round(refundSubtotal - refundDiscount + (origTx.total - (origTx.subtotal - (origTx.discount_total || 0))) * ratio);

    const now = this.db.nowJakartaISO();
    const refundReceiptNo = `RFD-${origTx.receipt_number.replace(/^TIKA-/, '')}`;

    const refundTx = {
      id: `tx_rfd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      receipt_number: refundReceiptNo,
      reference_receipt: origTx.receipt_number,
      type: 'REFUND',
      status: 'COMPLETED',
      dining_option: origTx.dining_option,
      customer_id: origTx.customer_id,
      customer_name: origTx.customer_name,
      employee_id: this.currentUser?.id || 'emp_tika',
      employee_name: this.currentUser?.name || 'TIKA',
      device_id: this.db.deviceId,
      device_name: this.db.deviceName,
      items: refundItems,
      subtotal: refundSubtotal,
      discount_total: refundDiscount,
      tax_total: refundTax,
      total: refundTotal,
      payment_method: origTx.payment_method,
      payments: [{ method: origTx.payment_method, amount: refundTotal }],
      notes: reason,
      created_at: now
    };

    await this.db.upsert('transactions', refundTx);

    for (const item of refundItems) {
      await this.db.adjustStock({
        product_id: item.product_id,
        delta: Number(item.qty || 0),
        reason: 'REFUND',
        reference_id: refundReceiptNo,
        notes: `Refund dari ${origTx.receipt_number}: ${reason}`,
        employee_id: refundTx.employee_id,
        employee_name: refundTx.employee_name
      });
    }

    await this.db.logActivity(this.currentUser, 'REFUND_TX', `Refund ${refundReceiptNo} senilai ${this.formatIDR(refundTotal)}`);
    this.closeModal();
    this.showReceiptModal(refundTx.id);
    this.toast(`Refund ${refundReceiptNo} berhasil diproses & stok dikembalikan`);
  }

  /* ========================================================================
     SHIFT MANAGEMENT & EMPLOYEE TIMECARDS (JAM KERJA)
     ======================================================================== */
  getActiveShift() {
    return this.db.getCollection('shifts').find((s) => s.status === 'OPEN') || null;
  }

  openShiftModal() {
    const activeShift = this.getActiveShift();
    if (!activeShift) {
      this.openModal(
        'Buka Shift Kasir Baru',
        `
          <div class="form-group">
            <label>Modal Awal Laci Kasir (Uang Tunai Rp)</label>
            <input type="number" id="shift-open-cash" class="form-control" value="200000" min="0" />
          </div>
          <div class="form-group">
            <label>Catatan Shift</label>
            <input type="text" id="shift-open-notes" class="form-control" placeholder="Shift Pagi / Sore" />
          </div>
        `,
        `
          <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Batal</button>
          <button class="btn btn-primary" onclick="window.posApp.startNewShift()">🔓 Buka Shift Sekarang</button>
        `
      );
      return;
    }

    const cashIn = (activeShift.cash_movements || [])
      .filter((c) => c.type === 'IN')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const cashOut = (activeShift.cash_movements || [])
      .filter((c) => c.type === 'OUT')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const expected = Number(activeShift.opening_cash || 0) + Number(activeShift.cash_sales || 0) + cashIn - cashOut;

    this.openModal(
      `Manajemen Shift Aktif (${this.escapeHtml(activeShift.employee_name)})`,
      `
        <div class="kpi-grid" style="margin-bottom:14px;">
          <div class="kpi-card">
            <div class="kpi-label">Modal Awal</div>
            <div class="kpi-value" style="font-size:16px;">${this.formatIDR(activeShift.opening_cash)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Penjualan Tunai</div>
            <div class="kpi-value" style="font-size:16px;">${this.formatIDR(activeShift.cash_sales || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Kas Masuk / Keluar</div>
            <div class="kpi-value" style="font-size:14px;">+${this.formatIDR(cashIn)} / -${this.formatIDR(cashOut)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Kas Diharapkan di Laci</div>
            <div class="kpi-value" style="font-size:16px;color:var(--primary-dark)">${this.formatIDR(expected)}</div>
          </div>
        </div>

        <div class="card" style="background:#f8fafc;">
          <h4 style="margin-bottom:8px;">Catat Uang Masuk / Keluar Laci Kasir (Pay In / Pay Out)</h4>
          <div class="form-grid">
            <div class="form-group">
              <label>Jenis</label>
              <select id="shift-cash-type" class="form-control">
                <option value="IN">Kas Masuk (Pay In)</option>
                <option value="OUT">Kas Keluar / Pengeluaran (Pay Out)</option>
              </select>
            </div>
            <div class="form-group">
              <label>Nominal (Rp)</label>
              <input type="number" id="shift-cash-amount" class="form-control" placeholder="50000" />
            </div>
            <div class="form-group">
              <label>Keterangan</label>
              <input type="text" id="shift-cash-reason" class="form-control" placeholder="Contoh: Beli es batu / Tambah uang receh" />
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="window.posApp.addShiftCashMovement()">+ Simpan Kas Masuk/Keluar</button>
        </div>

        <div class="form-group" style="margin-top:12px;">
          <label>Hitung Uang Tunai Aktual Saat Tutup Shift (Rp)</label>
          <input type="number" id="shift-actual-cash" class="form-control" value="${expected}" />
        </div>
      `,
      `
        <button class="btn btn-secondary" onclick="window.posApp.closeModal()">Tutup Jendela</button>
        <button class="btn btn-danger" onclick="window.posApp.closeActiveShift()">🔒 Tutup Shift & Rekonsiliasi</button>
      `
    );
  }

  async startNewShift() {
    const openingCash = Math.max(0, Number(document.getElementById('shift-open-cash')?.value || 0));
    const notes = (document.getElementById('shift-open-notes')?.value || '').trim();
    const now = this.db.nowJakartaISO();
    const shift = {
      id: `shf_${Date.now()}`,
      employee_id: this.currentUser?.id || 'emp_tika',
      employee_name: this.currentUser?.name || 'TIKA',
      device_id: this.db.deviceId,
      opened_at: now,
      closed_at: null,
      opening_cash: openingCash,
      cash_sales: 0,
      cash_movements: [],
      expected_cash: openingCash,
      actual_cash: null,
      difference: null,
      notes,
      status: 'OPEN'
    };
    await this.db.upsert('shifts', shift);
    await this.db.logActivity(this.currentUser, 'OPEN_SHIFT', `Membuka shift dengan modal awal ${this.formatIDR(openingCash)}`);
    this.closeModal();
    this.toast('Shift kasir berhasil dibuka');
    this.render();
  }

  async addShiftCashMovement() {
    const activeShift = this.getActiveShift();
    if (!activeShift) return;
    const type = document.getElementById('shift-cash-type')?.value || 'IN';
    const amount = Math.max(0, Number(document.getElementById('shift-cash-amount')?.value || 0));
    const reason = (document.getElementById('shift-cash-reason')?.value || '').trim();
    if (amount <= 0) {
      this.toast('Masukkan nominal uang lebih dari 0', 'error');
      return;
    }
    if (!activeShift.cash_movements) activeShift.cash_movements = [];
    activeShift.cash_movements.push({
      id: `cm_${Date.now()}`,
      type,
      amount,
      reason,
      employee_name: this.currentUser?.name || 'TIKA',
      timestamp: this.db.nowJakartaISO()
    });
    const cashIn = activeShift.cash_movements.filter((c) => c.type === 'IN').reduce((a, b) => a + Number(b.amount || 0), 0);
    const cashOut = activeShift.cash_movements.filter((c) => c.type === 'OUT').reduce((a, b) => a + Number(b.amount || 0), 0);
    activeShift.expected_cash = Number(activeShift.opening_cash || 0) + Number(activeShift.cash_sales || 0) + cashIn - cashOut;

    await this.db.upsert('shifts', activeShift);
    this.toast(`Kas ${type === 'IN' ? 'Masuk' : 'Keluar'} ${this.formatIDR(amount)} tercatat`);
    this.openShiftModal();
  }

  async closeActiveShift() {
    const activeShift = this.getActiveShift();
    if (!activeShift) return;
    const actualCash = Number(document.getElementById('shift-actual-cash')?.value || 0);
    const cashIn = (activeShift.cash_movements || []).filter((c) => c.type === 'IN').reduce((a, b) => a + Number(b.amount || 0), 0);
    const cashOut = (activeShift.cash_movements || []).filter((c) => c.type === 'OUT').reduce((a, b) => a + Number(b.amount || 0), 0);
    const expected = Number(activeShift.opening_cash || 0) + Number(activeShift.cash_sales || 0) + cashIn - cashOut;

    activeShift.expected_cash = expected;
    activeShift.actual_cash = actualCash;
    activeShift.difference = actualCash - expected;
    activeShift.closed_at = this.db.nowJakartaISO();
    activeShift.status = 'CLOSED';

    await this.db.upsert('shifts', activeShift);
    await this.db.logActivity(this.currentUser, 'CLOSE_SHIFT', `Menutup shift. Kas aktual: ${this.formatIDR(actualCash)}`);
    this.closeModal();
    this.toast('Shift berhasil ditutup & disimpan ke Laporan Shift');
    this.render();
  }

  /* ========================================================================
     QR CODE GENERATOR (PURE CANVAS DETERMINISTIC MATRIX)
     ======================================================================== */
  drawQRCodeCanvas(canvasId, text) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 25;
    const pad = 2;
    const totalModules = size + pad * 2;
    const scale = Math.floor(canvas.width / totalModules);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const drawFinder = (r0, c0) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (isBorder || isInner) {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect((c0 + c + pad) * scale, (r0 + r + pad) * scale, scale, scale);
          }
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Deterministic bit pattern from text payload
    let hash = 2166136261;
    const str = String(text || 'POSTIKA');
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const inFinderTL = r < 8 && c < 8;
        const inFinderTR = r < 8 && c >= size - 8;
        const inFinderBL = r >= size - 8 && c < 8;
        if (inFinderTL || inFinderTR || inFinderBL) continue;

        const charCode = str.charCodeAt((r * size + c) % str.length);
        hash ^= charCode + r * 31 + c * 17;
        hash = Math.imul(hash, 16777619);
        if ((Math.abs(hash) % 10) < 5) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect((c + pad) * scale, (r + pad) * scale, scale, scale);
        }
      }
    }
  }

  /* ========================================================================
     MODAL HELPER
     ======================================================================== */
  openModal(title, bodyHtml, footerHtml = '', large = false) {
    this.modalOpen = true;
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) window.posApp.closeModal()">
        <div class="modal-box ${large ? 'modal-lg' : ''}">
          <div class="modal-header">
            <h3>${title}</h3>
            <button class="btn btn-sm btn-secondary" onclick="window.posApp.closeModal()">✕</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-footer">${footerHtml}</div>
        </div>
      </div>
    `;
  }

  closeModal() {
    this.stopCameraBarcodeScanner();
    this.modalOpen = false;
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
  }

  /* ========================================================================
     NAVIGATION & SHELL RENDERING
     ======================================================================== */
  navigate(menuId) {
    this.activeMenu = menuId;
    this.sidebarOpen = false;
    this.render();
  }

  updateSyncTopbarPill() {
    const el = document.getElementById('topbar-sync-pill');
    if (!el || !this.sync) return;
    const st = this.sync.getStatusSummary();
    el.className = `sync-pill ${!st.online ? 'offline' : st.syncing ? 'syncing' : ''}`;
    el.innerHTML = `
      <span class="sync-dot"></span>
      <span>${
        !st.online
          ? 'OFFLINE (DB Lokal Aktif)'
          : st.syncing
          ? 'Menyinkronkan...'
          : `ONLINE • ${st.cloudConnected ? 'Cloud P2P' : 'Lokal'} (${st.discoveredPeers + 1} Perangkat)`
      }</span>
    `;
  }

  renderMainViewOnly() {
    const mount = document.getElementById('main-page-content');
    if (!mount) {
      this.render();
      return;
    }
    mount.className = `page-content ${this.activeMenu === 'pos' ? 'pos-mode' : ''}`;
    mount.innerHTML = this.renderActiveMenuContent();
    this.updateSyncTopbarPill();
  }

  render() {
    const appRoot = document.getElementById('app-root');
    if (!appRoot) return;

    if (this.isCustomerDisplayMode) {
      appRoot.innerHTML = window.posModules.renderCustomerDisplayScreen(this);
      return;
    }

    if (!this.currentUser) {
      appRoot.innerHTML = this.renderPinLoginScreen();
      return;
    }

    const settings = this.db.getSettings();
    const lowStockCount =
      settings.features?.low_stock_alert !== false
        ? this.db
            .getCollection('products')
            .filter((p) => p.track_stock !== false && Number(p.stock || 0) <= Number(p.min_stock || 0)).length
        : 0;

    const menuItems = [
      { id: 'dashboard', label: 'Dashboard', icon: '📊', perm: 'view_reports' },
      { id: 'pos', label: 'Kasir / POS', icon: '🛒', perm: 'pos_access' },
      { id: 'reports', label: 'Laporan', icon: '📈', perm: 'view_reports' },
      { id: 'items', label: 'Barang', icon: '📦', perm: 'manage_items', badge: lowStockCount > 0 ? lowStockCount : 0 },
      { id: 'categories', label: 'Kategori', icon: '🏷️', perm: 'manage_items' },
      { id: 'modifiers', label: 'Modifier', icon: '✨', perm: 'manage_items' },
      { id: 'discounts', label: 'Diskon', icon: '🎟️', perm: 'manage_items' },
      { id: 'taxes', label: 'Pajak', icon: '🧾', perm: 'manage_items' },
      { id: 'inventory', label: 'Inventaris', icon: '🏭', perm: 'manage_inventory' },
      { id: 'employees', label: 'Karyawan', icon: '👥', perm: 'manage_employees' },
      { id: 'permissions', label: 'Hak Akses', icon: '🔐', perm: 'manage_employees' },
      { id: 'customers', label: 'Pelanggan', icon: '🤝', perm: 'manage_customers' },
      { id: 'devices', label: 'Perangkat', icon: '💻', perm: 'manage_devices' },
      { id: 'sync', label: 'Sinkronisasi', icon: '🔄', perm: 'pos_access' },
      { id: 'integrations', label: 'Integrasi', icon: '🔌', perm: 'pos_access' },
      { id: 'settings', label: 'Pengaturan', icon: '⚙️', perm: 'manage_settings' },
      { id: 'backup', label: 'Backup & Restore', icon: '🛡️', perm: 'manage_backup' },
      { id: 'help', label: 'Bantuan', icon: '❓', perm: 'pos_access' }
    ];

    const activeMenuObj = menuItems.find((m) => m.id === this.activeMenu) || menuItems[1];
    const openTicketsCount = this.db.getCollection('open_tickets').length;

    appRoot.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar ${this.sidebarOpen ? 'open' : ''}" id="app-sidebar">
          <div class="sidebar-brand">
            <div class="brand-badge">TIKA</div>
            <div class="brand-info">
              <h1>${this.escapeHtml(settings.app_name || 'POS TIKA')}</h1>
              <p>Pemilik: ${this.escapeHtml(settings.owner_name || 'TIKA')}</p>
            </div>
          </div>
          <nav class="sidebar-nav">
            ${menuItems
              .map(
                (m) => `
              <button class="nav-item ${this.activeMenu === m.id ? 'active' : ''}" onclick="window.posApp.navigate('${m.id}')">
                <span class="nav-icon">${m.icon}</span>
                <span>${m.label}</span>
                ${m.badge ? `<span class="nav-badge">${m.badge}</span>` : ''}
              </button>
            `
              )
              .join('')}
          </nav>
          <div class="sidebar-footer">
            <div class="user-pill">
              <div class="user-meta">
                <div class="u-name">${this.escapeHtml(this.currentUser.name)}</div>
                <div class="u-role">${this.escapeHtml(this.currentUser.role)} • ${this.escapeHtml(this.db.deviceName)}</div>
              </div>
              <button class="btn btn-sm btn-danger" onclick="window.posApp.logout()" title="Kunci PIN / Keluar">🔒</button>
            </div>
          </div>
        </aside>

        <div class="main-area">
          <header class="topbar">
            <div class="topbar-left">
              <button class="menu-toggle-btn" onclick="document.getElementById('app-sidebar').classList.toggle('open')">☰</button>
              <h2 class="page-title">${activeMenuObj.icon} ${activeMenuObj.label}</h2>
            </div>
            <div class="topbar-right">
              ${
                settings.features?.shift !== false
                  ? `<button class="btn btn-sm btn-secondary" onclick="window.posApp.openShiftModal()">
                      💼 Shift: ${this.getActiveShift() ? '<span style="color:var(--primary-dark)">AKTIF</span>' : 'TUTUP'}
                    </button>`
                  : ''
              }
              ${
                settings.features?.open_tickets !== false
                  ? `<button class="btn btn-sm btn-secondary" onclick="window.posApp.openTicketsListModal()">
                      🎫 Tiket Terbuka (${openTicketsCount})
                    </button>`
                  : ''
              }
              <div id="topbar-sync-pill" class="sync-pill" onclick="window.posApp.navigate('sync')"></div>
            </div>
          </header>

          <main id="main-page-content" class="page-content ${this.activeMenu === 'pos' ? 'pos-mode' : ''}">
            ${this.renderActiveMenuContent()}
          </main>
        </div>
      </div>
    `;

    this.updateSyncTopbarPill();
  }

  renderPinLoginScreen() {
    const employees = this.db.getCollection('employees').filter((e) => e.active !== false);
    const settings = this.db.getSettings();
    return `
      <div class="login-overlay">
        <div class="login-card">
          <div class="login-logo">TIKA</div>
          <h1 class="login-title">${this.escapeHtml(settings.app_name || 'POS TIKA')}</h1>
          <p class="login-subtitle">Point of Sale & Manajemen Bisnis • Pemilik: <strong>${this.escapeHtml(settings.owner_name || 'TIKA')}</strong></p>

          <div style="font-size:12.5px;font-weight:600;color:var(--text-muted)">Masukkan 4 Digit PIN Karyawan / Pemilik</div>
          <div class="pin-dots">
            <div class="pin-dot" id="pin-dot-0"></div>
            <div class="pin-dot" id="pin-dot-1"></div>
            <div class="pin-dot" id="pin-dot-2"></div>
            <div class="pin-dot" id="pin-dot-3"></div>
          </div>

          <div class="pin-pad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9]
              .map((n) => `<button class="pin-btn" onclick="window.posApp.pressPin('${n}')">${n}</button>`)
              .join('')}
            <button class="pin-btn" style="font-size:14px;color:var(--danger)" onclick="window.posApp.pressPin('C')">HAPUS</button>
            <button class="pin-btn" onclick="window.posApp.pressPin('0')">0</button>
            <button class="pin-btn" style="font-size:16px;" onclick="window.posApp.pressPin('BS')">⌫</button>
          </div>

          <div class="quick-role-chips">
            ${employees
              .map(
                (e) => `
              <button class="role-chip" onclick="window.posApp.quickFillPin('${this.escapeHtml(e.pin)}')">
                👤 ${this.escapeHtml(e.name)} (PIN: ${this.escapeHtml(e.pin)})
              </button>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderActiveMenuContent() {
    switch (this.activeMenu) {
      case 'pos':
        return this.renderPOSCashierView();
      case 'dashboard':
        return window.posModules.renderDashboardView(this);
      case 'reports':
        return this.reports.renderReportsPage();
      case 'items':
        return window.posModules.renderItemsView(this);
      case 'categories':
        return window.posModules.renderCategoriesView(this);
      case 'modifiers':
        return window.posModules.renderModifiersView(this);
      case 'discounts':
        return window.posModules.renderDiscountsView(this);
      case 'taxes':
        return window.posModules.renderTaxesView(this);
      case 'inventory':
        return window.posModules.renderInventoryView(this);
      case 'employees':
        return window.posModules.renderEmployeesView(this);
      case 'permissions':
        return window.posModules.renderPermissionsView(this);
      case 'customers':
        return window.posModules.renderCustomersView(this);
      case 'devices':
        return window.posModules.renderDevicesView(this);
      case 'sync':
        return window.posModules.renderSyncView(this);
      case 'integrations':
        return window.posModules.renderIntegrationsView(this);
      case 'settings':
        return window.posModules.renderSettingsView(this);
      case 'backup':
        return window.posModules.renderBackupView(this);
      case 'help':
        return window.posModules.renderHelpView(this);
      default:
        return this.renderPOSCashierView();
    }
  }

  renderPOSProductsGridItems() {
    const settings = this.db.getSettings();
    const allProducts = this.db.getCollection('products');
    const q = this.posSearch.trim().toLowerCase();
    const filteredProducts = allProducts.filter((p) => {
      if (this.posCategory !== 'ALL' && p.category_id !== this.posCategory) return false;
      if (!q) return true;
      return (
        (p.name || '').toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.barcode || '').toLowerCase().includes(q)
      );
    });

    if (filteredProducts.length === 0) {
      return `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">
        Tidak ada barang yang cocok dengan pencarian "<strong>${this.escapeHtml(this.posSearch)}</strong>".
      </div>`;
    }

    return filteredProducts
      .map((p) => {
        const stk = Number(p.stock || 0);
        const minStk = Number(p.min_stock || 0);
        const isOut = p.track_stock !== false && stk <= 0;
        const isLow = p.track_stock !== false && stk > 0 && stk <= minStk && settings.features?.low_stock_alert !== false;
        const initials = (p.name || 'PR')
          .split(' ')
          .slice(0, 2)
          .map((w) => w[0])
          .join('')
          .toUpperCase();
        const thumbStyle = p.image
          ? `background-image:url('${p.image}');background-color:${p.color || '#10b981'}`
          : `background-color:${p.color || '#10b981'}`;

        return `
        <div class="product-card" onclick="window.posApp.handleProductTileClick('${p.id}')">
          <div class="product-thumb" style="${thumbStyle}">
            ${!p.image ? initials : ''}
            ${
              p.track_stock !== false
                ? `<span class="stock-badge ${isOut ? 'out' : isLow ? 'low' : ''}">
                    ${isOut ? 'Habis (0)' : `${stk} ${this.escapeHtml(p.unit || 'pcs')}`}
                  </span>`
                : ''
            }
          </div>
          <div class="product-card-body">
            <div class="product-card-title">${this.escapeHtml(p.name)}</div>
            <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:2px;">${this.escapeHtml(p.barcode || p.sku || '')}</div>
            <div class="product-card-price">
              ${this.formatIDR(p.price)}
              ${p.sold_by_weight ? `<span style="font-size:11px;font-weight:500;color:var(--text-muted)">/${this.escapeHtml(p.unit || 'kg')}</span>` : ''}
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  renderPOSCashierView() {
    const settings = this.db.getSettings();
    const categories = this.db.getCollection('categories');
    const allProducts = this.db.getCollection('products');
    const customers = this.db.getCollection('customers');
    const discounts = this.db.getCollection('discounts').filter((d) => d.active !== false);
    const totals = this.calculateCartTotals();

    return `
      <div class="pos-container">
        <!-- Left Catalog Area -->
        <div class="pos-catalog">
          <div class="pos-toolbar">
            <div class="pos-search-wrap">
              <span class="pos-search-icon">🔍</span>
              <input type="text" class="pos-search-input" placeholder="Cari nama barang, SKU, atau scan barcode lalu tekan Enter..."
                value="${this.escapeHtml(this.posSearch)}"
                oninput="window.posApp.onPosSearchInput(this.value)"
                onkeydown="window.posApp.onPosSearchKeydown(event)" />
            </div>
            <button class="btn btn-primary" onclick="window.posApp.openBarcodeScannerModal()">📷 Scan Barcode</button>
            <button class="btn btn-secondary" onclick="window.posApp.navigate('reports'); window.posApp.reports.setTab('receipts')">🧾 Riwayat Struk</button>
          </div>

          <div class="pos-categories">
            <button class="cat-tab ${this.posCategory === 'ALL' ? 'active' : ''}"
              onclick="window.posApp.posCategory='ALL'; window.posApp.renderMainViewOnly()">
              Semua Kategori (${allProducts.length})
            </button>
            ${categories
              .map(
                (c) => `
              <button class="cat-tab ${this.posCategory === c.id ? 'active' : ''}"
                onclick="window.posApp.posCategory='${c.id}'; window.posApp.renderMainViewOnly()">
                ${this.escapeHtml(c.name)}
              </button>
            `
              )
              .join('')}
          </div>

          <div class="pos-products-grid" id="pos-products-grid-mount">
            ${this.renderPOSProductsGridItems()}
          </div>
        </div>

        <!-- Right Cart Panel -->
        <div class="pos-cart">
          <div class="cart-header">
            <div class="cart-header-top">
              <select class="form-control" style="flex:1;padding:6px 10px;font-size:12.5px;"
                onchange="window.posApp.cartCustomerId=this.value; window.posApp.syncCartWithCustomerDisplay()">
                ${customers
                  .map(
                    (c) => `
                  <option value="${c.id}" ${this.cartCustomerId === c.id ? 'selected' : ''}>
                    👤 ${this.escapeHtml(c.name)} ${c.phone && c.phone !== '-' ? `(${this.escapeHtml(c.phone)})` : ''}
                  </option>
                `
                  )
                  .join('')}
              </select>
              <button class="btn btn-sm btn-secondary" onclick="window.posModules.openCustomerModal()" title="Tambah Pelanggan Baru">+ Pelanggan</button>
              <button class="btn btn-sm btn-danger" onclick="window.posApp.clearCart()" title="Kosongkan Keranjang">🗑️</button>
            </div>

            ${
              settings.features?.dining_options !== false
                ? `
              <div class="dining-selector">
                ${['Dine In', 'Takeaway', 'Delivery']
                  .map(
                    (opt) => `
                  <button class="dining-btn ${this.cartDiningOption === opt ? 'active' : ''}"
                    onclick="window.posApp.cartDiningOption='${opt}'; window.posApp.syncCartWithCustomerDisplay(); window.posApp.renderMainViewOnly()">
                    ${opt === 'Dine In' ? '🍽️ Dine In' : opt === 'Takeaway' ? '🛍️ Takeaway' : '🛵 Delivery'}
                  </button>
                `
                  )
                  .join('')}
              </div>
            `
                : ''
            }
          </div>

          <div class="cart-items">
            ${
              this.cart.length === 0
                ? `
              <div class="cart-empty">
                <div style="font-size:36px;margin-bottom:8px;">🛒</div>
                <div style="font-weight:700;color:var(--text-main)">Keranjang Belanja Kosong</div>
                <div style="font-size:12px;">Klik produk di sebelah kiri atau scan barcode untuk menambahkan pesanan.</div>
              </div>
            `
                : this.cart
                    .map((item) => {
                      const unitFull = Number(item.price || 0) + Number(item.modifier_total_unit || 0);
                      const lineTotal = unitFull * Number(item.qty || 0) - Number(item.line_discount || 0);
                      return `
                      <div class="cart-item">
                        <div class="cart-item-main">
                          <div>
                            <div class="cart-item-title" onclick="window.posApp.openCartItemEditModal('${item.cart_line_id}')">
                              ${this.escapeHtml(item.name)} ✏️
                            </div>
                            ${
                              (item.modifiers || []).length > 0
                                ? `<div class="cart-item-mods">${item.modifiers.map((m) => `+ ${this.escapeHtml(m.name)} (${this.formatIDR(m.price)})`).join(', ')}</div>`
                                : ''
                            }
                            ${item.note ? `<div class="cart-item-mods" style="font-style:italic;">Catatan: ${this.escapeHtml(item.note)}</div>` : ''}
                            ${item.line_discount > 0 ? `<div class="cart-item-mods" style="color:var(--danger)">Diskon Item: -${this.formatIDR(item.line_discount)}</div>` : ''}
                          </div>
                          <div style="font-weight:700;font-size:13.5px;">${this.formatIDR(lineTotal)}</div>
                        </div>
                        <div class="cart-item-controls">
                          <span style="font-size:11.5px;color:var(--text-muted)">@ ${this.formatIDR(unitFull)} / ${this.escapeHtml(item.unit || 'pcs')}</span>
                          <div class="qty-stepper">
                            <button class="qty-btn" onclick="window.posApp.changeCartQty('${item.cart_line_id}', -1)">-</button>
                            <span class="qty-input">${item.qty}</span>
                            <button class="qty-btn" onclick="window.posApp.changeCartQty('${item.cart_line_id}', 1)">+</button>
                          </div>
                        </div>
                      </div>
                    `;
                    })
                    .join('')
            }
          </div>

          <div class="cart-summary">
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <select class="form-control" style="padding:5px 8px;font-size:12px;flex:1;"
                onchange="window.posApp.cartDiscountId=this.value; window.posApp.syncCartWithCustomerDisplay(); window.posApp.renderMainViewOnly()">
                <option value="">🎟️ Pilih Diskon Promo (Tidak Ada)</option>
                ${discounts
                  .map(
                    (d) => `
                  <option value="${d.id}" ${this.cartDiscountId === d.id ? 'selected' : ''}>
                    ${this.escapeHtml(d.name)} (${d.type === 'PERCENTAGE' ? d.value + '%' : this.formatIDR(d.value)})
                  </option>
                `
                  )
                  .join('')}
              </select>
            </div>

            <div class="summary-row">
              <span>Subtotal (${this.cart.reduce((a, b) => a + Number(b.qty || 0), 0)} item)</span>
              <span>${this.formatIDR(totals.subtotal)}</span>
            </div>
            ${
              totals.discount_total > 0
                ? `<div class="summary-row" style="color:var(--danger)">
                    <span>Total Diskon</span>
                    <span>-${this.formatIDR(totals.discount_total)}</span>
                  </div>`
                : ''
            }
            ${totals.taxes_applied
              .map(
                (t) => `
              <div class="summary-row">
                <span>${this.escapeHtml(t.name)}</span>
                <span>${this.formatIDR(t.amount)}</span>
              </div>
            `
              )
              .join('')}
            <div class="summary-row total">
              <span>TOTAL BAYAR</span>
              <span style="color:var(--primary-dark)">${this.formatIDR(totals.total)}</span>
            </div>

            <div class="cart-actions">
              ${
                settings.features?.open_tickets !== false
                  ? `<button class="btn btn-secondary btn-lg" onclick="window.posApp.openSaveTicketModal()">
                      🎫 Simpan Tiket
                    </button>`
                  : `<div></div>`
              }
              <button class="btn btn-primary btn-lg" onclick="window.posApp.openPaymentModal()">
                💳 Bayar ${this.formatIDR(totals.total)}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

window.POSTikaApp = POSTikaApp;
