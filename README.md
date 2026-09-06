[![Node.js Version](https://img.shields.io/badge/node-18.9%2B-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![npm version](https://img.shields.io/npm/v/jiffyback)](https://www.npmjs.com/package/jiffyback)
[![npm project](https://img.shields.io/badge/npm-jiffyback-blue)](https://www.npmjs.com/package/jiffyback)

<br>

<img src="docs/images/jiffyback-logo.png" alt="jiffyback">

<br>

**jiffyback** is an ultra-simple, ultra-flexible Node.js backend framework built for web designers. It lets anyone who already knows JavaScript write a real, production-capable backend - routing, middleware, sessions, file uploads, a template engine, a database layer, even WebSockets - without ever touching PHP, and without pulling in a single external dependency.

Where PHP mixes server logic straight into your markup, jiffyback gives you the same "just write some code and it works" simplicity, but in the one language every web designer already writes every day: JavaScript. Everything is a plain, synchronous-feeling, chainable API - no build step, no ORM to learn, no framework magic to reverse-engineer.

---

## Quick Start - A Full Backend in a Few Lines

```javascript
import { createServer, serveStatic, bodyParser } from 'jiffyback';

const app = createServer();

app.use(bodyParser());
app.use(serveStatic('./public'));

app.get('/hello/:name', (req, res) => {
  res.json({ message: `Hello, ${req.params.name}!` });
});

app.post('/echo', (req, res) => {
  res.json({ received: req.body });
});

app.listen(3000, () => console.log('jiffyback running on http://localhost:3000'));
```

That's it - no config file, no build step, nothing to install beyond `jiffyback` itself.

---

## Main Capabilities

- **HTTP & HTTPS Server** - `createServer`/`Server` wraps Node's own `http`/`https` modules with a friendly, chainable API (`app.get()`, `app.post()`, `app.use()`, ...) and sane, explicit timeout handling.

- **Router** - a full-featured `Router` with route params (`:id`), optional params (`:id?`), wildcards (`*`), automatic `HEAD` handling, error middleware, and mountable sub-routers for organizing larger apps.

- **Request Helpers** - `req.query`, `req.params`, `req.cookies`, `req.get()`/`req.is()`, `req.secure`, and a proxy-aware `req.ip` (via a configurable `trustProxy` setting).

- **Response Helpers** - `res.json()`, `res.send()`, `res.redirect()`, `res.cookie()`/`res.clearCookie()`, `res.sendFile()` (with Range/ETag/conditional-request support for streaming media), `res.download()`, and `res.render()` for views.

- **Middleware, Batteries Included** - `bodyParser` (JSON, URL-encoded, text, raw, and streaming multipart file uploads), `serveStatic`, `cors`, `compression` (gzip/brotli/deflate), `logger`, `rateLimit`, `securityHeaders`, `csrf`, `cookieParser`, and `session` - all in jiffyback, all optional, all zero-dependency.

- **Built-in Template Engine** - a small `{{ }}`-style engine (`compileTemplate`/`createViewEngine`) with auto-escaping, layouts, partials, loops, and conditionals - enough for real server-rendered pages without adding a templating dependency.

- **Validation** - a small, chainable schema builder (`v.string()`, `v.number()`, `v.object({...})`, ...) plus a `validate(schema)` middleware, so incoming request data is checked and coerced before it ever reaches your route handler.

- **Database Layer** - `createDatabase()` wraps a pluggable adapter with an injection-safe, chainable query builder (`.where()`, `.orderBy()`, `.limit()`, `.insert()`, `.update()`, `.delete()`, transactions, ...). Ships with `sqliteAdapter()` built on Node's own `node:sqlite` - genuinely zero-dependency - and a documented shape for wrapping `mysql2`, `pg`, or any other driver.

- **WebSockets** - `server.ws('/path', handler)` gives you a native RFC 6455 WebSocket implementation, with origin checking (same-origin by default) and payload/buffer size limits, again with no external dependency.

- **Security-Minded by Default** - path-traversal-safe static serving, HTML auto-escaping in views, parameterized SQL everywhere, timing-safe cookie/CSRF comparisons, and header-injection guards, all documented inline where they matter.

---

## Installation

```bash
npm install jiffyback
```

jiffyback has **zero runtime dependencies**. The only thing worth calling out is `sqliteAdapter()`, which uses Node's built-in (currently experimental) `node:sqlite` module and therefore needs **Node.js 22.5+**; every other part of the library only requires the package's minimum, **Node.js 18.9+**.

---

## More Examples

### Routing and sub-routers

```javascript
import { createServer, Router } from 'jiffyback';

const app = createServer();

const users = new Router();
users.get('/:id', (req, res) => res.send(`User ID: ${req.params.id}`));
users.post('/', (req, res) => res.status(201).json({ created: req.body }));

app.use('/users', users);
app.listen(3000);
```

### Validating a request body

```javascript
import { v, validate } from 'jiffyback';

const signupSchema = v.object({
  email: v.string().email(),
  age: v.number().integer().min(13),
  bio: v.string().max(280).optional(),
});

app.post('/signup', validate(signupSchema), (req, res) => {
  res.json({ ok: true, data: req.body });
});
```

### Rendering a view

```javascript
const app = createServer({ views: { dir: './views', layout: 'layout' } });

app.get('/profile/:name', (req, res) => {
  res.render('profile', { name: req.params.name, isAdmin: false });
});
```

```html
<!-- views/profile.html -->
<h1>Hello, {{ name }}</h1>
{{if isAdmin}}
  <p>You have admin access.</p>
{{else}}
  <p>Standard account.</p>
{{/if}}
```

### Querying a database

```javascript
import { createDatabase, sqliteAdapter } from 'jiffyback';

const db = createDatabase(sqliteAdapter('./app.db'));

app.get('/posts', async (req, res) => {
  const posts = await db.table('posts').where('published', true).orderBy('createdAt', 'desc').limit(20).get();
  res.json(posts);
});
```

### Real-time with WebSockets

```javascript
app.ws('/chat', (ws, req) => {
  ws.send('Welcome!');
  ws.on('message', (msg) => ws.send(`Echo: ${msg}`));
});
```

---

## Bundled Examples

`examples/` contains two full, runnable apps:

| Folder | What it shows |
|---|---|
| `examples/simple-api/` | The basics: routing, JSON responses, a mounted sub-router, and static file serving. |
| `examples/advanced/` | A larger walkthrough: HTTPS setup, WebSockets, compression, rate limiting, signed cookies, and file uploads. |

Run either one with:

```bash
npm run dev            # examples/simple-api
npm run dev:advanced   # examples/advanced
```

---

## Design Philosophy

jiffyback is deliberately unopinionated: nothing is applied automatically. Every middleware - security headers, CORS, sessions, rate limiting, compression - is something you explicitly `app.use()`, so what runs on your server is always exactly what you asked for, never a hidden default. The goal is to feel as approachable as dropping a `<?php ... ?>` block into an HTML page, while staying entirely inside JavaScript.

---

## Running Tests

```bash
npm test
```

---

## Issues and Contributions

Bug reports and feature requests are welcome via GitHub Issues. Pull requests should maintain the existing code style and include tests where appropriate.

---

## Links

- **GitHub repository:**
  https://github.com/JCode-JCode/jiffyback

- **npm page:**
  https://www.npmjs.com/package/jiffyback

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

Designed and built with love by **J Code**
