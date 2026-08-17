/**
 * Browser-side JSON-RPC client for the terrain sidecar (spec §16, §23).
 *
 * The UI holds no generation logic of its own. Terrain is produced by the
 * sidecar and streamed here as tiles, which keeps a single implementation of
 * the physics-bearing data (spec §33: "the Three.js application must not
 * silently change physics data") and lets the browser drive a generator that
 * reads DEMs it could never open itself.
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Protocol major version this client speaks.
 *
 * The protocol docs declare a mismatch a hard error; a client that merely
 * records the hello version and carries on would mis-drive terrain generation
 * with silently wrong message shapes. Major-version disagreement therefore
 * closes the connection.
 */
export const CLIENT_PROTOCOL_MAJOR = 2;

export interface ProgressEvent {
  jobId: string;
  stage: string;
  progress: number;
  detail?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  /** The sidecar's own structured error code, when present (spec §28). */
  get terrainCode(): string | undefined {
    const d = this.data as { code?: string } | undefined;
    return d?.code;
  }
}

export class SidecarClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;

  state: ConnectionState = 'disconnected';
  protocolVersion = '';
  generatorVersion = '';

  onStateChange: (state: ConnectionState, detail?: string) => void = () => {};
  onProgress: (event: ProgressEvent) => void = () => {};

  constructor(timeoutMs = 600_000) {
    this.timeoutMs = timeoutMs;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(url: string): Promise<void> {
    this.disconnect();
    this.setState('connecting');
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        this.setState('error', String(e));
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.socket = socket;

      socket.onopen = () => {
        this.setState('connected');
        resolve();
      };
      socket.onerror = () => {
        this.setState('error', `could not reach ${url}`);
        reject(new Error(`could not reach ${url}`));
      };
      socket.onclose = () => {
        this.failAllPending(new Error('sidecar connection closed'));
        if (this.state !== 'error') this.setState('disconnected');
      };
      socket.onmessage = (event) => this.handleMessage(String(event.data));
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.failAllPending(new Error('disconnected'));
    this.setState('disconnected');
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.onStateChange(state, detail);
  }

  private failAllPending(reason: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.event === 'terrain.hello') {
      this.protocolVersion = String(msg.protocolVersion ?? '');
      this.generatorVersion = String(msg.generatorVersion ?? '');
      const major = Number(this.protocolVersion.split('.')[0]);
      if (!Number.isFinite(major) || major !== CLIENT_PROTOCOL_MAJOR) {
        this.setState(
          'error',
          `protocol mismatch: sidecar speaks ${this.protocolVersion || '(unknown)'}, ` +
            `this client speaks ${CLIENT_PROTOCOL_MAJOR}.x`,
        );
        this.disconnect();
      }
      return;
    }
    if (msg.event === 'terrain.progress') {
      this.onProgress({
        jobId: String(msg.jobId ?? ''),
        stage: String(msg.stage ?? ''),
        progress: Number(msg.progress ?? 0),
        detail: msg.detail === undefined ? undefined : String(msg.detail),
      });
      return;
    }

    const id = msg.id as number | undefined;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (msg.error) {
      const err = msg.error as { code: number; message: string; data?: unknown };
      pending.reject(new RpcError(err.code, err.message, err.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  /** Issue a request and await its response. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error('not connected to the sidecar'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
}

/** Decode a `terrain.getTile` payload into a Float32Array. */
export function decodeTile(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The payload is little-endian float32; DataView reads it portably.
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
