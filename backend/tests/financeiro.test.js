const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste } = require('./helpers');
const { pool } = require('../common/db');

describe('Contas a pagar', () => {
  test('cria e paga uma conta a pagar', async () => {
    const { token } = await registrarEmpresaDeTeste();

    const criada = await request(app)
      .post('/api/v1/financeiro/contas-pagar')
      .set('Authorization', `Bearer ${token}`)
      .send({ descricao: 'Aluguel da oficina', categoria: 'aluguel', valor: 900, vencimento: '2026-09-05' });
    assert.equal(criada.status, 201);
    assert.equal(criada.body.data.status, 'pendente');

    const paga = await request(app)
      .post(`/api/v1/financeiro/contas-pagar/${criada.body.data.id}/pagar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metodo: 'transferencia' });
    assert.equal(paga.status, 200);
    assert.equal(paga.body.data.conta_pagar.status, 'pago');

    // pagar de novo deve falhar
    const segundaVez = await request(app)
      .post(`/api/v1/financeiro/contas-pagar/${criada.body.data.id}/pagar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metodo: 'pix' });
    assert.equal(segundaVez.status, 409);
    assert.equal(segundaVez.body.error.code, 'ALREADY_PAID');
  });

  test('lista contas a pagar filtrando por status', async () => {
    const { token } = await registrarEmpresaDeTeste();
    await request(app)
      .post('/api/v1/financeiro/contas-pagar')
      .set('Authorization', `Bearer ${token}`)
      .send({ descricao: 'Combustível', valor: 150, vencimento: '2026-09-10' });

    const pendentes = await request(app)
      .get('/api/v1/financeiro/contas-pagar?status=pendente')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(pendentes.status, 200);
    assert.ok(pendentes.body.data.every((c) => c.status === 'pendente'));
  });
});

describe('Permissões granulares (seção 37 do manual)', () => {
  test('perfil EMPRESA_ADMIN consegue criar serviço (tem a permissão por padrão)', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app)
      .post('/api/v1/servicos')
      .set('Authorization', `Bearer ${token}`)
      .send({ nome: 'Troca de disjuntor', precoPadrao: 80, custo: 20 });
    assert.equal(res.status, 201);
  });

  test('token válido mas sem a permissão específica recebe 403, não 500', async () => {
    // simula um token de usuário autenticado mas sem nenhuma permissão concedida,
    // assinado com o mesmo segredo — isso testa o middleware, não o fluxo de login.
    const jwt = require('jsonwebtoken');
    process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
    const { token: tokenValido } = await registrarEmpresaDeTeste();
    const payload = jwt.decode(tokenValido);

    const tokenSemPermissao = jwt.sign(
      { sub: payload.sub, empresaId: payload.empresaId, perfil: 'FUNCIONARIO', permissoes: [] },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '5m' }
    );

    const res = await request(app)
      .post('/api/v1/clientes')
      .set('Authorization', `Bearer ${tokenSemPermissao}`)
      .send({ nome: 'Cliente Qualquer' });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });
});

after(async () => {
  await pool.end();
});
