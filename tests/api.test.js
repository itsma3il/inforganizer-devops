'use strict';

// ─── Environment ─────────────────────────────────────────────────────────────
// Defaults point at the local dev_postgres podman container.
// Override by setting DATABASE_URL in the environment before running tests.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://dev:devpass@127.0.0.1:5432/devdb';
process.env.JWT_SECRET = 'test-secret-for-tests-only';

const http = require('node:http');
const { init, pool } = require('../server/database.js');
const app  = require('../server/server.js');

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(token   ? { Authorization: 'Bearer ' + token } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const request = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// ─── Shared state ─────────────────────────────────────────────────────────────
let server;
let token;    // JWT for authenticated requests
let noteId;   // default note created at signup
let fieldId;  // custom field created in fields tests

beforeAll(async () => {
  await init();
  await pool.query('TRUNCATE users RESTART IDENTITY CASCADE');
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

// ─── Health ───────────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns { status: ok } without auth', async () => {
    const res = await req('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  it('POST /api/auth/signup — creates user and returns token + defaultNoteId', async () => {
    const res = await req('POST', '/api/auth/signup', {
      email: 'test@example.com',
      password: 'testpass123',
    });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.defaultNoteId).toBeTruthy();
    token  = res.body.token;
    noteId = res.body.defaultNoteId;
  });

  it('POST /api/auth/signup — rejects duplicate email', async () => {
    const res = await req('POST', '/api/auth/signup', {
      email: 'test@example.com',
      password: 'another',
    });
    expect(res.status).toBe(409);
  });

  it('POST /api/auth/signup — rejects short password', async () => {
    const res = await req('POST', '/api/auth/signup', {
      email: 'short@example.com',
      password: '12345',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login — returns token for valid credentials', async () => {
    const res = await req('POST', '/api/auth/login', {
      email: 'test@example.com',
      password: 'testpass123',
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('POST /api/auth/login — rejects wrong password', async () => {
    const res = await req('POST', '/api/auth/login', {
      email: 'test@example.com',
      password: 'wrongpass',
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me — returns user info with valid token', async () => {
    const res = await req('GET', '/api/auth/me', null, token);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('test@example.com');
  });

  it('GET /api/auth/me — returns 401 without token', async () => {
    const res = await req('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });
});

// ─── Notes ────────────────────────────────────────────────────────────────────
describe('Notes', () => {
  it('GET /api/notes — returns list containing the default note', async () => {
    const res = await req('GET', '/api/notes', null, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    if (!noteId) noteId = res.body[0].id;
  });

  it('POST /api/notes — creates a new note', async () => {
    const res = await req('POST', '/api/notes', { name: 'OFPPT 2026' }, token);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('OFPPT 2026');
  });

  it('POST /api/notes — rejects empty name', async () => {
    const res = await req('POST', '/api/notes', { name: '   ' }, token);
    expect(res.status).toBe(400);
  });

  it('PUT /api/notes/:id — renames a note', async () => {
    const res = await req('PUT', `/api/notes/${noteId}`, { name: 'Renamed Note' }, token);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Note');
  });

  it('PUT /api/notes/:id — returns 404 for unknown id', async () => {
    const res = await req('PUT', '/api/notes/999999', { name: 'x' }, token);
    expect(res.status).toBe(404);
  });

  it('GET /api/notes — returns 401 without token', async () => {
    const res = await req('GET', '/api/notes');
    expect(res.status).toBe(401);
  });
});

// ─── Note field values ────────────────────────────────────────────────────────
describe('Note field values', () => {
  it('PUT /api/notes/:id/data — stores key-value pairs', async () => {
    const res = await req('PUT', `/api/notes/${noteId}/data`, {
      nom: 'Mousdik', prenom: 'Ismail', email_addr: 'test@example.com',
    }, token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/notes/:id/data — retrieves stored values', async () => {
    const res = await req('GET', `/api/notes/${noteId}/data`, null, token);
    expect(res.status).toBe(200);
    expect(res.body.nom).toBe('Mousdik');
    expect(res.body.prenom).toBe('Ismail');
  });

  it('PUT /api/notes/:id/data — deletes a key when value is empty string', async () => {
    await req('PUT', `/api/notes/${noteId}/data`, { nom: 'Mousdik' }, token);
    await req('PUT', `/api/notes/${noteId}/data`, { nom: '' }, token);
    const res = await req('GET', `/api/notes/${noteId}/data`, null, token);
    expect(res.status).toBe(200);
    expect(res.body.nom).toBeUndefined();
  });
});

// ─── Custom fields ────────────────────────────────────────────────────────────
describe('Custom fields', () => {
  it('POST /api/notes/:id/fields — creates a custom field', async () => {
    const res = await req('POST', `/api/notes/${noteId}/fields`,
      { label: 'LinkedIn URL', section: 'info' }, token);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('LinkedIn URL');
    expect(res.body.section).toBe('info');
    expect(typeof res.body.field_key).toBe('string');
    fieldId = res.body.id;
  });

  it('GET /api/notes/:id/fields — returns the created field', async () => {
    const res = await req('GET', `/api/notes/${noteId}/fields`, null, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.label === 'LinkedIn URL')).toBe(true);
  });

  it('POST /api/notes/:id/fields — rejects empty label', async () => {
    const res = await req('POST', `/api/notes/${noteId}/fields`, { label: '' }, token);
    expect(res.status).toBe(400);
  });

  it('PUT /api/notes/:id/fields/:fieldId — renames a field', async () => {
    const res = await req('PUT', `/api/notes/${noteId}/fields/${fieldId}`,
      { label: 'GitHub URL' }, token);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('GitHub URL');
  });

  it('DELETE /api/notes/:id/fields/:fieldId — removes a field', async () => {
    const res = await req('DELETE', `/api/notes/${noteId}/fields/${fieldId}`, null, token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const list = await req('GET', `/api/notes/${noteId}/fields`, null, token);
    expect(list.body.every(f => f.id !== fieldId)).toBe(true);
  });
});

// ─── Universities ─────────────────────────────────────────────────────────────
describe('Universities', () => {
  const unis = [
    { name: 'ENSIAS', type: 'CI',    status: 'Applied',  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { name: 'INPT',   type: 'CI',    status: 'Pending',  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { name: 'UM5',    type: 'Other', status: 'Accepted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  ];

  it('PUT /api/notes/:id/universities — stores the list', async () => {
    const res = await req('PUT', `/api/notes/${noteId}/universities`, unis, token);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });

  it('GET /api/notes/:id/universities — retrieves the list in order', async () => {
    const res = await req('GET', `/api/notes/${noteId}/universities`, null, token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].name).toBe('ENSIAS');
    expect(res.body[2].status).toBe('Accepted');
  });

  it('PUT /api/notes/:id/universities — replaces with empty list', async () => {
    const res = await req('PUT', `/api/notes/${noteId}/universities`, [], token);
    expect(res.status).toBe(200);
    const list = await req('GET', `/api/notes/${noteId}/universities`, null, token);
    expect(list.body).toHaveLength(0);
  });
});

// ─── Reminders ────────────────────────────────────────────────────────────────
describe('Reminders', () => {
  it('PUT /api/reminders — stores reminders', async () => {
    const res = await req('PUT', '/api/reminders', [
      { text: 'Submit dossier ENSIAS', date: '2026-03-15T09:00' },
      { text: 'Campus France RDV',    date: '2026-03-20T14:00' },
    ], token);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it('GET /api/reminders — retrieves stored reminders', async () => {
    const res = await req('GET', '/api/reminders', null, token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe('Submit dossier ENSIAS');
  });

  it('PUT /api/reminders — replaces with empty list', async () => {
    const res = await req('PUT', '/api/reminders', [], token);
    expect(res.status).toBe(200);
    const list = await req('GET', '/api/reminders', null, token);
    expect(list.body).toHaveLength(0);
  });

  it('GET /api/reminders — returns 401 without token', async () => {
    const res = await req('GET', '/api/reminders');
    expect(res.status).toBe(401);
  });
});

// ─── Clear ────────────────────────────────────────────────────────────────────
describe('DELETE /api/notes/:id/clear', () => {
  beforeAll(async () => {
    // Seed some data to clear
    await req('PUT', `/api/notes/${noteId}/data`, { nom: 'ToDelete' }, token);
    await req('PUT', `/api/notes/${noteId}/universities`,
      [{ name: 'EMSI', type: 'CI', status: 'Applied',
         createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], token);
  });

  it('wipes field values and universities but keeps the note itself', async () => {
    const del = await req('DELETE', `/api/notes/${noteId}/clear`, null, token);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const data = await req('GET', `/api/notes/${noteId}/data`, null, token);
    expect(data.body).toEqual({});

    const unis = await req('GET', `/api/notes/${noteId}/universities`, null, token);
    expect(unis.body).toHaveLength(0);

    const notes = await req('GET', '/api/notes', null, token);
    expect(notes.body.some(n => n.id === noteId)).toBe(true);
  });
});

// ─── Note deletion ────────────────────────────────────────────────────────────
describe('DELETE /api/notes/:id', () => {
  it('cannot delete the only remaining note', async () => {
    // Get current notes, delete all but one first
    const list = await req('GET', '/api/notes', null, token);
    const extra = list.body.filter(n => n.id !== noteId);
    for (const n of extra) {
      await req('DELETE', `/api/notes/${n.id}`, null, token);
    }
    const res = await req('DELETE', `/api/notes/${noteId}`, null, token);
    expect(res.status).toBe(400);
  });

  it('can delete a note when more than one exists', async () => {
    const created = await req('POST', '/api/notes', { name: 'Temp Note' }, token);
    const tmpId = created.body.id;
    const res = await req('DELETE', `/api/notes/${tmpId}`, null, token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
