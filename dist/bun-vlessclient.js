#!/usr/bin/env bun
// @bun

// bun-vlessclient.ts
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
// package.json
var version = "1.2.0";

// bun-vlessclient.ts
var configPath = "";
var args = process.argv.slice(2);
for (let i = 0;i < args.length; i++) {
  if ((args[i] === "-c" || args[i] === "--config") && i + 1 < args.length) {
    configPath = resolve(args[++i]);
  }
  if (args[i] === "--version" || args[i] === "-v") {
    console.log(`bun-vlessclient v${version}`);
    process.exit(0);
  }
  if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: bvc [-c <config-file>]");
    console.log("       bvc --version");
    console.log("       bvc --help");
    console.log("Config file format: JSON");
    process.exit(0);
  }
}
function loadConfig(path) {
  if (!path || !existsSync(path))
    return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`Failed to load config file "${path}": ${e.message}`);
    process.exit(1);
  }
}
var cfg = loadConfig(configPath);
function cfgStr(key, envKey, def) {
  const parts = key.split(".");
  let o = cfg;
  for (const p of parts)
    if (o)
      o = o[p];
  return o ?? process.env[envKey] ?? def;
}
function cfgNum(key, envKey, def) {
  const parts = key.split(".");
  let o = cfg;
  for (const p of parts)
    if (o)
      o = o[p];
  return o ?? parseInt(process.env[envKey] || "") ?? def;
}
function cfgBool(key, envKey, def) {
  const parts = key.split(".");
  let o = cfg;
  for (const p of parts)
    if (o)
      o = o[p];
  if (o !== undefined && o !== null)
    return o;
  const ev = process.env[envKey];
  if (ev !== undefined)
    return ev === "true";
  return def;
}
var LOG_LEVEL = cfgStr("log_level", "LOG_LEVEL", "debug");
var LOG_LEVEL_RANK = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};
var LOG_LEVELS_MAP = {
  debug: { color: "\x1B[36m", label: "[DEBUG]" },
  info: { color: "\x1B[32m", label: "[INFO] " },
  warn: { color: "\x1B[33m", label: "[WARN] " },
  error: { color: "\x1B[31m", label: "[ERROR]" }
};
var log = LOG_LEVEL === "none" ? function(_level, ..._args) {} : function(level, ...args2) {
  if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[LOG_LEVEL])
    return;
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  const { color, label } = LOG_LEVELS_MAP[level];
  console.log(`${color}[${time}] ${label}\x1B[0m`, ...args2);
};
var LOCAL_PORT = cfgNum("local_port", "LOCAL_PORT", 1080);
var WS_TIMEOUT = cfgNum("timeout", "TIMEOUT", 20000);
var OUTBOUND = {
  server: cfgStr("remote.host", "REMOTE_HOST", "example.com"),
  server_port: cfgNum("remote.port", "REMOTE_PORT", 443),
  uuid: cfgStr("remote.uuid", "UUID", "00000000-0000-4000-8000-000000000000"),
  packet_encoding: cfgStr("remote.packet_encoding", "PACKET_ENCODING", "xudp"),
  tls: {
    enabled: cfgBool("tls.enabled", "TLS", true),
    server_name: cfgStr("tls.server_name", "TLS_SERVER_NAME", "example.com"),
    insecure: cfgBool("tls.insecure", "TLS_INSECURE", false)
  },
  transport: {
    type: "ws",
    path: cfgStr("transport.path", "WS_PATH", "/your-websocket-path"),
    headers: {
      Host: cfgStr("transport.host", "WS_HOST", "example.com")
    }
  }
};
function concatUint8Arrays(a, b) {
  const res = new Uint8Array(a.length + b.length);
  res.set(a);
  res.set(b, a.length);
  return res;
}
function parseUUID(uuid) {
  const clean = uuid.replace(/-/g, "");
  const r = new Uint8Array(16);
  for (let i = 0;i < 16; i++) {
    r[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return r;
}
var UUID_BYTES = parseUUID(OUTBOUND.uuid);
function mapSocksATypeToVless(socksAType) {
  switch (socksAType) {
    case SOCKS_ATYPE_IPV4:
      return VLESS_ATYPE_IPV4;
    case SOCKS_ATYPE_DOMAIN:
      return VLESS_ATYPE_DOMAIN;
    case SOCKS_ATYPE_IPV6:
      return VLESS_ATYPE_IPV6;
    default:
      throw new Error(`Unsupported SOCKS address type for VLESS: ${socksAType}`);
  }
}
var SOCKS_VERSION = 5;
var SOCKS_AUTH_NONE = 0;
var SOCKS_CMD_CONNECT = 1;
var SOCKS_ATYPE_IPV4 = 1;
var SOCKS_ATYPE_DOMAIN = 3;
var SOCKS_ATYPE_IPV6 = 4;
var SOCKS4_VERSION = 4;
var SOCKS4_CMD_CONNECT = 1;
var SOCKS4_REPLY_GRANTED = 90;
var SOCKS4_REPLY_REJECTED = 91;
var VLESS_ATYPE_IPV4 = 1;
var VLESS_ATYPE_DOMAIN = 2;
var VLESS_ATYPE_IPV6 = 3;

class BunVLESSClient {
  start() {
    log("info", `Starting local SOCKS5 proxy on port ${LOCAL_PORT}`);
    log("info", `Outbound: ${OUTBOUND.server}:${OUTBOUND.server_port} (Native WebSocket)`);
    const socketHandlers = {
      async data(socket, data) {
        const session = socket.data;
        if (!session)
          return;
        try {
          if (session.state === "forwarding") {
            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
              const len = data.byteLength ?? data.length ?? 0;
              log("debug", `[DATA\u2192WS] forwarding ${len} bytes to ${session.destHost}:${session.destPort} (ws.readyState=${session.ws.readyState})`);
              session.ws.send(data);
              session.bytesSentToWs = (session.bytesSentToWs || 0) + len;
            } else {
              const len = data.byteLength ?? data.length ?? 0;
              log("debug", `[DATA\u2192WS] buffering ${len} bytes (ws state=${session.ws?.readyState ?? "none"})`);
              session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, data) : data;
            }
          } else if (session.state === "greeting") {
            await handleSocksGreeting(socket, data, session);
          } else if (session.state === "request") {
            if (session.socksType === "http") {
              await handleHttpProxyRequest(socket, data, session);
            } else {
              await handleSocksRequest(socket, data, session);
            }
          }
        } catch (err) {
          log("error", `Session error: ${err.message}`);
          socket.end();
        }
      },
      open(socket) {
        socket.data = {
          state: "greeting",
          socksType: "socks5",
          responseHeaderBytesSkipped: 0,
          firstRemotePayloadReceived: false,
          socksReplySent: false,
          bytesSentToWs: 0,
          bytesReceivedFromWs: 0
        };
      },
      close(socket) {
        const session = socket.data;
        if (session?.ws) {
          session.ws.close();
        }
      },
      error(socket, error) {
        log("error", `Socket error: ${error.message}`);
      }
    };
    let ipv4Ok = false;
    let ipv6Ok = false;
    try {
      Bun.listen({ hostname: "0.0.0.0", port: LOCAL_PORT, socket: socketHandlers });
      ipv4Ok = true;
      log("info", `Listening on IPv4 0.0.0.0:${LOCAL_PORT}`);
    } catch (e) {
      log("warn", `Cannot listen on IPv4: ${e.message}`);
    }
    try {
      Bun.listen({ hostname: "::", port: LOCAL_PORT, socket: socketHandlers });
      ipv6Ok = true;
      log("info", `Listening on IPv6 [::]:${LOCAL_PORT}`);
    } catch (e) {
      log("warn", `Cannot listen on IPv6: ${e.message}`);
    }
    if (!ipv4Ok && !ipv6Ok) {
      log("error", "Failed to listen on any address");
      process.exit(1);
    }
  }
}
async function handleSocksGreeting(socket, data, session) {
  const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;
  if (currentData.length < 2) {
    session.socksBuffer = currentData;
    return;
  }
  const version2 = currentData[0];
  if (version2 === SOCKS4_VERSION) {
    session.socksType = "socks4";
    session.socksBuffer = undefined;
    session.state = "request";
    await handleSocks4Request(socket, currentData, session);
    return;
  }
  if (version2 !== SOCKS_VERSION) {
    if (currentData.length < 12) {
      session.socksBuffer = currentData;
      return;
    }
    const prefix = new TextDecoder().decode(currentData.subarray(0, 12));
    if (/^(CONNECT|GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE) /.test(prefix)) {
      session.socksType = "http";
      session.socksBuffer = undefined;
      session.state = "request";
      await handleHttpProxyRequest(socket, currentData, session);
      return;
    }
    throw new Error(`Invalid SOCKS version: ${version2}`);
  }
  const numMethods = currentData[1];
  if (currentData.length < 2 + numMethods) {
    session.socksBuffer = currentData;
    return;
  }
  const remaining = currentData.subarray(2 + numMethods);
  socket.write(new Uint8Array([SOCKS_VERSION, SOCKS_AUTH_NONE]));
  session.socksBuffer = undefined;
  session.state = "request";
  if (remaining.length > 0) {
    await handleSocksRequest(socket, remaining, session);
  }
}
async function handleSocksRequest(socket, data, session) {
  const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;
  if (currentData.length < 4) {
    session.socksBuffer = currentData;
    return;
  }
  if (currentData[0] !== SOCKS_VERSION || currentData[1] !== SOCKS_CMD_CONNECT) {
    throw new Error("Unsupported SOCKS command or version");
  }
  let offset = 3;
  const atype = currentData[offset++];
  let host = "";
  let port = 0;
  if (atype === SOCKS_ATYPE_IPV4) {
    if (currentData.length < offset + 6) {
      session.socksBuffer = currentData;
      return;
    }
    host = currentData.subarray(offset, offset + 4).join(".");
    offset += 4;
  } else if (atype === SOCKS_ATYPE_DOMAIN) {
    if (currentData.length < offset + 1) {
      session.socksBuffer = currentData;
      return;
    }
    const len = currentData[offset++];
    if (currentData.length < offset + len + 2) {
      session.socksBuffer = currentData;
      return;
    }
    host = new TextDecoder().decode(currentData.subarray(offset, offset + len));
    offset += len;
  } else if (atype === SOCKS_ATYPE_IPV6) {
    if (currentData.length < offset + 18) {
      session.socksBuffer = currentData;
      return;
    }
    const parts = [];
    for (let i = 0;i < 16; i += 2) {
      parts.push((currentData[offset + i] << 8 | currentData[offset + i + 1]).toString(16));
    }
    host = parts.join(":");
    offset += 16;
  } else {
    throw new Error("Unsupported address type");
  }
  port = currentData[offset] << 8 | currentData[offset + 1];
  offset += 2;
  session.destHost = host;
  session.destPort = port;
  session.socksBuffer = undefined;
  session.socksRequestData = currentData.subarray(0, offset);
  session.socksRequestOffset = offset;
  const remaining = currentData.subarray(offset);
  if (remaining.length > 0) {
    session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, remaining) : remaining;
  }
  log("info", `SOCKS5 CONNECT: ${host}:${port}${remaining.length > 0 ? ` (+${remaining.length} bytes early data)` : ""}`);
  const vlessAType = mapSocksATypeToVless(atype);
  const addrPortBuf = currentData.subarray(3, offset);
  await establishVlessConnection(socket, session, host, port, vlessAType, addrPortBuf);
}
async function handleSocks4Request(socket, data, session) {
  const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;
  if (currentData.length < 8) {
    session.socksBuffer = currentData;
    return;
  }
  if (currentData[0] !== SOCKS4_VERSION) {
    throw new Error(`Invalid SOCKS4 version: ${currentData[0]}`);
  }
  if (currentData[1] !== SOCKS4_CMD_CONNECT) {
    throw new Error(`Unsupported SOCKS4 command: ${currentData[1]}`);
  }
  const port = currentData[2] << 8 | currentData[3];
  const ipBytes = currentData.subarray(4, 8);
  let userIdEnd = 8;
  while (userIdEnd < currentData.length && currentData[userIdEnd] !== 0)
    userIdEnd++;
  if (userIdEnd >= currentData.length) {
    session.socksBuffer = currentData;
    return;
  }
  let offset = userIdEnd + 1;
  let host;
  let atype;
  if (ipBytes[0] === 0 && ipBytes[1] === 0 && ipBytes[2] === 0 && ipBytes[3] !== 0) {
    if (offset >= currentData.length) {
      session.socksBuffer = currentData;
      return;
    }
    const domainEnd = currentData.indexOf(0, offset);
    if (domainEnd < 0) {
      session.socksBuffer = currentData;
      return;
    }
    host = new TextDecoder().decode(currentData.subarray(offset, domainEnd));
    offset = domainEnd + 1;
    atype = SOCKS_ATYPE_DOMAIN;
  } else {
    host = ipBytes.join(".");
    atype = SOCKS_ATYPE_IPV4;
  }
  session.destHost = host;
  session.destPort = port;
  session.socksBuffer = undefined;
  session.socksRequestData = currentData.subarray(0, 8);
  session.socksRequestOffset = 8;
  const remaining = currentData.subarray(offset);
  if (remaining.length > 0) {
    session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, remaining) : remaining;
  }
  log("info", `SOCKS4${atype === SOCKS_ATYPE_DOMAIN ? "a" : ""} CONNECT: ${host}:${port}${remaining.length > 0 ? ` (+${remaining.length} bytes early data)` : ""}`);
  let addrPortBuf;
  const vlessAType = atype === SOCKS_ATYPE_DOMAIN ? VLESS_ATYPE_DOMAIN : VLESS_ATYPE_IPV4;
  if (atype === SOCKS_ATYPE_DOMAIN) {
    const domainBytes = new TextEncoder().encode(host);
    addrPortBuf = new Uint8Array(1 + 1 + domainBytes.length + 2);
    addrPortBuf[0] = SOCKS_ATYPE_DOMAIN;
    addrPortBuf[1] = domainBytes.length;
    addrPortBuf.set(domainBytes, 2);
    addrPortBuf[2 + domainBytes.length] = port >> 8 & 255;
    addrPortBuf[2 + domainBytes.length + 1] = port & 255;
  } else {
    addrPortBuf = new Uint8Array(1 + 4 + 2);
    addrPortBuf[0] = SOCKS_ATYPE_IPV4;
    addrPortBuf.set(ipBytes, 1);
    addrPortBuf[5] = port >> 8 & 255;
    addrPortBuf[6] = port & 255;
  }
  await establishVlessConnection(socket, session, host, port, vlessAType, addrPortBuf);
}
async function handleHttpProxyRequest(socket, data, session) {
  const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;
  const headerText = new TextDecoder().decode(currentData);
  const headerEnd = headerText.indexOf(`\r
\r
`);
  if (headerEnd < 0) {
    session.socksBuffer = currentData;
    return;
  }
  const body = currentData.subarray(headerEnd + 4);
  const lines = headerText.split(`\r
`);
  const requestLine = lines[0];
  const parts = requestLine.split(" ");
  if (parts.length < 3) {
    socket.write(new TextEncoder().encode(`HTTP/1.1 400 Bad Request\r
\r
`));
    socket.end();
    return;
  }
  const method = parts[0];
  const uri = parts[1];
  const httpVersion = parts[2];
  session.httpMethod = method;
  log("debug", `[HTTP REQUEST] ${requestLine} (${lines.length - 1} headers, ${body.length} body bytes)`);
  if (method === "CONNECT") {
    const [host, portStr] = uri.split(":");
    const port = parseInt(portStr, 10);
    if (!host || isNaN(port)) {
      socket.write(new TextEncoder().encode(`HTTP/1.1 400 Bad Request\r
\r
`));
      socket.end();
      return;
    }
    log("info", `HTTP CONNECT: ${host}:${port}${body.length > 0 ? ` (+${body.length} bytes early data)` : ""}`);
    session.destHost = host;
    session.destPort = port;
    session.socksBuffer = undefined;
    if (body.length > 0) {
      log("debug", `[HTTP CONNECT] storing ${body.length} bytes early data`);
      session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, body) : body;
    }
    const hostBytes = new TextEncoder().encode(host);
    const addrPortBuf = new Uint8Array(1 + 1 + hostBytes.length + 2);
    addrPortBuf[0] = SOCKS_ATYPE_DOMAIN;
    addrPortBuf[1] = hostBytes.length;
    addrPortBuf.set(hostBytes, 2);
    addrPortBuf[2 + hostBytes.length] = port >> 8 & 255;
    addrPortBuf[2 + hostBytes.length + 1] = port & 255;
    await establishVlessConnection(socket, session, host, port, VLESS_ATYPE_DOMAIN, addrPortBuf);
  } else {
    const urlMatch = uri.match(/^https?:\/\/([^:\/]+)(?::(\d+))?(\/.*)?$/i);
    if (!urlMatch) {
      log("warn", `Invalid HTTP proxy URI: ${uri}`);
      socket.write(new TextEncoder().encode(`HTTP/1.1 400 Bad Request\r
\r
`));
      socket.end();
      return;
    }
    const host = urlMatch[1];
    const port = urlMatch[2] ? parseInt(urlMatch[2], 10) : uri.startsWith("https") ? 443 : 80;
    const path = urlMatch[3] || "/";
    const rewrittenFirstLine = `${method} ${path} ${httpVersion}`;
    const restOfHeader = headerText.substring(headerText.indexOf(`\r
`), headerEnd + 4);
    const rewrittenRequest = rewrittenFirstLine + restOfHeader;
    log("info", `HTTP ${method}: ${host}:${port}${path}`);
    log("debug", `[HTTP REWRITE]
${rewrittenRequest.trimEnd()}`);
    session.destHost = host;
    session.destPort = port;
    session.socksBuffer = undefined;
    const rewrittenData = new TextEncoder().encode(rewrittenRequest);
    const fullPendingData = body.length > 0 ? concatUint8Arrays(rewrittenData, body) : rewrittenData;
    session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, fullPendingData) : fullPendingData;
    const hostBytes = new TextEncoder().encode(host);
    const addrPortBuf = new Uint8Array(1 + 1 + hostBytes.length + 2);
    addrPortBuf[0] = SOCKS_ATYPE_DOMAIN;
    addrPortBuf[1] = hostBytes.length;
    addrPortBuf.set(hostBytes, 2);
    addrPortBuf[2 + hostBytes.length] = port >> 8 & 255;
    addrPortBuf[2 + hostBytes.length + 1] = port & 255;
    await establishVlessConnection(socket, session, host, port, VLESS_ATYPE_DOMAIN, addrPortBuf);
  }
}
async function establishVlessConnection(socket, session, host, port, vlessAType, addrPortBuf) {
  const protocol = OUTBOUND.tls?.enabled ? "wss" : "ws";
  const wsUrl = `${protocol}://${OUTBOUND.server}:${OUTBOUND.server_port}${OUTBOUND.transport?.path}`;
  try {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Host: OUTBOUND.transport?.headers?.Host || OUTBOUND.server,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...OUTBOUND.transport?.headers
      },
      tls: OUTBOUND.tls?.enabled ? {
        rejectUnauthorized: !OUTBOUND.tls?.insecure,
        serverName: OUTBOUND.tls?.server_name || OUTBOUND.server
      } : undefined
    });
    ws.binaryType = "arraybuffer";
    session.ws = ws;
    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        log("error", `WebSocket connection timeout for ${host}:${port}`);
        ws.close();
        sendSocksError(socket, session);
        socket.end();
      }
    }, WS_TIMEOUT);
    ws.onopen = () => {
      clearTimeout(timeout);
      const vlessHeader = createVlessHeader(port, vlessAType, addrPortBuf);
      const firstFramePayload = session.pendingData && session.pendingData.length > 0 ? concatUint8Arrays(vlessHeader, session.pendingData) : vlessHeader;
      ws.send(firstFramePayload);
      if (session.socksType === "http") {
        markHttpProxySuccess(socket, session);
      } else {
        markSocksSuccess(socket, session);
      }
      session.pendingData = undefined;
      session.state = "forwarding";
      log("info", `[CONNECTED] ${session.socksType.toUpperCase()} ${host}:${port}`);
    };
    ws.onmessage = async (event) => {
      const normalized = await normalizeWsMessageData(event.data);
      if (!normalized) {
        log("warn", `Unsupported WS message type for ${host}:${port}: ${typeof event.data}`);
        return;
      }
      session.firstRemotePayloadReceived = true;
      let payload = normalized;
      log("debug", `[WS\u2192DATA] received ${payload.length} bytes (headerSkipped=${session.responseHeaderBytesSkipped})`);
      if (session.responseHeaderBytesSkipped < 2) {
        const toSkip = 2 - session.responseHeaderBytesSkipped;
        if (payload.length <= toSkip) {
          log("debug", `[WS\u2192DATA] skipping ${payload.length} VLESS header bytes (${session.responseHeaderBytesSkipped}/${2})`);
          if (session.responseHeaderBytesSkipped === 0 && payload.length >= 1) {
            log("info", `VLESS response: 0x${payload[0].toString(16).padStart(2, "0")} ${payload.length >= 2 ? "0x" + payload[1].toString(16).padStart(2, "0") : "?"}`);
          }
          session.responseHeaderBytesSkipped += payload.length;
          return;
        } else {
          const skipped = toSkip;
          log("info", `VLESS response: 0x${payload[0].toString(16).padStart(2, "0")} 0x${payload[1].toString(16).padStart(2, "0")} (${payload.length - toSkip} bytes payload following)`);
          payload = payload.subarray(toSkip);
          session.responseHeaderBytesSkipped = 2;
          log("debug", `[WS\u2192DATA] skipped ${skipped} VLESS header bytes, ${payload.length} bytes payload remaining`);
        }
      }
      if (payload.length > 0) {
        let prefix = "";
        if (session.socksType === "http" && payload.length > 0) {
          const preview = new TextDecoder().decode(payload.subarray(0, Math.min(60, payload.length)));
          prefix = ` first="${preview.replace(/\r\n/g, "\\r\\n")}"`;
        }
        log("debug", `[WS\u2192SOCKET] writing ${payload.length} bytes${prefix} to local socket`);
        const written = socket.write(payload);
        session.bytesReceivedFromWs = (session.bytesReceivedFromWs || 0) + payload.length;
      }
    };
    ws.onclose = (event) => {
      const sent = session.bytesSentToWs ?? 0;
      const recv = session.bytesReceivedFromWs ?? 0;
      log(session.firstRemotePayloadReceived ? "debug" : "warn", `Remote WS closed for ${host}:${port} (code=${event.code}, clean=${event.wasClean}, reason=${event.reason || "none"}, firstPayload=${session.firstRemotePayloadReceived ? "yes" : "no"})` + ` traffic: \u2191${sent} \u2193${recv}`);
      socket.end();
    };
    ws.onerror = (e) => {
      log("error", `WS Error for ${host}:${port}:`, e.message || "Unknown error");
      if (!session.socksReplySent) {
        sendSocksError(socket, session);
      }
      socket.end();
    };
  } catch (err) {
    log("error", `WebSocket creation failed: ${err.message}`);
    sendSocksError(socket, session);
    socket.end();
  }
}
function sendSocksError(socket, session) {
  if (session.socksReplySent) {
    return;
  }
  if (session.socksType === "http") {
    socket.write(new TextEncoder().encode(`HTTP/1.1 502 Bad Gateway\r
\r
`));
    session.socksReplySent = true;
    return;
  }
  if (session.socksType === "socks4") {
    const reply = new Uint8Array(8);
    reply[0] = 0;
    reply[1] = SOCKS4_REPLY_REJECTED;
    if (session.destPort !== undefined) {
      reply[2] = session.destPort >> 8 & 255;
      reply[3] = session.destPort & 255;
    }
    socket.write(reply);
    session.socksReplySent = true;
    return;
  }
  if (session.socksRequestData && session.socksRequestOffset) {
    const reply = new Uint8Array(session.socksRequestOffset);
    reply.set(session.socksRequestData);
    reply[1] = 1;
    socket.write(reply);
    session.socksRequestData = undefined;
    session.socksReplySent = true;
  } else {
    socket.write(new Uint8Array([SOCKS_VERSION, 1, 0, SOCKS_ATYPE_IPV4, 0, 0, 0, 0, 0, 0]));
    session.socksReplySent = true;
  }
}
function markSocksSuccess(socket, session) {
  if (session.socksReplySent || !session.socksRequestData || !session.socksRequestOffset) {
    return;
  }
  if (session.socksType === "socks4") {
    const reply2 = new Uint8Array(8);
    reply2[0] = 0;
    reply2[1] = SOCKS4_REPLY_GRANTED;
    reply2[2] = session.socksRequestData[2];
    reply2[3] = session.socksRequestData[3];
    reply2[4] = session.socksRequestData[4];
    reply2[5] = session.socksRequestData[5];
    reply2[6] = session.socksRequestData[6];
    reply2[7] = session.socksRequestData[7];
    socket.write(reply2);
    session.socksRequestData = undefined;
    session.socksReplySent = true;
    return;
  }
  const reply = new Uint8Array(session.socksRequestOffset);
  reply.set(session.socksRequestData);
  reply[1] = 0;
  socket.write(reply);
  session.socksRequestData = undefined;
  session.socksReplySent = true;
}
function markHttpProxySuccess(socket, session) {
  if (session.socksReplySent)
    return;
  if (session.httpMethod === "CONNECT") {
    log("debug", `[HTTP 200] Connection Established for ${session.destHost}:${session.destPort}`);
    socket.write(new TextEncoder().encode(`HTTP/1.1 200 Connection Established\r
\r
`));
  } else {
    log("debug", `[HTTP NO-REPLY] ${session.httpMethod} ${session.destHost}:${session.destPort} \u2014 response will come from remote`);
  }
  session.socksReplySent = true;
}
async function normalizeWsMessageData(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof Buffer !== "undefined" && data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}
function createVlessHeader(port, vlessAType, addrPortBuf) {
  const header = new Uint8Array(1 + 16 + 1 + 1 + 2 + (addrPortBuf.length - 2));
  let offset = 0;
  header[offset++] = 0;
  header.set(UUID_BYTES, offset);
  offset += 16;
  header[offset++] = 0;
  header[offset++] = 1;
  header[offset++] = port >> 8 & 255;
  header[offset++] = port & 255;
  header[offset++] = vlessAType;
  header.set(addrPortBuf.subarray(1, addrPortBuf.length - 2), offset);
  return header;
}
new BunVLESSClient().start();
