# jiffyback - Simple API Example

A minimal jiffyback server showing the basics: routing, JSON responses, route params, mounting a sub-`Router`, and serving static files.

## Run it

```bash
node app.js
```

or, from the project root:

```bash
npm run dev
```

The server starts on **http://localhost:3000**.

## What it shows

| Route | Method | What it does |
|---|---|---|
| `/hello` | GET | Returns a simple JSON greeting |
| `/echo` | POST | Echoes back the parsed request body |
| `/users/:id` | GET | Reads a route parameter from a mounted `Router` |
| `/` (and any other static path) | GET | Serves files from the `public/` folder |

## Middleware used

- `logger({ enabled: true })` - logs every request to the console
- `cors()` - allows cross-origin requests
- `bodyParser()` - parses JSON, URL-encoded, and multipart bodies
- `serveStatic()` - serves static files, falling through to later routes when a file isn't found

Try it with curl:

```bash
curl http://localhost:3000/hello
curl -X POST -H "Content-Type: application/json" -d '{"name":"jiffyback"}' http://localhost:3000/echo
curl http://localhost:3000/users/42
```
