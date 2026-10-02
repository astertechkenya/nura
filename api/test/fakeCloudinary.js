// A stand-in for Cloudinary's Admin API, for tests: look up an uploaded photo, delete one.
//
//   fake.resources.set('nura/products/abc', { format: 'webp', bytes: 120000, version: 1700000000 })
//   fake.deleted   → public_ids the API asked to delete
import http from 'node:http';

export const TEST_CLOUD = { name: 'nura-test', key: '123456789012345', secret: 'testOnlyCloudinarySecret0123' };

export function startFakeCloudinary(port = 4595) {
  const fake = { resources: new Map(), deleted: [] };
  const auth = `Basic ${Buffer.from(`${TEST_CLOUD.key}:${TEST_CLOUD.secret}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== auth) return send(401, { error: { message: 'Invalid credentials' } });
    const url = new URL(req.url, 'http://x');
    const prefix = `/v1_1/${TEST_CLOUD.name}/resources/image/upload`;
    if (req.method === 'GET' && url.pathname.startsWith(prefix + '/')) {
      const id = decodeURIComponent(url.pathname.slice(prefix.length + 1));
      const r = fake.resources.get(id);
      return r ? send(200, { public_id: id, resource_type: 'image', ...r }) : send(404, { error: { message: 'Resource not found' } });
    }
    if (req.method === 'DELETE' && url.pathname === prefix) {
      for (const id of url.searchParams.getAll('public_ids[]')) { fake.deleted.push(id); fake.resources.delete(id); }
      return send(200, { deleted: {} });
    }
    return send(404, { error: { message: 'Not found' } });
  });
  return new Promise((ok) => server.listen(port, () => ok({ fake, close: () => new Promise((r) => server.close(r)) })));
}
