#!/usr/bin/env node
'use strict';
/**
 * bridge-watch-mcp — zero-dependency MCP stdio bridge for the Bridge Watch server.
 *
 * Speaks JSON-RPC over stdio (what every MCP client uses) and forwards each
 * message to the remote Streamable HTTP endpoint https://agentsapi.top/mcp.
 * No SDK, no dependencies, no build step: Node >= 18 only (global fetch).
 *
 * R218 (2026-10-13) —— 分帧修复：
 *   旧实现把 stdin **按 \n 切行**再逐行 JSON.parse。而 MCP 客户端（Claude Desktop /
 *   Cursor / 官方 SDK）默认用 **LSP 分帧**：`Content-Length: N\r\n\r\n<payload>`，
 *   payload **不带结尾换行**。旧实现于是把一段 payload 和下一帧的
 *   `Content-Length:` 头粘成同一「行」，JSON.parse 失败 → 整条消息被丢弃
 *   （表现为「客户端卡住」），或把残缺片段转发出去 → 服务端回 HTTP 400
 *   （JSON-RPC -32700 Parse error）。
 *   一手证据：2026-10-13 外部 IP 8.209.211.131 用 UA `bridge-watch-mcp/0.1.0|0.1.1`
 *   对 /mcp 发 70 次 POST，**66 次 HTTP 400**；实测该栈只有「空 body / 非 JSON body」
 *   才会产生 400（initialize / tools/list / tools/call / 未实现方法 / 错误参数
 *   一律 200）。
 *   修法：先按 Content-Length 取字节数，再退化到换行的「裸 JSON」模式；
 *        空行与解析失败的片段一律跳过（写 stderr，绝不转发）。
 *
 * Env vars:
 *   BRIDGE_WATCH_URL         remote endpoint (default https://agentsapi.top/mcp)
 *   BRIDGE_WATCH_BEARER      wallet address that already paid (sent as Bearer)
 *   BRIDGE_WATCH_PAYMENT     raw x402 payment-signature header (advanced)
 *   BRIDGE_WATCH_TIMEOUT_MS  per-request timeout (default 60000)
 *   BRIDGE_WATCH_DEBUG       1 => print skipped fragments to stderr
 */

const pkg = require('./package.json');

const ENDPOINT = process.env.BRIDGE_WATCH_URL || 'https://agentsapi.top/mcp';
const BEARER = process.env.BRIDGE_WATCH_BEARER || '';
const PAYMENT = process.env.BRIDGE_WATCH_PAYMENT || '';
const TIMEOUT_MS = Number(process.env.BRIDGE_WATCH_TIMEOUT_MS || 60000);
const DEBUG = process.env.BRIDGE_WATCH_DEBUG === '1';
const VERSION = pkg.version;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function warn(msg) {
  if (DEBUG) process.stderr.write('[bridge-watch-mcp] ' + msg + '\n');
}

function isNotification(msg) {
  return msg && msg.id === undefined;
}

/** Turn an HTTP body into zero or more JSON-RPC messages and emit them. */
function emitBody(status, contentType, text, msg) {
  if (!text) return;
  if (contentType.includes('text/event-stream')) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      out(parsed);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (status === 402 && !isNotification(msg)) {
      out({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32003,
          message: 'Payment required: send USDC to 0x381cdbb664608bf7b1dd4f9403a572c1c57332c2 on Base, then reuse that address as Bearer. Details: https://agentsapi.top/.well-known/x402',
        },
      });
    }
    return;
  }
  if (Array.isArray(parsed)) parsed.forEach(out);
  else out(parsed);
}

let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

async function forward(msg) {
  pending += 1;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'bridge-watch-mcp/' + VERSION,
  };
  if (BEARER) headers.authorization = 'Bearer ' + BEARER;
  if (PAYMENT) headers['payment-signature'] = PAYMENT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 202/204 = notification accepted, nothing to emit.
    if (res.status === 202 || res.status === 204) return;
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    emitBody(res.status, contentType, text, msg);
  } catch (err) {
    clearTimeout(timer);
    if (!isNotification(msg)) {
      out({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32000,
          message: 'bridge-watch-mcp transport error: ' + ((err && err.message) || String(err)),
        },
      });
    }
  } finally {
    pending -= 1;
    maybeExit();
  }
}

/**
 * R218：把缓冲区切成完整的 JSON-RPC 消息。
 * 返回 { messages, rest } —— rest 是不完整的剩余字节，留给下一轮。
 */
function splitMessages(buf) {
  const messages = [];
  let rest = buf;

  for (;;) {
    if (rest.length === 0) break;

    // ── 形态 A：LSP 分帧 `Content-Length: N\r\n\r\n<payload>` ──────────────
    if (rest[0] === 0x43 /* 'C' */ || rest[0] === 0x63 /* 'c' */) {
      const hdrEnd = rest.indexOf('\r\n\r\n');
      if (hdrEnd === -1) break; // 头还没收全
      const headerText = rest.slice(0, hdrEnd).toString('utf8');
      const m = /content-length:\s*(\d+)/i.exec(headerText);
      const bodyStart = hdrEnd + 4;
      if (m) {
        const len = Number(m[1]);
        if (rest.length < bodyStart + len) break; // body 还没收全
        const payload = rest.slice(bodyStart, bodyStart + len);
        rest = rest.slice(bodyStart + len);
        pushParsed(messages, payload);
        continue;
      }
      rest = rest.slice(bodyStart);
      continue;
    }

    // ── 形态 B：裸 JSON，按换行切（旧行为，向后兼容） ──────────────────────
    const nl = rest.indexOf(0x0a);
    if (nl === -1) break;
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    pushParsed(messages, line);
  }

  return { messages, rest };
}

function pushParsed(messages, raw) {
  const trimmed = Buffer.from(raw).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return;                       // 空行：静默跳过
  if (trimmed.startsWith('Content-Length:')) return; // 已被形态 A 消费的兼容情况
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // R218：绝不把解析不了的片段转发出去 —— 那正是 HTTP 400 的来源。
    warn('skipped unparsable fragment: ' + JSON.stringify(trimmed.slice(0, 120)));
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    // 批处理数组按 JSON-RPC 规范是合法的，原样转发。
  }
  messages.push(msg);
}

function start() {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = splitMessages(buf);
    buf = rest;
    for (const msg of messages) forward(msg);
  });
  // Keep the process alive until every in-flight request has been answered:
  // piped (`printf ... | bridge-watch-mcp`) input closes stdin immediately.
  process.stdin.on('end', () => {
    // 收尾：缓冲区里若还有一整条没换行的裸 JSON，补发一次。
    const { messages, rest } = splitMessages(buf);
    buf = rest;
    for (const msg of messages) forward(msg);
    if (buf.length) {
      const { messages: tail } = splitMessages(Buffer.concat([buf, Buffer.from('\n')]));
      for (const msg of tail) forward(msg);
    }
    stdinClosed = true;
    maybeExit();
  });
}

module.exports = { start, forward, splitMessages, ENDPOINT, VERSION };

if (require.main === module) start();
