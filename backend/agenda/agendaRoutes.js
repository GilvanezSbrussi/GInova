const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const agendamentoSchema = z.object({
  clienteId: z.string().uuid(),
  servicoId: z.string().uuid().optional(),
  titulo: z.string().min(2),
  dataHora: z.string().datetime(),
  duracaoMin: z.number().int().positive().optional(),
  endereco: z.record(z.any()).optional(),
  valor: z.number().nonnegative().default(0),
});

// GET /api/v1/agenda?data=2026-08-18 — agenda do dia (default: hoje). seção 15.
router.get('/', async (req, res, next) => {
  const data = req.query.data; // 'YYYY-MM-DD'
  try {
    const rows = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select a.id, a.titulo, a.data_hora, a.duracao_min, a.status, a.valor, a.endereco,
                c.id as cliente_id, c.nome as cliente_nome, c.whatsapp as cliente_whatsapp
           from agendamentos a
           join clientes c on c.id = a.cliente_id
          where a.deleted_at is null
            and a.data_hora::date = coalesce($1::date, current_date)
          order by a.data_hora asc`,
        [data || null]
      );
      return rows;
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/agenda/:id
router.get('/:id', async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select a.*, c.nome as cliente_nome, c.whatsapp as cliente_whatsapp
           from agendamentos a join clientes c on c.id = a.cliente_id
          where a.id = $1 and a.deleted_at is null`,
        [req.params.id]
      );
      if (rows.length === 0) throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Compromisso não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/agenda — agendamento avulso (fora do fluxo de orçamento)
router.post('/', requirePermission('agenda.gerenciar'), async (req, res, next) => {
  const parsed = agendamentoSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const a = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const cliente = await client.query('select id from clientes where id = $1 and deleted_at is null', [a.clienteId]);
      if (cliente.rowCount === 0) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');

      const { rows } = await client.query(
        `insert into agendamentos (empresa_id, cliente_id, servico_id, titulo, data_hora, duracao_min, endereco, valor, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [req.auth.empresaId, a.clienteId, a.servicoId || null, a.titulo, a.dataHora,
         a.duracaoMin || null, a.endereco ? JSON.stringify(a.endereco) : null, a.valor, req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/agenda/:id — reagendar (nova data/hora, endereço etc.)
router.patch('/:id', requirePermission('agenda.gerenciar'), async (req, res, next) => {
  const parsed = agendamentoSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const map = { clienteId: 'cliente_id', servicoId: 'servico_id', dataHora: 'data_hora', duracaoMin: 'duracao_min' };
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) return next(new ApiError(400, 'VALIDATION_ERROR', 'Nenhum campo para atualizar.'));

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of entries) {
    const column = map[key] || key;
    const v = key === 'endereco' ? JSON.stringify(value) : value;
    setClauses.push(`${column} = $${i++}`);
    values.push(v);
  }
  setClauses.push(`updated_by = $${i++}`);
  values.push(req.auth.usuarioId);
  values.push(req.params.id);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update agendamentos set ${setClauses.join(', ')} where id = $${i} and deleted_at is null returning *`,
        values
      );
      if (rows.length === 0) throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Compromisso não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// Transições de status (seção 16: Agendado -> Em andamento -> Concluído / Cancelado)
async function mudarStatus(req, res, next, statusPermitidoDe, novoStatus) {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const atual = await client.query(
        'select status from agendamentos where id = $1 and deleted_at is null',
        [req.params.id]
      );
      if (atual.rowCount === 0) throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Compromisso não encontrado.');
      if (!statusPermitidoDe.includes(atual.rows[0].status)) {
        throw new ApiError(
          409, 'INVALID_TRANSITION',
          `Não é possível mudar de "${atual.rows[0].status}" para "${novoStatus}".`
        );
      }
      const { rows } = await client.query(
        `update agendamentos set status = $1, updated_by = $2 where id = $3 returning *`,
        [novoStatus, req.auth.usuarioId, req.params.id]
      );
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

router.post('/:id/iniciar', requirePermission('agenda.gerenciar'), (req, res, next) =>
  mudarStatus(req, res, next, ['agendado'], 'em_andamento')
);
router.post('/:id/concluir', requirePermission('agenda.gerenciar'), (req, res, next) =>
  mudarStatus(req, res, next, ['agendado', 'em_andamento'], 'concluido')
);
router.post('/:id/cancelar', requirePermission('agenda.gerenciar'), (req, res, next) =>
  mudarStatus(req, res, next, ['agendado', 'em_andamento'], 'cancelado')
);

module.exports = router;
