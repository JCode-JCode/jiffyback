# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-09-06

### Added

- Initial public release of jiffyback.
- Zero-dependency HTTP server (`createServer`/`Server`) with HTTP and HTTPS support.
- Express-style `Router` with route params (`:id`), optional params (`:id?`), wildcards (`*`), sub-router mounting, and error middleware.
- Request enhancements: `req.query`, `req.params`, `req.cookies`, `req.get()`, `req.is()`, `req.secure`, `req.ip` (with configurable `trustProxy`).
- Response helpers: `res.status()`, `res.json()`, `res.send()`, `res.redirect()`, `res.cookie()`/`res.clearCookie()`, `res.sendFile()` (with Range/ETag support), `res.download()`, `res.render()`.
- Built-in middleware: `bodyParser` (JSON/urlencoded/text/raw/multipart with streaming file uploads), `serveStatic`, `cors`, `compression` (gzip/brotli/deflate), `logger`, `rateLimit`, `securityHeaders`, `csrf`, `cookieParser`, `session`.
- Built-in `{{ }}`-style template engine (`compileTemplate`/`createViewEngine`) with layouts, partials, loops, and conditionals.
- Zero-dependency schema validation (`v`, `validate`) for request body/query/params.
- Injection-safe query builder and database layer (`createDatabase`, `sqliteAdapter`, `createAdapter`) built on `node:sqlite`.
- Native, dependency-free WebSocket support (`server.ws()`), including origin checking and payload/buffer size limits.
- Full test suite covering routing, middleware, validation, views, database, and WebSocket behavior.
