const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const crypto = require('crypto');
const { pool } = require('../common/db');
const { ApiError } = require('../common/apiError');

const router = express.Router();

function issueTokens(usuario, vinculo) {
  const claims = {
    sub: usuario.id,
    empresaId: vinculo.empresa_id,
    perfil: vinculo.perfil,
    permissoes: vinculo.permissoes,
  };
  const accessToken = jwt.sign(claims, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ sub: usuario.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
}

// POST /api/v1/auth/registrar
// Cria a empresa + o primeiro usuário (EMPRESA_ADMIN) — fluxo de "primeiro acesso" (seção 52).
const registrarSchema = z.object({
  nomeEmpresa: z.string().min(2),
  segmento: z.string().optional(),
  nomeUsuario: z.string().min(2),
  email: z.string().email(),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.'),
});

router.post('/registrar', async (req, res, next) => {
  const parsed = registrarSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const { nomeEmpresa, segmento, nomeUsuario, email, senha } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existente = await client.query('select id from usuarios where email = $1 and deleted_at is null', [email]);
    if (existente.rowCount > 0) {
      throw new ApiError(409, 'EMAIL_EM_USO', 'Já existe uma conta com este e-mail.');
    }

    const senhaHash = await bcrypt.hash(senha, 12);

    const empresa = await client.query(
      `insert into empresas (razao_social, nome_fantasia, cpf_cnpj, segmento)
       values ($1, $1, $2, $3) returning id`,
      [nomeEmpresa, `PENDENTE-${crypto.randomUUID()}`, segmento || null]
    );

    const usuario = await client.query(
      `insert into usuarios (nome, email, senha_hash) values ($1, $2, $3) returning id, nome, email`,
      [nomeUsuario, email, senhaHash]
    );

    const permissoesAdmin = [
      'cliente.visualizar', 'cliente.criar', 'cliente.editar', 'cliente.excluir',
      'servico.criar', 'servico.editar', 'servico.excluir',
      'financeiro.visualizar', 'financeiro.criar', 'financeiro.editar', 'financeiro.excluir',
      'orcamento.criar', 'orcamento.aprovar',
      'agenda.gerenciar',
    ];

    const vinculo = await client.query(
      `insert into usuarios_empresas (empresa_id, usuario_id, perfil, permissoes)
       values ($1, $2, 'EMPRESA_ADMIN', $3) returning empresa_id, perfil, permissoes`,
      [empresa.rows[0].id, usuario.rows[0].id, JSON.stringify(permissoesAdmin)]
    );

    await client.query('COMMIT');

    const tokens = issueTokens(usuario.rows[0], vinculo.rows[0]);
    return res.status(201).json({ success: true, data: { usuario: usuario.rows[0], ...tokens } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/auth/login
const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

router.post('/login', async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', 'E-mail e senha são obrigatórios.'));
  }
  const { email, senha } = parsed.data;

  try {
    const { rows } = await pool.query(
      `select u.id, u.nome, u.email, u.senha_hash,
              ue.empresa_id, ue.perfil, ue.permissoes
         from usuarios u
         join usuarios_empresas ue on ue.usuario_id = u.id and ue.status = 'ativo'
        where u.email = $1 and u.deleted_at is null
        limit 1`,
      [email]
    );

    if (rows.length === 0) {
      throw new ApiError(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.');
    }

    const usuario = rows[0];
    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) {
      throw new ApiError(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.');
    }

    const tokens = issueTokens(usuario, usuario);
    await pool.query('update usuarios set ultimo_login_at = now() where id = $1', [usuario.id]);

    return res.json({
      success: true,
      data: {
        usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
        ...tokens,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
