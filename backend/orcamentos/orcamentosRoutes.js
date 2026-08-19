const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const itemSchema = z.object({
  servicoId: z.string().uuid().optional(),
  descricao: z.string().min(1),
  quantidade: z.number().positive().default(1),
  valorUnit: z.number().nonnegative(),
});

const criarOrcamentoSchema = z.object({
  clienteId: z.string().uuid(),
  origem: z.enum(['manual', 'whatsapp_ia']).default('manual'),
  observacoes: z.string().optional(),
  itens: z.array(itemSchema).min(1, 'O orçamento precisa de pelo menos um item.'),
});

// GET /api/v1/orcamentos?status=aguardando_resposta — lista (usada na tela kanban)
router.get('/', async (req, res, next) => {
  const statusFiltro = req.query.status;
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select o.id, o.numero, o.status, o.valor_total, o.origem, o.enviado_em, o.created_at,
                c.id as cliente_id, c.nome as cliente_nome
           from orcamentos o
           join clientes c on c.id = o.cliente_id
          where o.deleted_at is null
            and ($1::text is null or o.status = $1)
          order by o.created_at desc`,
        [statusFiltro || null]
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/orcamentos/:id — detalhe com itens
router.get('/:id', async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const orc = await client.query(
        `select o.*, c.nome as cliente_nome, c.whatsapp as cliente_whatsapp
           from orcamentos o join clientes c on c.id = o.cliente_id
          where o.id = $1 and o.deleted_at is null`,
        [req.params.id]
      );
      if (orc.rowCount === 0) throw new ApiError(404, 'BUDGET_NOT_FOUND', 'Orçamento não encontrado.');

      const itens = await client.query(
        `select * from orcamento_itens where orcamento_id = $1 and deleted_at is null order by created_at asc`,
        [req.params.id]
      );
      return { ...orc.rows[0], itens: itens.rows };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/orcamentos — cria orçamento + itens numa única transação
router.post('/', requirePermission('orcamento.criar'), async (req, res, next) => {
  const parsed = criarOrcamentoSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const { clienteId, origem, observacoes, itens } = parsed.data;
  const valorTotal = itens.reduce((sum, it) => sum + it.quantidade * it.valorUnit, 0);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const clienteExiste = await client.query('select id from clientes where id = $1 and deleted_at is null', [clienteId]);
      if (clienteExiste.rowCount === 0) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');

      const orc = await client.query(
        `insert into orcamentos (empresa_id, cliente_id, origem, observacoes, valor_total, created_by)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [req.auth.empresaId, clienteId, origem, observacoes || null, valorTotal, req.auth.usuarioId]
      );

      for (const it of itens) {
        await client.query(
          `insert into orcamento_itens (empresa_id, orcamento_id, servico_id, descricao, quantidade, valor_unit)
           values ($1,$2,$3,$4,$5,$6)`,
          [req.auth.empresaId, orc.rows[0].id, it.servicoId || null, it.descricao, it.quantidade, it.valorUnit]
        );
      }

      return orc.rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// Transições de status simples (seção 14: enviado, recusado, cancelado)
async function transicionar(req, res, next, novoStatus, extraSet = '') {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update orcamentos set status = $1, updated_by = $2 ${extraSet}
          where id = $3 and deleted_at is null returning *`,
        [novoStatus, req.auth.usuarioId, req.params.id]
      );
      if (rows.length === 0) throw new ApiError(404, 'BUDGET_NOT_FOUND', 'Orçamento não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

router.post('/:id/enviar', requirePermission('orcamento.criar'), (req, res, next) =>
  transicionar(req, res, next, 'enviado', ', enviado_em = now()')
);
router.post('/:id/recusar', requirePermission('orcamento.aprovar'), (req, res, next) =>
  transicionar(req, res, next, 'recusado', ', respondido_em = now()')
);
router.post('/:id/cancelar', requirePermission('orcamento.aprovar'), (req, res, next) =>
  transicionar(req, res, next, 'cancelado')
);

// POST /api/v1/orcamentos/:id/aprovar
// O ponto mais importante do fluxo (seção 55): ao aprovar, o sistema cria
// automaticamente o compromisso na agenda e a conta a receber — sem que o
// usuário precise lançar tudo de novo à mão.
const aprovarSchema = z.object({
  dataHora: z.string().datetime().optional(),   // se informado, cria o agendamento
  duracaoMin: z.number().int().positive().optional(),
  endereco: z.record(z.any()).optional(),
  vencimento: z.string().date().optional(),      // default: hoje + 7 dias
});

router.post('/:id/aprovar', requirePermission('orcamento.aprovar'), async (req, res, next) => {
  const parsed = aprovarSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const { dataHora, duracaoMin, endereco, vencimento } = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const orc = await client.query(
        `select * from orcamentos where id = $1 and deleted_at is null`,
        [req.params.id]
      );
      if (orc.rowCount === 0) throw new ApiError(404, 'BUDGET_NOT_FOUND', 'Orçamento não encontrado.');
      if (orc.rows[0].status === 'aprovado') {
        throw new ApiError(409, 'ALREADY_APPROVED', 'Este orçamento já foi aprovado.');
      }

      const atualizado = await client.query(
        `update orcamentos set status = 'aprovado', respondido_em = now(), updated_by = $1
          where id = $2 returning *`,
        [req.auth.usuarioId, req.params.id]
      );

      let agendamento = null;
      if (dataHora) {
        const itens = await client.query(
          `select descricao, servico_id from orcamento_itens where orcamento_id = $1 and deleted_at is null limit 1`,
          [req.params.id]
        );
        const titulo = itens.rows[0]?.descricao || 'Serviço agendado a partir de orçamento';
        const ag = await client.query(
          `insert into agendamentos (empresa_id, cliente_id, servico_id, orcamento_id, titulo, data_hora, duracao_min, endereco, valor, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
          [req.auth.empresaId, atualizado.rows[0].cliente_id, itens.rows[0]?.servico_id || null,
           req.params.id, titulo, dataHora, duracaoMin || null,
           endereco ? JSON.stringify(endereco) : null, atualizado.rows[0].valor_total, req.auth.usuarioId]
        );
        agendamento = ag.rows[0];
      }

      const dataVencimento = vencimento || null;
      const conta = await client.query(
        `insert into contas_receber (empresa_id, cliente_id, orcamento_id, agendamento_id, descricao, valor, vencimento, created_by)
         values ($1,$2,$3,$4,$5,$6, coalesce($7::date, current_date + interval '7 days'), $8)
         returning *`,
        [req.auth.empresaId, atualizado.rows[0].cliente_id, req.params.id, agendamento?.id || null,
         'Orçamento aprovado #' + atualizado.rows[0].numero, atualizado.rows[0].valor_total,
         dataVencimento, req.auth.usuarioId]
      );

      return { orcamento: atualizado.rows[0], agendamento, conta_receber: conta.rows[0] };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
