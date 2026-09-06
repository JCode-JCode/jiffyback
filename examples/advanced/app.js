import {
  createServer, serveStatic, bodyParser, cors, compression,
  logger, rateLimit, cookieParser, Router,
} from '../../src/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = createServer();

app.use(logger({ enabled: true }));
app.use(cors({ origin: ['http://localhost:3000'], credentials: true }));
app.use(compression());
app.use(bodyParser({ maxSize: 2 * 1024 * 1024 }));
app.use(cookieParser('a-very-secret-key-change-me'));

const api = new Router();
api.use(rateLimit({ windowMs: 60_000, max: 60 }));

api.get('/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

api.post('/login', (req, res) => {
  res.cookie('session', 'demo-token', { httpOnly: true, sameSite: 'Strict', maxAge: 3600 });
  res.json({ loggedIn: true });
});

api.post('/upload', (req, res) => {
  const file = req.files && req.files.avatar;
  if (!file) return res.status(400).json({ error: 'no file field named "avatar"' });
  res.json({ received: file.filename, size: file.size, contentType: file.contentType });
});

app.use('/api', api);

app.ws('/ws', (ws, req) => {
  console.log('WebSocket client connected from', req.socket.remoteAddress);
  ws.send('Welcome to the server!');
  ws.on('message', (msg) => {
    ws.send(`Echo: ${msg}`);
  });
  ws.on('close', () => console.log('WebSocket client disconnected'));
});

app.use(serveStatic(path.join(__dirname, '..', 'simple-api', 'public')));

app.listen(3001, () => {
  console.log('jiffyback advanced server running on http://localhost:3001');
});
