import crypto from "node:crypto";

const clients = new Set();
const recentEvents = [];
const maxRecentEvents = 100;

function writeEvent(res, type, payload = {}) {
  const event = {
    eventId: payload.eventId || crypto.randomUUID(),
    type,
    ...payload,
    createdAt: payload.createdAt || new Date().toISOString()
  };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  return event;
}

export function publishOrderAlert(type, payload = {}) {
  const event = {
    eventId: payload.eventId || crypto.randomUUID(),
    type,
    ...payload,
    createdAt: payload.createdAt || new Date().toISOString()
  };
  recentEvents.push(event);
  while (recentEvents.length > maxRecentEvents) recentEvents.shift();

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

export function handleOrderAlertEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  writeEvent(res, "ORDER_ALERTS_CONNECTED", {
    recentEventIds: recentEvents.map((event) => event.eventId)
  });
  clients.add(res);
  req.on("close", () => clients.delete(res));
}
