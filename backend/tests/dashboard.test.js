const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste, criarCliente, criarServico } = require('./helpers');
const { pool, withTenant } = require('../common/db');

describe('Dashboard', () => {
  test('empresa nova começa com resumo zerado e sem alertas', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.resumo.a_receber, 0);
    assert.equal(res.body.data.resumo.cobrancas_pendentes, 0);
    assert.deepEqual(res.body.data.alertas, []);
  });

  test('cobrança vencida aparece no resumo e gera alerta de severidade alta', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Carlos Eduardo' });

    // cria uma conta a receber já vencida (vencimento no passado)
    await request(app)
      .post('/api/v1/financeiro/contas-receber')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, descricao: 'Entrega de peça', valor: 720, vencimento: '2020-01-01' });

    const res = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.resumo.cobrancas_pendentes, 1);
    assert.equal(res.body.data.resumo.vencido, 720);

    const alertaVencido = res.body.data.alertas.find((a) => a.tipo === 'cobranca_vencida');
    assert.ok(alertaVencido, 'deveria ter gerado um alerta de cobrança vencida');
    assert.equal(alertaVencido.severidade, 'alta');
    assert.match(alertaVencido.mensagem, /Carlos Eduardo/);
    assert.match(alertaVencido.mensagem, /720/);
  });

  test('orçamento enviado há mais de 2 dias sem resposta gera alerta', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Ana Beatriz' });
    const servico = await criarServico(token, { nome: 'Instalação de ar-condicionado', precoPadrao: 450 });

    const orcamento = await request(app)
      .post('/api/v1/orcamentos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clienteId: cliente.id,
        itens: [{ servicoId: servico.id, descricao: 'Instalação', quantidade: 1, valorUnit: 450 }],
      });

    await request(app)
      .post(`/api/v1/orcamentos/${orcamento.body.data.id}/enviar`)
      .set('Authorization', `Bearer ${token}`);

    // força o enviado_em pra 3 dias atrás, direto no banco, pra não depender de esperar de verdade
    // (via withTenant, com o contexto de empresa correto — igual o backend faria)
    const empresaId = require('jsonwebtoken').decode(token).empresaId;
    await withTenant(empresaId, (client) =>
      client.query(`update orcamentos set enviado_em = now() - interval '3 days' where id = $1`, [orcamento.body.data.id])
    );

    const res = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${token}`);
    const alertaOrcamento = res.body.data.alertas.find((a) => a.tipo === 'orcamento_sem_resposta');
    assert.ok(alertaOrcamento, 'deveria ter gerado um alerta de orçamento sem resposta');
    assert.match(alertaOrcamento.mensagem, /Ana Beatriz/);
  });

  test('agenda_hoje só traz compromissos de hoje, não de outros dias', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'João da Silva' });

    await request(app)
      .post('/api/v1/agenda')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, titulo: 'Manutenção hoje', dataHora: new Date().toISOString() });

    const amanha = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    await request(app)
      .post('/api/v1/agenda')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, titulo: 'Manutenção depois de amanhã', dataHora: amanha });

    const res = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${token}`);
    assert.equal(res.body.data.agenda_hoje.length, 1);
    assert.equal(res.body.data.agenda_hoje[0].titulo, 'Manutenção hoje');
  });

  test('dashboard de uma empresa não mistura dados de outra (isolamento multi-tenant)', async () => {
    const empresaA = await registrarEmpresaDeTeste();
    const empresaB = await registrarEmpresaDeTeste();
    const clienteA = await criarCliente(empresaA.token, { nome: 'Cliente da Empresa A' });

    await request(app)
      .post('/api/v1/financeiro/contas-receber')
      .set('Authorization', `Bearer ${empresaA.token}`)
      .send({ clienteId: clienteA.id, descricao: 'Serviço A', valor: 500, vencimento: '2020-01-01' });

    const dashboardB = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${empresaB.token}`);
    assert.equal(dashboardB.body.data.resumo.vencido, 0);
    assert.equal(dashboardB.body.data.alertas.length, 0);
  });
});

after(async () => {
  await pool.end();
});
