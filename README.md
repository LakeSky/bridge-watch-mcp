# bridge-watch-mcp

Zero-dependency **MCP stdio bridge** for the [Bridge Watch](https://agentsapi.top) server:
104,209 on-chain address labels (Base / Ethereum), funding-cluster and CCTP tracing,
transaction explanation, plus 7 metered tools paid per call over [x402](https://www.x402.org) in USDC on Base.

Node >= 18. **No dependencies, no build step, ~10 KB.**

## Install / run

```bash
npx -y bridge-watch-mcp --tools        # print the live tool list (server reachability check)
npx -y bridge-watch-mcp                # run the stdio bridge (this is what MCP clients call)
```

MCP client config (Claude Desktop, Cursor, Windsurf, Cline, ...):

```json
{
  "mcpServers": {
    "bridge-watch": {
      "command": "npx",
      "args": ["-y", "bridge-watch-mcp"]
    }
  }
}
```

## Free tier

Every IP gets **3 free tool calls per day**, no key and no wallet required.
`get_label` accepts **no arguments** and returns a real demo result, so a fresh client
can see working data on the very first call:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_label","arguments":{}}}
```

## Paying

1. Send USDC (Base) to `0x381cdbb664608bf7b1dd4f9403a572c1c57332c2`.
2. Reuse that same address as the credential:

```bash
BRIDGE_WATCH_BEARER=0xYourPayerAddress npx -y bridge-watch-mcp
```

Live per-call prices are published by the server itself — ask the model to call
`list_paid_endpoints`, or read `https://agentsapi.top/.well-known/x402`. Prices are
never hardcoded in this package.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_WATCH_URL` | `https://agentsapi.top/mcp` | remote Streamable HTTP endpoint |
| `BRIDGE_WATCH_BEARER` | – | payer address (Bearer credential) |
| `BRIDGE_WATCH_PAYMENT` | – | raw `payment-signature` header (advanced x402 flows) |
| `BRIDGE_WATCH_TIMEOUT_MS` | `60000` | per-request timeout |

## How it works

Reads newline-delimited JSON-RPC on stdin, POSTs each message to the remote
Streamable HTTP endpoint, and writes back the (SSE-unwrapped) JSON-RPC responses.
Notifications (`202 Accepted`) produce no output. Nothing is logged, nothing is
persisted, and the process exits as soon as stdin closes and every in-flight
request is answered.

## Remote-first alternative

You do not need this package if your client speaks HTTP: point it at
`https://agentsapi.top/mcp` directly.

## License

MIT


---

## 0.1.2 (R218, 2026-10-13)

- Fixed LSP `Content-Length` framing on stdin: the previous newline-splitting parser
  glued a payload to the next frame header, which made the bridge forward invalid
  JSON (server answered HTTP 400 / JSON-RPC -32700) or silently drop messages.
- Anonymous free tier is now **1 call per tool per IP per day** across all 7 tools.
