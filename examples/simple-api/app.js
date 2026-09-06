import { createServer, serveStatic, bodyParser, cors, logger, Router } from '../../src/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createServer();

app.use(logger({ enabled: true }));
app.use(cors());
app.use(bodyParser());

app.get('/hello', (req, res) => {
  res.json({ message: 'Hello, Designer! 🎨' });
});

app.post('/echo', (req, res) => {
  res.json({ received: req.body });
});

const userRouter = new Router();
userRouter.get('/:id', (req, res) => {
  res.send(`User ID: ${req.params.id}`);
});
app.use('/users', userRouter);

app.use(serveStatic(path.join(__dirname, 'public')));

app.onError((err, req, res) => {
  console.error('Error handling request:', err.message);
  res.status(500).json({ error: 'Something went wrong', detail: err.message });
});

app.listen(3000, () => {
  console.log('jiffyback running on http://localhost:3000');
});
