const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { app, request, registrarEmpresaDeTeste, criarCliente, criarServico } = require('./helpers');
const { pool } = require('../common/db');

function empresaIdDe(token) {
  return jwt.decode(token).empresaId;
}

async function receberMensagem(token, texto) {
  const empresaId = empresaIdDe(token);
  const res = await request(app).post('/api/v1/webhooks/whatsapp').send({
    empresaId, telefone: '5511' + Math.floor(Math.random() * 1e9),
    externalMessageId: crypto.randomUUID(), texto,
  });
  return res.body.data.ia_interacao;
}

describe('Confirmação de sugestões da IA (seção 5: nunca automática)', () => {
  test('confirmar uma sugestão de orçamento cria o orçamento de verdade', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Rafael Torres' });
    const servico = await criarServico(token, { nome: 'Instalação de ventilador', precoPadrao: 120 });

    const interacao = await receberMensagem(token, 'Queria orçamento pra instalar 3 ventiladores');
    assert.equal(interacao.intent, 'orcamento');

    const confirmar = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/confirmar`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        clienteId: cliente.id, servicoId: servico.id,
        descricao: 'Instalação de ventilador', quantidade: 3, valorUnit: 120,
      });

    assert.equal(confirmar.status, 200);
    assert.equal(confirmar.body.data.acao.tipo, 'orcamento_criado');
    assert.equal(Number(confirmar.body.data.acao.orcamento.valor_total), 360);

    // não pode confirmar de novo
    const segunda = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/confirmar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, descricao: 'x', valorUnit: 1 });
    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.error.code, 'ALREADY_RESOLVED');
  });

  test('confirmar uma sugestão de pagamento cria a conta a receber já paga', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Maria Fernandes' });

    const interacao = await receberMensagem(token, 'Recebi 280 da Maria');
    assert.equal(interacao.intent, 'registrar_pagamento');

    const confirmar = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/confirmar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, valor: 280, metodo: 'pix' });

    assert.equal(confirmar.status, 200);
    assert.equal(confirmar.body.data.acao.conta_receber.status, 'pago');
    assert.equal(Number(confirmar.body.data.acao.pagamento.valor), 280);
  });

  test('rejeitar uma sugestão marca como rejeitada e impede confirmação depois', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token);
    const interacao = await receberMensagem(token, 'Queria orçamento pra pintura');

    const rejeitar = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/rejeitar`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(rejeitar.status, 200);
    assert.equal(rejeitar.body.data.status, 'rejeitada');

    const tentarConfirmar = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/confirmar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, descricao: 'x', valorUnit: 1 });
    assert.equal(tentarConfirmar.status, 409);
  });

  test('usuário sem a permissão ia.executar recebe 403 ao tentar confirmar', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const interacao = await receberMensagem(token, 'Queria orçamento pra troca de fiação');

    const tokenSemPermissao = jwt.sign(
      { sub: 'algum-usuario', empresaId: empresaIdDe(token), perfil: 'FUNCIONARIO', permissoes: [] },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '5m' }
    );

    const res = await request(app)
      .post(`/api/v1/whatsapp/interacoes/${interacao.id}/confirmar`)
      .set('Authorization', `Bearer ${tokenSemPermissao}`)
      .send({ clienteId: 'x', descricao: 'x', valorUnit: 1 });
    assert.equal(res.status, 403);
  });

  test('lista apenas interações pendentes por padrão', async () => {
    const { token } = await registrarEmpresaDeTeste();
    await receberMensagem(token, 'Queria orçamento pra revisão elétrica');

    const lista = await request(app).get('/api/v1/whatsapp/interacoes').set('Authorization', `Bearer ${token}`);
    assert.equal(lista.status, 200);
    assert.ok(lista.body.data.length >= 1);
    assert.ok(lista.body.data.every((i) => i.status === 'pendente'));
  });
});

describe('IA_ASSISTENTE — respostas com dados reais (seção 26)', () => {
  test('"quanto tenho para receber?" responde com o valor real do banco', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token);
    await request(app)
      .post('/api/v1/financeiro/contas-receber')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, descricao: 'Serviço X', valor: 450, vencimento: '2027-01-01' });

    const res = await request(app)
      .post('/api/v1/assistente/perguntar')
      .set('Authorization', `Bearer ${token}`)
      .send({ pergunta: 'Quanto tenho para receber?' });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.reconhecida, true);
    assert.equal(res.body.data.dados.total, 450);
    assert.match(res.body.data.texto, /450/);
  });

  test('"quem está atrasado?" lista clientes com conta vencida', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Carlos Eduardo' });
    await request(app)
      .post('/api/v1/financeiro/contas-receber')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, descricao: 'Entrega', valor: 720, vencimento: '2020-01-01' });

    const res = await request(app)
      .post('/api/v1/assistente/perguntar')
      .set('Authorization', `Bearer ${token}`)
      .send({ pergunta: 'Quem está atrasado?' });

    assert.match(res.body.data.texto, /Carlos Eduardo/);
  });

  test('pergunta sem padrão reconhecido devolve reconhecida: false, não erro', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app)
      .post('/api/v1/assistente/perguntar')
      .set('Authorization', `Bearer ${token}`)
      .send({ pergunta: 'Qual a previsão do tempo amanhã?' });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.reconhecida, false);
  });
});

after(async () => {
  await pool.end();
});
