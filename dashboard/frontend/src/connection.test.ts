import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./connection";
import { Store } from "./store";

class FakeSocket {
  static live: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  binaryType = "blob";

  constructor(
    public url: string,
    public protocols: string[] = [],
  ) {
    FakeSocket.live.push(this);
  }

  close() {
    this.closed = true;
  }

  accept() {
    this.onopen?.();
  }

  deliver(topic: string, key: string, value: unknown) {
    this.onmessage?.({ data: JSON.stringify({ topic, key, value }) });
  }

  async deliverDeflated(topic: string, key: string, value: unknown) {
    const json = JSON.stringify({ topic, key, value });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate"));
    this.onmessage?.({ data: await new Response(stream).arrayBuffer() });
  }
}

const sockets = () => FakeSocket.live;
const latest = () => FakeSocket.live[FakeSocket.live.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.live = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "validator:10999" });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("deflated frames", () => {
  it("offers the subprotocol and asks for binary frames as buffers", () => {
    const store = new Store();
    connect(store);
    expect(latest().protocols).toEqual(["deflate"]);
    expect(latest().binaryType).toBe("arraybuffer");
  });

  it("inflates a deflated frame and keeps the frames behind it in order", async () => {
    // Inflating is asynchronous, so a text frame arriving behind a deflated one
    // must not overtake it: the last value sent has to be the last applied.
    vi.useRealTimers();
    const store = new Store();
    const applied: unknown[] = [];
    vi.spyOn(store, "apply").mockImplementation((envelope) => applied.push(envelope.value));
    connect(store);
    latest().accept();

    latest().deliver("summary", "root_slot", 1);
    await latest().deliverDeflated("summary", "root_slot", 2);
    latest().deliver("summary", "root_slot", 3);
    await latest().deliverDeflated("summary", "root_slot", 4);

    await vi.waitFor(() => expect(applied).toHaveLength(4));
    expect(applied).toEqual([1, 2, 3, 4]);
  });

  it("drops a binary frame it cannot inflate and goes on", async () => {
    vi.useRealTimers();
    const store = new Store();
    const applied: unknown[] = [];
    vi.spyOn(store, "apply").mockImplementation((envelope) => applied.push(envelope.value));
    connect(store);
    latest().accept();

    latest().onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    latest().deliver("summary", "root_slot", 9);

    await vi.waitFor(() => expect(applied).toEqual([9]));
  });
});

describe("the silence watchdog", () => {
  it("reconnects a socket that stops delivering without ever closing", () => {
    // A NAT table drops the flow and the socket stays OPEN with no event, so the page shows stale
    // values as current.
    const store = new Store();
    connect(store);
    latest().accept();
    expect(store.getConnection()).toBe("open");

    latest().deliver("summary", "server_time_nanos", 1);
    vi.advanceTimersByTime(6_000);
    expect(sockets()).toHaveLength(1);
    expect(store.getConnection()).toBe("open");

    // Just past the watchdog and before the first retry, which would otherwise hide this.
    vi.advanceTimersByTime(2_200);
    expect(store.getConnection()).toBe("closed");
    expect(sockets()[0].closed).toBe(true);
    expect(sockets()).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(sockets()).toHaveLength(2);
  });

  it("stays connected while anything at all keeps arriving", () => {
    const store = new Store();
    connect(store);
    latest().accept();

    for (let second = 0; second < 30; second += 1) {
      vi.advanceTimersByTime(1_000);
      latest().deliver("summary", "server_time_nanos", second);
    }

    expect(sockets()).toHaveLength(1);
    expect(store.getConnection()).toBe("open");
  });

  it("tolerates a stall shorter than the limit", () => {
    // A mobile handover pauses a connection for a few seconds without it being
    // dead. Reconnecting through those would pull the whole snapshot each time.
    const store = new Store();
    connect(store);
    latest().accept();

    vi.advanceTimersByTime(6_000);
    latest().deliver("summary", "server_time_nanos", 1);
    vi.advanceTimersByTime(6_000);
    latest().deliver("summary", "server_time_nanos", 2);

    expect(sockets()).toHaveLength(1);
    expect(store.getConnection()).toBe("open");
  });

  it("counts a frame it cannot parse as proof of life", () => {
    const store = new Store();
    connect(store);
    latest().accept();

    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(4_000);
      latest().onmessage?.({ data: "{ not json" });
    }

    expect(sockets()).toHaveLength(1);
    expect(store.getConnection()).toBe("open");
  });

  it("does not fire on a socket that has not opened yet", () => {
    const store = new Store();
    connect(store);
    vi.advanceTimersByTime(30_000);
    expect(sockets()).toHaveLength(1);
  });

  it("stops watching once the page is done with the connection", () => {
    // The teardown returned by connect must leave no timer running, or a test
    // suite and a closed tab both keep reopening sockets.
    const store = new Store();
    const stop = connect(store);
    latest().accept();
    stop();

    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  it("ignores a late event from a socket it already gave up on", () => {
    // An abandoned socket can still fire, and it must not tear down the
    // connection that replaced it.
    const store = new Store();
    connect(store);
    latest().accept();

    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(600);
    expect(sockets()).toHaveLength(2);
    const replacement = latest();
    replacement.accept();

    sockets()[0].onclose?.();
    expect(store.getConnection()).toBe("open");
    expect(latest()).toBe(replacement);
  });
});
