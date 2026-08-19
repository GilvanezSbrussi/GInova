require('./testEnv');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../app');

/**
 * Cada teste registra sua própria empresa com e-mail único. Isso evita ter
 * que truncar tabelas entre testes e, de brinde, testa isolamento
 * multi-tenant de verdade: empresas de testes diferentes nunca deveriam
 * enxergar dados umas das outras.
 */
async function registrarEmpresaDeTeste(overrides = {}) {
  const sufixo = crypto.randomUUID().slice(0, 8);
  const payload = {
    nomeEmpresa: overrides.nomeEmpresa || `Empresa Teste ${sufixo}`,
    segmento: overrides.segmento || 'eletricista',
    nomeUsuario: overrides.nomeUsuario || 'Usuário Teste',
    email: overrides.email || `teste-${sufixo}@exemplo.com`,
    senha: overrides.senha || 'senha12345',
  };

  const res = await request(app).post('/api/v1/auth/registrar').send(payload);
  if (res.status !== 201) {
    throw new Error(`Falha ao registrar empresa de teste: ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.data.accessToken,
    usuarioId: res.body.data.usuario.id,
    email: payload.email,
    senha: payload.senha,
  };
}

async function criarCliente(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/clientes')
    .set('Authorization', `Bearer ${token}`)
    .send({ nome: overrides.nome || 'Cliente Teste', whatsapp: overrides.whatsapp || '11999990000' });
  if (res.status !== 201) {
    throw new Error(`Falha ao criar cliente de teste: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

async function criarServico(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/servicos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      nome: overrides.nome || 'Serviço Teste',
      precoPadrao: overrides.precoPadrao ?? 100,
      custo: overrides.custo ?? 30,
    });
  if (res.status !== 201) {
    throw new Error(`Falha ao criar serviço de teste: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

module.exports = { app, request, registrarEmpresaDeTeste, criarCliente, criarServico };
