const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste, criarCliente } = require('./helpers');
const { pool, withTenant } = require('../common/db');

describe('Clientes — CRUD básico', () => {
  test('cria, lista, edita e exclui (soft delete) um cliente', async () => {
    const { token } = await registrarEmpresaDeTeste();

    const cliente = await criarCliente(token, { nome: 'João da Silva', whatsapp: '47991234567' });
    assert.equal(cliente.nome, 'João da Silva');

    const lista = await request(app).get('/api/v1/clientes').set('Authorization', `Bearer ${token}`);
    assert.equal(lista.status, 200);
    assert.ok(lista.body.data.some((c) => c.id === cliente.id));

    const editado = await request(app)
      .patch(`/api/v1/clientes/${cliente.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ observacoes: 'Prefere ser atendido de manhã' });
    assert.equal(editado.status, 200);
    assert.equal(editado.body.data.observacoes, 'Prefere ser atendido de manhã');

    const excluido = await request(app).delete(`/api/v1/clientes/${cliente.id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(excluido.status, 204);

    const detalheAposExclusao = await request(app)
      .get(`/api/v1/clientes/${cliente.id}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(detalheAposExclusao.status, 404); // soft delete: some da lista
  });

  test('rejeita nome muito curto na criação', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app)
      .post('/api/v1/clientes')
      .set('Authorization', `Bearer ${token}`)
      .send({ nome: 'A' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('GET de cliente inexistente retorna 404 com código padronizado', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app)
      .get('/api/v1/clientes/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

describe('Clientes — isolamento multi-tenant (seção 33 do manual)', () => {
  test('empresa B não consegue ver cliente da empresa A pela listagem', async () => {
    const empresaA = await registrarEmpresaDeTeste();
    const empresaB = await registrarEmpresaDeTeste();

    await criarCliente(empresaA.token, { nome: 'Cliente Exclusivo da Empresa A' });

    const listaB = await request(app).get('/api/v1/clientes').set('Authorization', `Bearer ${empresaB.token}`);
    assert.equal(listaB.status, 200);
    assert.ok(
      !listaB.body.data.some((c) => c.nome === 'Cliente Exclusivo da Empresa A'),
      'a empresa B não deveria ver cliente da empresa A na listagem'
    );
  });

  test('empresa B não consegue acessar cliente da empresa A mesmo sabendo o ID exato', async () => {
    const empresaA = await registrarEmpresaDeTeste();
    const empresaB = await registrarEmpresaDeTeste();

    const clienteA = await criarCliente(empresaA.token);

    // Este é o teste mais importante do arquivo: forjar o ID de outra empresa
    // na URL não pode funcionar, mesmo com um token válido de outra empresa.
    const res = await request(app)
      .get(`/api/v1/clientes/${clienteA.id}`)
      .set('Authorization', `Bearer ${empresaB.token}`);
    assert.equal(res.status, 404, 'RLS deveria esconder o registro, retornando 404 e não os dados de outra empresa');
  });

  test('empresa B não consegue editar cliente da empresa A', async () => {
    const empresaA = await registrarEmpresaDeTeste();
    const empresaB = await registrarEmpresaDeTeste();
    const clienteA = await criarCliente(empresaA.token, { nome: 'Cliente Original' });

    const res = await request(app)
      .patch(`/api/v1/clientes/${clienteA.id}`)
      .set('Authorization', `Bearer ${empresaB.token}`)
      .send({ nome: 'Nome Alterado Por Invasor' });
    assert.equal(res.status, 404);

    // confirma no banco que o nome realmente não mudou — usando withTenant
    // com o empresa_id CORRETO (o RLS bloquearia essa checagem também se
    // consultássemos via pool cru, sem contexto de tenant nenhum).
    const empresaAId = require('jsonwebtoken').decode(empresaA.token).empresaId;
    const nomeAtual = await withTenant(empresaAId, async (client) => {
      const { rows } = await client.query('select nome from clientes where id = $1', [clienteA.id]);
      return rows[0]?.nome;
    });
    assert.equal(nomeAtual, 'Cliente Original');
  });
});

after(async () => {
  await pool.end();
});
