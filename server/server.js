'use strict';

require('dotenv').config();

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const { pool, init } = require('./database');
const { signToken, authMiddleware } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

async function getOwnedNote(noteId, userId) {
    const { rows } = await pool.query('SELECT * FROM info_notes WHERE id = $1', [noteId]);
    const note = rows[0];
    if (!note || note.user_id !== userId) return null;
    return note;
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.length) return res.status(409).json({ error: 'Email already registered' });

        const hash = await bcrypt.hash(password, 12);
        const { rows: userRows } = await pool.query(
            'INSERT INTO users (email, password_hash, created_at) VALUES ($1,$2,$3) RETURNING id',
            [email.toLowerCase(), hash, now()]
        );
        const userId = userRows[0].id;

        const { rows: noteRows } = await pool.query(
            'INSERT INTO info_notes (user_id, name, created_at, updated_at) VALUES ($1,$2,$3,$4) RETURNING id',
            [userId, 'My Application', now(), now()]
        );

        const token = signToken(userId);
        res.status(201).json({ token, user: { id: userId, email: email.toLowerCase() }, defaultNoteId: noteRows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = signToken(user.id);
        res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.userId]);
        const user = rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Notes (CRUD) ─────────────────────────────────────────────────────────────
app.get('/api/notes', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM info_notes WHERE user_id = $1 ORDER BY created_at ASC', [req.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/notes', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'Note name required' });
        const { rows } = await pool.query(
            'INSERT INTO info_notes (user_id, name, created_at, updated_at) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.userId, name.trim(), now(), now()]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notes/:id', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { name } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'Note name required' });
        await pool.query('UPDATE info_notes SET name = $1, updated_at = $2 WHERE id = $3', [name.trim(), now(), note.id]);
        res.json({ ...note, name: name.trim() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/notes/:id', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows } = await pool.query('SELECT COUNT(*) AS n FROM info_notes WHERE user_id = $1', [req.userId]);
        if (parseInt(rows[0].n, 10) <= 1) return res.status(400).json({ error: 'Cannot delete your only note' });
        await pool.query('DELETE FROM info_notes WHERE id = $1', [note.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Custom Fields ────────────────────────────────────────────────────────────
app.get('/api/notes/:id/fields', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows } = await pool.query(
            'SELECT * FROM custom_fields WHERE note_id = $1 ORDER BY section, position ASC', [note.id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/notes/:id/fields', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { label, section } = req.body || {};
        if (!label || !label.trim()) return res.status(400).json({ error: 'Field label required' });
        const fieldKey = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const { rows: maxRows } = await pool.query(
            'SELECT MAX(position) AS m FROM custom_fields WHERE note_id = $1 AND section = $2',
            [note.id, section || 'custom']
        );
        const position = (maxRows[0].m ?? -1) + 1;
        const { rows } = await pool.query(
            'INSERT INTO custom_fields (note_id, field_key, label, section, position) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [note.id, fieldKey, label.trim(), section || 'custom', position]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notes/:id/fields/:fieldId', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows: fieldRows } = await pool.query(
            'SELECT * FROM custom_fields WHERE id = $1 AND note_id = $2',
            [Number(req.params.fieldId), note.id]
        );
        const field = fieldRows[0];
        if (!field) return res.status(404).json({ error: 'Field not found' });
        const { label } = req.body || {};
        if (!label || !label.trim()) return res.status(400).json({ error: 'Field label required' });
        await pool.query('UPDATE custom_fields SET label = $1 WHERE id = $2', [label.trim(), field.id]);
        res.json({ ...field, label: label.trim() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/notes/:id/fields/:fieldId', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows: fieldRows } = await pool.query(
            'SELECT * FROM custom_fields WHERE id = $1 AND note_id = $2',
            [Number(req.params.fieldId), note.id]
        );
        const field = fieldRows[0];
        if (!field) return res.status(404).json({ error: 'Field not found' });
        await pool.query('DELETE FROM note_field_values WHERE note_id = $1 AND field_key = $2', [note.id, field.field_key]);
        await pool.query('DELETE FROM custom_fields WHERE id = $1', [field.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Note Field Values (all fields for a note) ───────────────────────────────
app.get('/api/notes/:id/data', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows } = await pool.query('SELECT field_key, value FROM note_field_values WHERE note_id = $1', [note.id]);
        const data = {};
        rows.forEach(r => { data[r.field_key] = r.value; });
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notes/:id/data', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const data = req.body || {};
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const [key, val] of Object.entries(data)) {
                if (val !== null && val !== undefined && val !== '') {
                    await client.query(
                        'INSERT INTO note_field_values (note_id, field_key, value) VALUES ($1,$2,$3) ON CONFLICT (note_id, field_key) DO UPDATE SET value = EXCLUDED.value',
                        [note.id, key, String(val)]
                    );
                } else {
                    await client.query('DELETE FROM note_field_values WHERE note_id = $1 AND field_key = $2', [note.id, key]);
                }
            }
            await client.query('UPDATE info_notes SET updated_at = $1 WHERE id = $2', [now(), note.id]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Universities (per note) ──────────────────────────────────────────────────
app.get('/api/notes/:id/universities', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const { rows } = await pool.query('SELECT * FROM universities WHERE note_id = $1 ORDER BY id ASC', [note.id]);
        res.json(rows.map(r => ({ id: r.id, name: r.name, type: r.type, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notes/:id/universities', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const list = Array.isArray(req.body) ? req.body : [];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM universities WHERE note_id = $1', [note.id]);
            for (const u of list) {
                await client.query(
                    'INSERT INTO universities (note_id, name, type, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
                    [note.id, u.name, u.type || 'CI', u.status || 'Applied', u.createdAt || now(), u.updatedAt || now()]
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json({ success: true, count: list.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Reminders (per user) ────────────────────────────────────────────────────
app.get('/api/reminders', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, text, date FROM reminders WHERE user_id = $1 ORDER BY id ASC', [req.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/reminders', authMiddleware, async (req, res) => {
    try {
        const list = Array.isArray(req.body) ? req.body : [];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM reminders WHERE user_id = $1', [req.userId]);
            for (const r of list) {
                await client.query('INSERT INTO reminders (user_id, text, date) VALUES ($1,$2,$3)', [req.userId, r.text, r.date]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json({ success: true, count: list.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Clear note data only ────────────────────────────────────────────────────
app.delete('/api/notes/:id/clear', authMiddleware, async (req, res) => {
    try {
        const note = await getOwnedNote(Number(req.params.id), req.userId);
        if (!note) return res.status(404).json({ error: 'Note not found' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM note_field_values WHERE note_id = $1', [note.id]);
            await client.query('DELETE FROM universities WHERE note_id = $1', [note.id]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
    init().then(() => {
        app.listen(PORT, () => console.log(`Inforganizer running on http://0.0.0.0:${PORT}`));
    }).catch(err => {
        console.error('Database initialisation failed:', err);
        process.exit(1);
    });
}

module.exports = app;
