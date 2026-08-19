const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const fornecedorSchema = z.object({
  nome: z.string().min(2),
  telefone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  observacoes: z.string().optional(),
});

router.get('/', requirePermission('estoque.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select * from fornecedores where deleted_at is null order by nome asc`
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post('/', requirePermission('estoque.movimentar'), async (req, res, next) => {
  const parsed = fornecedorSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const f = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `insert into fornecedores (empresa_id, nome, telefone, whatsapp, email, observacoes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.auth.empresaId, f.nome, f.telefone || null, f.whatsapp || null, f.email || null, f.observacoes || null, req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', requirePermission('estoque.movimentar'), async (req, res, next) => {
  const parsed = fornecedorSchema.partial().safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) return next(new ApiError(400, 'VALIDATION_ERROR', 'Nenhum campo para atualizar.'));

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of entries) {
    setClauses.push(`${key} = $${i++}`);
    values.push(value);
  }
  setClauses.push(`updated_by = $${i++}`);
  values.push(req.auth.usuarioId);
  values.push(req.params.id);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update fornecedores set ${setClauses.join(', ')} where id = $${i} and deleted_at is null returning *`,
        values
      );
      if (rows.length === 0) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requirePermission('estoque.movimentar'), async (req, res, next) => {
  try {
    await withTenant(req.auth.empresaId, async (client) => {
      const { rowCount } = await client.query(
        `update fornecedores set deleted_at = now(), updated_by = $1 where id = $2 and deleted_at is null`,
        [req.auth.usuarioId, req.params.id]
      );
      if (rowCount === 0) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.');
    });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
