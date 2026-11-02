/**
 * POS TIKA - P2P WebRTC DataChannel + Global Cloud Signaling + Relay Synchronization Engine
 * Supports:
 * 1. Offline-First Local Operation Queue (IndexedDB oplog)
 * 2. WebRTC Peer-to-Peer DataChannel (STUN / TURN configurable for NAT traversal)
 * 3. Global Cross-Network P2P Signaling & Oplog Relay via MQTT-over-WebSocket (works across 4G/5G/different Wi-Fi)
 * 4. Public HTTPS Tunnel Integration & HTTP Relay Fallback
 * 5. BroadcastChannel for instant local multi-tab & Customer Display sync
 */

class POSTikaSyncEngine {
  constructor(db) {
    this.db = db;
    this.isOnline = navigator.onLine;
    this.isSyncing = false;
    this.simulatedOffline = localStorage.getItem('postika_sim_offline') === '1';
    this.relayUrl = localStorage.getItem('postika_relay_url') || ''; // Empty means current origin
    this.lastServerSyncedHlc = localStorage.getItem('postika_server_hlc') || '';
    this.peers = new Map(); // peerId -> { info, pc, dc, status }
    this.activePeerList = [];
    this.cloudPeers = new Map(); // peerId -> { device_id, name, platform, last_seen, via: 'Cloud-P2P' }
    this.syncHistory = JSON.parse(localStorage.getItem('postika_sync_history') || '[]');
    this.statusListeners = new Set();

    // Network & Public Tunnel Info from local server
    this.networkInfo = {
      port: 8090,
      lan_ips: [],
      lan_urls: [],
      tunnel: { status: 'stopped', public_url: '', provider: '', error: '' }
    };

    // Global Cross-Network Cloud P2P Bridge (MQTT over WebSockets)
    this.mqttWs = null;
    this.mqttConnected = false;
    this.mqttBrokerIdx = 0;
    this.mqttBrokers = [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ];

    // BroadcastChannel for instant zero-latency local tab & Customer Display sync
    this.bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('postika_p2p_bus') : null;
    if (this.bus) {
      this.bus.onmessage = async (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'OP' && msg.op && msg.from !== this.db.deviceId) {
          await this.db.applyOp(msg.op, false);
          this.recordLocalSyncLog(msg.from, 'P2P-LocalBus', 1, 0, 'Operasi diterima via P2P Local Bus');
        } else if (msg.type === 'CART_STATE' && window.posApp) {
          window.posApp.onCustomerDisplayUpdate(msg.cartState);
        }
      };
    }

    window.addEventListener('online', () => {
      this.isOnline = true;
      this.emitStatus();
      if (!this.simulatedOffline) {
        this.connectCloudMqttBridge();
        this.syncNow('Auto-Reconnect');
      }
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.emitStatus();
    });
  }

  getApiBase() {
    return this.relayUrl ? this.relayUrl.replace(/\/+$/, '') : '';
  }

  getBusinessTopic() {
    const settings = this.db.getSettings();
    const bizId = (localStorage.getItem('postika_pair_biz') || settings.business_id || 'BIZ-POSTIKA-01').trim();
    const pairKey = (localStorage.getItem('postika_pair_key') || settings.pairing_key || 'TIKA-SYNC-2026').trim();
    return `postika/v1/${bizId}/${pairKey}`;
  }

  onStatusChange(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  emitStatus() {
    const state = this.getStatusSummary();
    for (const fn of this.statusListeners) {
      try {
        fn(state);
      } catch (_) {}
    }
  }

  setSimulatedOffline(flag) {
    this.simulatedOffline = Boolean(flag);
    localStorage.setItem('postika_sim_offline', this.simulatedOffline ? '1' : '0');
    if (this.simulatedOffline) {
      for (const [, p] of this.peers.entries()) {
        try {
          if (p.dc) p.dc.close();
          if (p.pc) p.pc.close();
        } catch (_) {}
      }
      this.peers.clear();
      if (this.mqttWs) {
        try {
          this.mqttWs.close();
        } catch (_) {}
        this.mqttWs = null;
        this.mqttConnected = false;
      }
    } else {
      this.connectCloudMqttBridge();
      this.syncNow('Manual-Online');
    }
    this.emitStatus();
  }

  getMergedActivePeers() {
    const map = new Map();
    const now = Date.now();
    for (const p of this.activePeerList || []) {
      if (p.device_id && p.device_id !== this.db.deviceId) {
        map.set(p.device_id, p);
      }
    }
    for (const [pid, p] of this.cloudPeers.entries()) {
      if (pid !== this.db.deviceId && now - p.last_seen <= 45000) {
        if (!map.has(pid)) {
          map.set(pid, p);
        }
      }
    }
    return Array.from(map.values());
  }

  getStatusSummary() {
    const effectiveOnline = (this.isOnline || this.mqttConnected) && !this.simulatedOffline;
    let openWebRtcCount = 0;
    for (const [, p] of this.peers.entries()) {
      if (p.dc && p.dc.readyState === 'open') openWebRtcCount++;
    }
    const mergedPeers = this.getMergedActivePeers();
    return {
      online: effectiveOnline,
      simulatedOffline: this.simulatedOffline,
      syncing: this.isSyncing,
      cloudConnected: this.mqttConnected && !this.simulatedOffline,
      webrtcPeers: openWebRtcCount,
      discoveredPeers: mergedPeers.length,
      tunnelUrl: this.networkInfo?.tunnel?.public_url || '',
      tunnelStatus: this.networkInfo?.tunnel?.status || 'stopped',
      lanUrls: this.networkInfo?.lan_urls || [],
      lastSync: localStorage.getItem('postika_last_sync_time') || '-'
    };
  }

  start() {
    this.fetchNetworkInfo();
    this.connectCloudMqttBridge();

    // Periodic Relay & Signaling Heartbeat
    this.pollInterval = setInterval(() => {
      if (!this.simulatedOffline && navigator.onLine) {
        this.pollSignalingAndPeers();
        this.publishCloudPresence();
      }
    }, 4000);

    this.netInfoInterval = setInterval(() => {
      if (!this.simulatedOffline && navigator.onLine) {
        this.fetchNetworkInfo();
      }
    }, 10000);

    this.syncInterval = setInterval(() => {
      if (!this.simulatedOffline && navigator.onLine) {
        this.syncNow('Auto-Periodic');
      }
    }, 8000);

    if (!this.simulatedOffline && navigator.onLine) {
      this.pollSignalingAndPeers();
      this.syncNow('Initial-Boot');
    }
    this.emitStatus();
  }

  async fetchNetworkInfo() {
    try {
      const base = this.getApiBase();
      const res = await fetch(`${base}/api/network-info`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.ok) {
        const prevTunnel = this.networkInfo?.tunnel?.public_url || '';
        this.networkInfo = data;
        if (data.tunnel?.public_url && data.tunnel.public_url !== prevTunnel) {
          this.emitStatus();
        }
      }
      return data;
    } catch (_) {
      return null;
    }
  }

  async startPublicTunnel() {
    try {
      const base = this.getApiBase();
      const res = await fetch(`${base}/api/tunnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' })
      });
      const data = await res.json();
      await this.fetchNetworkInfo();
      this.emitStatus();
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async stopPublicTunnel() {
    try {
      const base = this.getApiBase();
      const res = await fetch(`${base}/api/tunnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });
      const data = await res.json();
      await this.fetchNetworkInfo();
      this.emitStatus();
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ========================================================================
     GLOBAL CLOUD P2P BRIDGE (MQTT v3.1.1 over WebSocket - Zero Dependency)
     Enables devices on completely different networks (4G / 5G / Wi-Fi lain)
     to discover peers, exchange WebRTC ICE/SDP, and sync oplog in real-time.
     ======================================================================== */
  _encodeMqttUTF8(str) {
    const enc = new TextEncoder().encode(str);
    const out = new Uint8Array(2 + enc.length);
    out[0] = (enc.length >> 8) & 0xff;
    out[1] = enc.length & 0xff;
    out.set(enc, 2);
    return out;
  }

  _encodeMqttVarLen(len) {
    const bytes = [];
    do {
      let encodedByte = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) encodedByte |= 128;
      bytes.push(encodedByte);
    } while (len > 0);
    return new Uint8Array(bytes);
  }

  _buildMqttPacket(typeFlags, payloadBytes) {
    const remLen = this._encodeMqttVarLen(payloadBytes.length);
    const pkt = new Uint8Array(1 + remLen.length + payloadBytes.length);
    pkt[0] = typeFlags;
    pkt.set(remLen, 1);
    pkt.set(payloadBytes, 1 + remLen.length);
    return pkt;
  }

  connectCloudMqttBridge() {
    if (this.simulatedOffline || typeof WebSocket === 'undefined') return;
    if (this.mqttWs && (this.mqttWs.readyState === WebSocket.OPEN || this.mqttWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const brokerUrl = this.mqttBrokers[this.mqttBrokerIdx % this.mqttBrokers.length];
    try {
      const ws = new WebSocket(brokerUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.mqttWs = ws;

      ws.onopen = () => {
        // Send MQTT CONNECT packet (Protocol Level 4 = v3.1.1)
        const clientId = `postika_${this.db.deviceId}_${Math.random().toString(36).slice(2, 6)}`;
        const protoName = this._encodeMqttUTF8('MQTT');
        const cidBytes = this._encodeMqttUTF8(clientId);
        const varHeader = new Uint8Array([0x04, 0x02, 0x00, 0x3c]); // level 4, clean session, keepalive 60s
        const body = new Uint8Array(protoName.length + varHeader.length + cidBytes.length);
        body.set(protoName, 0);
        body.set(varHeader, protoName.length);
        body.set(cidBytes, protoName.length + varHeader.length);
        ws.send(this._buildMqttPacket(0x10, body));
      };

      ws.onmessage = async (ev) => {
        const buf = new Uint8Array(ev.data);
        if (buf.length < 2) return;
        const pktType = buf[0] >> 4;

        if (pktType === 2) {
          // CONNACK -> Subscribe to Business Topic
          this.mqttConnected = true;
          this.emitStatus();
          const topicBytes = this._encodeMqttUTF8(this.getBusinessTopic());
          const subBody = new Uint8Array(2 + topicBytes.length + 1);
          subBody[0] = 0x00;
          subBody[1] = 0x01;
          subBody.set(topicBytes, 2);
          subBody[subBody.length - 1] = 0x00; // QoS 0
          ws.send(this._buildMqttPacket(0x82, subBody));

          // Announce presence & request missing ops from any peer on different network
          this.publishCloudPresence();
          this.publishCloudPacket({
            type: 'CLOUD_SYNC_REQ',
            from: this.db.deviceId,
            device_name: this.db.deviceName,
            since_hlc: this.db.lastHlc || ''
          });
        } else if (pktType === 3) {
          // PUBLISH packet received
          let idx = 1;
          let multiplier = 1;
          let remLen = 0;
          let encodedByte = 0;
          do {
            encodedByte = buf[idx++];
            remLen += (encodedByte & 127) * multiplier;
            multiplier *= 128;
          } while ((encodedByte & 128) !== 0 && idx < buf.length);

          const topicLen = (buf[idx] << 8) | buf[idx + 1];
          idx += 2 + topicLen;
          if ((buf[0] & 0x06) > 0) idx += 2; // Packet Identifier if QoS > 0
          const payloadBytes = buf.slice(idx);
          const jsonStr = new TextDecoder().decode(payloadBytes);
          try {
            const packet = JSON.parse(jsonStr);
            await this.handleCloudPacket(packet);
          } catch (_) {}
        }
      };

      ws.onclose = () => {
        this.mqttConnected = false;
        this.emitStatus();
        if (!this.simulatedOffline && navigator.onLine) {
          this.mqttBrokerIdx = (this.mqttBrokerIdx + 1) % this.mqttBrokers.length;
          setTimeout(() => this.connectCloudMqttBridge(), 5000);
        }
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch (_) {}
      };

      if (this._mqttPingTimer) clearInterval(this._mqttPingTimer);
      this._mqttPingTimer = setInterval(() => {
        if (this.mqttWs && this.mqttWs.readyState === WebSocket.OPEN && this.mqttConnected) {
          this.mqttWs.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
        }
      }, 25000);
    } catch (_) {}
  }

  publishCloudPacket(obj) {
    if (this.simulatedOffline || !this.mqttWs || this.mqttWs.readyState !== WebSocket.OPEN || !this.mqttConnected) {
      return false;
    }
    try {
      const topicBytes = this._encodeMqttUTF8(this.getBusinessTopic());
      const msgBytes = new TextEncoder().encode(JSON.stringify(obj));
      const body = new Uint8Array(topicBytes.length + msgBytes.length);
      body.set(topicBytes, 0);
      body.set(msgBytes, topicBytes.length);
      this.mqttWs.send(this._buildMqttPacket(0x30, body));
      return true;
    } catch (_) {
      return false;
    }
  }

  publishCloudPresence() {
    this.publishCloudPacket({
      type: 'PRESENCE',
      from: this.db.deviceId,
      name: this.db.deviceName,
      platform: this.db.detectPlatform(),
      timestamp: this.db.nowJakartaISO()
    });
  }

  async handleCloudPacket(packet) {
    if (!packet || !packet.from || packet.from === this.db.deviceId) return;
    if (packet.to && packet.to !== '*' && packet.to !== this.db.deviceId) return;

    // Update cloud peer presence
    this.cloudPeers.set(packet.from, {
      device_id: packet.from,
      name: packet.name || packet.device_name || `Perangkat (${packet.from.slice(-4)})`,
      platform: packet.platform || 'Cloud P2P',
      last_seen: Date.now(),
      last_seen_iso: this.db.nowJakartaISO(),
      via: 'Cloud-P2P'
    });

    if (packet.type === 'PRESENCE') {
      // Also register/update in local devices table so it appears in Menu Perangkat
      const existingDev = this.db.getById('devices', packet.from);
      if (!existingDev) {
        await this.db.upsert(
          'devices',
          {
            id: packet.from,
            name: packet.name || `Perangkat ${packet.from}`,
            platform: packet.platform || 'Browser PWA',
            business_id: this.db.getSettings().business_id || 'BIZ-POSTIKA-01',
            status: 'online',
            authorized: true,
            last_sync: this.db.nowJakartaISO(),
            created_at: this.db.nowJakartaISO()
          },
          false
        );
      }
      // Initiate WebRTC across networks if deterministic leader
      if (this.db.deviceId > packet.from) {
        const existingPeer = this.peers.get(packet.from);
        if (!existingPeer || !existingPeer.pc || existingPeer.pc.connectionState === 'failed' || existingPeer.pc.connectionState === 'closed') {
          await this.initiateWebRTCPeer(packet.from, { device_id: packet.from, name: packet.name });
        }
      }
      this.emitStatus();
      return;
    }

    if (packet.type === 'SIGNAL' && packet.signalType) {
      await this.handleSignalingMessage({
        from: packet.from,
        to: packet.to,
        type: packet.signalType,
        data: packet.data
      });
      return;
    }

    if (packet.type === 'CLOUD_OP' && packet.op) {
      const applied = await this.db.applyOp(packet.op, false);
      if (applied) {
        this.recordLocalSyncLog(packet.from, 'Cloud-P2P-Lintas-Jaringan', 1, 0, `Operasi real-time lintas jaringan dari ${packet.device_name || packet.from}`);
      }
      return;
    }

    if (packet.type === 'CLOUD_SYNC_REQ') {
      const allOps = await this.db.getAllOpsSince(packet.since_hlc || '', 300);
      if (allOps.length > 0) {
        this.publishCloudPacket({
          type: 'CLOUD_SYNC_RES',
          from: this.db.deviceId,
          device_name: this.db.deviceName,
          to: packet.from,
          ops: allOps
        });
      }
      return;
    }

    if (packet.type === 'CLOUD_SYNC_RES' && Array.isArray(packet.ops)) {
      let applied = 0;
      for (const op of packet.ops) {
        if (await this.db.applyOp(op, false)) applied++;
      }
      if (applied > 0) {
        this.recordLocalSyncLog(packet.from, 'Cloud-P2P-Batch', applied, 0, `Sinkronisasi ${applied} data lintas jaringan dari ${packet.device_name || packet.from}`);
      }
    }
  }

  broadcastCartToCustomerDisplay(cartState) {
    if (this.bus) {
      this.bus.postMessage({
        type: 'CART_STATE',
        from: this.db.deviceId,
        cartState
      });
    }
    try {
      localStorage.setItem('postika_customer_display_cart', JSON.stringify(cartState));
    } catch (_) {}
  }

  async broadcastLocalOp(op) {
    // 1. Broadcast over local BroadcastChannel
    if (this.bus) {
      this.bus.postMessage({
        type: 'OP',
        from: this.db.deviceId,
        op
      });
    }

    if (this.simulatedOffline || !navigator.onLine) {
      this.emitStatus();
      return;
    }

    // 2. Send directly over open WebRTC DataChannels to all connected peers
    let sentOverWebRTC = 0;
    const msgStr = JSON.stringify({ type: 'P2P_OP', from: this.db.deviceId, op });
    for (const [, peerObj] of this.peers.entries()) {
      if (peerObj.dc && peerObj.dc.readyState === 'open') {
        try {
          peerObj.dc.send(msgStr);
          sentOverWebRTC++;
        } catch (_) {}
      }
    }

    // 3. Broadcast over Global Cloud P2P Bridge (for devices on different Wi-Fi / 4G / 5G)
    this.publishCloudPacket({
      type: 'CLOUD_OP',
      from: this.db.deviceId,
      device_name: this.db.deviceName,
      op
    });

    // 4. Also trigger Relay/Server sync so SQLite & any NAT-restricted peers receive it
    this.syncNow(sentOverWebRTC > 0 ? 'WebRTC+Relay' : 'Relay-Sync');
  }

  recordLocalSyncLog(peerOrMode, mode, received, sent, details) {
    const entry = {
      id: `slog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      device_id: this.db.deviceId,
      device_name: this.db.deviceName,
      mode,
      ops_received: received,
      ops_sent: sent,
      status: 'SUCCESS',
      details,
      timestamp: this.db.nowJakartaISO()
    };
    this.syncHistory.unshift(entry);
    if (this.syncHistory.length > 80) this.syncHistory.length = 80;
    localStorage.setItem('postika_sync_history', JSON.stringify(this.syncHistory));
    localStorage.setItem('postika_last_sync_time', entry.timestamp);
    this.emitStatus();
  }

  getIceServers() {
    const settings = this.db.getSettings();
    const custom = settings?.rtc_config?.iceServers || [];
    return [
      ...custom,
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
  }

  async pollSignalingAndPeers() {
    if (this.simulatedOffline) return;
    try {
      const base = this.getApiBase();
      const q = new URLSearchParams({
        device_id: this.db.deviceId,
        name: this.db.deviceName,
        platform: this.db.detectPlatform()
      });
      const res = await fetch(`${base}/api/rtc/poll?${q.toString()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;

      this.isOnline = true;
      this.activePeerList = (data.peers || []).filter((p) => p.device_id !== this.db.deviceId);

      // Process incoming signaling messages
      const messages = data.messages || [];
      for (const msg of messages) {
        await this.handleSignalingMessage(msg);
      }

      // Initiate WebRTC connection to deterministic peers (higher ID initiates to lower ID)
      for (const peerInfo of this.getMergedActivePeers()) {
        const pid = peerInfo.device_id;
        if (this.db.deviceId > pid) {
          const existing = this.peers.get(pid);
          if (!existing || !existing.pc || existing.pc.connectionState === 'failed' || existing.pc.connectionState === 'closed') {
            await this.initiateWebRTCPeer(pid, peerInfo);
          }
        }
      }

      this.emitStatus();
    } catch (_) {
      this.emitStatus();
    }
  }

  async sendSignal(targetId, type, payloadData) {
    if (this.simulatedOffline) return;
    // Send over Cloud P2P Bridge (works across different networks)
    this.publishCloudPacket({
      type: 'SIGNAL',
      from: this.db.deviceId,
      to: targetId,
      signalType: type,
      data: payloadData
    });
    // Also send over HTTP Signaling Server
    try {
      const base = this.getApiBase();
      await fetch(`${base}/api/rtc/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.db.deviceId,
          to: targetId,
          type,
          data: payloadData
        })
      });
    } catch (_) {}
  }

  async initiateWebRTCPeer(peerId, peerInfo = {}) {
    if (typeof RTCPeerConnection === 'undefined') return;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
      const dc = pc.createDataChannel('postika-oplog-channel', { ordered: true });
      const peerEntry = { info: peerInfo, pc, dc, status: 'connecting' };
      this.peers.set(peerId, peerEntry);

      this.setupDataChannel(peerId, dc);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.sendSignal(peerId, 'ice', ev.candidate);
        }
      };

      pc.onconnectionstatechange = () => {
        peerEntry.status = pc.connectionState;
        this.emitStatus();
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(peerId, 'offer', offer);
    } catch (e) {
      console.warn('WebRTC Offer Error:', e);
    }
  }

  async handleSignalingMessage(msg) {
    const fromId = msg.from;
    if (!fromId || fromId === this.db.deviceId) return;

    if (msg.type === 'p2p_ops' && Array.isArray(msg.data)) {
      let applied = 0;
      for (const op of msg.data) {
        if (await this.db.applyOp(op, false)) applied++;
      }
      if (applied > 0) {
        this.recordLocalSyncLog(fromId, 'Relay-Forwarded-P2P', applied, 0, `Sinkronisasi P2P via Relay dari ${fromId}`);
      }
      return;
    }

    if (typeof RTCPeerConnection === 'undefined') return;

    try {
      if (msg.type === 'offer') {
        const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
        const peerEntry = { info: { device_id: fromId }, pc, dc: null, status: 'connecting' };
        this.peers.set(fromId, peerEntry);

        pc.ondatachannel = (ev) => {
          peerEntry.dc = ev.channel;
          this.setupDataChannel(fromId, ev.channel);
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            this.sendSignal(fromId, 'ice', ev.candidate);
          }
        };

        pc.onconnectionstatechange = () => {
          peerEntry.status = pc.connectionState;
          this.emitStatus();
        };

        await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(fromId, 'answer', answer);
      } else if (msg.type === 'answer') {
        const peerEntry = this.peers.get(fromId);
        if (peerEntry && peerEntry.pc) {
          await peerEntry.pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        }
      } else if (msg.type === 'ice') {
        const peerEntry = this.peers.get(fromId);
        if (peerEntry && peerEntry.pc && msg.data) {
          await peerEntry.pc.addIceCandidate(new RTCIceCandidate(msg.data));
        }
      }
    } catch (e) {
      console.warn('WebRTC Signal Handling Error:', e);
    }
  }

  setupDataChannel(peerId, dc) {
    dc.onopen = async () => {
      const peerEntry = this.peers.get(peerId);
      if (peerEntry) peerEntry.status = 'open';
      this.emitStatus();
      const unsynced = await this.db.getUnsyncedOps(200);
      if (unsynced.length > 0) {
        dc.send(JSON.stringify({ type: 'P2P_BATCH', from: this.db.deviceId, ops: unsynced }));
      }
    };

    dc.onclose = () => {
      const peerEntry = this.peers.get(peerId);
      if (peerEntry) peerEntry.status = 'closed';
      this.emitStatus();
    };

    dc.onmessage = async (ev) => {
      try {
        const packet = JSON.parse(ev.data);
        if (packet.type === 'P2P_OP' && packet.op) {
          const applied = await this.db.applyOp(packet.op, false);
          if (applied) {
            this.recordLocalSyncLog(peerId, 'WebRTC-DataChannel', 1, 0, `Operasi real-time via WebRTC dari ${peerId}`);
          }
        } else if (packet.type === 'P2P_BATCH' && Array.isArray(packet.ops)) {
          let count = 0;
          for (const op of packet.ops) {
            if (await this.db.applyOp(op, false)) count++;
          }
          if (count > 0) {
            this.recordLocalSyncLog(peerId, 'WebRTC-Batch', count, 0, `Batch ${count} operasi via WebRTC dari ${peerId}`);
          }
        }
      } catch (e) {
        console.warn('DataChannel message parse error:', e);
      }
    };
  }

  async syncNow(triggerMode = 'Manual') {
    if (this.simulatedOffline || this.isSyncing) return { ok: false, offline: true };
    this.isSyncing = true;
    this.emitStatus();

    // Always request cloud peers on different networks to send any new ops
    if (this.mqttConnected) {
      this.publishCloudPacket({
        type: 'CLOUD_SYNC_REQ',
        from: this.db.deviceId,
        device_name: this.db.deviceName,
        since_hlc: this.lastServerSyncedHlc || ''
      });
    }

    try {
      const unsyncedOps = await this.db.getUnsyncedOps(500);
      // Also broadcast unsynced ops to cloud peers if any
      if (this.mqttConnected && unsyncedOps.length > 0) {
        this.publishCloudPacket({
          type: 'CLOUD_SYNC_RES',
          from: this.db.deviceId,
          device_name: this.db.deviceName,
          to: '*',
          ops: unsyncedOps.slice(0, 150)
        });
      }

      const base = this.getApiBase();
      const res = await fetch(`${base}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: this.db.deviceId,
          device_name: this.db.deviceName,
          platform: this.db.detectPlatform(),
          since_hlc: this.lastServerSyncedHlc,
          ops: unsyncedOps,
          mode: triggerMode,
          manual: triggerMode.startsWith('Manual')
        })
      });

      if (res.status === 403) {
        const errData = await res.json();
        this.isSyncing = false;
        this.emitStatus();
        if (errData.revoked && window.posApp) {
          window.posApp.handleDeviceRevoked(errData.error);
        }
        return { ok: false, revoked: true };
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (unsyncedOps.length > 0) {
        await this.db.markOpsSynced(unsyncedOps.map((o) => o.op_id));
      }

      let receivedApplied = 0;
      if (Array.isArray(data.ops)) {
        for (const op of data.ops) {
          if (await this.db.applyOp(op, false)) {
            receivedApplied++;
          }
        }
      }

      if (data.max_hlc && data.max_hlc > this.lastServerSyncedHlc) {
        this.lastServerSyncedHlc = data.max_hlc;
        localStorage.setItem('postika_server_hlc', this.lastServerSyncedHlc);
      }

      const nowStr = this.db.nowJakartaISO();
      localStorage.setItem('postika_last_sync_time', nowStr);

      if (unsyncedOps.length > 0 || receivedApplied > 0 || triggerMode.startsWith('Manual')) {
        this.recordLocalSyncLog(
          'Relay+SQLite',
          triggerMode,
          receivedApplied,
          unsyncedOps.length,
          `Terkirim ${unsyncedOps.length} op, diterima ${receivedApplied} op baru`
        );
      }

      this.isOnline = true;
      this.isSyncing = false;
      this.emitStatus();
      return { ok: true, sent: unsyncedOps.length, received: receivedApplied };
    } catch (err) {
      this.isSyncing = false;
      this.emitStatus();
      return { ok: this.mqttConnected, error: err.message, sent: 0, received: 0 };
    }
  }
}

window.POSTikaSyncEngine = POSTikaSyncEngine;
