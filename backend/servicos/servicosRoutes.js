const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const servicoSchema = z.object({
  nome: z.string().min(2),
  descricao: z.string().optional(),
  categoria: z.string().optional(),
  precoPadrao: z.number().nonnegative(),
  custo: z.number().nonnegative().default(0),
  duracaoMin: z.number().int().positive().optional(),
  materiais: z.array(z.string()).optional(),
});

// GET /api/v1/servicos — catálogo (qualquer usuário autenticado da empresa pode ver)
router.get('/', async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select id, nome, descricao, categoria, preco_padrao, custo,
                (preco_padrao - custo) as lucro_estimado, duracao_min, materiais, ativo
           from servicos
          where deleted_at is null
          order by nome asc`
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/servicos
router.post('/', requirePermission('servico.criar'), async (req, res, next) => {
  const parsed = servicoSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const s = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `insert into servicos (empresa_id, nome, descricao, categoria, preco_padrao, custo, duracao_min, materiais, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning *`,
        [req.auth.empresaId, s.nome, s.descricao || null, s.categoria || null,
         s.precoPadrao, s.custo, s.duracaoMin || null,
         s.materiais ? JSON.stringify(s.materiais) : null, req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/servicos/:id
router.patch('/:id', requirePermission('servico.editar'), async (req, res, next) => {
  const parsed = servicoSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const map = { precoPadrao: 'preco_padrao', duracaoMin: 'duracao_min' };
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) {
    return next(new ApiError(400, 'VALIDATION_ERROR', 'Nenhum campo para atualizar.'));
  }
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of entries) {
    const column = map[key] || key;
    const v = key === 'materiais' ? JSON.stringify(value) : value;
    setClauses.push(`${column} = $${i++}`);
    values.push(v);
  }
  setClauses.push(`updated_by = $${i++}`);
  values.push(req.auth.usuarioId);
  values.push(req.params.id);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update servicos set ${setClauses.join(', ')} where id = $${i} and deleted_at is null returning *`,
        values
      );
      if (rows.length === 0) throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Serviço não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/v1/servicos/:id
router.delete('/:id', requirePermission('servico.excluir'), async (req, res, next) => {
  try {
    await withTenant(req.auth.empresaId, async (client) => {
      const { rowCount } = await client.query(
        `update servicos set deleted_at = now(), updated_by = $1 where id = $2 and deleted_at is null`,
        [req.auth.usuarioId, req.params.id]
      );
      if (rowCount === 0) throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Serviço não encontrado.');
    });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
