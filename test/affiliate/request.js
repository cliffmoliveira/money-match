// Minimal supertest-style HTTP client over Node's http + global fetch, so the
// affiliate tests need no third-party test dependency (npm can't install
// supertest on this Windows box). Supports the subset the tests use:
//   request(app).post(path).set(k, v).send(bodyObjectOrString) -> Promise<{status, body, text}>
//   request(app).post(path)                                    -> awaitable (no body)
//
// Each call spins up the express app on an ephemeral port, makes one request,
// then closes the server. `body` of type string/Buffer is sent verbatim (used
// for raw-JSON HMAC payloads); an object is JSON-stringified with a JSON
// Content-Type unless one was already set.
const http = require('http');

class Pending {
  constructor(app, method, path) {
    this.app = app; this.method = method; this.path = path;
    this.headers = {}; this.body = undefined; this.promise = null;
  }
  set(key, value) { this.headers[key] = value; return this; }
  send(body) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      this.body = body;
    } else if (body !== undefined) {
      this.body = JSON.stringify(body);
      const hasCT = Object.keys(this.headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasCT) this.headers['Content-Type'] = 'application/json';
    }
    return this.exec();
  }
  exec() {
    if (this.promise) return this.promise;
    this.promise = new Promise((resolve, reject) => {
      const server = http.createServer(this.app);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', async () => {
        const { port } = server.address();
        try {
          const res = await fetch(`http://127.0.0.1:${port}${this.path}`, {
            method: this.method, headers: this.headers, body: this.body,
          });
          const text = await res.text();
          let parsed;
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
          resolve({ status: res.status, body: parsed, text });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
    return this.promise;
  }
  then(onF, onR) { return this.exec().then(onF, onR); }
  catch(onR) { return this.exec().catch(onR); }
}

function request(app) {
  return {
    post: (path) => new Pending(app, 'POST', path),
    get: (path) => new Pending(app, 'GET', path),
  };
}

module.exports = request;
