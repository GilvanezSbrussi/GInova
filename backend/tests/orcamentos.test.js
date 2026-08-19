const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste, criarCliente, criarServico } = require('./helpers');
const { pool } = require('../common/db');

describe('Fluxo completo: orçamento → aprovação → agenda → financeiro (seção 113, "regra de ouro")', () => {
  test('criar orçamento com itens calcula o valor total corretamente', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token);
    const servico = await criarServico(token, { nome: 'Instalação de ventilador', precoPadrao: 120 });

    const res = await request(app)
      .post('/api/v1/orcamentos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clienteId: cliente.id,
        itens: [
          { servicoId: servico.id, descricao: 'Instalação de ventilador', quantidade: 3, valorUnit: 120 },
        ],
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'rascunho');
    assert.equal(Number(res.body.data.valor_total), 360);
  });

  test('rejeita orçamento sem nenhum item', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token);

    const res = await request(app)
      .post('/api/v1/orcamentos')
      .set('Authorization', `Bearer ${token}`)
      .send({ clienteId: cliente.id, itens: [] });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('aprovar orçamento cria agendamento e conta a receber automaticamente, e o dinheiro flui até o resumo financeiro', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token, { nome: 'Maria Fernandes' });
    const servico = await criarServico(token, { nome: 'Manutenção preventiva', precoPadrao: 180, custo: 40 });

    const orcamento = await request(app)
      .post('/api/v1/orcamentos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clienteId: cliente.id,
        itens: [{ servicoId: servico.id, descricao: 'Manutenção preventiva', quantidade: 1, valorUnit: 180 }],
      });
    const orcamentoId = orcamento.body.data.id;

    // aprova sem passar dataHora -> não deveria criar agendamento, só a conta a receber
    const semData = await request(app)
      .post(`/api/v1/orcamentos/${orcamentoId}/aprovar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ vencimento: '2026-09-01' });

    assert.equal(semData.status, 200);
    assert.equal(semData.body.data.orcamento.status, 'aprovado');
    assert.equal(semData.body.data.agendamento, null);
    assert.equal(Number(semData.body.data.conta_receber.valor), 180);
    assert.equal(semData.body.data.conta_receber.status, 'pendente');

    // aprovar de novo deve falhar (já está aprovado)
    const segundaAprovacao = await request(app)
      .post(`/api/v1/orcamentos/${orcamentoId}/aprovar`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(segundaAprovacao.status, 409);
    assert.equal(segundaAprovacao.body.error.code, 'ALREADY_APPROVED');

    // registra o pagamento da conta que nasceu da aprovação
    const contaId = semData.body.data.conta_receber.id;
    const pagamento = await request(app)
      .post(`/api/v1/financeiro/contas-receber/${contaId}/pagar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metodo: 'pix' });
    assert.equal(pagamento.status, 200);
    assert.equal(pagamento.body.data.conta_receber.status, 'pago');

    // o resumo financeiro precisa refletir esse recebimento hoje
    const resumo = await request(app).get('/api/v1/financeiro/resumo').set('Authorization', `Bearer ${token}`);
    assert.equal(resumo.status, 200);
    assert.ok(Number(resumo.body.data.recebido_hoje) >= 180);
    assert.equal(Number(resumo.body.data.a_receber), 0);
  });

  test('aprovar com dataHora também cria o agendamento, e ele pode ser iniciado e concluído', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const cliente = await criarCliente(token);
    const servico = await criarServico(token, { nome: 'Instalação de ar-condicionado', precoPadrao: 450 });

    const orcamento = await request(app)
      .post('/api/v1/orcamentos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clienteId: cliente.id,
        itens: [{ servicoId: servico.id, descricao: 'Instalação de ar-condicionado', quantidade: 1, valorUnit: 450 }],
      });

    const aprovado = await request(app)
      .post(`/api/v1/orcamentos/${orcamento.body.data.id}/aprovar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dataHora: '2026-09-05T14:00:00Z', vencimento: '2026-09-12' });

    assert.equal(aprovado.status, 200);
    assert.ok(aprovado.body.data.agendamento, 'deveria ter criado um agendamento');
    assert.equal(aprovado.body.data.agendamento.status, 'agendado');

    const agendamentoId = aprovado.body.data.agendamento.id;

    const iniciado = await request(app)
      .post(`/api/v1/agenda/${agendamentoId}/iniciar`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(iniciado.status, 200);
    assert.equal(iniciado.body.data.status, 'em_andamento');

    const concluido = await request(app)
      .post(`/api/v1/agenda/${agendamentoId}/concluir`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(concluido.status, 200);
    assert.equal(concluido.body.data.status, 'concluido');

    // não pode "iniciar" algo que já foi concluído
    const transicaoInvalida = await request(app)
      .post(`/api/v1/agenda/${agendamentoId}/iniciar`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(transicaoInvalida.status, 409);
    assert.equal(transicaoInvalida.body.error.code, 'INVALID_TRANSITION');
  });
});

after(async () => {
  await pool.end();
});
