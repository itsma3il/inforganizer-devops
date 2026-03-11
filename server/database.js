'use strict';

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Set ssl=true and DATABASE_SSL=true only when connecting to a managed RDS/Cloud SQL instance
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function init() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            email         TEXT   UNIQUE NOT NULL,
            password_hash TEXT   NOT NULL,
            created_at    TEXT   NOT NULL
        );

        CREATE TABLE IF NOT EXISTS info_notes (
            id         SERIAL  PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS custom_fields (
            id        SERIAL  PRIMARY KEY,
            note_id   INTEGER NOT NULL REFERENCES info_notes(id) ON DELETE CASCADE,
            field_key TEXT    NOT NULL,
            label     TEXT    NOT NULL,
            section   TEXT    NOT NULL DEFAULT 'custom',
            position  INTEGER NOT NULL DEFAULT 0,
            UNIQUE(note_id, field_key)
        );

        CREATE TABLE IF NOT EXISTS note_field_values (
            note_id   INTEGER NOT NULL REFERENCES info_notes(id) ON DELETE CASCADE,
            field_key TEXT    NOT NULL,
            value     TEXT    NOT NULL,
            PRIMARY KEY (note_id, field_key)
        );

        CREATE TABLE IF NOT EXISTS universities (
            id         SERIAL  PRIMARY KEY,
            note_id    INTEGER NOT NULL REFERENCES info_notes(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            type       TEXT    NOT NULL DEFAULT 'CI',
            status     TEXT    NOT NULL DEFAULT 'Applied',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reminders (
            id      SERIAL  PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text    TEXT    NOT NULL,
            date    TEXT    NOT NULL
        );
    `);
    console.log('Database schema initialised');
}

module.exports = { pool, init };
