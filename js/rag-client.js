/*
 * Blog RAG 搜索客户端 —— 原生 JavaScript，无框架依赖。
 *
 * 在右下角注入一个浮动的 AI 聊天按钮 + 面板。提交时，它优先使用
 * RAG SSE 端点以增量方式获取回答；当流式不可用时回退到传统 JSON
 * 端点；当后端无法访问时，最终会打开 Butterfly 的本地搜索。
 *
 * 2026-07-20 增强：
 * - 开场白（welcome）展示博主简介、博客内容说明、推荐问题、关于我链接
 * - sessionStorage 持久化对话，翻页不丢历史
 * - 分阶段 loading 提示（检索中 → 整理答案中）
 */
(function () {
  "use strict";

  // 按运行环境自动选择后端：
  // - 本地预览（localhost / 127.0.0.1）→ 连本机 uvicorn（默认 8000，端口冲突改这里）
  // - 生产环境 → 优先用 HTML 注入的 RAG_SEARCH_ENDPOINT，否则回退 Vercel
  var ENDPOINT;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    ENDPOINT = "http://localhost:8000/search";
  } else {
    ENDPOINT = window.RAG_SEARCH_ENDPOINT || "https://blog-rag-backend.vercel.app/search";
  }
  var STREAM_ENDPOINT = window.RAG_SEARCH_STREAM_ENDPOINT || ENDPOINT.replace(/\/search(?:\?.*)?$/, "/search/stream");
  var DEBOUNCE_MS = 800;
  var MIN_LEN = 2;
  var TIMEOUT_MS = 120000;  // 首次请求需要加载 reranker/BM25，给足 2 分钟
  var LOADING_STAGE_2_MS = 2000;
  var LONG_WAIT_NOTICE_MS = 35000; // 35s 后提示仍在等待，但不 abort
  var CACHE_TTL = 60000;
  var SESSION_KEY = "rag_session_v1";
  var ABOUT_URL = "https://zyydgrbk.top/about/";

  var cache = {};
  var activeController = null;
  var activeRequestId = 0;
  var sendTimer = null;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function fmtSnippet(text, n) {
    text = (text || "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n) + "…" : text;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function inlineMd(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderMarkdown(text) {
    if (!text) return "";
    // 防御性清理残留引用标记 [1][2][3]
    text = text.replace(/\[\d+\]/g, "");
    var lines = text.split("\n");
    var inList = false;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var li = line.match(/^[-*]\s+(.+)$/);
      if (li) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + inlineMd(escapeHtml(li[1])) + "</li>");
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        if (line.trim()) {
          out.push("<p>" + inlineMd(escapeHtml(line)) + "</p>");
        }
      }
    }
    if (inList) out.push("</ul>");
    return out.join("");
  }

  function renderMessage(role, html) {
    var wrap = el("div", "rag-msg " + role);
    wrap.innerHTML = html;
    return wrap;
  }

  function renderCitations(citations) {
    if (!citations || !citations.length) return "";
    var items = citations
      .map(function (c) {
        return (
          '<a class="rag-cite-link" href="' +
          escapeHtml(c.url) +
          '" target="_blank" rel="noopener">👉 ' +
          escapeHtml(c.title) +
          "</a>"
        );
      })
      .join("");
    return '<div class="rag-cites"><div class="rag-cites-head">📚 推荐阅读</div>' + items + "</div>";
  }

  function renderWelcome() {
    var wrap = el("div", "rag-welcome");
    wrap.innerHTML =
      '<div class="rag-welcome-badge">👋</div>' +
      '<div class="rag-welcome-title">你好，我是邹阳博客的 AI 助手</div>' +
      '<div class="rag-welcome-desc">我会基于博客里的文章回答你的问题。先简单介绍一下博主：</div>' +
      '<div class="rag-welcome-author">邹阳，延大数字媒体本科 + 西交软件工程硕士，有全栈与模型训练经历，' +
      '1 年前端开发（途虎养车）、1 年 gap，目前正转向 AI 产品经理。</div>' +
      '<div class="rag-welcome-topics"><strong>博客内容涵盖：</strong>前端开发（Vue / React / JS / DOM / BOM）、' +
      '后端与数据库（Node / Express）、AI 与 RAG（RAG / Prompt / Agent / 论文解读）、算法与数据结构、' +
      '工程与运维、健身训练、项目实战与随笔生活。</div>' +
      '<div class="rag-welcome-suggest">' +
      '<div class="rag-welcome-suggest-head">💡 你可以这样问我：</div>' +
      '<button class="rag-suggest" data-q="博主看过的 AI 论文有哪些？">博主看过的 AI 论文有哪些？</button>' +
      '<button class="rag-suggest" data-q="博客里有哪些 AI 与 RAG 相关文章？">博客里有哪些 AI 与 RAG 相关文章？</button>' +
      '<button class="rag-suggest" data-q="离职一年反思了什么？">离职一年反思了什么？</button>' +
      '<button class="rag-suggest" data-q="健身练背的动作有哪些？">健身练背的动作有哪些？</button>' +
      "</div>" +
      '<a class="rag-welcome-about" href="' + ABOUT_URL + '" target="_blank" rel="noopener">👉 关于我</a>';
    return wrap;
  }

  function scrollMessages(messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function responseHtml(data) {
    return (
      '<div class="rag-answer">' +
      renderMarkdown(data.answer || "") +
      "</div>" +
      renderCitations(data.citations)
    );
  }

  // ---- sessionStorage 持久化：翻页不丢对话 ----
  function saveSession(messagesEl) {
    try {
      var msgs = [];
      var nodes = messagesEl.querySelectorAll(".rag-msg");
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var role = n.classList.contains("user") ? "user" : "bot";
        msgs.push({ role: role, html: n.innerHTML });
      }
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ open: !panel.classList.contains("rag-hidden"), msgs: msgs })
      );
    } catch (e) { /* 忽略配额/隐私模式错误 */ }
  }

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function fetchJson(query, history, signal) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, top_k: 5, history: history }),
      signal: signal,
    }).then(function (res) {
      if (!res.ok) throw new Error("bad JSON status " + res.status);
      return res.json();
    });
  }

  function consumeSSE(response, onEvent) {
    if (!response.body || !response.body.getReader) {
      return Promise.reject(new Error("streaming response is unsupported"));
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";

    function parseEvent(block) {
      var event = "message";
      var data = "";
      block.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf("event:") === 0) event = line.slice(6).trim();
        if (line.indexOf("data:") === 0) data += line.slice(5).trim();
      });
      if (!data) return;
      try {
        onEvent(event, JSON.parse(data));
      } catch (err) {
        throw new Error("invalid SSE payload: " + err.message);
      }
    }

    function read() {
      return reader.read().then(function (result) {
        buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
        var boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          var block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
          parseEvent(block);
        }
        if (result.done) {
          if (buffer.trim()) parseEvent(buffer);
          return;
        }
        return read();
      });
    }

    return read();
  }

  function askAI(query, messagesEl, send) {
    var history = getUserHistory(messagesEl);
    var cacheKey = history.map(function (item) { return item.content; }).join("\n") + "\n" + query;
    if (cache[cacheKey] && Date.now() - cache[cacheKey].t < CACHE_TTL) {
      messagesEl.appendChild(renderMessage("bot", cache[cacheKey].html));
      scrollMessages(messagesEl);
      saveSession(messagesEl);
      return;
    }
    send.disabled = true;
    var botNode = renderMessage("bot", '<span class="rag-loading">正在检索博客资料…</span>');
    messagesEl.appendChild(botNode);
    scrollMessages(messagesEl);

    var requestId = ++activeRequestId;
    var controller = new AbortController();
    activeController = controller;
    var abortTimer = setTimeout(function () {
      controller.abort();
    }, TIMEOUT_MS);
    // 分阶段 loading
    var loadingSpan = botNode.querySelector(".rag-loading");
    var stageTimer = setTimeout(function () {
      if (loadingSpan && loadingSpan.parentNode) {
        loadingSpan.textContent = "正在整理答案…";
      }
    }, LOADING_STAGE_2_MS);
    var longWaitTimer = setTimeout(function () {
      if (loadingSpan && loadingSpan.parentNode) {
        loadingSpan.textContent = "后端仍在响应，首次加载模型较慢，请继续等待…";
      }
    }, LONG_WAIT_NOTICE_MS);
    var receivedToken = false;
    var done = false;
    var answerNode = null;
    var citationsNode = null;
    var answerRaw = ""; // 累积原始文本，done 后统一渲染 Markdown

    function setCitations(citations) {
      if (!citationsNode) {
        citationsNode = el("div", "rag-stream-citations");
        botNode.appendChild(citationsNode);
      }
      citationsNode.innerHTML = renderCitations(citations);
    }

    function startAnswer() {
      if (!answerNode) {
        botNode.innerHTML = "";
        answerNode = el("div", "rag-answer rag-streaming");
        botNode.appendChild(answerNode);
        if (citationsNode) botNode.appendChild(citationsNode);
      }
      return answerNode;
    }

    function renderLegacy(data) {
      var html = responseHtml(data);
      botNode.innerHTML = html;
      cache[cacheKey] = { html: html, t: Date.now() };
      scrollMessages(messagesEl);
    }

    function finishAnswer() {
      if (!answerNode) return;
      answerNode.classList.remove("rag-streaming");
      answerNode.innerHTML = renderMarkdown(answerRaw);
    }

    function fallbackToJson() {
      // stream 失败时，用新的 controller 重试 JSON 端点，避免复用已 abort 的 signal
      var fbController = new AbortController();
      var fbTimer = setTimeout(function () { fbController.abort(); }, 30000);
      return fetchJson(query, history, fbController.signal).then(function (data) {
        if (requestId !== activeRequestId) return;
        done = true;
        renderLegacy(data);
      }).finally(function () {
        clearTimeout(fbTimer);
      });
    }

    function showError(err) {
      var isAbort = err.name === "AbortError";
      botNode.innerHTML = '<div class="rag-error">' +
        (isAbort
          ? 'AI 助手响应较慢，已等待超时。可能后端首次加载模型尚未完成，请刷新后稍等 30~60 秒再试。'
          : 'AI 服务连接失败：' + escapeHtml(err.message) + '。请检查后端是否已启动。') +
        '</div>';
    }

    console.log("[RAG] streaming:", STREAM_ENDPOINT, "query:", query);
    fetch(STREAM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, top_k: 5, history: history }),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("bad stream status " + res.status);
        return consumeSSE(res, function (event, data) {
          if (requestId !== activeRequestId) return;
          if (event === "sources") {
            setCitations(data.citations || []);
          } else if (event === "token") {
            receivedToken = true;
            answerRaw += data.text || "";
            startAnswer().textContent = answerRaw;
          } else if (event === "error") {
            answerRaw = data.message || "回答生成失败，请稍后重试。";
            startAnswer().textContent = answerRaw;
          } else if (event === "done") {
            done = true;
            if (!receivedToken) answerRaw = data.answer || "";
            setCitations(data.citations || []);
            finishAnswer();
            var html = responseHtml(data);
            cache[cacheKey] = { html: html, t: Date.now() };
          }
          scrollMessages(messagesEl);
        });
      })
      .catch(function (err) {
        if (requestId !== activeRequestId) return;
        if (done || receivedToken) return;
        console.warn("[RAG] stream failed; trying JSON endpoint:", err.name, err.message);
        return fallbackToJson().catch(function (jsonErr) {
          console.error("[RAG] JSON fallback failed:", jsonErr.name, jsonErr.message);
          showError(jsonErr);
        });
      })
      .finally(function () {
        if (requestId !== activeRequestId) return;
        clearTimeout(abortTimer);
        clearTimeout(stageTimer);
        clearTimeout(longWaitTimer);
        activeController = null;
        send.disabled = false;
        scrollMessages(messagesEl);
        saveSession(messagesEl);
      });
  }

  function fallbackToLocalSearch(query, messagesEl) {
    messagesEl.appendChild(
      renderMessage(
        "bot",
        '<div class="rag-fallback">AI 搜索暂不可用，已为你打开站内搜索 ✅</div>'
      )
    );
    // Trigger Butterfly's local search modal (magnifier icon).
    var btn = document.querySelector(".search");
    if (btn && btn.click) btn.click();
  }

  var panel, messages, input, send; // 提升到闭包，供 saveSession 引用

  function getUserHistory(messagesEl) {
    var nodes = messagesEl.querySelectorAll(".rag-msg.user");
    var history = [];
    for (var i = Math.max(0, nodes.length - 3); i < nodes.length - 1; i++) {
      var content = (nodes[i].textContent || "").trim();
      if (content) history.push({ role: "user", content: content });
    }
    return history.slice(-2);
  }

  function buildUI() {
    if (document.getElementById("rag-fab")) return;

    var fab = el("button", "rag-fab", "💬");
    fab.id = "rag-fab";
    fab.setAttribute("aria-label", "AI 搜索");

    panel = el("div", "rag-panel rag-hidden");
    panel.id = "rag-panel";
    var header = el("div", "rag-head", "<span>AI 问答</span>");
    var actions = el("div", "rag-head-actions");
    var clear = el("button", "rag-clear", "清空");
    clear.type = "button";
    clear.setAttribute("aria-label", "清空对话");
    var close = el("button", "rag-close", "×");
    actions.appendChild(clear);
    actions.appendChild(close);
    header.appendChild(actions);
    messages = el("div", "rag-msgs");
    var inputRow = el("div", "rag-input-row");
    input = el("input", "rag-input");
    input.type = "text";
    input.placeholder = "问问博客里的任何事…";
    send = el("button", "rag-send", "发送");
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputRow);

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // 欢迎引导始终保留在对话顶部；会话中只保存实际问答消息。
    messages.appendChild(renderWelcome());
    var session = loadSession();
    if (session && session.msgs && session.msgs.length) {
      session.msgs.forEach(function (m) {
        messages.appendChild(renderMessage(m.role, m.html));
      });
      if (session.open) {
        panel.classList.remove("rag-hidden");
        input.focus();
      }
    }

    function toggle() {
      panel.classList.toggle("rag-hidden");
      var open = !panel.classList.contains("rag-hidden");
      if (open) input.focus();
      saveSession(messages);
    }
    fab.addEventListener("click", toggle);
    close.addEventListener("click", toggle);
    clear.addEventListener("click", function () {
      activeRequestId += 1;
      if (activeController) activeController.abort();
      activeController = null;
      cache = {};
      sessionStorage.removeItem(SESSION_KEY);
      messages.innerHTML = "";
      messages.appendChild(renderWelcome());
      input.value = "";
      send.disabled = false;
      scrollMessages(messages);
    });

    // 推荐问题点击即发送（事件委托，恢复后依然有效）
    messages.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".rag-suggest") : null;
      if (btn) {
        input.value = btn.getAttribute("data-q") || "";
        submit();
      }
    });

    function submit() {
      var q = input.value.trim();
      if (q.length < MIN_LEN || send.disabled) return;
      messages.appendChild(renderMessage("user", escapeHtml(q)));
      input.value = "";
      askAI(q, messages, send);
      messages.scrollTop = messages.scrollHeight;
    }

    send.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });
  }

  // 页面启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildUI);
  } else {
    buildUI();
  }
})();
