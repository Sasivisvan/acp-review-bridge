// Minimal JSON-RPC 2.0 peer over newline-delimited JSON (the ACP stdio transport).
//
// - One JSON message per line, no embedded newlines.
// - Incoming requests are dispatched concurrently, so a long-running `session/prompt`
//   never blocks a `session/cancel` notification.
// - Outgoing requests (`fs/read_text_file`, `fs/write_text_file`, ...) return Promises.

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class Connection {
  /**
   * @param {import('node:stream').Readable} input
   * @param {import('node:stream').Writable} output
   * @param {{ log?: (...args: any[]) => void }} [opts]
   */
  constructor(input, output, { log = () => {} } = {}) {
    this.output = output;
    this.log = log;
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    let buffer = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.#handleLine(line);
      }
    });
    input.on('end', () => this.#close());
    input.on('error', () => this.#close());
    this.closedPromise = new Promise((resolve) => (this.onClosed = resolve));
  }

  /** Register a handler for an incoming request; its return value becomes the result. */
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  /** Register a handler for an incoming notification. */
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request to the peer and wait for its result. */
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method, params) {
    if (!this.closed) this.#send({ jsonrpc: '2.0', method, params });
  }

  #send(message) {
    // JSON.stringify never emits raw newlines, satisfying the one-message-per-line rule.
    this.output.write(JSON.stringify(message) + '\n');
  }

  #close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, method } of this.pending.values()) {
      reject(new Error(`connection closed while waiting for ${method}`));
    }
    this.pending.clear();
    this.onClosed();
  }

  #handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('ignoring unparseable message:', line.slice(0, 200));
      this.#send({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error' } });
      return;
    }

    // Response to one of our requests.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }

    if (typeof msg.method !== 'string') return;

    // Notification.
    if (msg.id === undefined || msg.id === null) {
      const handler = this.notificationHandlers.get(msg.method);
      if (!handler) return this.log('unhandled notification', msg.method);
      Promise.resolve()
        .then(() => handler(msg.params ?? {}))
        .catch((err) => this.log(`notification ${msg.method} failed:`, err));
      return;
    }

    // Request.
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      this.#send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params ?? {}))
      .then(
        (result) => this.#send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
        (err) => {
          if (!(err instanceof RpcError)) this.log(`request ${msg.method} failed:`, err);
          this.#send({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: err instanceof RpcError ? err.code : ErrorCodes.INTERNAL_ERROR,
              message: err?.message ?? String(err),
              ...(err?.data !== undefined ? { data: err.data } : {}),
            },
          });
        },
      );
  }
}
