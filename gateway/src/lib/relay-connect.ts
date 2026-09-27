// Bounded WebSocket upgrade to a Nostr relay.
//
// Every outbound relay socket in the gateway opens with
// `fetch(httpUrl, { headers: { Upgrade: "websocket" } })`. That fetch has no
// timeout of its own, so a relay that accepts the TCP/TLS connection but never
// answers the upgrade stalls the caller until something upstream gives up.
// nos.lol does exactly this intermittently: its nginx holds the upgrade for
// its 60 s proxy_read_timeout, then returns 502. Behind `Promise.all` in
// fanOut, one relay like that turned 1–2 s custodial publishes into 61–79 s
// ones (2026-09-27).
//
// connectRelaySocket bounds the upgrade: it aborts the fetch AND races it
// against a timer, so it returns within `timeoutMs` even if the runtime
// ignores the abort signal. A socket that upgrades after the deadline is
// closed rather than leaked.

export class RelayConnectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout connecting to relay after ${timeoutMs}ms`);
    this.name = "RelayConnectTimeoutError";
  }
}

// Resolves to the upgraded (not yet accepted) WebSocket, or null if the relay
// answered without upgrading. Rejects with RelayConnectTimeoutError when the
// upgrade does not complete within `timeoutMs`, or with the fetch error.
export async function connectRelaySocket(
  httpUrl: string,
  timeoutMs: number,
): Promise<WebSocket | null> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const upgrade = fetch(httpUrl, {
    headers: { Upgrade: "websocket" },
    signal: controller.signal,
  });

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RelayConnectTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  // If the upgrade lands after the deadline, close the socket instead of
  // leaving it open; if it rejects after the deadline (the abort), swallow it.
  upgrade.then(
    (response) => {
      if (!timedOut) return;
      const late = response.webSocket;
      if (!late) return;
      try {
        late.accept();
        late.close();
      } catch {
        // noop
      }
    },
    () => {},
  );

  try {
    const response = await Promise.race([upgrade, deadline]);
    return response.webSocket ?? null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
