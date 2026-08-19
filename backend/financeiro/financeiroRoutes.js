const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { marcarContasVencidas } = require('../common/vencimentos');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// GET /api/v1/financeiro/resumo — alimenta o dashboard (seções 8 e 9)
// ---------------------------------------------------------------------
router.get('/resumo', requirePermission('financeiro.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      await marcarContasVencidas(client);

      const [recebidoHoje, aReceber, vencido, faturamentoMes, recebidoMes, cobrancasPendentes, servicosHoje] =
        await Promise.all([
          client.query(`
            select coalesce(sum(valor),0) as total from pagamentos
             where conta_receber_id is not null and pago_em::date = current_date and deleted_at is null`),
          client.query(`
            select coalesce(sum(valor),0) as total from contas_receber
             where status in ('pendente','vencido') and deleted_at is null`),
          client.query(`
            select coalesce(sum(valor),0) as total from contas_receber
             where status = 'vencido' and deleted_at is null`),
          client.query(`
            select coalesce(sum(valor_total),0) as total from orcamentos
             where status = 'aprovado' and created_at >= date_trunc('month', current_date) and deleted_at is null`),
          client.query(`
            select coalesce(sum(valor),0) as total from pagamentos
             where conta_receber_id is not null and pago_em >= date_trunc('month', current_date) and deleted_at is null`),
          client.query(`
            select count(*) as total from contas_receber
             where status in ('pendente','vencido') and deleted_at is null`),
          client.query(`
            select count(*) as total from agendamentos
             where data_hora::date = current_date and status <> 'cancelado' and deleted_at is null`),
        ]);

      return {
        recebido_hoje: Number(recebidoHoje.rows[0].total),
        a_receber: Number(aReceber.rows[0].total),
        vencido: Number(vencido.rows[0].total),
        faturamento_mes: Number(faturamentoMes.rows[0].total),
        recebido_mes: Number(recebidoMes.rows[0].total),
        cobrancas_pendentes: Number(cobrancasPendentes.rows[0].total),
        servicos_hoje: Number(servicosHoje.rows[0].total),
      };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------
// CONTAS A RECEBER
// ---------------------------------------------------------------------
const contaReceberSchema = z.object({
  clienteId: z.string().uuid(),
  descricao: z.string().min(2),
  valor: z.number().positive(),
  vencimento: z.string().date(),
});

router.get('/contas-receber', requirePermission('financeiro.visualizar'), async (req, res, next) => {
  const statusFiltro = req.query.status;
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select cr.*, c.nome as cliente_nome
           from contas_receber cr join clientes c on c.id = cr.cliente_id
          where cr.deleted_at is null
            and ($1::text is null or cr.status = $1)
          order by cr.vencimento asc`,
        [statusFiltro || null]
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post('/contas-receber', requirePermission('financeiro.criar'), async (req, res, next) => {
  const parsed = contaReceberSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const c = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `insert into contas_receber (empresa_id, cliente_id, descricao, valor, vencimento, created_by)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [req.auth.empresaId, c.clienteId, c.descricao, c.valor, c.vencimento, req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/financeiro/contas-receber/:id/pagar — baixa da conta (seção 57)
const pagarSchema = z.object({
  metodo: z.enum(['pix', 'dinheiro', 'cartao', 'transferencia', 'outro']),
  valor: z.number().positive().optional(), // default: valor total da conta
});

router.post('/contas-receber/:id/pagar', requirePermission('financeiro.editar'), async (req, res, next) => {
  const parsed = pagarSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const { metodo, valor } = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const conta = await client.query(
        `select * from contas_receber where id = $1 and deleted_at is null`, [req.params.id]
      );
      if (conta.rowCount === 0) throw new ApiError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.');
      if (conta.rows[0].status === 'pago') {
        throw new ApiError(409, 'ALREADY_PAID', 'Esta conta já está paga.');
      }

      const pagamento = await client.query(
        `insert into pagamentos (empresa_id, conta_receber_id, valor, metodo, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [req.auth.empresaId, req.params.id, valor || conta.rows[0].valor, metodo, req.auth.usuarioId]
      );

      const atualizada = await client.query(
        `update contas_receber set status = 'pago', pago_em = now(), updated_by = $1 where id = $2 returning *`,
        [req.auth.usuarioId, req.params.id]
      );

      return { conta_receber: atualizada.rows[0], pagamento: pagamento.rows[0] };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------
// CONTAS A PAGAR
// ---------------------------------------------------------------------
const contaPagarSchema = z.object({
  fornecedor: z.string().optional(),
  descricao: z.string().min(2),
  categoria: z.string().optional(),
  valor: z.number().positive(),
  vencimento: z.string().date(),
});

router.get('/contas-pagar', requirePermission('financeiro.visualizar'), async (req, res, next) => {
  const statusFiltro = req.query.status;
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select * from contas_pagar
          where deleted_at is null and ($1::text is null or status = $1)
          order by vencimento asc`,
        [statusFiltro || null]
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post('/contas-pagar', requirePermission('financeiro.criar'), async (req, res, next) => {
  const parsed = contaPagarSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const c = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `insert into contas_pagar (empresa_id, fornecedor, descricao, categoria, valor, vencimento, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.auth.empresaId, c.fornecedor || null, c.descricao, c.categoria || null, c.valor, c.vencimento, req.auth.usuarioId]
      );
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post('/contas-pagar/:id/pagar', requirePermission('financeiro.editar'), async (req, res, next) => {
  const parsed = pagarSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const { metodo, valor } = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const conta = await client.query(
        `select * from contas_pagar where id = $1 and deleted_at is null`, [req.params.id]
      );
      if (conta.rowCount === 0) throw new ApiError(404, 'PAYABLE_NOT_FOUND', 'Conta a pagar não encontrada.');
      if (conta.rows[0].status === 'pago') {
        throw new ApiError(409, 'ALREADY_PAID', 'Esta conta já está paga.');
      }

      const pagamento = await client.query(
        `insert into pagamentos (empresa_id, conta_pagar_id, valor, metodo, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [req.auth.empresaId, req.params.id, valor || conta.rows[0].valor, metodo, req.auth.usuarioId]
      );

      const atualizada = await client.query(
        `update contas_pagar set status = 'pago', pago_em = now(), updated_by = $1 where id = $2 returning *`,
        [req.auth.usuarioId, req.params.id]
      );

      return { conta_pagar: atualizada.rows[0], pagamento: pagamento.rows[0] };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
