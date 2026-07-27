const clients = new Set();

export function publishIntegrationEvent(type, payload = {}) {
  const event = {
    type,
    payload,
    created_at: new Date().toISOString()
  };
  const text = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(text);
    } catch {
      clients.delete(res);
    }
  }
  return event;
}

export function handleIntegrationEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`event: integration.connected\ndata: ${JSON.stringify({ ok: true, created_at: new Date().toISOString() })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}
