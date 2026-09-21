/* Live co-editing rooms — a Durable Object that relays sealed CRDT updates.
 *
 * This is as blind as the share path. Clients exchange Yjs updates, each one
 * sealed with AES-GCM by src/modules/crypto.js under a key that lives in the
 * URL fragment. We append opaque frames to a log and fan them out in order;
 * merging happens in each browser, after decryption. A room never holds a
 * document, only a pile of bytes it cannot interpret.
 *
 * Why a Durable Object and not KV: this needs one authoritative, consistent
 * place per document to serialise appends and hold the open sockets. KV is
 * eventually consistent and has no sockets.
 */

const T = {
  UPDATE: 1, // both ways: one sealed CRDT update
  SNAPSHOT: 2, // client -> server: sealed full state, replaces the log
  SYNCED: 3, // server -> client: history replay finished
  PEERS: 4, // server -> client: how many sockets are open
  COMPACT: 5, // server -> client: log is long, please send a snapshot
};

const MAX_FRAME = 96 * 1024; // a DO storage value caps at 128 KB; leave headroom
const COMPACT_AT = 200; // updates before we ask someone to collapse the log
const IDLE_MS = 30 * 86400000; // rooms with no traffic for a month delete themselves

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Hibernation: the DO may be evicted between messages, so nothing lives in
    // `this`. getWebSockets() and storage survive; instance fields do not.
    this.ctx.acceptWebSocket(server);

    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    await this.replay(server);
    this.announce();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* Send everything we hold, oldest first, then mark the client caught up. */
  async replay(ws) {
    const log = await this.ctx.storage.list({ prefix: "u:" });
    for (const value of log.values()) ws.send(tag(T.UPDATE, value));
    ws.send(new Uint8Array([T.SYNCED]));
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw === "string") return; // protocol is binary only
    const buf = new Uint8Array(raw);
    if (buf.length < 2 || buf.length > MAX_FRAME) return;

    const type = buf[0];
    const body = buf.slice(1); // slice, not subarray — this gets stored

    if (type === T.SNAPSHOT) {
      // One client has merged the whole log and re-sealed it. Everyone already
      // has these edits, so this replaces the log rather than being broadcast.
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put("u:" + seq(0), body);
      await this.ctx.storage.put("seq", 1);
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return;
    }

    if (type !== T.UPDATE) return;

    const n = (await this.ctx.storage.get("seq")) || 0;
    await this.ctx.storage.put("u:" + seq(n), body);
    await this.ctx.storage.put("seq", n + 1);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);

    const frame = tag(T.UPDATE, body);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) trySend(peer, frame);
    }

    // Ask the sender to collapse the log once it gets long. Any client can do
    // it — they all hold the key and the merged state — but the one that just
    // wrote is certainly awake.
    if (n + 1 >= COMPACT_AT) trySend(ws, new Uint8Array([T.COMPACT]));
  }

  webSocketClose(ws) {
    this.announce(ws);
  }

  webSocketError(ws) {
    this.announce(ws);
  }

  /* Tell everyone how many are here. A count is not content — it leaks nothing
     the server doesn't already see by counting its own sockets.

     `leaving` is the socket whose close handler we're in: it is still listed by
     getWebSockets() at that point, so without excluding it the count would stay
     one too high until the next message. */
  announce(leaving) {
    const peers = this.ctx.getWebSockets().filter((ws) => ws !== leaving);
    const frame = new Uint8Array([T.PEERS, Math.min(255, peers.length)]);
    for (const ws of peers) trySend(ws, frame);
  }

  async alarm() {
    // Still busy? push the expiry out instead of deleting under live editors.
    if (this.ctx.getWebSockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}

const seq = (n) => String(n).padStart(12, "0");

function tag(type, body) {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = type;
  out.set(new Uint8Array(body), 1);
  return out;
}

function trySend(ws, frame) {
  try {
    ws.send(frame);
  } catch {
    /* a socket that died between getWebSockets() and here is not our problem */
  }
}
