type DebateStatus = 'waiting' | 'matching' | 'in_progress' | 'voting' | 'finished' | 'cancelled';
type DebateSide = 'pro' | 'con' | null;

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

export class DebateRoom {
  private readonly state: DurableObjectState;
  private readonly env: DebateRoomEnv;
  private readonly sockets = new Map<WebSocket, ClientMeta>();
  private snapshot: RealtimeSnapshot | null = null;
  private readonly boot: Promise<void>;

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
    const persisted = await this.state.storage.get<RealtimeSnapshot>(STORAGE_KEY);
    this.snapshot = persisted ?? this.buildInitialSnapshot();
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

  private authorizeInternalRequest(request: Request): boolean {
    const configured = this.env.INTERNAL_SECRET;
    if (!configured) {
      return true;
    }

    const provided = request.headers.get('x-internal-secret');
    return provided === configured;
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return this.jsonResponse({ error: 'Expected websocket upgrade' }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const snapshot = this.ensureSnapshot();
    if (snapshot.debateId === 'unknown') {
      const fromQuery = url.searchParams.get('debateId');
      if (fromQuery) {
        snapshot.debateId = fromQuery;
      }
    }

    const meta: ClientMeta = {
      id: crypto.randomUUID(),
      userId: url.searchParams.get('userId'),
      role: url.searchParams.get('role'),
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };

    server.accept();
    this.sockets.set(server, meta);

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
    } catch {
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
    } catch {
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
    this.broadcast({ type: 'presence:update', viewers: this.sockets.size });
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(message);
      } catch {
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