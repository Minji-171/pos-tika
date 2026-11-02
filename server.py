#!/usr/bin/env python3
"""
POS TIKA - Point of Sale & Business Management System
Local-First Backend Server, SQLite Storage Engine, WebRTC Signaling & P2P Relay Server
Pemilik: TIKA | Bahasa: Indonesia | Mata Uang: IDR | Zona Waktu: Asia/Jakarta
"""

import os
import re
import sys
import json
import time
import uuid
import socket
import shutil
import sqlite3
import hashlib
import threading
import subprocess
from datetime import datetime, timezone, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(DATA_DIR, "pos_tika.db")
SERVER_PORT = 8090

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

JKT_TZ = timezone(timedelta(hours=7))
DB_LOCK = threading.RLock()

# In-memory WebRTC signaling mailbox & peer presence registry
SIGNAL_LOCK = threading.RLock()
SIGNAL_MAILBOX = {}  # target_device_id -> list of signaling messages
PEER_PRESENCE = {}   # device_id -> { device_id, name, platform, last_seen, ip, business_id, status }

# Public Tunnel State (for accessing POS TIKA across different networks / 4G / 5G / Internet)
TUNNEL_LOCK = threading.RLock()
TUNNEL_STATE = {
    "status": "stopped",  # "stopped", "starting", "running", "error"
    "public_url": "",
    "provider": "",
    "error": "",
    "proc": None
}


def get_lan_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        if ip and not ip.startswith("127."):
            ips.add(ip)
        s.close()
    except Exception:
        pass
    return sorted(ips)


def start_public_tunnel(port=None):
    target_port = port or SERVER_PORT
    with TUNNEL_LOCK:
        if TUNNEL_STATE["status"] in ("running", "starting") and TUNNEL_STATE["proc"] and TUNNEL_STATE["proc"].poll() is None:
            return {
                "ok": True,
                "status": TUNNEL_STATE["status"],
                "public_url": TUNNEL_STATE["public_url"],
                "provider": TUNNEL_STATE["provider"]
            }
        stop_public_tunnel()
        TUNNEL_STATE["status"] = "starting"
        TUNNEL_STATE["public_url"] = ""
        TUNNEL_STATE["error"] = ""

    def _tunnel_worker():
        # Try cloudflared first if available, otherwise built-in OpenSSH (localhost.run)
        cloudflared_bin = shutil.which("cloudflared")
        if cloudflared_bin:
            cmd = [cloudflared_bin, "tunnel", "--url", f"http://127.0.0.1:{target_port}", "--no-autoupdate"]
            provider = "Cloudflare Tunnel"
            url_pattern = re.compile(r"(https://[a-zA-Z0-9.-]+\.trycloudflare\.com)")
        else:
            ssh_bin = shutil.which("ssh")
            if not ssh_bin:
                with TUNNEL_LOCK:
                    TUNNEL_STATE["status"] = "error"
                    TUNNEL_STATE["error"] = "OpenSSH / cloudflared tidak ditemukan di sistem ini."
                return
            cmd = [
                ssh_bin,
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null" if os.name != "nt" else "UserKnownHostsFile=NUL",
                "-o", "ServerAliveInterval=30",
                "-R", f"80:127.0.0.1:{target_port}",
                "nokey@localhost.run"
            ]
            provider = "Localhost.run HTTPS Tunnel"
            url_pattern = re.compile(r"(https://[a-zA-Z0-9.-]+\.(?:lhr\.life|localhost\.run))")

        try:
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                creationflags=creationflags
            )
            with TUNNEL_LOCK:
                TUNNEL_STATE["proc"] = proc
                TUNNEL_STATE["provider"] = provider

            for line in iter(proc.stdout.readline, ""):
                if not line:
                    break
                m = url_pattern.search(line)
                if m:
                    pub_url = m.group(1).rstrip("/")
                    with TUNNEL_LOCK:
                        TUNNEL_STATE["public_url"] = pub_url
                        TUNNEL_STATE["status"] = "running"
                    print(f"  [TUNNEL PUBLIK AKTIF] {pub_url}")

            proc.wait()
            with TUNNEL_LOCK:
                if TUNNEL_STATE["proc"] == proc:
                    TUNNEL_STATE["status"] = "stopped"
                    TUNNEL_STATE["public_url"] = ""
        except Exception as e:
            with TUNNEL_LOCK:
                TUNNEL_STATE["status"] = "error"
                TUNNEL_STATE["error"] = str(e)

    t = threading.Thread(target=_tunnel_worker, daemon=True)
    t.start()
    # Wait up to 4.5s for quick tunnel URL resolution
    for _ in range(18):
        time.sleep(0.25)
        with TUNNEL_LOCK:
            if TUNNEL_STATE["public_url"] or TUNNEL_STATE["status"] == "error":
                break
    with TUNNEL_LOCK:
        return {
            "ok": True,
            "status": TUNNEL_STATE["status"],
            "public_url": TUNNEL_STATE["public_url"],
            "provider": TUNNEL_STATE["provider"],
            "error": TUNNEL_STATE["error"]
        }


def stop_public_tunnel():
    with TUNNEL_LOCK:
        proc = TUNNEL_STATE.get("proc")
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        TUNNEL_STATE["proc"] = None
        TUNNEL_STATE["status"] = "stopped"
        TUNNEL_STATE["public_url"] = ""
        TUNNEL_STATE["error"] = ""
        return {"ok": True, "status": "stopped"}


def now_jkt_iso():
    return datetime.now(JKT_TZ).isoformat()


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db():
    with DB_LOCK:
        conn = get_db_connection()
        cur = conn.cursor()

        # Table 1: Entity Store (Normalized JSON document store per collection + metadata for CRDT/HLC sync)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS entities (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            hlc TEXT NOT NULL,
            deleted INTEGER DEFAULT 0,
            device_id TEXT NOT NULL,
            PRIMARY KEY (collection, id)
        );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_col ON entities(collection, deleted);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_hlc ON entities(hlc);")

        # Table 2: Operation Log (Oplog for P2P & Relay Synchronization without data loss or duplicate transactions)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS oplog (
            op_id TEXT PRIMARY KEY,
            hlc TEXT NOT NULL,
            device_id TEXT NOT NULL,
            collection TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_oplog_hlc ON oplog(hlc);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_oplog_created ON oplog(created_at);")

        # Table 3: Sync History Log
        cur.execute("""
        CREATE TABLE IF NOT EXISTS sync_logs (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            device_name TEXT NOT NULL,
            mode TEXT NOT NULL,
            ops_received INTEGER DEFAULT 0,
            ops_sent INTEGER DEFAULT 0,
            status TEXT NOT NULL,
            details TEXT,
            timestamp TEXT NOT NULL
        );
        """)

        conn.commit()

        # Check if initial seed for Owner TIKA & default business profile exists
        cur.execute("SELECT COUNT(*) as cnt FROM entities WHERE collection = 'settings'")
        row = cur.fetchone()
        if not row or row["cnt"] == 0:
            seed_initial_data(conn)

        conn.close()


def upsert_entity_internal(conn, collection, entity_id, data_obj, hlc, device_id, deleted=0):
    now_str = now_jkt_iso()
    cur = conn.cursor()
    cur.execute(
        "SELECT hlc, data FROM entities WHERE collection = ? AND id = ?",
        (collection, entity_id)
    )
    existing = cur.fetchone()
    if existing:
        # Conflict resolution:
        # For 'products', if stock is calculated via stock_movements, we preserve deterministic stock calculation
        if existing["hlc"] > hlc:
            # Incoming operation is older than current state; ignore overwrite unless it's an additive log
            return False
    cur.execute("""
        INSERT INTO entities (collection, id, data, updated_at, hlc, deleted, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
            data = excluded.data,
            updated_at = excluded.updated_at,
            hlc = excluded.hlc,
            deleted = excluded.deleted,
            device_id = excluded.device_id
    """, (collection, entity_id, json.dumps(data_obj, ensure_ascii=False), now_str, hlc, deleted, device_id))
    return True


def record_op_internal(conn, op):
    """
    Idempotently applies an operation from oplog.
    Prevents duplicate transactions and accurately applies stock deltas.
    """
    op_id = op.get("op_id")
    if not op_id:
        return False

    cur = conn.cursor()
    cur.execute("SELECT op_id FROM oplog WHERE op_id = ?", (op_id,))
    if cur.fetchone():
        # Already applied this exact operation! Zero duplicate transactions or double stock deductions.
        return False

    hlc = op.get("hlc") or f"{int(time.time()*1000):015d}-0000-SERVER"
    device_id = op.get("device_id") or "SERVER"
    collection = op.get("collection")
    entity_id = op.get("entity_id")
    action = op.get("action", "UPSERT")
    payload = op.get("payload", {})
    created_at = op.get("created_at") or now_jkt_iso()

    cur.execute("""
        INSERT INTO oplog (op_id, hlc, device_id, collection, entity_id, action, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (op_id, hlc, device_id, collection, entity_id, action, json.dumps(payload, ensure_ascii=False), created_at))

    if action == "DELETE":
        cur.execute("SELECT data FROM entities WHERE collection = ? AND id = ?", (collection, entity_id))
        row = cur.fetchone()
        existing_data = json.loads(row["data"]) if row else {"id": entity_id}
        existing_data["_deleted"] = True
        upsert_entity_internal(conn, collection, entity_id, existing_data, hlc, device_id, deleted=1)

    elif action == "STOCK_DELTA":
        # Atomic delta adjustment on product stock + insert into stock_movements collection
        product_id = payload.get("product_id")
        delta = float(payload.get("delta", 0))
        movement = payload.get("movement")
        if product_id:
            cur.execute("SELECT data, hlc FROM entities WHERE collection = 'products' AND id = ?", (product_id,))
            prow = cur.fetchone()
            if prow:
                pdata = json.loads(prow["data"])
                if pdata.get("track_stock", True):
                    old_stock = float(pdata.get("stock", 0))
                    new_stock = round(old_stock + delta, 4)
                    pdata["stock"] = new_stock
                    pdata["updated_at"] = created_at
                    new_hlc = max(hlc, prow["hlc"])
                    upsert_entity_internal(conn, "products", product_id, pdata, new_hlc, device_id, deleted=0)
                    if movement:
                        movement["stock_before"] = old_stock
                        movement["stock_after"] = new_stock
        if movement and movement.get("id"):
            upsert_entity_internal(conn, "stock_movements", movement["id"], movement, hlc, device_id, deleted=0)

    else:  # UPSERT
        upsert_entity_internal(conn, collection, entity_id, payload, hlc, device_id, deleted=0)

    return True


def seed_initial_data(conn):
    ts = now_jkt_iso()
    base_hlc = f"{int(time.time()*1000):015d}-0000-SEED"

    # 1. Business Settings & Feature Toggles
    settings_data = {
        "id": "main_settings",
        "app_name": "POS TIKA",
        "owner_name": "TIKA",
        "business_id": "BIZ-POSTIKA-01",
        "pairing_key": "TIKA-SYNC-2026",
        "store_name": "POS TIKA - Cabang Utama",
        "store_address": "Jl. Merdeka No. 88, Jakarta Pusat",
        "store_phone": "0812-3456-7890",
        "currency": "IDR",
        "timezone": "Asia/Jakarta",
        "language": "id-ID",
        "receipt_header": "POS TIKA\nRetail, Restoran & Kafe",
        "receipt_footer": "Terima kasih atas kunjungan Anda!\nBarang yang sudah dibeli tidak dapat ditukar kecuali ada perjanjian.",
        "qris_merchant_name": "POS TIKA OFFICIAL",
        "qris_nmid": "ID1026000889901",
        "bank_accounts": [
            {"bank": "BCA", "number": "8720192831", "holder": "TIKA"},
            {"bank": "Mandiri", "number": "1370098212345", "holder": "TIKA"},
            {"bank": "BRI", "number": "002901002391302", "holder": "TIKA"}
        ],
        "features": {
            "shift": True,
            "timecard": True,
            "open_tickets": True,
            "kitchen_printer": True,
            "customer_display": True,
            "dining_options": True,
            "low_stock_alert": True,
            "negative_stock_warning": True,
            "weight_barcodes": True
        },
        "weight_barcode_config": {
            "prefixes": ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"],
            "item_code_digits": 5,
            "weight_digits": 5,
            "weight_decimals": 3
        },
        "rtc_config": {
            "iceServers": [
                {"urls": "stun:stun.l.google.com:19302"},
                {"urls": "stun:stun1.l.google.com:19302"}
            ],
            "relay_enabled": True,
            "auto_sync_interval_sec": 8
        },
        "updated_at": ts
    }
    record_op_internal(conn, {
        "op_id": "seed-settings-01",
        "hlc": base_hlc,
        "device_id": "SERVER-MASTER",
        "collection": "settings",
        "entity_id": "main_settings",
        "action": "UPSERT",
        "payload": settings_data,
        "created_at": ts
    })

    # 2. Roles & Permissions (Owner, Admin, Manager, Cashier, Kitchen Staff)
    roles = [
        {
            "id": "role_owner",
            "name": "Owner",
            "label": "Pemilik Bisnis (Owner)",
            "is_system": True,
            "permissions": {
                "pos_access": True,
                "edit_price": True,
                "apply_discount": True,
                "void_refund": True,
                "manage_open_tickets": True,
                "view_reports": True,
                "manage_items": True,
                "manage_inventory": True,
                "manage_employees": True,
                "manage_customers": True,
                "manage_devices": True,
                "manage_settings": True,
                "manage_backup": True
            }
        },
        {
            "id": "role_admin",
            "name": "Admin",
            "label": "Administrator",
            "is_system": True,
            "permissions": {
                "pos_access": True,
                "edit_price": True,
                "apply_discount": True,
                "void_refund": True,
                "manage_open_tickets": True,
                "view_reports": True,
                "manage_items": True,
                "manage_inventory": True,
                "manage_employees": True,
                "manage_customers": True,
                "manage_devices": True,
                "manage_settings": True,
                "manage_backup": True
            }
        },
        {
            "id": "role_manager",
            "name": "Manager",
            "label": "Manajer Toko",
            "is_system": True,
            "permissions": {
                "pos_access": True,
                "edit_price": True,
                "apply_discount": True,
                "void_refund": True,
                "manage_open_tickets": True,
                "view_reports": True,
                "manage_items": True,
                "manage_inventory": True,
                "manage_employees": False,
                "manage_customers": True,
                "manage_devices": False,
                "manage_settings": False,
                "manage_backup": False
            }
        },
        {
            "id": "role_cashier",
            "name": "Cashier",
            "label": "Kasir",
            "is_system": True,
            "permissions": {
                "pos_access": True,
                "edit_price": False,
                "apply_discount": True,
                "void_refund": False,
                "manage_open_tickets": True,
                "view_reports": False,
                "manage_items": False,
                "manage_inventory": False,
                "manage_employees": False,
                "manage_customers": True,
                "manage_devices": False,
                "manage_settings": False,
                "manage_backup": False
            }
        },
        {
            "id": "role_kitchen",
            "name": "Kitchen Staff",
            "label": "Staf Dapur",
            "is_system": True,
            "permissions": {
                "pos_access": True,
                "edit_price": False,
                "apply_discount": False,
                "void_refund": False,
                "manage_open_tickets": True,
                "view_reports": False,
                "manage_items": False,
                "manage_inventory": True,
                "manage_employees": False,
                "manage_customers": False,
                "manage_devices": False,
                "manage_settings": False,
                "manage_backup": False
            }
        }
    ]
    for r in roles:
        record_op_internal(conn, {
            "op_id": f"seed-role-{r['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "roles",
            "entity_id": r["id"],
            "action": "UPSERT",
            "payload": r,
            "created_at": ts
        })

    # 3. Employees (Owner TIKA + Staff)
    employees = [
        {
            "id": "emp_tika",
            "name": "TIKA",
            "role": "Owner",
            "role_id": "role_owner",
            "pin": "1234",
            "phone": "0812-3456-7890",
            "email": "tika@postika.id",
            "active": True,
            "is_owner": True,
            "created_at": ts
        },
        {
            "id": "emp_admin",
            "name": "Rina (Admin)",
            "role": "Admin",
            "role_id": "role_admin",
            "pin": "2222",
            "phone": "0813-1111-2222",
            "email": "rina@postika.id",
            "active": True,
            "is_owner": False,
            "created_at": ts
        },
        {
            "id": "emp_manager",
            "name": "Budi (Manager)",
            "role": "Manager",
            "role_id": "role_manager",
            "pin": "3333",
            "phone": "0813-3333-4444",
            "email": "budi@postika.id",
            "active": True,
            "is_owner": False,
            "created_at": ts
        },
        {
            "id": "emp_cashier",
            "name": "Siti (Kasir)",
            "role": "Cashier",
            "role_id": "role_cashier",
            "pin": "4444",
            "phone": "0813-5555-6666",
            "email": "siti@postika.id",
            "active": True,
            "is_owner": False,
            "created_at": ts
        },
        {
            "id": "emp_kitchen",
            "name": "Andi (Dapur)",
            "role": "Kitchen Staff",
            "role_id": "role_kitchen",
            "pin": "5555",
            "phone": "0813-7777-8888",
            "email": "andi@postika.id",
            "active": True,
            "is_owner": False,
            "created_at": ts
        }
    ]
    for emp in employees:
        record_op_internal(conn, {
            "op_id": f"seed-emp-{emp['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "employees",
            "entity_id": emp["id"],
            "action": "UPSERT",
            "payload": emp,
            "created_at": ts
        })

    # 4. Categories
    categories = [
        {"id": "cat_minuman", "name": "Minuman & Kopi", "color": "#10b981", "sort_order": 1},
        {"id": "cat_makanan", "name": "Makanan Utama", "color": "#f59e0b", "sort_order": 2},
        {"id": "cat_snack", "name": "Camilan & Roti", "color": "#3b82f6", "sort_order": 3},
        {"id": "cat_retail", "name": "Retail & Kemasan", "color": "#8b5cf6", "sort_order": 4},
        {"id": "cat_segar", "name": "Produk Timbangan (Kg)", "color": "#ec4899", "sort_order": 5}
    ]
    for c in categories:
        record_op_internal(conn, {
            "op_id": f"seed-cat-{c['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "categories",
            "entity_id": c["id"],
            "action": "UPSERT",
            "payload": c,
            "created_at": ts
        })

    # 5. Modifiers
    modifiers = [
        {
            "id": "mod_sugar",
            "name": "Level Gula",
            "options": [
                {"id": "opt_sug_normal", "name": "Normal Sugar (100%)", "price": 0},
                {"id": "opt_sug_less", "name": "Less Sugar (50%)", "price": 0},
                {"id": "opt_sug_no", "name": "No Sugar (0%)", "price": 0}
            ]
        },
        {
            "id": "mod_topping",
            "name": "Topping Tambahan",
            "options": [
                {"id": "opt_top_espresso", "name": "Extra Shot Espresso", "price": 6000},
                {"id": "opt_top_boba", "name": "Brown Sugar Boba", "price": 5000},
                {"id": "opt_top_cheese", "name": "Cheese Foam", "price": 7000},
                {"id": "opt_top_oat", "name": "Ganti Oat Milk", "price": 8000}
            ]
        },
        {
            "id": "mod_spicy",
            "name": "Level Pedas",
            "options": [
                {"id": "opt_sp_0", "name": "Tidak Pedas", "price": 0},
                {"id": "opt_sp_1", "name": "Pedas Sedang", "price": 0},
                {"id": "opt_sp_2", "name": "Pedas Ekstra (+Sambal)", "price": 3000}
            ]
        }
    ]
    for m in modifiers:
        record_op_internal(conn, {
            "op_id": f"seed-mod-{m['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "modifiers",
            "entity_id": m["id"],
            "action": "UPSERT",
            "payload": m,
            "created_at": ts
        })

    # 6. Discounts
    discounts = [
        {"id": "disc_member10", "name": "Diskon Pelanggan Setia 10%", "type": "PERCENTAGE", "value": 10, "active": True},
        {"id": "disc_promo5k", "name": "Potongan Langsung Rp 5.000", "type": "FIXED", "value": 5000, "active": True},
        {"id": "disc_karyawan", "name": "Diskon Staf 20%", "type": "PERCENTAGE", "value": 20, "active": True}
    ]
    for d in discounts:
        record_op_internal(conn, {
            "op_id": f"seed-disc-{d['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "discounts",
            "entity_id": d["id"],
            "action": "UPSERT",
            "payload": d,
            "created_at": ts
        })

    # 7. Taxes
    taxes = [
        {"id": "tax_pb1", "name": "PB1 Restoran (10%)", "rate": 10.0, "type": "ADDED", "active": True, "is_default": True},
        {"id": "tax_ppn11", "name": "PPN Retail (11% Termasuk)", "rate": 11.0, "type": "INCLUDED", "active": True, "is_default": False}
    ]
    for tx in taxes:
        record_op_internal(conn, {
            "op_id": f"seed-tax-{tx['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "taxes",
            "entity_id": tx["id"],
            "action": "UPSERT",
            "payload": tx,
            "created_at": ts
        })

    # 8. Products Catalog (Real operational items for POS TIKA)
    products = [
        {
            "id": "prd_kopi_tika",
            "name": "Es Kopi Susu Gula Aren TIKA",
            "category_id": "cat_minuman",
            "sku": "KOP-001",
            "barcode": "8991001000011",
            "cost": 9500,
            "price": 22000,
            "unit": "cup",
            "stock": 85,
            "min_stock": 15,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#10b981",
            "image": "",
            "modifier_ids": ["mod_sugar", "mod_topping"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_matcha",
            "name": "Uji Matcha Latte Iced",
            "category_id": "cat_minuman",
            "sku": "KOP-002",
            "barcode": "8991001000028",
            "cost": 12000,
            "price": 26000,
            "unit": "cup",
            "stock": 50,
            "min_stock": 10,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#059669",
            "image": "",
            "modifier_ids": ["mod_sugar", "mod_topping"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_americano",
            "name": "Iced Americano Arabica",
            "category_id": "cat_minuman",
            "sku": "KOP-003",
            "barcode": "8991001000035",
            "cost": 7000,
            "price": 18000,
            "unit": "cup",
            "stock": 60,
            "min_stock": 10,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#047857",
            "image": "",
            "modifier_ids": ["mod_sugar"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_nasgor",
            "name": "Nasi Goreng Spesial TIKA",
            "category_id": "cat_makanan",
            "sku": "MKN-001",
            "barcode": "8991002000018",
            "cost": 16000,
            "price": 32000,
            "unit": "porsi",
            "stock": 40,
            "min_stock": 8,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#f59e0b",
            "image": "",
            "modifier_ids": ["mod_spicy"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_ricebowl",
            "name": "Chicken Teriyaki Rice Bowl",
            "category_id": "cat_makanan",
            "sku": "MKN-002",
            "barcode": "8991002000025",
            "cost": 15000,
            "price": 29000,
            "unit": "porsi",
            "stock": 35,
            "min_stock": 8,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#d97706",
            "image": "",
            "modifier_ids": ["mod_spicy"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_mie_tika",
            "name": "Mie Tek-Tek Kuah Pedas",
            "category_id": "cat_makanan",
            "sku": "MKN-003",
            "barcode": "8991002000032",
            "cost": 12000,
            "price": 25000,
            "unit": "porsi",
            "stock": 30,
            "min_stock": 5,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#ea580c",
            "image": "",
            "modifier_ids": ["mod_spicy"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_croissant",
            "name": "Butter Croissant Artisan",
            "category_id": "cat_snack",
            "sku": "SNK-001",
            "barcode": "8991003000015",
            "cost": 10000,
            "price": 21000,
            "unit": "pcs",
            "stock": 25,
            "min_stock": 6,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#3b82f6",
            "image": "",
            "modifier_ids": [],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_fries",
            "name": "French Fries Truffle Mayo",
            "category_id": "cat_snack",
            "sku": "SNK-002",
            "barcode": "8991003000022",
            "cost": 9000,
            "price": 20000,
            "unit": "porsi",
            "stock": 45,
            "min_stock": 10,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#2563eb",
            "image": "",
            "modifier_ids": ["mod_spicy"],
            "tax_ids": ["tax_pb1"]
        },
        {
            "id": "prd_beans250",
            "name": "Biji Kopi House Blend 250g",
            "category_id": "cat_retail",
            "sku": "RTL-001",
            "barcode": "8991004000012",
            "cost": 55000,
            "price": 85000,
            "unit": "pack",
            "stock": 18,
            "min_stock": 5,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#8b5cf6",
            "image": "",
            "modifier_ids": [],
            "tax_ids": ["tax_ppn11"]
        },
        {
            "id": "prd_tumbler",
            "name": "Tumbler Stainless POS TIKA",
            "category_id": "cat_retail",
            "sku": "RTL-002",
            "barcode": "8991004000029",
            "cost": 65000,
            "price": 120000,
            "unit": "pcs",
            "stock": 7,
            "min_stock": 10,
            "track_stock": True,
            "sold_by_weight": False,
            "color": "#7c3aed",
            "image": "",
            "modifier_ids": [],
            "tax_ids": ["tax_ppn11"]
        },
        {
            "id": "prd_arabica_kg",
            "name": "Biji Kopi Gayo Curah (Timbangan)",
            "category_id": "cat_segar",
            "sku": "10001",
            "barcode": "10001",
            "cost": 140000,
            "price": 220000,
            "unit": "kg",
            "stock": 12.5,
            "min_stock": 3.0,
            "track_stock": True,
            "sold_by_weight": True,
            "color": "#ec4899",
            "image": "",
            "modifier_ids": [],
            "tax_ids": ["tax_ppn11"]
        },
        {
            "id": "prd_buah_kg",
            "name": "Jeruk Mandarin Segar (Timbangan)",
            "category_id": "cat_segar",
            "sku": "10002",
            "barcode": "10002",
            "cost": 28000,
            "price": 45000,
            "unit": "kg",
            "stock": 20.0,
            "min_stock": 5.0,
            "track_stock": True,
            "sold_by_weight": True,
            "color": "#db2777",
            "image": "",
            "modifier_ids": [],
            "tax_ids": []
        }
    ]
    for p in products:
        record_op_internal(conn, {
            "op_id": f"seed-prd-{p['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "products",
            "entity_id": p["id"],
            "action": "UPSERT",
            "payload": p,
            "created_at": ts
        })

    # 9. Customers
    customers = [
        {
            "id": "cust_umum",
            "name": "Pelanggan Umum",
            "phone": "-",
            "email": "",
            "address": "-",
            "notes": "Pelanggan walk-in default",
            "points": 0,
            "total_transactions": 0,
            "total_spent": 0,
            "created_at": ts
        },
        {
            "id": "cust_dewi",
            "name": "Dewi Lestari",
            "phone": "0811-2233-4455",
            "email": "dewi.lestari@email.id",
            "address": "Jl. Sudirman Kav. 21, Jakarta",
            "notes": "Suka Es Kopi Susu Less Sugar",
            "points": 120,
            "total_transactions": 0,
            "total_spent": 0,
            "created_at": ts
        },
        {
            "id": "cust_hendra",
            "name": "Hendra Wijaya",
            "phone": "0812-9988-7766",
            "email": "hendra.w@email.id",
            "address": "Komp. Griya Asri Blok B4",
            "notes": "Pelanggan langganan katering kantor",
            "points": 250,
            "total_transactions": 0,
            "total_spent": 0,
            "created_at": ts
        }
    ]
    for cust in customers:
        record_op_internal(conn, {
            "op_id": f"seed-cust-{cust['id']}",
            "hlc": base_hlc,
            "device_id": "SERVER-MASTER",
            "collection": "customers",
            "entity_id": cust["id"],
            "action": "UPSERT",
            "payload": cust,
            "created_at": ts
        })

    # 10. Primary Server Device Registration
    master_device = {
        "id": "DEV-MASTER-PC",
        "name": "Kasir Utama (Server PC)",
        "platform": "Windows PC / Server",
        "business_id": "BIZ-POSTIKA-01",
        "status": "online",
        "authorized": True,
        "last_sync": ts,
        "created_at": ts
    }
    record_op_internal(conn, {
        "op_id": "seed-dev-master",
        "hlc": base_hlc,
        "device_id": "SERVER-MASTER",
        "collection": "devices",
        "entity_id": master_device["id"],
        "action": "UPSERT",
        "payload": master_device,
        "created_at": ts
    })

    conn.commit()


class POSTikaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, format, *args):
        # Quiet standard logging to keep console clean
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Device-ID, X-Business-ID, X-Pairing-Key")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Device-ID, X-Business-ID, X-Pairing-Key")
        self.end_headers()

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/ping":
            return self.send_json({
                "ok": True,
                "app": "POS TIKA",
                "owner": "TIKA",
                "server_time": now_jkt_iso(),
                "timezone": "Asia/Jakarta"
            })

        if path == "/api/network-info":
            lan_ips = get_lan_ips()
            lan_urls = [f"http://{ip}:{SERVER_PORT}" for ip in lan_ips]
            with TUNNEL_LOCK:
                t_status = TUNNEL_STATE["status"]
                t_url = TUNNEL_STATE["public_url"]
                t_prov = TUNNEL_STATE["provider"]
                t_err = TUNNEL_STATE["error"]
            return self.send_json({
                "ok": True,
                "port": SERVER_PORT,
                "lan_ips": lan_ips,
                "lan_urls": lan_urls,
                "tunnel": {
                    "status": t_status,
                    "public_url": t_url,
                    "provider": t_prov,
                    "error": t_err
                },
                "server_time": now_jkt_iso()
            })

        if path == "/api/bootstrap":
            with DB_LOCK:
                conn = get_db_connection()
                cur = conn.cursor()
                cur.execute("SELECT collection, id, data, updated_at, hlc, deleted, device_id FROM entities WHERE deleted = 0")
                rows = cur.fetchall()
                collections = {}
                for r in rows:
                    col = r["collection"]
                    if col not in collections:
                        collections[col] = []
                    collections[col].append(json.loads(r["data"]))

                cur.execute("SELECT MAX(hlc) as max_hlc, COUNT(*) as total_ops FROM oplog")
                op_meta = cur.fetchone()
                conn.close()

            return self.send_json({
                "ok": True,
                "server_time": now_jkt_iso(),
                "max_hlc": op_meta["max_hlc"] if op_meta and op_meta["max_hlc"] else "",
                "total_ops": op_meta["total_ops"] if op_meta else 0,
                "collections": collections
            })

        if path == "/api/oplog":
            since_hlc = query.get("since_hlc", [""])[0]
            limit = int(query.get("limit", ["2000"])[0])
            with DB_LOCK:
                conn = get_db_connection()
                cur = conn.cursor()
                if since_hlc:
                    cur.execute(
                        "SELECT op_id, hlc, device_id, collection, entity_id, action, payload, created_at FROM oplog WHERE hlc > ? ORDER BY hlc ASC LIMIT ?",
                        (since_hlc, limit)
                    )
                else:
                    cur.execute(
                        "SELECT op_id, hlc, device_id, collection, entity_id, action, payload, created_at FROM oplog ORDER BY hlc ASC LIMIT ?",
                        (limit,)
                    )
                ops = []
                for r in cur.fetchall():
                    ops.append({
                        "op_id": r["op_id"],
                        "hlc": r["hlc"],
                        "device_id": r["device_id"],
                        "collection": r["collection"],
                        "entity_id": r["entity_id"],
                        "action": r["action"],
                        "payload": json.loads(r["payload"]),
                        "created_at": r["created_at"]
                    })
                conn.close()
            return self.send_json({"ok": True, "ops": ops})

        if path == "/api/sync/logs":
            with DB_LOCK:
                conn = get_db_connection()
                cur = conn.cursor()
                cur.execute("SELECT * FROM sync_logs ORDER BY timestamp DESC LIMIT 100")
                logs = [dict(r) for r in cur.fetchall()]
                conn.close()
            return self.send_json({"ok": True, "logs": logs})

        if path == "/api/rtc/poll":
            device_id = query.get("device_id", [""])[0]
            device_name = query.get("name", ["Perangkat POS TIKA"])[0]
            platform = query.get("platform", ["Browser PWA"])[0]
            now_ts = time.time()

            with SIGNAL_LOCK:
                if device_id:
                    PEER_PRESENCE[device_id] = {
                        "device_id": device_id,
                        "name": device_name,
                        "platform": platform,
                        "last_seen": now_ts,
                        "last_seen_iso": now_jkt_iso(),
                        "ip": self.client_address[0]
                    }
                # Prune stale peers (> 30s)
                active_peers = []
                for pid, pinfo in list(PEER_PRESENCE.items()):
                    if now_ts - pinfo["last_seen"] <= 35:
                        active_peers.append(pinfo)
                messages = SIGNAL_MAILBOX.pop(device_id, []) if device_id else []

            return self.send_json({
                "ok": True,
                "peers": active_peers,
                "messages": messages,
                "server_time": now_jkt_iso()
            })

        # Fallback to static files for SPA / PWA
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_json_body()

        if path == "/api/sync":
            # Full P2P & Relay Oplog Synchronization Endpoint
            device_id = body.get("device_id", "UNKNOWN")
            device_name = body.get("device_name", "Perangkat POS")
            platform = body.get("platform", "PWA")
            since_hlc = body.get("since_hlc", "")
            incoming_ops = body.get("ops", [])
            mode = body.get("mode", "P2P-Relay")

            applied_count = 0
            with DB_LOCK:
                conn = get_db_connection()
                cur = conn.cursor()

                # Check if device is revoked
                cur.execute("SELECT data FROM entities WHERE collection = 'devices' AND id = ?", (device_id,))
                dev_row = cur.fetchone()
                if dev_row:
                    dev_data = json.loads(dev_row["data"])
                    if dev_data.get("authorized") is False:
                        conn.close()
                        return self.send_json({
                            "ok": False,
                            "revoked": True,
                            "error": "Akses perangkat ini telah dicabut oleh pemilik bisnis (TIKA)."
                        }, status=403)

                for op in incoming_ops:
                    if record_op_internal(conn, op):
                        applied_count += 1

                # Update or register device heartbeat
                now_str = now_jkt_iso()
                dev_hlc = f"{int(time.time()*1000):015d}-0000-{device_id}"
                if dev_row:
                    dev_data = json.loads(dev_row["data"])
                    dev_data["status"] = "online"
                    dev_data["last_sync"] = now_str
                    dev_data["name"] = device_name or dev_data.get("name", device_id)
                    dev_data["platform"] = platform or dev_data.get("platform", "PWA")
                else:
                    dev_data = {
                        "id": device_id,
                        "name": device_name,
                        "platform": platform,
                        "business_id": "BIZ-POSTIKA-01",
                        "status": "online",
                        "authorized": True,
                        "last_sync": now_str,
                        "created_at": now_str
                    }
                upsert_entity_internal(conn, "devices", device_id, dev_data, dev_hlc, device_id, deleted=0)

                # Fetch missing ops for this device
                if since_hlc:
                    cur.execute(
                        "SELECT op_id, hlc, device_id, collection, entity_id, action, payload, created_at FROM oplog WHERE hlc > ? ORDER BY hlc ASC LIMIT 2500",
                        (since_hlc,)
                    )
                else:
                    cur.execute(
                        "SELECT op_id, hlc, device_id, collection, entity_id, action, payload, created_at FROM oplog ORDER BY hlc ASC LIMIT 2500"
                    )
                missing_ops = []
                max_hlc = since_hlc
                for r in cur.fetchall():
                    if r["hlc"] > max_hlc:
                        max_hlc = r["hlc"]
                    missing_ops.append({
                        "op_id": r["op_id"],
                        "hlc": r["hlc"],
                        "device_id": r["device_id"],
                        "collection": r["collection"],
                        "entity_id": r["entity_id"],
                        "action": r["action"],
                        "payload": json.loads(r["payload"]),
                        "created_at": r["created_at"]
                    })

                # Record sync log if any ops were exchanged or explicit manual sync
                if applied_count > 0 or body.get("manual"):
                    log_id = f"synclog-{uuid.uuid4().hex[:10]}"
                    cur.execute("""
                        INSERT INTO sync_logs (id, device_id, device_name, mode, ops_received, ops_sent, status, details, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        log_id,
                        device_id,
                        device_name,
                        mode,
                        applied_count,
                        len(missing_ops),
                        "SUCCESS",
                        f"Diterima {applied_count} operasi, dikirim {len(missing_ops)} operasi",
                        now_str
                    ))

                conn.commit()
                conn.close()

            with SIGNAL_LOCK:
                PEER_PRESENCE[device_id] = {
                    "device_id": device_id,
                    "name": device_name,
                    "platform": platform,
                    "last_seen": time.time(),
                    "last_seen_iso": now_str,
                    "ip": self.client_address[0]
                }

            return self.send_json({
                "ok": True,
                "applied": applied_count,
                "ops": missing_ops,
                "max_hlc": max_hlc,
                "server_time": now_str
            })

        if path == "/api/rtc/signal":
            # WebRTC Signaling & P2P Relay Message Forwarding
            # Relay does NOT store business data permanently; it routes SDP/ICE/Data packets to target peers
            sender_id = body.get("from")
            target_id = body.get("to")
            msg_type = body.get("type")  # "offer", "answer", "ice", "p2p_ops"
            data = body.get("data")

            with SIGNAL_LOCK:
                if target_id == "*" or not target_id:
                    # Broadcast to all active peers except sender
                    for pid in PEER_PRESENCE.keys():
                        if pid != sender_id:
                            SIGNAL_MAILBOX.setdefault(pid, []).append({
                                "from": sender_id,
                                "to": pid,
                                "type": msg_type,
                                "data": data,
                                "timestamp": now_jkt_iso()
                            })
                else:
                    SIGNAL_MAILBOX.setdefault(target_id, []).append({
                        "from": sender_id,
                        "to": target_id,
                        "type": msg_type,
                        "data": data,
                        "timestamp": now_jkt_iso()
                    })

            return self.send_json({"ok": True})

        if path == "/api/restore":
            # Full database restore (Merge or Replace)
            mode = body.get("mode", "merge")  # "merge" or "replace"
            collections = body.get("collections", {})
            ops = body.get("ops", [])
            device_id = body.get("device_id", "RESTORE-ADMIN")

            with DB_LOCK:
                conn = get_db_connection()
                cur = conn.cursor()
                if mode == "replace":
                    cur.execute("DELETE FROM entities")
                    cur.execute("DELETE FROM oplog")

                restored_count = 0
                base_hlc = f"{int(time.time()*1000):015d}-0000-{device_id}"
                now_str = now_jkt_iso()

                if ops:
                    for op in ops:
                        if record_op_internal(conn, op):
                            restored_count += 1

                for col_name, items in collections.items():
                    if not isinstance(items, list):
                        continue
                    for item in items:
                        if not isinstance(item, dict) or "id" not in item:
                            continue
                        op_obj = {
                            "op_id": f"restore-{col_name}-{item['id']}-{uuid.uuid4().hex[:8]}",
                            "hlc": base_hlc,
                            "device_id": device_id,
                            "collection": col_name,
                            "entity_id": item["id"],
                            "action": "UPSERT",
                            "payload": item,
                            "created_at": now_str
                        }
                        if record_op_internal(conn, op_obj):
                            restored_count += 1

                conn.commit()
                conn.close()

            return self.send_json({"ok": True, "restored": restored_count, "server_time": now_jkt_iso()})

        if path == "/api/tunnel":
            action = body.get("action", "start")
            if action == "stop":
                return self.send_json(stop_public_tunnel())
            else:
                return self.send_json(start_public_tunnel(SERVER_PORT))

        return self.send_json({"ok": False, "error": "Endpoint tidak ditemukan"}, status=404)


def run_server(port=8090):
    global SERVER_PORT
    SERVER_PORT = port
    init_db()
    lan_ips = get_lan_ips()
    server = ThreadingHTTPServer(("0.0.0.0", port), POSTikaHandler)
    print(f"============================================================")
    print(f"  POS TIKA - Point of Sale & Business Management System")
    print(f"  Pemilik: TIKA | Zona Waktu: Asia/Jakarta | Mata Uang: IDR")
    print(f"  Server Lokal (PC Ini)   : http://localhost:{port}")
    for ip in lan_ips:
        print(f"  Akses Satu Wi-Fi (LAN)  : http://{ip}:{port}")
    print(f"  Database Lokal          : {DB_PATH}")
    print(f"============================================================")
    # Automatically start public tunnel in background so cross-network devices can connect immediately
    threading.Thread(target=start_public_tunnel, args=(port,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop_public_tunnel()
        print("\nMenutup server POS TIKA...")
        server.server_close()


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    run_server(port_arg)
