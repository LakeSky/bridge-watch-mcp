#!/usr/bin/env node
'use strict';
/**
 * bridge-watch-mcp — zero-dependency MCP stdio bridge for the Bridge Watch server.
 *
 * Speaks JSON-RPC over stdio (what every MCP client uses) and forwards each
 * message to the remote Streamable HTTP endpoint https://agentsapi.top/mcp.
 * No SDK, no dependencies, no build step: Node >= 18 only (global fetch).
 *
 * Env vars:
 *   BRIDGE_WATCH_URL         remote endpoint (default https://agentsapi.top/mcp)
 *   BRIDGE_WATCH_BEARER      wallet address that already paid (sent as Bearer)
 *   BRIDGE_WATCH_PAYMENT     raw x402 payment-signature header (advanced)
 *   BRIDGE_WATCH_TIMEOUT_MS  per-request timeout (default 60000)
 */

const pkg = require('./package.json');

const ENDPOINT = process.env.BRIDGE_WATCH_URL || 'https://agentsapi.top/mcp';
const BEARER = process.env.BRIDGE_WATCH_BEARER || '';
const PAYMENT = process.env.BRIDGE_WATCH_PAYMENT || '';
const TIMEOUT_MS = Number(process.env.BRIDGE_WATCH_TIMEOUT_MS || 60000);
const VERSION = pkg.version;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
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

function start() {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.slice(0, idx).toString('utf8');
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('Content-Length:')) continue; // tolerate framed input
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // not JSON: ignore, never crash the client
      }
      forward(msg);
    }
  });
  // Keep the process alive until every in-flight request has been answered:
  // piped (`printf ... | bridge-watch-mcp`) input closes stdin immediately.
  process.stdin.on('end', () => {
    stdinClosed = true;
    maybeExit();
  });
}

module.exports = { start, forward, ENDPOINT, VERSION };

if (require.main === module) start();
