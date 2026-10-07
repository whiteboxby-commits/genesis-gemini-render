<script>
(function () {
  "use strict";

  /*
    ============================================================
    GENESIS EXTRA — TILDA CLIENT
    Browser -> Render WebSocket -> Gemini Live
    ============================================================

    IMPORTANT:
    1) There is NO Gemini API key in this file.
    2) Replace only PROXY_WS_URL with your Render URL.
  */

  const PROXY_WS_URL = "wss://YOUR-APP.onrender.com/gemini";

  // =========================
  // DOM
  // =========================
  const orbButton = document.getElementById("genesis-orb-button");
  const voiceStatus = document.getElementById("genesis-voice-status");
  const voiceStatusText = document.getElementById("genesis-voice-status-text");
  const connectionText = document.getElementById("genesis-connection-text");
  const connectionDot = document.querySelector(".genesis-connection-dot");

  const chatMessages = document.getElementById("genesis-chat-messages");
  const chatForm = document.getElementById("genesis-chat-form");
  const chatInput = document.getElementById("genesis-chat-input");
  const clearChatButton = document.getElementById("genesis-clear-chat");

  const sidebar = document.getElementById("genesis-sidebar");
  const sidebarOverlay = document.getElementById("genesis-sidebar-overlay");
  const menuToggle = document.getElementById("genesis-menu-toggle");
  const closeSidebar = document.getElementById("genesis-close-sidebar");
  const historyList = document.getElementById("genesis-history-list");

  const attachBtn = document.getElementById("genesis-attach-btn");
  const fileInput = document.getElementById("genesis-file-input");
  const chatMicBtn = document.getElementById("genesis-chat-mic-btn");

  // =========================
  // STATE
  // =========================
  let socket = null;
  let outputAudio = null;
  let microphoneAudio = null;
  let mediaStream = null;
  let source = null;
  let processor = null;
  let silentGain = null;

  let connected = false;
  let setupDone = false;
  let microphoneOn = false;
  let connectionPromise = null;
  let stopRequested = false;

  let nextAudioTime = 0;
  let inputText = "";
  let outputText = "";

  let liveUserBubble = null;
  let liveAiBubble = null;

  let chatMicRecognition = null;

  // =========================
  // STATUS
  // =========================
  function setStatus(text, dotClass) {
    voiceStatusText.textContent = text;
    connectionText.textContent = text;

    if (connectionDot) {
      connectionDot.className = "genesis-connection-dot";
      if (dotClass) connectionDot.classList.add(dotClass);
    }
  }

  function setActiveStatus(active) {
    voiceStatus.classList.toggle("is-active", Boolean(active));
  }

  // =========================
  // CHAT
  // =========================
  function createLiveMessageBubble(role) {
    const wrapper = document.createElement("div");
    const label = document.createElement("div");
    const bubble = document.createElement("div");

    wrapper.className =
      "genesis-message genesis-message-" + (role === "user" ? "user" : "ai");

    label.className = "genesis-message-label";
    bubble.className = "genesis-message-bubble";

    label.textContent = role === "user" ? "Вы" : "Genesis Extra";

    wrapper.appendChild(label);
    wrapper.appendChild(bubble);
    chatMessages.appendChild(wrapper);

    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
  }

  function addMessage(text, role) {
    if (!text) return;
    const bubble = createLiveMessageBubble(role);
    bubble.textContent = text;
  }

  function addToHistorySidebar(text) {
    if (!text) return;

    const placeholder = historyList.querySelector('div[style]');
    if (placeholder) historyList.innerHTML = "";

    const item = document.createElement("div");
    item.className = "genesis-history-item";
    item.textContent = text;

    item.addEventListener("click", function () {
      chatInput.value = text;
      toggleSidebar(false);
    });

    historyList.prepend(item);
  }

  // =========================
  // OUTPUT AUDIO
  // =========================
  function initOutputAudio() {
    if (!outputAudio) {
      outputAudio = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000
      });
    }

    if (outputAudio.state === "suspended") {
      return outputAudio.resume();
    }

    return Promise.resolve();
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Int16Array(bytes.buffer);
  }

  function stopQueuedAudio() {
    if (!outputAudio) return;

    nextAudioTime = outputAudio.currentTime;

    // Closing the context would also stop audio, but would require re-creating it.
    // Resetting the scheduling cursor is enough for normal barge-in.
  }

  async function playAudio(base64) {
    await initOutputAudio();

    if (!outputAudio) return;

    const pcm = base64ToInt16(base64);
    const samples = new Float32Array(pcm.length);

    for (let i = 0; i < pcm.length; i++) {
      samples[i] = pcm[i] / 32768;
    }

    const buffer = outputAudio.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);

    const node = outputAudio.createBufferSource();
    node.buffer = buffer;
    node.connect(outputAudio.destination);

    const now = outputAudio.currentTime;
    if (nextAudioTime < now) nextAudioTime = now;

    node.start(nextAudioTime);
    nextAudioTime += buffer.duration;

    orbButton.classList.add("is-speaking");
    orbButton.classList.remove("is-listening");
    setActiveStatus(true);

    node.onended = function () {
      if (!outputAudio) return;

      if (outputAudio.currentTime >= nextAudioTime - 0.05) {
        orbButton.classList.remove("is-speaking");

        if (microphoneOn) {
          orbButton.classList.add("is-listening");
          setActiveStatus(true);
        } else {
          setActiveStatus(false);
        }
      }
    };
  }

  // =========================
  // MIC
  // =========================
  function floatToPCM(data) {
    const pcm = new Int16Array(data.length);

    for (let i = 0; i < data.length; i++) {
      const value = Math.max(-1, Math.min(1, data[i]));
      pcm[i] = value < 0 ? value * 32768 : value * 32767;
    }

    return pcm;
  }

  function resample(data, sourceRate) {
    const targetRate = 16000;

    if (sourceRate === targetRate) return data;

    const ratio = sourceRate / targetRate;
    const length = Math.round(data.length / ratio);
    const result = new Float32Array(length);

    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(
        Math.floor((i + 1) * ratio),
        data.length
      );

      let sum = 0;
      let count = 0;

      for (let j = start; j < end; j++) {
        sum += data[j];
        count++;
      }

      result[i] = count ? sum / count : 0;
    }

    return result;
  }

  function pcmToBase64(pcm) {
    const bytes = new Uint8Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength
    );

    let binary = "";
    const chunk = 0x8000;

    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunk, bytes.length))
      );
    }

    return btoa(binary);
  }

  async function startMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("MIC_NOT_SUPPORTED");
    }

    stopRequested = false;

    await initOutputAudio();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    await connect();

    microphoneAudio = new (window.AudioContext || window.webkitAudioContext)();

    if (microphoneAudio.state === "suspended") {
      await microphoneAudio.resume();
    }

    source = microphoneAudio.createMediaStreamSource(mediaStream);

    // Smaller buffer => lower voice latency.
    processor = microphoneAudio.createScriptProcessor(2048, 1, 1);

    // Silent output keeps ScriptProcessor alive without playing the microphone.
    silentGain = microphoneAudio.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = function (event) {
      if (!microphoneOn) return;
      if (!socket || socket.readyState !== WebSocket.OPEN || !setupDone) return;

      const data = event.inputBuffer.getChannelData(0);
      const resampled = resample(data, microphoneAudio.sampleRate);
      const pcm = floatToPCM(resampled);
      const base64 = pcmToBase64(pcm);

      try {
        socket.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: base64,
              mimeType: "audio/pcm;rate=16000"
            }
          }
        }));
      } catch (error) {
        console.error("[GENESIS] MIC SEND ERROR", error);
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(microphoneAudio.destination);

    microphoneOn = true;

    orbButton.classList.remove("is-speaking");
    orbButton.classList.add("is-listening");
    setActiveStatus(true);
    setStatus("Слушаю...", "is-recording");
  }

  function stopMic() {
    microphoneOn = false;
    stopRequested = true;

    if (processor) {
      try { processor.disconnect(); } catch {}
      processor.onaudioprocess = null;
      processor = null;
    }

    if (silentGain) {
      try { silentGain.disconnect(); } catch {}
      silentGain = null;
    }

    if (source) {
      try { source.disconnect(); } catch {}
      source = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    if (microphoneAudio) {
      try { microphoneAudio.close(); } catch {}
      microphoneAudio = null;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({
          realtimeInput: { audioStreamEnd: true }
        }));
      } catch {}
    }

    orbButton.classList.remove("is-listening");

    if (!orbButton.classList.contains("is-speaking")) {
      setActiveStatus(false);
    }

    if (connected) {
      setStatus("Live-режим отключен");
    } else {
      setStatus("Нажмите на сферу");
    }
  }

  // =========================
  // PROXY WEBSOCKET
  // =========================
  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN && setupDone) {
      return Promise.resolve();
    }

    if (connectionPromise) {
      return connectionPromise;
    }

    connectionPromise = new Promise(function (resolve, reject) {
      setStatus("Подключение к Genesis...", "is-recording");

      try {
        socket = new WebSocket(PROXY_WS_URL);
      } catch (error) {
        connectionPromise = null;
        reject(error);
        return;
      }

      let settled = false;

      function resolveOnce() {
        if (settled) return;
        settled = true;
        connectionPromise = null;
        resolve();
      }

      function rejectOnce(error) {
        if (settled) return;
        settled = true;
        connectionPromise = null;
        reject(error);
      }

      socket.onopen = function () {
        console.log("[GENESIS] Connected to Render proxy.");
        // DO NOT SEND SETUP HERE.
        // Render owns the Gemini setup.
      };

      socket.onmessage = async function (event) {
        let data;

        try {
          if (event.data instanceof Blob) {
            data = JSON.parse(await event.data.text());
          } else {
            data = JSON.parse(event.data);
          }
        } catch (error) {
          console.error("[GENESIS] JSON parse error:", error);
          return;
        }

        // Proxy-level errors
        if (data.genesisProxyError) {
          console.error("[GENESIS] Proxy error:", data.message);
          setupDone = false;
          connected = false;
          setStatus(data.message || "Ошибка proxy", "is-error");
          rejectOnce(new Error(data.message || "PROXY_ERROR"));
          return;
        }

        if (data.genesisProxyClosed) {
          console.warn("[GENESIS] Gemini closed:", data.code, data.reason);
          setupDone = false;
          connected = false;
          setStatus("Gemini завершил сессию", "is-error");
          return;
        }

        // Setup completed by Gemini through Render.
        if (data.setupComplete !== undefined) {
          setupDone = true;
          connected = true;

          setStatus(
            microphoneOn ? "Слушаю..." : "Готов к диалогу"
          );

          resolveOnce();
          return;
        }

        const content = data.serverContent;
        if (!content) return;

        // Barge-in / interruption
        if (content.interrupted) {
          stopQueuedAudio();

          orbButton.classList.remove("is-speaking");

          if (microphoneOn) {
            orbButton.classList.add("is-listening");
            setActiveStatus(true);
            setStatus("Слушаю...", "is-recording");
          }
        }

        // User transcription
        if (content.inputTranscription?.text) {
          inputText += content.inputTranscription.text;

          if (!liveUserBubble) {
            liveUserBubble = createLiveMessageBubble("user");
          }

          liveUserBubble.textContent = inputText;
          chatMessages.scrollTop = chatMessages.scrollHeight;

          setStatus("Распознаю речь...", "is-recording");
        }

        // AI transcription
        if (content.outputTranscription?.text) {
          outputText += content.outputTranscription.text;

          if (!liveAiBubble) {
            liveAiBubble = createLiveMessageBubble("ai");
          }

          liveAiBubble.textContent = outputText;
          chatMessages.scrollTop = chatMessages.scrollHeight;

          setStatus("Genesis отвечает...", "is-recording");
        }

        // Native audio
        if (content.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              playAudio(part.inlineData.data).catch((error) => {
                console.error("[GENESIS] AUDIO PLAY ERROR:", error);
              });
            }
          }
        }

        // Turn complete
        if (content.turnComplete) {
          if (inputText) addToHistorySidebar(inputText);

          liveUserBubble = null;
          liveAiBubble = null;
          inputText = "";
          outputText = "";

          if (microphoneOn) {
            setStatus("Слушаю...", "is-recording");
          } else if (!orbButton.classList.contains("is-speaking")) {
            setStatus("Готов");
          }
        }
      };

      socket.onerror = function (error) {
        console.error("[GENESIS] WebSocket error:", error);

        setupDone = false;
        connected = false;

        if (!microphoneOn) {
          setStatus("Ошибка WebSocket", "is-error");
        }

        rejectOnce(new Error("WEBSOCKET_ERROR"));
      };

      socket.onclose = function (event) {
        console.warn(
          "[GENESIS] WebSocket closed:",
          event.code,
          event.reason
        );

        setupDone = false;
        connected = false;

        orbButton.classList.remove("is-listening", "is-speaking");
        setActiveStatus(false);

        if (!microphoneOn) {
          setStatus("Нажмите на сферу");
        }

        socket = null;
        rejectOnce(new Error("WEBSOCKET_CLOSED"));
      };
    });

    return connectionPromise;
  }

  // =========================
  // TEXT
  // =========================
  async function sendText() {
    const text = chatInput.value.trim();

    let fileAttachedText = "";

    if (attachBtn.classList.contains("has-file")) {
      const file = fileInput.files?.[0];

      // The current UI has not implemented a document upload service.
      // We explicitly tell the model that a file was selected instead of
      // pretending the file contents were uploaded.
      fileAttachedText = file
        ? `\n\nПользователь выбрал файл "${file.name}", но содержимое файла пока не передано в модель. Не притворяйся, что прочитал файл.`
        : "";

      attachBtn.classList.remove("has-file");
      fileInput.value = "";
    }

    if (!text && !fileAttachedText) return;

    try {
      await connect();
    } catch (error) {
      setStatus("Не удалось подключиться", "is-error");
      return;
    }

    const userText = text || "📎 Файл выбран";

    addMessage(userText, "user");
    addToHistorySidebar(text || userText);

    chatInput.value = "";
    setStatus("Genesis отвечает...");

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Соединение потеряно", "is-error");
      return;
    }

    socket.send(JSON.stringify({
      realtimeInput: {
        text: text + fileAttachedText
      }
    }));
  }

  // =========================
  // SIDEBAR
  // =========================
  function toggleSidebar(force) {
    const open =
      typeof force === "boolean"
        ? force
        : !sidebar.classList.contains("is-open");

    sidebar.classList.toggle("is-open", open);
    sidebarOverlay.classList.toggle("is-active", open);
  }

  // =========================
  // EVENTS
  // =========================
  orbButton.addEventListener("click", async function () {
    if (microphoneOn) {
      stopMic();
      return;
    }

    try {
      await startMic();
    } catch (error) {
      console.error("[GENESIS] MIC START ERROR:", error);

      stopMic();

      if (error?.name === "NotAllowedError") {
        setStatus(
          "Разрешите микрофон в браузере",
          "is-error"
        );
      } else if (error?.message === "MIC_NOT_SUPPORTED") {
        setStatus(
          "Браузер не поддерживает микрофон",
          "is-error"
        );
      } else {
        setStatus(
          "Ошибка запуска Live",
          "is-error"
        );
      }
    }
  });

  chatForm.addEventListener("submit", function (event) {
    event.preventDefault();
    sendText();
  });

  clearChatButton.addEventListener("click", function () {
    chatMessages.innerHTML = "";
    addMessage("История чата очищена.", "ai");

    liveUserBubble = null;
    liveAiBubble = null;
    inputText = "";
    outputText = "";
  });

  menuToggle.addEventListener("click", function () {
    toggleSidebar();
  });

  closeSidebar.addEventListener("click", function () {
    toggleSidebar(false);
  });

  sidebarOverlay.addEventListener("click", function () {
    toggleSidebar(false);
  });

  attachBtn.addEventListener("click", function () {
    fileInput.click();
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files?.[0]) {
      attachBtn.classList.add("has-file");
      attachBtn.title = fileInput.files[0].name;
    }
  });

  chatMicBtn.addEventListener("click", function () {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Браузер не поддерживает Web Speech API.");
      return;
    }

    if (!chatMicRecognition) {
      chatMicRecognition = new SpeechRecognition();

      chatMicRecognition.lang = "ru-RU";
      chatMicRecognition.interimResults = true;
      chatMicRecognition.continuous = false;

      chatMicRecognition.onstart = function () {
        chatMicBtn.classList.add("is-active");
      };

      chatMicRecognition.onresult = function (event) {
        let finalText = "";

        for (
          let i = event.resultIndex;
          i < event.results.length;
          i++
        ) {
          finalText += event.results[i][0].transcript;
        }

        if (finalText) {
          chatInput.value +=
            (chatInput.value ? " " : "") + finalText.trim();
        }
      };

      chatMicRecognition.onend = function () {
        chatMicBtn.classList.remove("is-active");
      };

      chatMicRecognition.onerror = function () {
        chatMicBtn.classList.remove("is-active");
      };
    }

    try {
      chatMicRecognition.start();
    } catch (error) {
      console.warn("[GENESIS] Recognition start:", error.message);
    }
  });

  // =========================
  // INITIAL
  // =========================
  setStatus("Готов");
})();
</script>
