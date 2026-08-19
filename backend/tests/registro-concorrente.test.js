const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, request } = require('./helpers');
const { pool } = require('../common/db');

describe('Registro concorrente (regressão do bug de colisão em cpf_cnpj)', () => {
  test('20 registros disparados ao mesmo tempo não colidem', async () => {
    const promessas = Array.from({ length: 20 }, (_, i) =>
      request(app).post('/api/v1/auth/registrar').send({
        nomeEmpresa: `Empresa Concorrente ${i}`,
        nomeUsuario: `Usuário ${i}`,
        email: `concorrente-${Date.now()}-${i}-${Math.random()}@exemplo.com`,
        senha: 'senha12345',
      })
    );
    const resultados = await Promise.all(promessas);
    const falhas = resultados.filter((r) => r.status !== 201);
    assert.equal(falhas.length, 0, `esperava 20 sucessos, mas ${falhas.length} falharam: ${JSON.stringify(falhas.map((f) => f.body))}`);
  });
});

after(async () => {
  await pool.end();
});
