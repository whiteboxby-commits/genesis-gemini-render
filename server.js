import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = createServer(app);

const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-live";
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || "*";

if (!GEMINI_API_KEY) {
  console.warn("[GENESIS] GEMINI_API_KEY is not set. The service will start, but Gemini sessions will fail.");
}

const ALLOWED_ORIGINS = ALLOWED_ORIGINS_RAW
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n\r\n"
  );
  socket.destroy();
}

app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "Genesis Extra — Gemini Live Proxy",
    ok: true,
    websocket: "/gemini",
    model: GEMINI_MODEL
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    geminiKeyConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
  });
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4 * 1024 * 1024,
  clientTracking: true
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname !== "/gemini") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin || "";
    if (!isOriginAllowed(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (!GEMINI_API_KEY) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      wss.emit("connection", clientSocket, request);
    });
  } catch (error) {
    console.error("[GENESIS] Upgrade error:", error);
    rejectUpgrade(socket, 400, "Bad Request");
  }
});

wss.on("connection", (client, request) => {
  const origin = request.headers.origin || "unknown";
  const clientIp =
    request.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    request.socket.remoteAddress ||
    "unknown";

  console.log(`[GENESIS] Client connected from ${clientIp}; origin=${origin}`);

  let upstream = null;
  let upstreamOpen = false;
  let closed = false;
  const pending = [];

  const geminiUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  function safeSendClient(payload) {
    if (closed) return;
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  function closeBoth(code = 1000, reason = "closed") {
    if (closed) return;
    closed = true;

    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try { upstream.close(code, reason); } catch {}
    } else if (upstream && upstream.readyState === WebSocket.CONNECTING) {
      try { upstream.terminate(); } catch {}
    }

    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      try { client.close(code, reason); } catch {}
    }
  }

  upstream = new WebSocket(geminiUrl, {
    handshakeTimeout: 15000,
    perMessageDeflate: false
  });

  upstream.on("open", () => {
    upstreamOpen = true;
    console.log("[GENESIS] Connected to Gemini Live.");

    const setup = {
      setup: {
        model: `models/${GEMINI_MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: process.env.GEMINI_VOICE || "Puck"
              }
            },
            languageCode: process.env.GEMINI_LANGUAGE || "ru-RU"
          }
        },
        inputAudioTranscription: {
          languageCodes: ["ru-RU"],
          mode: "SMART"
        },
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false
          }
        },
        systemInstruction: {
          parts: [{
            text:
              "Ты Genesis Extra — живой, дружелюбный и очень естественный голосовой AI-помощник. " +
              "Отвечай на русском языке, если пользователь не просит другой язык. " +
              "Говори коротко, естественно и по делу, без длинных формальных монологов. " +
              "Учитывай контекст всего текущего диалога. " +
              "Ты можешь помогать с электроникой, товарами, продажами, закупками, технологиями, " +
              "программированием, бизнесом, бытовыми и общими вопросами. " +
              "Не утверждай, что у тебя есть доступ к веб-поиску, генерации изображений, видео или внешним системам, " +
              "если конкретный инструмент не был реально подключён к этой сессии. " +
              "Если информации недостаточно, честно скажи об этом и предложи следующий шаг. " +
              "Главная задача — живой полезный разговор с человеком."
          }]
        }
      }
    };

    upstream.send(JSON.stringify(setup));

    while (pending.length && upstream.readyState === WebSocket.OPEN) {
      const msg = pending.shift();
      upstream.send(msg, { binary: false });
    }
  });

  upstream.on("message", (data, isBinary) => {
    if (closed) return;

    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    } catch (error) {
      console.error("[GENESIS] Failed to forward Gemini -> client:", error);
      closeBoth(1011, "proxy-forward-error");
    }
  });

  upstream.on("error", (error) => {
    console.error("[GENESIS] Gemini WebSocket error:", error.message);
    safeSendClient(JSON.stringify({
      genesisProxyError: true,
      message: "Ошибка подключения к Gemini Live."
    }));
  });

  upstream.on("close", (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString?.() || "";
    console.log(`[GENESIS] Gemini closed: ${code} ${reason}`);

    if (!closed && client.readyState === WebSocket.OPEN) {
      safeSendClient(JSON.stringify({
        genesisProxyClosed: true,
        code,
        reason
      }));

      try {
        client.close(1011, "gemini-closed");
      } catch {}
    }
  });

  client.on("message", (data, isBinary) => {
    if (closed) return;

    if (isBinary) {
      // We use JSON text frames from the Tilda client.
      safeSendClient(JSON.stringify({
        genesisProxyError: true,
        message: "Binary client frames are not supported by this proxy."
      }));
      return;
    }

    const message = data.toString();

    // The client must never send a "setup" message.
    // The proxy owns the setup so the API key and model configuration stay server-side.
    try {
      const parsed = JSON.parse(message);
      if (parsed?.setup) {
        safeSendClient(JSON.stringify({
          genesisProxyError: true,
          message: "Setup is managed by the Genesis proxy."
        }));
        return;
      }
    } catch {
      safeSendClient(JSON.stringify({
        genesisProxyError: true,
        message: "Некорректный JSON от клиента."
      }));
      return;
    }

    if (!upstreamOpen || !upstream || upstream.readyState !== WebSocket.OPEN) {
      if (pending.length < 100) {
        pending.push(message);
      }
      return;
    }

    try {
      upstream.send(message);
    } catch (error) {
      console.error("[GENESIS] Failed to forward client -> Gemini:", error);
      closeBoth(1011, "proxy-forward-error");
    }
  });

  client.on("close", (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString?.() || "";
    console.log(`[GENESIS] Client closed: ${code} ${reason}`);
    closeBoth(code || 1000, reason || "client-closed");
  });

  client.on("error", (error) => {
    console.error("[GENESIS] Client WebSocket error:", error.message);
    closeBoth(1011, "client-error");
  });

  // Render recommends ping/pong heartbeats for long-lived WebSocket connections.
  client.isAlive = true;
  client.on("pong", () => {
    client.isAlive = true;
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      try { client.terminate(); } catch {}
      return;
    }

    client.isAlive = false;
    try { client.ping(); } catch {}
  });
}, 30000);

function shutdown(signal) {
  console.log(`[GENESIS] ${signal}: shutting down...`);
  clearInterval(heartbeat);

  try { wss.close(); } catch {}
  try { server.close(); } catch {}

  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[GENESIS] Server listening on port ${PORT}`);
  console.log(`[GENESIS] Model: ${GEMINI_MODEL}`);
  console.log(`[GENESIS] Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
