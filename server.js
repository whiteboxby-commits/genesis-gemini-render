import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = createServer(app);

const PORT = Number(process.env.PORT || 10000);

// =====================================================
// НАСТРОЙКИ — API-КЛЮЧ ЗДЕСЬ НЕ ПРОПИСЫВАТЬ!
// Ключ берётся из Render → Environment Variables
// =====================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-live";

const GEMINI_VOICE =
  process.env.GEMINI_VOICE || "Puck";

// =====================================================
// ПРОВЕРКА
// =====================================================

if (!GEMINI_API_KEY) {
  console.error(
    "[GENESIS] ERROR: GEMINI_API_KEY is not configured"
  );
}

// =====================================================
// HTTP
// =====================================================

app.get("/", (req, res) => {
  res.json({
    service: "Genesis Extra — Gemini Live Proxy",
    ok: true,
    websocket: "/gemini",
    model: GEMINI_MODEL
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Genesis Extra",
    geminiKeyConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
  });
});

// =====================================================
// WEBSOCKET SERVER
// =====================================================

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4 * 1024 * 1024
});

// =====================================================
// UPGRADE
// =====================================================

server.on("upgrade", (request, socket, head) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  if (url.pathname !== "/gemini") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// =====================================================
// CLIENT → GEMINI
// =====================================================

wss.on("connection", (client) => {
  console.log("[GENESIS] Tilda client connected");

  if (!GEMINI_API_KEY) {
    client.send(
      JSON.stringify({
        genesisProxyError: true,
        message:
          "На Render не задан GEMINI_API_KEY"
      })
    );

    client.close();
    return;
  }

  let upstream = null;
  let setupComplete = false;
  let setupTimer = null;

  // ---------------------------------------------------
  // Безопасная отправка клиенту
  // ---------------------------------------------------

  function sendClient(data) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }

  // ---------------------------------------------------
  // Подключение к Gemini Live
  // ---------------------------------------------------

  const geminiUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  console.log("[GENESIS] Connecting to Gemini Live...");
  console.log("[GENESIS] Model:", GEMINI_MODEL);

  upstream = new WebSocket(geminiUrl, {
    handshakeTimeout: 15000,
    perMessageDeflate: false
  });

  // ---------------------------------------------------
  // GEMINI CONNECTED
  // ---------------------------------------------------

  upstream.on("open", () => {
    console.log(
      "[GENESIS] Connected to Gemini Live"
    );

    // =================================================
    // ВАЖНО:
    // Здесь специально оставлена МИНИМАЛЬНАЯ setup-конфигурация.
    // Не добавляем languageCodes / mode / languageCode /
    // realtimeInputConfig — они раньше могли ломать setup.
    // =================================================

    const setupMessage = {
      setup: {
        model: `models/${GEMINI_MODEL}`,

        generationConfig: {
          responseModalities: ["AUDIO"],

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: GEMINI_VOICE
              }
            }
          }
        },

        inputAudioTranscription: {},

        outputAudioTranscription: {},

        systemInstruction: {
          parts: [
            {
              text:
                "Ты Genesis Extra — живой голосовой AI-ассистент. " +
                "Общайся естественно, спокойно и доброжелательно. " +
                "Основной язык общения — русский. " +
                "Понимай речь пользователя и отвечай как живой человек. " +
                "Не повторяй без необходимости слова пользователя. " +
                "Отвечай кратко и по существу, когда вопрос простой."
            }
          ]
        }
      }
    };

    console.log(
      "[GENESIS] Sending Gemini setup..."
    );

    upstream.send(
      JSON.stringify(setupMessage)
    );

    // Если Gemini не ответил setupComplete
    // в течение 15 секунд — показываем ошибку.

    setupTimer = setTimeout(() => {
      if (!setupComplete) {
        console.error(
          "[GENESIS] ERROR: Gemini setup timeout"
        );

        sendClient(
          JSON.stringify({
            genesisProxyError: true,
            message:
              "Gemini Live не подтвердил setup за 15 секунд."
          })
        );
      }
    }, 15000);
  });

  // ---------------------------------------------------
  // GEMINI MESSAGE
  // ---------------------------------------------------

  upstream.on("message", (raw) => {
    const text = raw.toString();

    let message = null;

    try {
      message = JSON.parse(text);
    } catch (error) {
      console.error(
        "[GENESIS] Gemini sent invalid JSON"
      );

      return;
    }

    // =================================================
    // ОШИБКА GEMINI
    // =================================================

    if (message.error) {
      console.error(
        "[GENESIS] GEMINI ERROR:",
        JSON.stringify(message.error, null, 2)
      );

      sendClient(
        JSON.stringify({
          genesisProxyError: true,
          message:
            message.error.message ||
            "Gemini Live вернул ошибку",
          error: message.error
        })
      );

      return;
    }

    // =================================================
    // SETUP COMPLETE
    // =================================================

    if (message.setupComplete !== undefined) {
      setupComplete = true;

      if (setupTimer) {
        clearTimeout(setupTimer);
        setupTimer = null;
      }

      console.log(
        "[GENESIS] Gemini setup complete"
      );
    }

    // =================================================
    // ПЕРЕДАЁМ ВСЁ В TILDA
    // =================================================

    sendClient(text);
  });

  // ---------------------------------------------------
  // GEMINI ERROR
  // ---------------------------------------------------

  upstream.on("error", (error) => {
    console.error(
      "[GENESIS] Gemini WebSocket error:",
      error.message
    );

    sendClient(
      JSON.stringify({
        genesisProxyError: true,
        message:
          "Ошибка WebSocket Gemini: " +
          error.message
      })
    );
  });

  // ---------------------------------------------------
  // GEMINI CLOSE
  // ---------------------------------------------------

  upstream.on("close", (code, reason) => {
    const reasonText =
      reason?.toString() || "";

    console.log(
      "[GENESIS] Gemini connection closed:",
      code,
      reasonText
    );

    if (setupTimer) {
      clearTimeout(setupTimer);
      setupTimer = null;
    }

    if (
      client.readyState === WebSocket.OPEN
    ) {
      client.send(
        JSON.stringify({
          genesisProxyError: true,
          message:
            `Gemini connection closed: ${code}` +
            (reasonText
              ? ` — ${reasonText}`
              : "")
        })
      );

      client.close();
    }
  });

  // ===================================================
  // TILDA → GEMINI
  // ===================================================

  client.on("message", (raw) => {
    if (!upstream) {
      return;
    }

    if (
      upstream.readyState !== WebSocket.OPEN
    ) {
      console.log(
        "[GENESIS] Gemini is not ready yet"
      );

      return;
    }

    const text = raw.toString();

    try {
      JSON.parse(text);
    } catch (error) {
      console.error(
        "[GENESIS] Client sent invalid JSON"
      );

      return;
    }

    // Передаём аудио / текст / realtimeInput
    // напрямую в Gemini.

    upstream.send(text);
  });

  // ---------------------------------------------------
  // CLIENT CLOSE
  // ---------------------------------------------------

  client.on("close", () => {
    console.log(
      "[GENESIS] Tilda client disconnected"
    );

    if (setupTimer) {
      clearTimeout(setupTimer);
      setupTimer = null;
    }

    if (
      upstream &&
      upstream.readyState === WebSocket.OPEN
    ) {
      upstream.close();
    }
  });

  // ---------------------------------------------------
  // CLIENT ERROR
  // ---------------------------------------------------

  client.on("error", (error) => {
    console.error(
      "[GENESIS] Client WebSocket error:",
      error.message
    );
  });
});

// =====================================================
// HEARTBEAT
// =====================================================

setInterval(() => {
  wss.clients.forEach((client) => {
    if (
      client.readyState === WebSocket.OPEN
    ) {
      client.ping();
    }
  });
}, 30000);

// =====================================================
// START
// =====================================================

server.listen(PORT, () => {
  console.log(
    `[GENESIS] Server started on port ${PORT}`
  );

  console.log(
    `[GENESIS] Model: ${GEMINI_MODEL}`
  );

  console.log(
    `[GENESIS] API key configured: ${Boolean(
      GEMINI_API_KEY
    )}`
  );
});

// =====================================================
// SHUTDOWN
// =====================================================

function shutdown() {
  console.log(
    "[GENESIS] Shutting down..."
  );

  wss.clients.forEach((client) => {
    try {
      client.close();
    } catch {}
  });

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
