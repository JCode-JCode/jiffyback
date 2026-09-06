import { createServer } from '../../src/index.js';

export async function startTestServer(setup, options) {
  const app = createServer(options);
  setup(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
