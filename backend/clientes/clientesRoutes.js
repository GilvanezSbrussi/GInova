const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth); // nenhuma rota de cliente é acessível sem autenticação

const clienteSchema = z.object({
  nome: z.string().min(2),
  cpfCnpj: z.string().optional(),
  telefone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  observacoes: z.string().optional(),
  origem: z.string().optional(),
});

// GET /api/v1/clientes  — lista clientes da empresa autenticada, com saldo em aberto
router.get('/', requirePermission('cliente.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(`
        select c.id, c.nome, c.whatsapp, c.telefone,
               coalesce(sum(cr.valor) filter (where cr.status <> 'cancelado'), 0)         as total_comprado,
               coalesce(sum(cr.valor) filter (where cr.status in ('pendente','vencido')), 0) as em_aberto,
               max(a.data_hora) as ultimo_servico_em
          from clientes c
          left join contas_receber cr on cr.cliente_id = c.id and cr.deleted_at is null
          left join agendamentos a on a.cliente_id = c.id and a.status = 'concluido' and a.deleted_at is null
         where c.deleted_at is null
         group by c.id
         order by c.nome asc
      `);
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/clientes/:id — detalhe + histórico (seção 11)
router.get('/:id', requirePermission('cliente.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const cliente = await client.query('select * from clientes where id = $1 and deleted_at is null', [req.params.id]);
      if (cliente.rowCount === 0) {
        throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');
      }
      const servicos = await client.query(
        `select a.id, a.titulo, a.data_hora, a.valor, a.status
           from agendamentos a
          where a.cliente_id = $1 and a.deleted_at is null
          order by a.data_hora desc limit 20`,
        [req.params.id]
      );
      return { ...cliente.rows[0], historico_servicos: servicos.rows };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/clientes
router.post('/', requirePermission('cliente.criar'), async (req, res, next) => {
  const parsed = clienteSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const c = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `insert into clientes (empresa_id, nome, cpf_cnpj, telefone, whatsapp, email, observacoes, origem, primeiro_contato_em, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8, current_date, $9)
         returning *`,
        [req.auth.empresaId, c.nome, c.cpfCnpj || null, c.telefone || null, c.whatsapp || null,
         c.email || null, c.observacoes || null, c.origem || 'manual', req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/clientes/:id
router.patch('/:id', requirePermission('cliente.editar'), async (req, res, next) => {
  const parsed = clienteSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const fields = parsed.data;
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    const column = key === 'cpfCnpj' ? 'cpf_cnpj' : key;
    setClauses.push(`${column} = $${i++}`);
    values.push(value);
  }
  if (setClauses.length === 0) {
    return next(new ApiError(400, 'VALIDATION_ERROR', 'Nenhum campo para atualizar.'));
  }
  setClauses.push(`updated_by = $${i++}`);
  values.push(req.auth.usuarioId);
  values.push(req.params.id);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update clientes set ${setClauses.join(', ')} where id = $${i} and deleted_at is null returning *`,
        values
      );
      if (rows.length === 0) {
        throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');
      }
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/v1/clientes/:id — soft delete (nunca apagar de verdade, ver seção 32)
router.delete('/:id', requirePermission('cliente.excluir'), async (req, res, next) => {
  try {
    await withTenant(req.auth.empresaId, async (client) => {
      const { rowCount } = await client.query(
        `update clientes set deleted_at = now(), updated_by = $1 where id = $2 and deleted_at is null`,
        [req.auth.usuarioId, req.params.id]
      );
      if (rowCount === 0) {
        throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');
      }
    });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
