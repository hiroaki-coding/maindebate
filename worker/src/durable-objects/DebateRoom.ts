import type {
  DebateSide as SharedDebateSide,
  DebateStatus,
} from '../../../packages/shared/src/index';
import { reportWorkerError } from '../lib/monitoring';

type DebateSide = SharedDebateSide | null;
type RealtimeTicketRole = 'authenticated' | 'guest';

type RealtimeTicketPayload = {
  v: 1;
  jti: string;
  debateId: string;
  userId: string | null;
  role: RealtimeTicketRole;
  iat: number;
  exp: number;
};

type RealtimeSnapshot = {
  debateId: string;
  status: DebateStatus;
  currentTurn: DebateSide;
  turnNumber: number;
  updatedAt: string;
  version: number;
  viewers: number;
  lastEvent?: {
    type: string;
    at: string;
    source: string;
  };
};

type RealtimeEvent = {
  type: 'state:update' | 'timer:update' | 'message:new' | 'vote:update' | 'comment:new' | 'heartbeat';
  source?: string;
  payload?: Record<string, unknown>;
  status?: DebateStatus;
  currentTurn?: DebateSide;
  turnNumber?: number;
};

type ClientMeta = {
  id: string;
  userId: string | null;
  role: string | null;
  joinedAt: number;
  lastSeenAt: number;
};

type DebateRoomEnv = {
  INTERNAL_SECRET?: string;
};

const STORAGE_KEY = 'realtime:snapshot';
const USED_WS_TICKET_PREFIX = 'realtime:used-ticket:';
const MAX_IAT_FUTURE_SKEW_SEC = 30;
const MAX_TICKET_LIFETIME_SEC = 120;
const HEARTBEAT_INTERVAL_MS = 25_000;
const SOCKET_STALE_MS = 75_000;

export class DebateRoom {
  private readonly state: DurableObjectState;
  private readonly env: DebateRoomEnv;
  private readonly sockets = new Map<WebSocket, ClientMeta>();
  private snapshot: RealtimeSnapshot | null = null;
  private readonly boot: Promise<void>;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(state: DurableObjectState, env: DebateRoomEnv) {
    this.state = state;
    this.env = env;
    this.boot = this.initialize();
  }

  async fetch(request: Request): Promise<Response> {
    await this.boot;

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/connect') {
      return this.handleConnect(request, url);
    }

    if (path === '/snapshot' && request.method === 'GET') {
      const snapshot = this.ensureSnapshot();
      if (snapshot.debateId === 'unknown') {
        const fromQuery = url.searchParams.get('debateId');
        if (fromQuery) {
          snapshot.debateId = fromQuery;
        }
      }
      return this.jsonResponse(this.withViewerCount(snapshot));
    }

    if (path === '/events' && request.method === 'POST') {
      return this.handleInternalEvent(request);
    }

    if (path === '/reset' && request.method === 'POST') {
      if (!this.authorizeInternalRequest(request)) {
        return this.jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const next = this.buildInitialSnapshot(this.ensureSnapshot().debateId);
      this.snapshot = next;
      await this.persistSnapshot();
      this.broadcast({ type: 'snapshot:reset', snapshot: this.withViewerCount(next) });
      return this.jsonResponse({ ok: true, snapshot: this.withViewerCount(next) });
    }

    return this.jsonResponse({ error: 'Not found' }, 404);
  }

  private async initialize(): Promise<void> {
    // Fail fast so missing secret is visible during deployment, not at runtime.
    this.requireInternalSecret();
    const persisted = await this.state.storage.get<RealtimeSnapshot>(STORAGE_KEY);
    this.snapshot = persisted ?? this.buildInitialSnapshot();
  }

  private requireInternalSecret(): string {
    const secret = this.env.INTERNAL_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('DebateRoom requires INTERNAL_SECRET (min length: 32)');
    }
    return secret;
  }

  private ensureSnapshot(): RealtimeSnapshot {
    if (!this.snapshot) {
      this.snapshot = this.buildInitialSnapshot();
    }
    return this.snapshot;
  }

  private buildInitialSnapshot(debateId = 'unknown'): RealtimeSnapshot {
    return {
      debateId,
      status: 'waiting',
      currentTurn: null,
      turnNumber: 1,
      updatedAt: new Date().toISOString(),
      version: 1,
      viewers: 0,
    };
  }

  private withViewerCount(snapshot: RealtimeSnapshot): RealtimeSnapshot {
    return {
      ...snapshot,
      viewers: this.sockets.size,
    };
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    await this.state.storage.put(STORAGE_KEY, this.snapshot);
  }

  private base64UrlToBytes(input: string): Uint8Array {
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private async verifyRealtimeTicket(ticket: string): Promise<RealtimeTicketPayload | null> {
    const internalSecret = this.requireInternalSecret();

    const parts = ticket.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [payloadB64, signatureB64] = parts;
    let payload: RealtimeTicketPayload;
    let signature: Uint8Array;

    try {
      signature = this.base64UrlToBytes(signatureB64);
      const payloadJson = new TextDecoder().decode(this.base64UrlToBytes(payloadB64));
      payload = JSON.parse(payloadJson) as RealtimeTicketPayload;
    } catch (error) {
      reportWorkerError(error, {
        area: 'debate_room_do',
        action: 'decode_realtime_ticket',
      });
      return null;
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(internalSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(payloadB64)
    );
    if (!validSignature) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.v !== 1) return null;
    if (typeof payload.jti !== 'string' || payload.jti.length < 8) return null;
    if (typeof payload.debateId !== 'string' || payload.debateId.length === 0) return null;
    if (payload.userId !== null && (typeof payload.userId !== 'string' || payload.userId.length === 0)) return null;
    if (payload.role !== 'authenticated' && payload.role !== 'guest') return null;
    if (payload.role === 'authenticated' && payload.userId === null) return null;
    if (payload.role === 'guest' && payload.userId !== null) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.exp <= nowSec) return null;
    if (payload.iat > nowSec + MAX_IAT_FUTURE_SKEW_SEC) return null;
    if (payload.exp - payload.iat > MAX_TICKET_LIFETIME_SEC) return null;

    return payload;
  }

  private async consumeTicketOnce(jti: string, exp: number): Promise<boolean> {
    const key = `${USED_WS_TICKET_PREFIX}${jti}`;
    let accepted = false;

    await this.state.blockConcurrencyWhile(async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const usedUntil = await this.state.storage.get<number>(key);
      if (typeof usedUntil === 'number' && usedUntil > nowSec) {
        accepted = false;
        return;
      }

      await this.state.storage.put(key, exp);
      accepted = true;
    });

    if (Math.random() < 0.1) {
      const nowSec = Math.floor(Date.now() / 1000);
      const entries = await this.state.storage.list<number>({
        prefix: USED_WS_TICKET_PREFIX,
        limit: 128,
      });

      for (const [entryKey, usedUntil] of entries.entries()) {
        if (typeof usedUntil !== 'number' || usedUntil <= nowSec) {
          await this.state.storage.delete(entryKey);
        }
      }
    }

    return accepted;
  }

  private authorizeInternalRequest(request: Request): boolean {
    const configured = this.requireInternalSecret();

    const provided = request.headers.get('x-internal-secret');
    return provided === configured;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = globalThis.setInterval(() => {
      const now = Date.now();
      for (const [socket, meta] of this.sockets.entries()) {
        if (now - meta.lastSeenAt > SOCKET_STALE_MS) {
          try {
            socket.close(1001, 'Heartbeat timeout');
          } catch (error) {
            reportWorkerError(error, {
              area: 'debate_room_do',
              action: 'close_stale_socket',
              extras: { clientId: meta.id },
            });
          }
          this.removeSocket(socket);
          continue;
        }

        try {
          socket.send(JSON.stringify({ type: 'heartbeat', ts: now }));
        } catch (error) {
          reportWorkerError(error, {
            area: 'debate_room_do',
            action: 'send_heartbeat',
            extras: { clientId: meta.id },
          });
          this.removeSocket(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatIfIdle(): void {
    if (this.sockets.size > 0) return;
    if (!this.heartbeatTimer) return;
    globalThis.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return this.jsonResponse({ error: 'Expected websocket upgrade' }, 426);
    }

    this.requireInternalSecret();

    const debateIdFromQuery = url.searchParams.get('debateId');
    const rawTicket = url.searchParams.get('ticket') ?? '';
    if (!debateIdFromQuery || !rawTicket) {
      return this.jsonResponse({ error: 'Missing realtime auth ticket' }, 401);
    }

    const ticket = await this.verifyRealtimeTicket(rawTicket);
    if (!ticket || ticket.debateId !== debateIdFromQuery) {
      return this.jsonResponse({ error: 'Invalid realtime auth ticket' }, 401);
    }

    const consumeOk = await this.consumeTicketOnce(ticket.jti, ticket.exp);
    if (!consumeOk) {
      return this.jsonResponse({ error: 'Realtime auth ticket already used' }, 401);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const snapshot = this.ensureSnapshot();
    if (snapshot.debateId === 'unknown') {
      snapshot.debateId = ticket.debateId;
    } else if (snapshot.debateId !== ticket.debateId) {
      return this.jsonResponse({ error: 'Debate room mismatch' }, 403);
    }

    const meta: ClientMeta = {
      id: crypto.randomUUID(),
      userId: ticket.userId,
      role: ticket.role,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };

    server.accept();
    this.sockets.set(server, meta);
    this.startHeartbeat();

    server.addEventListener('message', (event) => {
      void this.handleClientMessage(server, event.data);
    });
    server.addEventListener('close', () => {
      this.removeSocket(server);
    });
    server.addEventListener('error', () => {
      this.removeSocket(server);
    });

    this.broadcast({
      type: 'presence:update',
      viewers: this.sockets.size,
    });

    server.send(
      JSON.stringify({
        type: 'snapshot:init',
        clientId: meta.id,
        snapshot: this.withViewerCount(this.ensureSnapshot()),
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleClientMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const meta = this.sockets.get(socket);
    if (!meta) return;

    meta.lastSeenAt = Date.now();

    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else {
      text = new TextDecoder().decode(raw);
    }

    if (text === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    let payload: { type?: string } | null = null;
    try {
      payload = JSON.parse(text) as { type?: string };
    } catch (error) {
      reportWorkerError(error, {
        area: 'debate_room_do',
        action: 'parse_client_message',
      });
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
      return;
    }

    if (!payload?.type) {
      socket.send(JSON.stringify({ type: 'error', message: 'Missing event type' }));
      return;
    }

    if (payload.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (payload.type === 'pong' || payload.type === 'heartbeat') {
      meta.lastSeenAt = Date.now();
      return;
    }

    if (payload.type === 'snapshot:get') {
      socket.send(
        JSON.stringify({
          type: 'snapshot:data',
          snapshot: this.withViewerCount(this.ensureSnapshot()),
        })
      );
      return;
    }

    socket.send(JSON.stringify({ type: 'ack', eventType: payload.type }));
  }

  private async handleInternalEvent(request: Request): Promise<Response> {
    if (!this.authorizeInternalRequest(request)) {
      return this.jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let event: RealtimeEvent;
    try {
      event = await request.json<RealtimeEvent>();
    } catch (error) {
      reportWorkerError(error, {
        area: 'debate_room_do',
        action: 'parse_internal_event',
      });
      return this.jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const snapshot = this.ensureSnapshot();
    const nowIso = new Date().toISOString();

    if (event.status) {
      snapshot.status = event.status;
    }
    if (event.currentTurn === 'pro' || event.currentTurn === 'con' || event.currentTurn === null) {
      snapshot.currentTurn = event.currentTurn;
    }
    if (typeof event.turnNumber === 'number' && Number.isFinite(event.turnNumber) && event.turnNumber > 0) {
      snapshot.turnNumber = Math.floor(event.turnNumber);
    }

    snapshot.version += 1;
    snapshot.updatedAt = nowIso;
    snapshot.lastEvent = {
      type: event.type,
      at: nowIso,
      source: event.source ?? 'worker',
    };

    await this.persistSnapshot();

    this.broadcast({
      type: 'event',
      event,
      snapshot: this.withViewerCount(snapshot),
    });

    return this.jsonResponse({ ok: true, snapshot: this.withViewerCount(snapshot) });
  }

  private removeSocket(socket: WebSocket): void {
    this.sockets.delete(socket);
    this.stopHeartbeatIfIdle();
    this.broadcast({ type: 'presence:update', viewers: this.sockets.size });
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(message);
      } catch (error) {
        reportWorkerError(error, {
          area: 'debate_room_do',
          action: 'broadcast',
        });
        this.removeSocket(socket);
      }
    }
  }

  private jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });
  }
}