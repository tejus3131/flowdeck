#!/usr/bin/env node
// flowdeck-mcp — the Flowdeck board CLI as an MCP stdio server.
//
// It is a thin, dependency-free translator: MCP JSON-RPC messages arrive on
// stdin (newline-delimited), each is forwarded to the Flowdeck MCP endpoint
// (streamable HTTP) with the personal access token, and each response is
// written back to stdout. Tool definitions live on the server; this CLI
// carries no logic of its own — the same PAT, the same operations, the same
// RLS as the web app.
//
// Configure any MCP client with the command:
//   { "mcpServers": { "flowdeck": {
//       "command": "npx",
//       "args": ["flowdeck-mcp"],
//       "env": {
//         "FLOWDECK_URL": "https://flowdeck.tejusgupta.dev/api/mcp",
//         "FLOWDECK_TOKEN": "fd_…your token from the Flowdeck profile page…"
//       } } } }
//
// Environment:
//   FLOWDECK_URL   the MCP endpoint (defaults to the hosted Flowdeck one)
//   FLOWDECK_TOKEN the personal access token (required)

import { createInterface } from 'node:readline';

const URL_DEFAULT = 'https://flowdeck.tejusgupta.dev/api/mcp';
const endpoint = process.env.FLOWDECK_URL || URL_DEFAULT;
const token = process.env.FLOWDECK_TOKEN || '';

if (!token) {
  process.stderr.write(
    'flowdeck-mcp: FLOWDECK_TOKEN is not set. Create a token on your Flowdeck profile page (API tokens) and pass it via the environment.\n',
  );
  process.exit(1);
}

/** Forward one JSON-RPC message; resolves to a reply object or null. */
async function forward(message) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(message),
    });
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32000, message: `Could not reach Flowdeck: ${String(error)}` },
    };
  }

  if (response.status === 202) return null; // notification accepted, no reply
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32000, message: `Unparsable response (${response.status}): ${text.slice(0, 200)}` },
    };
  }
}

let started = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let inFlight = 0;
let stdinClosed = false;

/** Exit only when the pipe is closed AND every forwarded call has settled. */
function maybeExit() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`flowdeck-mcp: ignoring non-JSON line: ${trimmed.slice(0, 80)}\n`);
    return;
  }
  inFlight++;
  void forward(message)
    .then((reply) => {
      if (message.method === 'initialize') {
        started = true;
        process.stderr.write(`flowdeck-mcp: connected to ${endpoint}\n`);
      }
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`flowdeck-mcp: ${String(error)}\n`);
    })
    .finally(() => {
      inFlight--;
      maybeExit();
    });
});

input.on('close', () => {
  process.stderr.write('flowdeck-mcp: stdin closed, exiting.\n');
  stdinClosed = true;
  maybeExit();
});

process.stderr.write(`flowdeck-mcp: ready (${endpoint}).\n`);
void started; // tracked purely for the friendly connect log
