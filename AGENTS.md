# bun-vlessclient

Bun 原生 VLESS 客户端，提供本地 SOCKS5/SOCKS4/HTTP 代理服务。

## 项目结构

```
bun-vlessclient/
├── bun-vlessclient.ts   # 主入口，CLI 参数解析 + 所有协议处理
├── package.json          # 构建配置
├── config.json           # 配置文件示例
├── .env.example          # 环境变量模板
└── dist/                 # 构建产物
```

## 技术栈

- **运行时**: Bun ≥ 1.0.0
- **语言**: TypeScript
- **核心 API**: `Bun.listen()`、`WebSocket`

## 协议支持

- `SOCKS5` (默认)
- `SOCKS4` / `SOCKS4a`
- `HTTP CONNECT` + 标准方法

## 配置优先级

`命令行参数 (-c)` > `config.json` > `.env` > 默认值

## 编码约定

### 类型定义

在文件顶部集中定义接口，避免重复：

```typescript
// 全局 Session 接口 (bun-vlessclient.ts:190-204)
interface Session {
    state: 'greeting' | 'request' | 'forwarding';
    socksType: 'socks4' | 'socks5' | 'http';
    // ...
}
```

### Buffer 处理

- 使用 `Uint8Array`，不要用 `Buffer`（兼容性问题）
- 合并字节：自定义 `concatUint8Arrays()` 函数（第 134 行）
- 解码文本：`new TextDecoder().decode()`
- 编码文本：`new TextEncoder().encode()`

### 状态机模式

每个连接的生命周期：
1. `greeting` → 检测协议（SOCKS4/5 或 HTTP）
2. `request` → 解析目标地址，建立远程连接
3. `forwarding` → 双向透传数据

### 错误处理

- 协议错误：返回对应协议的错误响应（如 SOCKS4 0x5B），然后关闭连接
- 连接错误：打印日志，发送 SOCKS 错误码
- 所有 WebSocket 回调中都有 try-catch

### 关键函数签名

```typescript
// 数据合并
concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array

// UUID 解析
parseUUID(uuid: string): Uint8Array

// 地址类型映射（SOCKS → VLESS）
mapSocksATypeToVless(socksAType: number): number

// 创建 VLESS 头
createVlessHeader(port: number, vlessAType: number, addrPortBuf: Uint8Array): Uint8Array

// WebSocket 消息规范化
normalizeWsMessageData(data: any): Promise<Uint8Array | null>
```

### 常量命名

使用全大写下划线命名协议的常量，声明在各自处理函数上方：

```typescript
// SOCKS5
const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
// ...

// SOCKS4
const SOCKS4_VERSION = 0x04;
// ...

// VLESS
const VLESS_ATYPE_IPV4 = 0x01;
// ...
```

## 构建与运行

```bash
bun run build    # 编译到 dist/
bun run start    # 运行
bun bun-vlessclient.ts --help
```

## 调试技巧

在 `handleSocksGreeting` 中检测协议版本号：
- `0x04` → SOCKS4
- `0x05` → SOCKS5
- 其他 + HTTP 方法 → HTTP

## 注意事项

- `PACKET_ENCODING=xudp` 配置项存在，但 UDP 功能未实现
- WebSocket 连接支持早期数据（handshake 期间的请求）
- 双栈监听：IPv4 `0.0.0.0` + IPv6 `::`