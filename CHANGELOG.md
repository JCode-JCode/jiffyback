# Changelog

All notable changes to **jiffyback** are documented in this file.

---

## [1.0.1] - 2026-09-18

**· Added** – Optional HTTP/2 support: pass `http2: true` to `createServer()`/`new Server()` (together with `options.https`) to serve over HTTP/2, with automatic ALPN fallback to HTTP/1.1 (`allowHTTP1: true`) for clients that don't speak h2.

---

## [1.0.0] - Initial Release

**· Added** – Initial public release of jiffyback.

**· Added** – Zero-dependency HTTP server (`createServer`/`Server`) with HTTP and HTTPS support.

**· Added** – Express-style `Router` with route params (`:id`), optional params (`:id?`), wildcards (`*`), sub-router mounting, and error middleware.

**· Added** – Request enhancements: `req.query`, `req.params`, `req.cookies`, `req.get()`, `req.is()`, `req.secure`, `req.ip` (with configurable `trustProxy`).

**· Added** – Response helpers: `res.status()`, `res.json()`, `res.send()`, `res.redirect()`, `res.cookie()`/`res.clearCookie()`, `res.sendFile()` (with Range/ETag support), `res.download()`, `res.render()`.

**· Added** – Built-in middleware: `bodyParser` (JSON/urlencoded/text/raw/multipart with streaming file uploads), `serveStatic`, `cors`, `compression` (gzip/brotli/deflate), `logger`, `rateLimit`, `securityHeaders`, `csrf`, `cookieParser`, `session`.

**· Added** – Built-in `{{ }}`-style template engine (`compileTemplate`/`createViewEngine`) with layouts, partials, loops, and conditionals.

**· Added** – Zero-dependency schema validation (`v`, `validate`) for request body/query/params.

**· Added** – Injection-safe query builder and database layer (`createDatabase`, `sqliteAdapter`, `createAdapter`) built on `node:sqlite`.

**· Added** – Native, dependency-free WebSocket support (`server.ws()`), including origin checking and payload/buffer size limits.

**· Added** – Full test suite covering routing, middleware, validation, views, database, and WebSocket behavior.