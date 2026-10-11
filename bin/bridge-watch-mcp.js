#!/usr/bin/env node
'use strict';
/**
 * CLI entry: `npx bridge-watch-mcp` runs the stdio bridge.
 * `--tools` prints the live tool list (a quick way to check the server is up).
 */

const { start, ENDPOINT, VERSION } = require('../index.js');

const HELP = `bridge-watch-mcp ${VERSION}

Usage:
  npx bridge-watch-mcp              run the MCP stdio bridge (default)
  npx bridge-watch-mcp --tools      print the live tool list and exit
  npx bridge-watch-mcp --help       this text

Environment:
  BRIDGE_WATCH_URL          default https://agentsapi.top/mcp
  BRIDGE_WATCH_BEARER       wallet address that already paid (Bearer credential)
  BRIDGE_WATCH_PAYMENT      raw x402 payment-signature header
  BRIDGE_WATCH_TIMEOUT_MS   per-request timeout (default 60000)

MCP client config (Claude Desktop / Cursor / Windsurf ...):
  { "mcpServers": { "bridge-watch": { "command": "npx", "args": ["-y", "bridge-watch-mcp"] } } }

Free tier: 3 anonymous tool calls per IP per day. No arguments needed:
  tools/call {"name":"get_label","arguments":{}}
Paid: send USDC to 0x381cdbb664608bf7b1dd4f9403a572c1c57332c2 on Base,
then set BRIDGE_WATCH_BEARER=<that address> (100 credits per 1 USDC).
`;

async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'bridge-watch-mcp/' + VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
  });
  const text = await res.text();
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}

async function listTools() {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-watch-mcp-cli', version: VERSION },
  });
  const res = await rpc('tools/list', {});
  const tools = (res.result && res.result.tools) || [];
  console.log(ENDPOINT + '  ->  ' + tools.length + ' tools');
  for (const t of tools) {
    const req = ((t.inputSchema && t.inputSchema.required) || []).join(',') || 'no required args';
    console.log('  - ' + t.name + '  [' + req + ']  ' + String(t.description || '').slice(0, 90));
  }
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (arg === '--version' || arg === '-v') {
    console.log(VERSION);
    return;
  }
  if (arg === '--tools') {
    try {
      await listTools();
    } catch (err) {
      console.error('failed to reach ' + ENDPOINT + ': ' + ((err && err.message) || err));
      process.exit(1);
    }
    return;
  }
  start();
})();
