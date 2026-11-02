/**
 * POS TIKA - Local-First Database Engine (IndexedDB + HLC Oplog + AES-GCM Backup Encryption)
 * Pemilik: TIKA | Bahasa: Indonesia | Mata Uang: IDR | Zona Waktu: Asia/Jakarta
 */

const IDB_NAME = 'pos_tika_idb_v1';
const IDB_VERSION = 1;

class POSTikaDB {
  constructor() {
    this.db = null;
    this.cache = {
      settings: [],
      roles: [],
      employees: [],
      categories: [],
      modifiers: [],
      discounts: [],
      taxes: [],
      products: [],
      customers: [],
      transactions: [],
      open_tickets: [],
      stock_movements: [],
      shifts: [],
      timecards: [],
      activity_logs: [],
      devices: [],
      kitchen_orders: []
    };
    this.deviceId = localStorage.getItem('postika_device_id') || '';
    this.deviceName = localStorage.getItem('postika_device_name') || '';
    this.lastHlc = localStorage.getItem('postika_last_hlc') || '';
    this.hlcCounter = 0;
    this.lastWallTime = 0;
    this.listeners = new Set();
  }

  detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return 'iPhone / iOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Tablet|PlayBook|Silk/i.test(ua)) return 'Tablet';
    if (/Windows/.test(ua)) return 'Windows PC / Laptop';
    if (/Macintosh/.test(ua)) return 'Mac / Laptop';
    return 'Browser PWA';
  }

  async init() {
    if (!this.deviceId) {
      const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
      this.deviceId = `DEV-${rand}`;
      localStorage.setItem('postika_device_id', this.deviceId);
    }
    if (!this.deviceName) {
      const plat = this.detectPlatform();
      this.deviceName = `Kasir ${plat.split(' ')[0]} (${this.deviceId.slice(-4)})`;
      localStorage.setItem('postika_device_name', this.deviceName);
    }

    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('entities')) {
          const entStore = db.createObjectStore('entities', { keyPath: '_key' });
          entStore.createIndex('collection', 'collection', { unique: false });
        }
        if (!db.objectStoreNames.contains('oplog')) {
          const opStore = db.createObjectStore('oplog', { keyPath: 'op_id' });
          opStore.createIndex('hlc', 'hlc', { unique: false });
          opStore.createIndex('synced', 'synced', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });

    await this.loadCacheFromIDB();

    // Check URL pairing parameters before bootstrap
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('pair_relay')) {
        localStorage.setItem('postika_relay_url', urlParams.get('pair_relay').replace(/\/+$/, ''));
      }
      if (urlParams.get('pair_biz')) {
        localStorage.setItem('postika_pair_biz', urlParams.get('pair_biz'));
      }
      if (urlParams.get('pair_key')) {
        localStorage.setItem('postika_pair_key', urlParams.get('pair_key'));
      }
    } catch (_) {}

    const savedRelay = (localStorage.getItem('postika_relay_url') || '').replace(/\/+$/, '');

    // Try bootstrapping from configured Relay Server or local SQLite server if reachable
    try {
      const bootUrl = savedRelay ? `${savedRelay}/api/bootstrap` : '/api/bootstrap';
      const res = await fetch(bootUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.collections) {
          await this.mergeBootstrap(data.collections, data.max_hlc);
        }
      }
    } catch (_) {
      // Offline mode: continue with IndexedDB local data
    }

    // Ensure local seed exists even if opened 100% offline with empty IDB
    if (!this.cache.settings || this.cache.settings.length === 0) {
      await this.seedOfflineDefaults();
    }

    // Register current device in local devices list if not present
    const existingDev = this.getById('devices', this.deviceId);
    if (!existingDev) {
      await this.upsert('devices', {
        id: this.deviceId,
        name: this.deviceName,
        platform: this.detectPlatform(),
        business_id: this.getSettings().business_id || 'BIZ-POSTIKA-01',
        status: 'online',
        authorized: true,
        last_sync: this.nowJakartaISO(),
        created_at: this.nowJakartaISO()
      });
    }

    return this;
  }

  nowJakartaISO() {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const jktDate = new Date(utcMs + 7 * 3600000);
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return (
      `${jktDate.getFullYear()}-${pad(jktDate.getMonth() + 1)}-${pad(jktDate.getDate())}` +
      `T${pad(jktDate.getHours())}:${pad(jktDate.getMinutes())}:${pad(jktDate.getSeconds())}+07:00`
    );
  }

  generateHLC() {
    const now = Date.now();
    if (now > this.lastWallTime) {
      this.lastWallTime = now;
      this.hlcCounter = 0;
    } else {
      this.hlcCounter += 1;
    }
    const tsPart = String(this.lastWallTime).padStart(15, '0');
    const cntPart = String(this.hlcCounter).padStart(4, '0');
    const hlc = `${tsPart}-${cntPart}-${this.deviceId}`;
    if (hlc > this.lastHlc) {
      this.lastHlc = hlc;
      localStorage.setItem('postika_last_hlc', this.lastHlc);
    }
    return hlc;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notifyChange(detail = {}) {
    for (const fn of this.listeners) {
      try {
        fn(detail);
      } catch (e) {
        console.error('DB listener error:', e);
      }
    }
  }

  async loadCacheFromIDB() {
    const rows = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('entities', 'readonly');
      const store = tx.objectStore('entities');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    // Reset cache collections
    Object.keys(this.cache).forEach((k) => {
      this.cache[k] = [];
    });

    for (const row of rows) {
      if (row.deleted) continue;
      if (!this.cache[row.collection]) {
        this.cache[row.collection] = [];
      }
      this.cache[row.collection].push(row.data);
    }
  }

  async mergeBootstrap(collections, serverMaxHlc) {
    const tx = this.db.transaction('entities', 'readwrite');
    const store = tx.objectStore('entities');

    for (const [col, items] of Object.entries(collections)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || !item.id) continue;
        const _key = `${col}:${item.id}`;
        store.put({
          _key,
          collection: col,
          id: item.id,
          data: item,
          hlc: serverMaxHlc || '000000000000000-0000-SERVER',
          deleted: 0,
          updated_at: item.updated_at || this.nowJakartaISO()
        });
      }
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await this.loadCacheFromIDB();
  }

  getCollection(collection) {
    return this.cache[collection] ? [...this.cache[collection]] : [];
  }

  getById(collection, id) {
    const list = this.cache[collection] || [];
    return list.find((item) => item.id === id) || null;
  }

  getSettings() {
    const s = this.getById('settings', 'main_settings');
    return (
      s || {
        id: 'main_settings',
        app_name: 'POS TIKA',
        owner_name: 'TIKA',
        business_id: 'BIZ-POSTIKA-01',
        pairing_key: 'TIKA-SYNC-2026',
        store_name: 'POS TIKA - Cabang Utama',
        store_address: 'Jl. Merdeka No. 88, Jakarta Pusat',
        store_phone: '0812-3456-7890',
        currency: 'IDR',
        timezone: 'Asia/Jakarta',
        language: 'id-ID',
        features: {
          shift: true,
          timecard: true,
          open_tickets: true,
          kitchen_printer: true,
          customer_display: true,
          dining_options: true,
          low_stock_alert: true,
          negative_stock_warning: true,
          weight_barcodes: true
        },
        weight_barcode_config: {
          prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'],
          item_code_digits: 5,
          weight_digits: 5,
          weight_decimals: 3
        }
      }
    );
  }

  async upsert(collection, payload, emitSync = true) {
    if (!payload.id) {
      payload.id = `${collection.slice(0, 3)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
    const now = this.nowJakartaISO();
    payload.updated_at = now;
    if (!payload.created_at) payload.created_at = now;

    const hlc = this.generateHLC();
    const op = {
      op_id: `op_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      hlc,
      device_id: this.deviceId,
      collection,
      entity_id: payload.id,
      action: 'UPSERT',
      payload: JSON.parse(JSON.stringify(payload)),
      created_at: now,
      synced: 0
    };

    await this.applyOp(op, true);
    if (emitSync && window.posSync) {
      window.posSync.broadcastLocalOp(op);
    }
    return payload;
  }

  async delete(collection, entityId, emitSync = true) {
    const now = this.nowJakartaISO();
    const hlc = this.generateHLC();
    const op = {
      op_id: `op_del_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      hlc,
      device_id: this.deviceId,
      collection,
      entity_id: entityId,
      action: 'DELETE',
      payload: { id: entityId, _deleted: true },
      created_at: now,
      synced: 0
    };

    await this.applyOp(op, true);
    if (emitSync && window.posSync) {
      window.posSync.broadcastLocalOp(op);
    }
    return true;
  }

  async adjustStock({
    product_id,
    delta,
    reason,
    reference_id = '',
    notes = '',
    employee_id = '',
    employee_name = '',
    cost_per_unit = null
  }) {
    const product = this.getById('products', product_id);
    if (!product) return null;

    const now = this.nowJakartaISO();
    const hlc = this.generateHLC();
    const oldStock = Number(product.stock || 0);
    const numDelta = Number(delta || 0);
    const newStock = Math.round((oldStock + numDelta) * 10000) / 10000;

    const movement = {
      id: `stk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      product_id: product.id,
      product_name: product.name,
      sku: product.sku || '',
      delta: numDelta,
      stock_before: oldStock,
      stock_after: newStock,
      reason: reason || 'ADJUSTMENT', // SALE, REFUND, VOID, RESTOCK, STOCK_OUT, ADJUSTMENT, DAMAGE
      reference_id,
      notes,
      cost_per_unit: cost_per_unit !== null ? Number(cost_per_unit) : Number(product.cost || 0),
      employee_id,
      employee_name,
      device_id: this.deviceId,
      created_at: now
    };

    const op = {
      op_id: `op_stk_${movement.id}`,
      hlc,
      device_id: this.deviceId,
      collection: 'stock_movements',
      entity_id: movement.id,
      action: 'STOCK_DELTA',
      payload: {
        product_id: product.id,
        delta: numDelta,
        movement
      },
      created_at: now,
      synced: 0
    };

    await this.applyOp(op, true);
    if (window.posSync) {
      window.posSync.broadcastLocalOp(op);
    }
    return movement;
  }

  async applyOp(op, isLocal = false) {
    if (!op || !op.op_id) return false;

    const alreadyExists = await new Promise((resolve) => {
      const tx = this.db.transaction('oplog', 'readonly');
      const req = tx.objectStore('oplog').get(op.op_id);
      req.onsuccess = () => resolve(Boolean(req.result));
      req.onerror = () => resolve(false);
    });

    if (alreadyExists) {
      return false; // Idempotent: never apply the same op twice
    }

    if (op.hlc && op.hlc > this.lastHlc) {
      this.lastHlc = op.hlc;
      localStorage.setItem('postika_last_hlc', this.lastHlc);
    }

    const tx = this.db.transaction(['entities', 'oplog'], 'readwrite');
    const entStore = tx.objectStore('entities');
    const opStore = tx.objectStore('oplog');

    opStore.put({
      ...op,
      synced: isLocal ? 0 : 1
    });

    const col = op.collection;
    const id = op.entity_id;
    const _key = `${col}:${id}`;

    if (op.action === 'DELETE') {
      entStore.put({
        _key,
        collection: col,
        id,
        data: { id, _deleted: true },
        hlc: op.hlc,
        deleted: 1,
        updated_at: op.created_at
      });
      if (this.cache[col]) {
        this.cache[col] = this.cache[col].filter((x) => x.id !== id);
      }
    } else if (op.action === 'STOCK_DELTA') {
      const { product_id, delta, movement } = op.payload;
      const prod = this.getById('products', product_id);
      if (prod && prod.track_stock !== false) {
        const before = Number(prod.stock || 0);
        const after = Math.round((before + Number(delta || 0)) * 10000) / 10000;
        prod.stock = after;
        prod.updated_at = op.created_at;
        entStore.put({
          _key: `products:${prod.id}`,
          collection: 'products',
          id: prod.id,
          data: prod,
          hlc: op.hlc,
          deleted: 0,
          updated_at: op.created_at
        });
        if (movement) {
          movement.stock_before = before;
          movement.stock_after = after;
        }
      }
      if (movement && movement.id) {
        entStore.put({
          _key: `stock_movements:${movement.id}`,
          collection: 'stock_movements',
          id: movement.id,
          data: movement,
          hlc: op.hlc,
          deleted: 0,
          updated_at: op.created_at
        });
        if (!this.cache.stock_movements) this.cache.stock_movements = [];
        const idx = this.cache.stock_movements.findIndex((m) => m.id === movement.id);
        if (idx >= 0) this.cache.stock_movements[idx] = movement;
        else this.cache.stock_movements.push(movement);
      }
    } else {
      // UPSERT
      entStore.put({
        _key,
        collection: col,
        id,
        data: op.payload,
        hlc: op.hlc,
        deleted: 0,
        updated_at: op.created_at
      });
      if (!this.cache[col]) this.cache[col] = [];
      const idx = this.cache[col].findIndex((x) => x.id === id);
      if (idx >= 0) {
        this.cache[col][idx] = op.payload;
      } else {
        this.cache[col].push(op.payload);
      }
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    this.notifyChange({ collection: col, entity_id: id, action: op.action });
    return true;
  }

  async getUnsyncedOps(limit = 500) {
    return new Promise((resolve) => {
      const tx = this.db.transaction('oplog', 'readonly');
      const store = tx.objectStore('oplog');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const unsynced = all.filter((o) => !o.synced).slice(0, limit);
        resolve(unsynced);
      };
      req.onerror = () => resolve([]);
    });
  }

  async getAllOps(sinceHlc = '') {
    return new Promise((resolve) => {
      const tx = this.db.transaction('oplog', 'readonly');
      const store = tx.objectStore('oplog');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const filtered = sinceHlc ? all.filter((o) => o.hlc > sinceHlc) : all;
        filtered.sort((a, b) => (a.hlc > b.hlc ? 1 : -1));
        resolve(filtered);
      };
      req.onerror = () => resolve([]);
    });
  }

  async getAllOpsSince(sinceHlc = '', limit = 300) {
    const ops = await this.getAllOps(sinceHlc);
    return ops.slice(0, limit);
  }

  async markOpsSynced(opIds) {
    if (!opIds || !opIds.length) return;
    const tx = this.db.transaction('oplog', 'readwrite');
    const store = tx.objectStore('oplog');
    for (const id of opIds) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        if (getReq.result) {
          getReq.result.synced = 1;
          store.put(getReq.result);
        }
      };
    }
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async logActivity(employee, action, details) {
    return this.upsert('activity_logs', {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      employee_id: employee ? employee.id : 'system',
      employee_name: employee ? employee.name : 'Sistem',
      role: employee ? employee.role : 'System',
      action,
      details,
      device_id: this.deviceId,
      device_name: this.deviceName,
      created_at: this.nowJakartaISO()
    });
  }

  async exportFullDatabase() {
    const ops = await this.getAllOps('');
    return {
      app: 'POS TIKA',
      owner: 'TIKA',
      version: '1.0.0',
      exported_at: this.nowJakartaISO(),
      device_id: this.deviceId,
      collections: JSON.parse(JSON.stringify(this.cache)),
      ops
    };
  }

  async encryptBackupData(plainObj, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const plaintextBytes = enc.encode(JSON.stringify(plainObj));
    const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes);

    const toB64 = (u8) => {
      let binary = '';
      for (let i = 0; i < u8.byteLength; i++) binary += String.fromCharCode(u8[i]);
      return btoa(binary);
    };

    return {
      format: 'POS_TIKA_ENCRYPTED_BACKUP_V1',
      owner: 'TIKA',
      algorithm: 'AES-256-GCM-PBKDF2',
      created_at: this.nowJakartaISO(),
      salt: toB64(salt),
      iv: toB64(iv),
      ciphertext: toB64(new Uint8Array(cipherBuffer))
    };
  }

  async decryptBackupData(encObj, password) {
    const fromB64 = (b64) => {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const salt = fromB64(encObj.salt);
    const iv = fromB64(encObj.iv);
    const ciphertext = fromB64(encObj.ciphertext);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(dec.decode(plainBuffer));
  }

  async restoreDatabase(backupData, mode = 'merge') {
    if (mode === 'replace') {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['entities', 'oplog'], 'readwrite');
        tx.objectStore('entities').clear();
        tx.objectStore('oplog').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      Object.keys(this.cache).forEach((k) => {
        this.cache[k] = [];
      });
    }

    if (backupData.collections) {
      await this.mergeBootstrap(backupData.collections, this.generateHLC());
    }
    if (Array.isArray(backupData.ops)) {
      for (const op of backupData.ops) {
        await this.applyOp(op, false);
      }
    }

    try {
      await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          collections: backupData.collections || {},
          ops: backupData.ops || [],
          device_id: this.deviceId
        })
      });
    } catch (_) {
      // Offline restore still succeeds in IndexedDB and will sync when server/peers connect
    }

    await this.loadCacheFromIDB();
    this.notifyChange({ action: 'RESTORE' });
  }

  async seedOfflineDefaults() {
    const ts = this.nowJakartaISO();
    await this.upsert(
      'settings',
      {
        id: 'main_settings',
        app_name: 'POS TIKA',
        owner_name: 'TIKA',
        business_id: 'BIZ-POSTIKA-01',
        pairing_key: 'TIKA-SYNC-2026',
        store_name: 'POS TIKA - Cabang Utama',
        store_address: 'Jl. Merdeka No. 88, Jakarta Pusat',
        store_phone: '0812-3456-7890',
        currency: 'IDR',
        timezone: 'Asia/Jakarta',
        language: 'id-ID',
        receipt_header: 'POS TIKA\nRetail, Restoran & Kafe',
        receipt_footer: 'Terima kasih atas kunjungan Anda!',
        qris_merchant_name: 'POS TIKA OFFICIAL',
        qris_nmid: 'ID1026000889901',
        bank_accounts: [
          { bank: 'BCA', number: '8720192831', holder: 'TIKA' },
          { bank: 'Mandiri', number: '1370098212345', holder: 'TIKA' }
        ],
        features: {
          shift: true,
          timecard: true,
          open_tickets: true,
          kitchen_printer: true,
          customer_display: true,
          dining_options: true,
          low_stock_alert: true,
          negative_stock_warning: true,
          weight_barcodes: true
        },
        weight_barcode_config: {
          prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'],
          item_code_digits: 5,
          weight_digits: 5,
          weight_decimals: 3
        },
        updated_at: ts
      },
      false
    );

    const roles = [
      {
        id: 'role_owner',
        name: 'Owner',
        label: 'Pemilik Bisnis (Owner)',
        is_system: true,
        permissions: {
          pos_access: true,
          edit_price: true,
          apply_discount: true,
          void_refund: true,
          manage_open_tickets: true,
          view_reports: true,
          manage_items: true,
          manage_inventory: true,
          manage_employees: true,
          manage_customers: true,
          manage_devices: true,
          manage_settings: true,
          manage_backup: true
        }
      },
      {
        id: 'role_admin',
        name: 'Admin',
        label: 'Administrator',
        is_system: true,
        permissions: {
          pos_access: true,
          edit_price: true,
          apply_discount: true,
          void_refund: true,
          manage_open_tickets: true,
          view_reports: true,
          manage_items: true,
          manage_inventory: true,
          manage_employees: true,
          manage_customers: true,
          manage_devices: true,
          manage_settings: true,
          manage_backup: true
        }
      },
      {
        id: 'role_manager',
        name: 'Manager',
        label: 'Manajer Toko',
        is_system: true,
        permissions: {
          pos_access: true,
          edit_price: true,
          apply_discount: true,
          void_refund: true,
          manage_open_tickets: true,
          view_reports: true,
          manage_items: true,
          manage_inventory: true,
          manage_employees: false,
          manage_customers: true,
          manage_devices: false,
          manage_settings: false,
          manage_backup: false
        }
      },
      {
        id: 'role_cashier',
        name: 'Cashier',
        label: 'Kasir',
        is_system: true,
        permissions: {
          pos_access: true,
          edit_price: false,
          apply_discount: true,
          void_refund: false,
          manage_open_tickets: true,
          view_reports: false,
          manage_items: false,
          manage_inventory: false,
          manage_employees: false,
          manage_customers: true,
          manage_devices: false,
          manage_settings: false,
          manage_backup: false
        }
      },
      {
        id: 'role_kitchen',
        name: 'Kitchen Staff',
        label: 'Staf Dapur',
        is_system: true,
        permissions: {
          pos_access: true,
          edit_price: false,
          apply_discount: false,
          void_refund: false,
          manage_open_tickets: true,
          view_reports: false,
          manage_items: false,
          manage_inventory: true,
          manage_employees: false,
          manage_customers: false,
          manage_devices: false,
          manage_settings: false,
          manage_backup: false
        }
      }
    ];
    for (const r of roles) await this.upsert('roles', r, false);

    const emps = [
      { id: 'emp_tika', name: 'TIKA', role: 'Owner', role_id: 'role_owner', pin: '1234', phone: '0812-3456-7890', email: 'tika@postika.id', active: true, is_owner: true },
      { id: 'emp_admin', name: 'Rina (Admin)', role: 'Admin', role_id: 'role_admin', pin: '2222', phone: '0813-1111-2222', email: 'rina@postika.id', active: true, is_owner: false },
      { id: 'emp_manager', name: 'Budi (Manager)', role: 'Manager', role_id: 'role_manager', pin: '3333', phone: '0813-3333-4444', email: 'budi@postika.id', active: true, is_owner: false },
      { id: 'emp_cashier', name: 'Siti (Kasir)', role: 'Cashier', role_id: 'role_cashier', pin: '4444', phone: '0813-5555-6666', email: 'siti@postika.id', active: true, is_owner: false },
      { id: 'emp_kitchen', name: 'Andi (Dapur)', role: 'Kitchen Staff', role_id: 'role_kitchen', pin: '5555', phone: '0813-7777-8888', email: 'andi@postika.id', active: true, is_owner: false }
    ];
    for (const e of emps) await this.upsert('employees', e, false);
  }
}

window.posDB = new POSTikaDB();
