#!/usr/bin/env bun
/**
 * bunvlclient.ts - Bun-native VLESS client with local SOCKS5 proxy
 * Optimized with Bun's native WebSocket for maximum stability
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { version } from './package.json';

// Parse config file path BEFORE anything else
let configPath = '';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-c' || args[i] === '--config') && i + 1 < args.length) {
        configPath = resolve(args[++i]);
    }
    if (args[i] === '--version' || args[i] === '-v') {
        console.log(`bun-vlessclient v${version}`);
        process.exit(0);
    }
    if (args[i] === '--help' || args[i] === '-h') {
        console.log('Usage: bvc [-c <config-file>]');
        console.log('       bvc --version');
        console.log('       bvc --help');
        console.log('Config file format: JSON');
        process.exit(0);
    }
}

interface Config {
    log_level?: string;
    local_port?: number;
    remote?: {
        host?: string;
        port?: number;
        uuid?: string;
        packet_encoding?: string;
    };
    tls?: {
        enabled?: boolean;
        server_name?: string;
        insecure?: boolean;
    };
    timeout?: number;
    transport?: {
        type?: string;
        path?: string;
        host?: string;
    };
}

function loadConfig(path: string): Config | null {
    if (!path || !existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e: any) {
        console.error(`Failed to load config file "${path}": ${e.message}`);
        process.exit(1);
    }
}

const cfg = loadConfig(configPath);

// --- Config helpers: cfg > env > default ---
function cfgStr(key: string, envKey: string, def: string): string {
    const parts = key.split('.');
    let o: any = cfg;
    for (const p of parts) if (o) o = o[p];
    return o ?? process.env[envKey] ?? def;
}
function cfgNum(key: string, envKey: string, def: number): number {
    const parts = key.split('.');
    let o: any = cfg;
    for (const p of parts) if (o) o = o[p];
    return o ?? parseInt(process.env[envKey] || '') ?? def;
}
function cfgBool(key: string, envKey: string, def: boolean): boolean {
    const parts = key.split('.');
    let o: any = cfg;
    for (const p of parts) if (o) o = o[p];
    if (o !== undefined && o !== null) return o;
    const ev = process.env[envKey];
    if (ev !== undefined) return ev === 'true';
    return def;
}

// --- Logger ---
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
const LOG_LEVEL = cfgStr('log_level', 'LOG_LEVEL', 'debug') as LogLevel;
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
    none: 0, error: 1, warn: 2, info: 3, debug: 4,
};
const LOG_LEVELS_MAP: Record<string, { color: string; label: string }> = {
    debug: { color: '\x1b[36m', label: '[DEBUG]' },
    info: { color: '\x1b[32m', label: '[INFO] ' },
    warn: { color: '\x1b[33m', label: '[WARN] ' },
    error: { color: '\x1b[31m', label: '[ERROR]' },
};
const log = LOG_LEVEL === 'none'
    ? function (_level: string, ..._args: any[]) {}
    : function (level: 'debug' | 'info' | 'warn' | 'error', ...args: any[]) {
        if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[LOG_LEVEL]) return;
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        const { color, label } = LOG_LEVELS_MAP[level];
        console.log(`${color}[${time}] ${label}\x1b[0m`, ...args);
    };

// --- Configuration ---
interface VlessOutbound {
    server: string;
    server_port: number;
    uuid: string;
    packet_encoding?: string;
    tag?: string;
    tls?: {
        enabled: boolean;
        server_name?: string;
        insecure?: boolean;
        alpn?: string[];
        utls?: {
            enabled: boolean;
            fingerprint?: string;
        };
    };
    transport?: {
        type: string;
        path: string;
        headers?: Record<string, string>;
    };
}

const LOCAL_PORT = cfgNum('local_port', 'LOCAL_PORT', 1080);
const WS_TIMEOUT = cfgNum('timeout', 'TIMEOUT', 20000);

let OUTBOUND: VlessOutbound = {
    server: cfgStr('remote.host', 'REMOTE_HOST', 'example.com'),
    server_port: cfgNum('remote.port', 'REMOTE_PORT', 443),
    uuid: cfgStr('remote.uuid', 'UUID', '00000000-0000-4000-8000-000000000000'),
    packet_encoding: cfgStr('remote.packet_encoding', 'PACKET_ENCODING', 'xudp'),
    tls: {
        enabled: cfgBool('tls.enabled', 'TLS', true),
        server_name: cfgStr('tls.server_name', 'TLS_SERVER_NAME', 'example.com'),
        insecure: cfgBool('tls.insecure', 'TLS_INSECURE', false),
    },
    transport: {
        type: 'ws',
        path: cfgStr('transport.path', 'WS_PATH', '/your-websocket-path'),
        headers: {
            'Host': cfgStr('transport.host', 'WS_HOST', 'example.com'),
        },
    },
};

// --- Utils ---
function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
    const res = new Uint8Array(a.length + b.length);
    res.set(a);
    res.set(b, a.length);
    return res;
}

function parseUUID(uuid: string): Uint8Array {
    const clean = uuid.replace(/-/g, "");
    const r = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        r[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return r;
}

let UUID_BYTES = parseUUID(OUTBOUND.uuid);

function mapSocksATypeToVless(socksAType: number): number {
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

/**
 * SOCKS5 Protocol Constants
 */
const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYPE_IPV4 = 0x01;
const SOCKS_ATYPE_DOMAIN = 0x03;
const SOCKS_ATYPE_IPV6 = 0x04;

/**
 * SOCKS4 Protocol Constants
 */
const SOCKS4_VERSION = 0x04;
const SOCKS4_CMD_CONNECT = 0x01;
const SOCKS4_REPLY_GRANTED = 0x5A;
const SOCKS4_REPLY_REJECTED = 0x5B;
const SOCKS4_REPLY_BIND = 0x5C;
const SOCKS4_REPLY_IDENTD_FAIL = 0x5D;
const VLESS_ATYPE_IPV4 = 0x01;
const VLESS_ATYPE_DOMAIN = 0x02;
const VLESS_ATYPE_IPV6 = 0x03;

/**
 * Session Interface
 */
interface Session {
    state: 'greeting' | 'request' | 'forwarding';
    socksType: 'socks4' | 'socks5';
    ws?: WebSocket;
    destHost?: string;
    destPort?: number;
    responseHeaderBytesSkipped: number;
    socksBuffer?: Uint8Array;
    socksRequestData?: Uint8Array;
    socksRequestOffset?: number;
    pendingData?: Uint8Array;
    firstRemotePayloadReceived?: boolean;
    socksReplySent?: boolean;
}

/**
 * VLESS Client implementation
 */
class BunVLESSClient {
    start() {
        log('info', `Starting local SOCKS5 proxy on port ${LOCAL_PORT}`);
        log('info', `Outbound: ${OUTBOUND.server}:${OUTBOUND.server_port} (Native WebSocket)`);
        
        Bun.listen({
            hostname: "0.0.0.0",
            port: LOCAL_PORT,
            socket: {
                async data(socket, data) {
                    const session = socket.data as unknown as Session;
                    if (!session) return;

                    try {
                        if (session.state === 'forwarding') {
                            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                const len = data.byteLength ?? data.length ?? 0;
                                log('debug', `[DATA→WS] forwarding ${len} bytes to ${session.destHost}:${session.destPort} (ws.readyState=${session.ws.readyState})`);
                                session.ws.send(data);
                                session.bytesSentToWs = (session.bytesSentToWs || 0) + len;
                            } else {
                                // Buffer data if WS is not ready yet (Early Data)
                                const len = data.byteLength ?? data.length ?? 0;
                                log('debug', `[DATA→WS] buffering ${len} bytes (ws state=${session.ws?.readyState ?? 'none'})`);
                                session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, data) : data;
                            }
                        } else if (session.state === 'greeting') {
                            await handleSocksGreeting(socket, data, session);
                        } else if (session.state === 'request') {
                            await handleSocksRequest(socket, data, session);
                        }
                    } catch (err: any) {
                        log('error', `Session error: ${err.message}`);
                        socket.end();
                    }
                },
                open(socket) {
                    socket.data = { 
                        state: 'greeting',
                        socksType: 'socks5',
                        responseHeaderBytesSkipped: 0,
                        firstRemotePayloadReceived: false,
                        socksReplySent: false
                    };
                },
                close(socket) {
                    const session = socket.data as unknown as Session;
                    if (session?.ws) {
                        session.ws.close();
                    }
                },
                error(socket, error) {
                    log('error', `Socket error: ${error.message}`);
                }
            }
        });
    }
}

/**
 * Greeting Handler - detects SOCKS4 vs SOCKS5
 */
async function handleSocksGreeting(socket: any, data: Uint8Array, session: Session) {
    const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;
    
    if (currentData.length < 2) {
        session.socksBuffer = currentData;
        return;
    }

    const version = currentData[0];

    // SOCKS4: no greeting phase, parse directly as a request
    if (version === SOCKS4_VERSION) {
        session.socksType = 'socks4';
        session.socksBuffer = undefined;
        session.state = 'request';
        await handleSocks4Request(socket, currentData, session);
        return;
    }

    // SOCKS5 greeting
    if (version !== SOCKS_VERSION) {
        throw new Error(`Invalid SOCKS version: ${version}`);
    }

    const numMethods = currentData[1];
    if (currentData.length < 2 + numMethods) {
        session.socksBuffer = currentData;
        return;
    }

    const remaining = currentData.subarray(2 + numMethods);
    socket.write(new Uint8Array([SOCKS_VERSION, SOCKS_AUTH_NONE]));
    
    session.socksBuffer = undefined;
    session.state = 'request';

    if (remaining.length > 0) {
        await handleSocksRequest(socket, remaining, session);
    }
}

/**
 * SOCKS5 Request Handler
 */
async function handleSocksRequest(socket: any, data: Uint8Array, session: Session) {
    const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;

    if (currentData.length < 4) {
        session.socksBuffer = currentData;
        return;
    }

    if (currentData[0] !== SOCKS_VERSION || currentData[1] !== SOCKS_CMD_CONNECT) {
        throw new Error('Unsupported SOCKS command or version');
    }

    let offset = 3;
    const atype = currentData[offset++];
    let host = "";
    let port = 0;

    if (atype === SOCKS_ATYPE_IPV4) {
        if (currentData.length < offset + 6) { session.socksBuffer = currentData; return; }
        host = currentData.subarray(offset, offset + 4).join('.');
        offset += 4;
    } else if (atype === SOCKS_ATYPE_DOMAIN) {
        if (currentData.length < offset + 1) { session.socksBuffer = currentData; return; }
        const len = currentData[offset++];
        if (currentData.length < offset + len + 2) { session.socksBuffer = currentData; return; }
        host = new TextDecoder().decode(currentData.subarray(offset, offset + len));
        offset += len;
    } else if (atype === SOCKS_ATYPE_IPV6) {
        if (currentData.length < offset + 18) { session.socksBuffer = currentData; return; }
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(((currentData[offset + i] << 8) | currentData[offset + i + 1]).toString(16));
        }
        host = parts.join(':');
        offset += 16;
    } else {
        throw new Error('Unsupported address type');
    }

    port = (currentData[offset] << 8) | currentData[offset + 1];
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

    log('info', `SOCKS5 CONNECT: ${host}:${port}${remaining.length > 0 ? ` (+${remaining.length} bytes early data)` : ''}`);

    const vlessAType = mapSocksATypeToVless(atype);
    const addrPortBuf = currentData.subarray(3, offset);
    await establishVlessConnection(socket, session, host, port, vlessAType, addrPortBuf);
}

/**
 * SOCKS4 / SOCKS4a Request Handler
 */
async function handleSocks4Request(socket: any, data: Uint8Array, session: Session) {
    const currentData = session.socksBuffer ? concatUint8Arrays(session.socksBuffer, data) : data;

    // Minimum SOCKS4 request: ver(1) + cmd(1) + port(2) + ip(4) = 8 bytes
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

    const port = (currentData[2] << 8) | currentData[3];
    const ipBytes = currentData.subarray(4, 8);

    // Find null-terminated user ID (starts at byte 8)
    let userIdEnd = 8;
    while (userIdEnd < currentData.length && currentData[userIdEnd] !== 0) userIdEnd++;
    if (userIdEnd >= currentData.length) {
        session.socksBuffer = currentData;
        return;
    }
    // userId is informational, we don't use it for auth in this client
    // const userId = new TextDecoder().decode(currentData.subarray(8, userIdEnd));
    let offset = userIdEnd + 1;

    let host: string;
    let atype: number;

    // SOCKS4a: if IP is 0.0.0.x (x != 0), domain follows user ID
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
        host = ipBytes.join('.');
        atype = SOCKS_ATYPE_IPV4;
    }

    session.destHost = host;
    session.destPort = port;
    session.socksBuffer = undefined;
    // Store first 8 bytes (ver, cmd, port, ip) as template for SOCKS4 reply
    session.socksRequestData = currentData.subarray(0, 8);
    session.socksRequestOffset = 8;

    const remaining = currentData.subarray(offset);
    if (remaining.length > 0) {
        session.pendingData = session.pendingData ? concatUint8Arrays(session.pendingData, remaining) : remaining;
    }

    log('info', `SOCKS4${atype === SOCKS_ATYPE_DOMAIN ? 'a' : ''} CONNECT: ${host}:${port}${remaining.length > 0 ? ` (+${remaining.length} bytes early data)` : ''}`);

    // Build addrPortBuf for VLESS header: [socks_atype, ...addr..., port_hi, port_lo]
    let addrPortBuf: Uint8Array;
    const vlessAType = (atype === SOCKS_ATYPE_DOMAIN) ? VLESS_ATYPE_DOMAIN : VLESS_ATYPE_IPV4;

    if (atype === SOCKS_ATYPE_DOMAIN) {
        const domainBytes = new TextEncoder().encode(host);
        addrPortBuf = new Uint8Array(1 + 1 + domainBytes.length + 2);
        addrPortBuf[0] = SOCKS_ATYPE_DOMAIN;
        addrPortBuf[1] = domainBytes.length;
        addrPortBuf.set(domainBytes, 2);
        addrPortBuf[2 + domainBytes.length] = (port >> 8) & 0xff;
        addrPortBuf[2 + domainBytes.length + 1] = port & 0xff;
    } else {
        addrPortBuf = new Uint8Array(1 + 4 + 2);
        addrPortBuf[0] = SOCKS_ATYPE_IPV4;
        addrPortBuf.set(ipBytes, 1);
        addrPortBuf[5] = (port >> 8) & 0xff;
        addrPortBuf[6] = port & 0xff;
    }

    await establishVlessConnection(socket, session, host, port, vlessAType, addrPortBuf);
}

/**
 * Shared VLESS WebSocket connection logic for both SOCKS4 and SOCKS5
 */
async function establishVlessConnection(
    socket: any,
    session: Session,
    host: string,
    port: number,
    vlessAType: number,
    addrPortBuf: Uint8Array,
) {
    const protocol = OUTBOUND.tls?.enabled ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${OUTBOUND.server}:${OUTBOUND.server_port}${OUTBOUND.transport?.path}`;

    try {
        const ws = new WebSocket(wsUrl, {
            headers: {
                'Host': OUTBOUND.transport?.headers?.Host || OUTBOUND.server,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...OUTBOUND.transport?.headers
            },
            tls: OUTBOUND.tls?.enabled ? {
                rejectUnauthorized: !OUTBOUND.tls?.insecure,
                serverName: OUTBOUND.tls?.server_name || OUTBOUND.server,
            } : undefined
        });

        ws.binaryType = "arraybuffer";
        session.ws = ws;

        const timeout = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                log('error', `WebSocket connection timeout for ${host}:${port}`);
                ws.close();
                sendSocksError(socket, session);
                socket.end();
            }
        }, WS_TIMEOUT);

        ws.onopen = () => {
            clearTimeout(timeout);

            // VLESS header + early data
            const vlessHeader = createVlessHeader(port, vlessAType, addrPortBuf);
            const firstFramePayload = session.pendingData && session.pendingData.length > 0
                ? concatUint8Arrays(vlessHeader, session.pendingData)
                : vlessHeader;
            ws.send(firstFramePayload);

            // Reply SOCKS success (format depends on socksType)
            markSocksSuccess(socket, session);

            session.pendingData = undefined;
            session.state = 'forwarding';
        };

        ws.onmessage = async (event) => {
            const normalized = await normalizeWsMessageData(event.data);
            if (!normalized) {
                log('warn', `Unsupported WS message type for ${host}:${port}: ${typeof event.data}`);
                return;
            }

            session.firstRemotePayloadReceived = true;
            let payload = normalized;

            log('debug', `[WS→DATA] received ${payload.length} bytes (headerSkipped=${session.responseHeaderBytesSkipped})`);

            // VLESS response header is 2 bytes at the start of the stream
            if (session.responseHeaderBytesSkipped < 2) {
                const toSkip = 2 - session.responseHeaderBytesSkipped;
                if (payload.length <= toSkip) {
                    log('debug', `[WS→DATA] skipping ${payload.length} VLESS header bytes (${session.responseHeaderBytesSkipped}/${2})`);
                    if (session.responseHeaderBytesSkipped === 0 && payload.length >= 1) {
                        log('info', `VLESS response: 0x${payload[0].toString(16).padStart(2, '0')} ${payload.length >= 2 ? '0x' + payload[1].toString(16).padStart(2, '0') : '?'}`);
                    }
                    session.responseHeaderBytesSkipped += payload.length;
                    return;
                } else {
                    const skipped = toSkip;
                    // Log the VLESS response bytes before skipping
                    log('info', `VLESS response: 0x${payload[0].toString(16).padStart(2, '0')} 0x${payload[1].toString(16).padStart(2, '0')} (${payload.length - toSkip} bytes payload following)`);
                    payload = payload.subarray(toSkip);
                    session.responseHeaderBytesSkipped = 2;
                    log('debug', `[WS→DATA] skipped ${skipped} VLESS header bytes, ${payload.length} bytes payload remaining`);
                }
            }

            if (payload.length > 0) {
                log('debug', `[WS→SOCKET] writing ${payload.length} bytes to local socket`);
                const written = socket.write(payload);
                session.bytesReceivedFromWs = (session.bytesReceivedFromWs || 0) + payload.length;
            }
        };

        ws.onclose = (event) => {
            const sent = session.bytesSentToWs ?? 0;
            const recv = session.bytesReceivedFromWs ?? 0;
            log(
                session.firstRemotePayloadReceived ? 'debug' : 'warn',
                `Remote WS closed for ${host}:${port} (code=${event.code}, clean=${event.wasClean}, reason=${event.reason || 'none'}, firstPayload=${session.firstRemotePayloadReceived ? 'yes' : 'no'})` +
                ` traffic: ↑${sent} ↓${recv}`
            );
            socket.end();
        };

        ws.onerror = (e: any) => {
            log('error', `WS Error for ${host}:${port}:`, e.message || 'Unknown error');
            if (!session.socksReplySent) {
                sendSocksError(socket, session);
            }
            socket.end();
        };

    } catch (err: any) {
        log('error', `WebSocket creation failed: ${err.message}`);
        sendSocksError(socket, session);
        socket.end();
    }
}

/**
 * Send SOCKS error reply (SOCKS4 or SOCKS5)
 */
function sendSocksError(socket: any, session: Session) {
    if (session.socksReplySent) {
        return;
    }

    if (session.socksType === 'socks4') {
        // SOCKS4 error reply: [0x00, 0x5B, port_hi, port_lo, 0, 0, 0, 0]
        const reply = new Uint8Array(8);
        reply[0] = 0x00;
        reply[1] = SOCKS4_REPLY_REJECTED;
        if (session.destPort !== undefined) {
            reply[2] = (session.destPort >> 8) & 0xff;
            reply[3] = session.destPort & 0xff;
        }
        socket.write(reply);
        session.socksReplySent = true;
        return;
    }

    // SOCKS5 error
    if (session.socksRequestData && session.socksRequestOffset) {
        const reply = new Uint8Array(session.socksRequestOffset);
        reply.set(session.socksRequestData);
        reply[1] = 0x01; // General failure
        socket.write(reply);
        session.socksRequestData = undefined;
        session.socksReplySent = true;
    } else {
        socket.write(new Uint8Array([SOCKS_VERSION, 0x01, 0x00, SOCKS_ATYPE_IPV4, 0, 0, 0, 0, 0, 0]));
        session.socksReplySent = true;
    }
}

function markSocksSuccess(socket: any, session: Session) {
    if (session.socksReplySent || !session.socksRequestData || !session.socksRequestOffset) {
        return;
    }

    if (session.socksType === 'socks4') {
        // SOCKS4 success reply: [0x00, 0x5A, port_hi, port_lo, ip1, ip2, ip3, ip4]
        // Copy port and IP from the original request (first 8 bytes)
        const reply = new Uint8Array(8);
        reply[0] = 0x00;
        reply[1] = SOCKS4_REPLY_GRANTED;
        reply[2] = session.socksRequestData[2];
        reply[3] = session.socksRequestData[3];
        reply[4] = session.socksRequestData[4];
        reply[5] = session.socksRequestData[5];
        reply[6] = session.socksRequestData[6];
        reply[7] = session.socksRequestData[7];
        socket.write(reply);
        session.socksRequestData = undefined;
        session.socksReplySent = true;
        return;
    }

    // SOCKS5 success
    const reply = new Uint8Array(session.socksRequestOffset);
    reply.set(session.socksRequestData);
    reply[1] = 0x00;
    socket.write(reply);
    session.socksRequestData = undefined;
    session.socksReplySent = true;
}

async function normalizeWsMessageData(data: any): Promise<Uint8Array | null> {
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

/**
 * Create VLESS Header
 */
function createVlessHeader(port: number, vlessAType: number, addrPortBuf: Uint8Array): Uint8Array {
    const header = new Uint8Array(1 + 16 + 1 + 1 + 2 + (addrPortBuf.length - 2));
    let offset = 0;
    
    header[offset++] = 0; // Version
    header.set(UUID_BYTES, offset);
    offset += 16;
    
    header[offset++] = 0; // Addons length
    header[offset++] = 1; // Command: TCP
    
    header[offset++] = (port >> 8) & 0xff;
    header[offset++] = port & 0xff;

    header[offset++] = vlessAType;
    header.set(addrPortBuf.subarray(1, addrPortBuf.length - 2), offset);
    
    return header;
}

// Start the client
new BunVLESSClient().start();
