const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, registrarEmpresaDeTeste } = require('./helpers');
const { pool } = require('../common/db');

async function criarProduto(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/produtos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      nome: overrides.nome || 'Disjuntor 20A',
      estoqueInicial: overrides.estoqueInicial ?? 10,
      estoqueMinimo: overrides.estoqueMinimo ?? 5,
      custo: overrides.custo ?? 12,
      preco: overrides.preco ?? 25,
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`Falha ao criar produto: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

describe('Fornecedores — CRUD básico', () => {
  test('cria, lista e edita um fornecedor', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const criado = await request(app)
      .post('/api/v1/fornecedores')
      .set('Authorization', `Bearer ${token}`)
      .send({ nome: 'Elétrica Distribuidora LTDA', whatsapp: '11988887777' });
    assert.equal(criado.status, 201);

    const lista = await request(app).get('/api/v1/fornecedores').set('Authorization', `Bearer ${token}`);
    assert.ok(lista.body.data.some((f) => f.id === criado.body.data.id));

    const editado = await request(app)
      .patch(`/api/v1/fornecedores/${criado.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ observacoes: 'Entrega em 2 dias úteis' });
    assert.equal(editado.status, 200);
    assert.equal(editado.body.data.observacoes, 'Entrega em 2 dias úteis');
  });
});

describe('Produtos — cadastro e estoque inicial', () => {
  test('criar produto com estoque inicial já gera um movimento de entrada', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { nome: 'Fio 2.5mm', estoqueInicial: 50, estoqueMinimo: 10 });
    assert.equal(produto.estoque_atual, 50);

    const detalhe = await request(app).get(`/api/v1/produtos/${produto.id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(detalhe.body.data.movimentos.length, 1);
    assert.equal(detalhe.body.data.movimentos[0].tipo, 'entrada');
    assert.equal(detalhe.body.data.movimentos[0].quantidade, 50);
  });

  test('produto com código duplicado é rejeitado', async () => {
    const { token } = await registrarEmpresaDeTeste();
    await request(app).post('/api/v1/produtos').set('Authorization', `Bearer ${token}`)
      .send({ nome: 'Conector A', codigo: 'CN-01', estoqueInicial: 5, estoqueMinimo: 1 });
    const duplicado = await request(app).post('/api/v1/produtos').set('Authorization', `Bearer ${token}`)
      .send({ nome: 'Conector B', codigo: 'CN-01', estoqueInicial: 5, estoqueMinimo: 1 });
    assert.equal(duplicado.status, 409);
    assert.equal(duplicado.body.error.code, 'CODIGO_EM_USO');
  });

  test('lista de produtos marca estoque_baixo corretamente', async () => {
    const { token } = await registrarEmpresaDeTeste();
    await criarProduto(token, { nome: 'Item Baixo', estoqueInicial: 3, estoqueMinimo: 5 });
    await criarProduto(token, { nome: 'Item OK', estoqueInicial: 20, estoqueMinimo: 5 });

    const lista = await request(app).get('/api/v1/produtos').set('Authorization', `Bearer ${token}`);
    const baixo = lista.body.data.find((p) => p.nome === 'Item Baixo');
    const ok = lista.body.data.find((p) => p.nome === 'Item OK');
    assert.equal(baixo.estoque_baixo, true);
    assert.equal(ok.estoque_baixo, false);
  });
});

describe('Movimentação de estoque (seção 21)', () => {
  test('uma saída reduz o saldo e fica registrada no histórico', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { estoqueInicial: 12, estoqueMinimo: 5 });

    const res = await request(app)
      .post(`/api/v1/produtos/${produto.id}/movimentar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'saida', quantidade: 3, motivo: 'venda' });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.estoque_anterior, 12);
    assert.equal(res.body.data.estoque_atual, 9);
    assert.equal(res.body.data.estoque_baixo, false);
  });

  test('saída que levaria o saldo abaixo do mínimo gera estoque_baixo: true', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { estoqueInicial: 12, estoqueMinimo: 10 });

    const res = await request(app)
      .post(`/api/v1/produtos/${produto.id}/movimentar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'saida', quantidade: 5, motivo: 'venda' });

    assert.equal(res.body.data.estoque_atual, 7);
    assert.equal(res.body.data.estoque_baixo, true);
  });

  test('NUNCA deixa o saldo ficar negativo — regra mais importante do módulo', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { estoqueInicial: 5, estoqueMinimo: 1 });

    const res = await request(app)
      .post(`/api/v1/produtos/${produto.id}/movimentar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'saida', quantidade: 999 });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ESTOQUE_INSUFICIENTE');

    // confirma que o saldo realmente não mudou
    const detalhe = await request(app).get(`/api/v1/produtos/${produto.id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(detalhe.body.data.estoque_atual, 5);
  });

  test('20 saídas concorrentes de 1 unidade num estoque de 15 nunca deixam o saldo negativo', async () => {
    // este é o teste que valida o "for update" (lock de linha) do endpoint:
    // sem ele, requisições concorrentes poderiam ler o mesmo saldo e
    // gravar valores incorretos (race condition clássica de estoque).
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { estoqueInicial: 15, estoqueMinimo: 0 });

    const promessas = Array.from({ length: 20 }, () =>
      request(app)
        .post(`/api/v1/produtos/${produto.id}/movimentar`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tipo: 'saida', quantidade: 1 })
    );
    const resultados = await Promise.all(promessas);
    const sucesso = resultados.filter((r) => r.status === 200).length;
    const falha = resultados.filter((r) => r.status === 409).length;

    assert.equal(sucesso, 15, 'só 15 das 20 saídas deveriam ter sucesso (é tudo que existia em estoque)');
    assert.equal(falha, 5);

    const detalhe = await request(app).get(`/api/v1/produtos/${produto.id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(detalhe.body.data.estoque_atual, 0, 'o saldo final tem que ser exatamente 0, nunca negativo');
  });

  test('entrada aumenta o saldo normalmente', async () => {
    const { token } = await registrarEmpresaDeTeste();
    const produto = await criarProduto(token, { estoqueInicial: 5, estoqueMinimo: 1 });

    const res = await request(app)
      .post(`/api/v1/produtos/${produto.id}/movimentar`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'entrada', quantidade: 20, motivo: 'compra' });

    assert.equal(res.body.data.estoque_atual, 25);
  });
});

describe('Isolamento multi-tenant (estoque)', () => {
  test('empresa B não vê produtos da empresa A', async () => {
    const empresaA = await registrarEmpresaDeTeste();
    const empresaB = await registrarEmpresaDeTeste();
    await criarProduto(empresaA.token, { nome: 'Produto Exclusivo A' });

    const listaB = await request(app).get('/api/v1/produtos').set('Authorization', `Bearer ${empresaB.token}`);
    assert.ok(!listaB.body.data.some((p) => p.nome === 'Produto Exclusivo A'));
  });
});

describe('Dashboard — alerta de estoque baixo (seção 94)', () => {
  test('produto abaixo do mínimo aparece como alerta no dashboard', async () => {
    const { token } = await registrarEmpresaDeTeste();
    await criarProduto(token, { nome: 'Fita Isolante', estoqueInicial: 2, estoqueMinimo: 10 });

    const dashboard = await request(app).get('/api/v1/dashboard').set('Authorization', `Bearer ${token}`);
    const alerta = dashboard.body.data.alertas.find((a) => a.tipo === 'estoque_baixo');
    assert.ok(alerta, 'deveria ter gerado um alerta de estoque baixo');
    assert.match(alerta.mensagem, /Fita Isolante/);
  });
});

after(async () => {
  await pool.end();
});
