const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { app, request, registrarEmpresaDeTeste } = require('./helpers');
const { pool, withTenant } = require('../common/db');
const jwt = require('jsonwebtoken');

function empresaIdDe(token) {
  return jwt.decode(token).empresaId;
}

describe('Webhook do WhatsApp', () => {
  test('recebe mensagem, cria contato/conversa e detecta intenção de orçamento', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const empresaId = empresaIdDe(token);
    const externalMessageId = crypto.randomUUID();

    const res = await request(app).post('/api/v1/webhooks/whatsapp').send({
      empresaId,
      telefone: '5511999990000',
      nomePerfil: 'Rafael Torres',
      externalMessageId,
      texto: 'Oi, queria orçamento pra instalar 3 ventiladores essa semana',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.duplicada, false);
    assert.equal(res.body.data.contato.nome_perfil, 'Rafael Torres');
    assert.equal(res.body.data.ia_interacao.intent, 'orcamento');
    assert.equal(res.body.data.ia_interacao.agente, 'IA_ORCAMENTO');
    assert.equal(res.body.data.ia_interacao.status, 'pendente');
    assert.equal(res.body.data.ia_interacao.dados_extraidos.quantidade, 3);
  });

  test('a mesma external_message_id enviada duas vezes não duplica nada (idempotência, seção 67)', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const empresaId = empresaIdDe(token);
    const externalMessageId = crypto.randomUUID();
    const payload = {
      empresaId, telefone: '5511988880000', externalMessageId,
      texto: 'Recebi 500 do João pela instalação',
    };

    const primeira = await request(app).post('/api/v1/webhooks/whatsapp').send(payload);
    assert.equal(primeira.status, 201);

    const segunda = await request(app).post('/api/v1/webhooks/whatsapp').send(payload);
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.data.duplicada, true);

    const contagem = await withTenant(empresaId, (client) =>
      client.query(`select count(*) from whatsapp_mensagens where external_message_id = $1`, [externalMessageId])
    );
    assert.equal(Number(contagem.rows[0].count), 1, 'só deveria existir 1 linha, mesmo com o webhook chegando 2x');
  });

  test('reconhece intenção de pagamento ("recebi X do fulano")', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const empresaId = empresaIdDe(token);
    const res = await request(app).post('/api/v1/webhooks/whatsapp').send({
      empresaId, telefone: '5511977770000', externalMessageId: crypto.randomUUID(),
      texto: 'Recebi 450 reais do cliente hoje',
    });
    assert.equal(res.body.data.ia_interacao.agente, 'IA_FINANCEIRO');
    assert.equal(res.body.data.ia_interacao.intent, 'registrar_pagamento');
    assert.equal(Number(res.body.data.ia_interacao.dados_extraidos.valor), 450);
  });

  test('mensagem sem padrão reconhecido cai como dúvida, sem exigir confirmação', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const empresaId = empresaIdDe(token);
    const res = await request(app).post('/api/v1/webhooks/whatsapp').send({
      empresaId, telefone: '5511966660000', externalMessageId: crypto.randomUUID(),
      texto: 'Vocês abrem aos sábados?',
    });
    assert.equal(res.body.data.ia_interacao.intent, 'duvida');
    assert.equal(res.body.data.ia_interacao.confirm_required, false);
  });

  test('rejeita payload inválido (telefone ausente)', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const res = await request(app).post('/api/v1/webhooks/whatsapp').send({
      empresaId: empresaIdDe(token), externalMessageId: 'x', texto: 'oi',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('respeita o token de origem quando WHATSAPP_WEBHOOK_SECRET está configurado', async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = 'segredo-de-teste';
    try {
      const { token } = await registrarEmpresaDeTeste();
      const semToken = await request(app).post('/api/v1/webhooks/whatsapp').send({
        empresaId: empresaIdDe(token), telefone: '5511955550000',
        externalMessageId: crypto.randomUUID(), texto: 'oi',
      });
      assert.equal(semToken.status, 401);
      assert.equal(semToken.body.error.code, 'WEBHOOK_UNAUTHORIZED');

      const comToken = await request(app)
        .post('/api/v1/webhooks/whatsapp')
        .set('x-webhook-token', 'segredo-de-teste')
        .send({
          empresaId: empresaIdDe(token), telefone: '5511955550000',
          externalMessageId: crypto.randomUUID(), texto: 'oi',
        });
      assert.equal(comToken.status, 201);
    } finally {
      delete process.env.WHATSAPP_WEBHOOK_SECRET;
    }
  });
});

after(async () => {
  await pool.end();
});
