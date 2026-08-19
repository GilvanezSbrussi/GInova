const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Executa uma função dentro de uma transação já configurada com o
 * empresa_id do usuário autenticado, para que as policies de Row Level
 * Security do banco (ver database/001_mvp1_schema.sql) isolem os dados
 * automaticamente — mesmo que alguém tente forjar um empresa_id na
 * query ou na URL (seção 33 do manual: "autorização por objeto").
 */
async function withTenant(empresaId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('select set_config($1, $2, true)', ['app.empresa_id', empresaId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant };
