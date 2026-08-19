const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste } = require('./helpers');
const { pool } = require('../common/db');

describe('POST /api/v1/auth/registrar', () => {
  test('cria empresa + usuário e devolve tokens', async () => {
    const { token, usuarioId } = await registrarEmpresaDeTeste();
    assert.ok(token, 'accessToken deveria existir');
    assert.ok(usuarioId, 'usuário deveria ter id');
  });

  test('rejeita senha curta com 400 e mensagem clara', async () => {
    const res = await request(app).post('/api/v1/auth/registrar').send({
      nomeEmpresa: 'Empresa X',
      nomeUsuario: 'Fulano',
      email: `curta-${Date.now()}@exemplo.com`,
      senha: '123',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('rejeita e-mail duplicado com 409', async () => {
    const { email } = await registrarEmpresaDeTeste();
    const res = await request(app).post('/api/v1/auth/registrar').send({
      nomeEmpresa: 'Outra Empresa',
      nomeUsuario: 'Outro Usuário',
      email,
      senha: 'senha12345',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_EM_USO');
  });
});

describe('POST /api/v1/auth/login', () => {
  test('autentica com credenciais corretas', async () => {
    const { email, senha } = await registrarEmpresaDeTeste();
    const res = await request(app).post('/api/v1/auth/login').send({ email, senha });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken);
  });

  test('rejeita senha errada sem revelar se o e-mail existe (mesma mensagem genérica)', async () => {
    const { email } = await registrarEmpresaDeTeste();
    const res = await request(app).post('/api/v1/auth/login').send({ email, senha: 'senhaErrada123' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'CREDENCIAIS_INVALIDAS');
  });

  test('rejeita e-mail inexistente com a mesma resposta genérica', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ninguem@exemplo.com', senha: 'qualquercoisa' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'CREDENCIAIS_INVALIDAS');
  });
});

describe('Proteção por token', () => {
  test('rota protegida sem token retorna 401', async () => {
    const res = await request(app).get('/api/v1/clientes');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  test('rota protegida com token inválido retorna 401', async () => {
    const res = await request(app).get('/api/v1/clientes').set('Authorization', 'Bearer token-invalido');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_TOKEN');
  });
});

after(async () => {
  await pool.end();
});
