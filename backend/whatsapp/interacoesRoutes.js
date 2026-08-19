const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/whatsapp/interacoes?status=pendente — "novos pedidos identificados" do dashboard
router.get('/interacoes', requirePermission('ia.executar'), async (req, res, next) => {
  const statusFiltro = req.query.status || 'pendente';
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `select ii.*, wm.conteudo as mensagem_texto, c.whatsapp_contato_id,
                wc.telefone, wc.nome_perfil, wc.cliente_id
           from ia_interacoes ii
           join whatsapp_mensagens wm on wm.id = ii.mensagem_id
           join conversas c on c.id = wm.conversa_id
           join whatsapp_contatos wc on wc.id = c.whatsapp_contato_id
          where ii.deleted_at is null and ii.status = $1
          order by ii.created_at desc`,
        [statusFiltro]
      );
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/whatsapp/interacoes/:id/rejeitar
router.post('/interacoes/:id/rejeitar', requirePermission('ia.executar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update ia_interacoes set status = 'rejeitada', updated_by = $1
          where id = $2 and status = 'pendente' and deleted_at is null returning *`,
        [req.auth.usuarioId, req.params.id]
      );
      if (rows.length === 0) throw new ApiError(404, 'INTERACTION_NOT_FOUND', 'Sugestão não encontrada ou já resolvida.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/v1/whatsapp/interacoes/:id/confirmar
//
// Este é o único lugar onde uma sugestão da IA vira algo real no sistema.
// Sempre exige um usuário humano autenticado com a permissão ia.executar,
// e sempre passa pelas MESMAS validações que os endpoints normais usam
// (nunca um INSERT direto a partir de dado da IA sem checagem — seção 29).
// -----------------------------------------------------------------------
const confirmarOrcamentoSchema = z.object({
  clienteId: z.string().uuid(),   // humano confirma/escolhe o cliente certo
  servicoId: z.string().uuid().optional(),
  descricao: z.string().min(1),
  quantidade: z.number().positive().default(1),
  valorUnit: z.number().nonnegative(),
});

const confirmarPagamentoSchema = z.object({
  clienteId: z.string().uuid(),
  valor: z.number().positive(),
  metodo: z.enum(['pix', 'dinheiro', 'cartao', 'transferencia', 'outro']),
  descricao: z.string().optional(),
});

router.post('/interacoes/:id/confirmar', requirePermission('ia.executar'), async (req, res, next) => {
  try {
    const resultado = await withTenant(req.auth.empresaId, async (client) => {
      const interacao = await client.query(
        `select * from ia_interacoes where id = $1 and deleted_at is null`,
        [req.params.id]
      );
      if (interacao.rowCount === 0) throw new ApiError(404, 'INTERACTION_NOT_FOUND', 'Sugestão não encontrada.');
      if (interacao.rows[0].status !== 'pendente') {
        throw new ApiError(409, 'ALREADY_RESOLVED', 'Esta sugestão já foi confirmada ou rejeitada.');
      }

      let acaoResultado;

      if (interacao.rows[0].intent === 'orcamento') {
        const parsed = confirmarOrcamentoSchema.safeParse(req.body);
        if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message);
        const p = parsed.data;

        const cliente = await client.query('select id from clientes where id = $1 and deleted_at is null', [p.clienteId]);
        if (cliente.rowCount === 0) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');

        const valorTotal = p.quantidade * p.valorUnit;
        const orcamento = await client.query(
          `insert into orcamentos (empresa_id, cliente_id, origem, valor_total, created_by)
           values ($1,$2,'whatsapp_ia',$3,$4) returning *`,
          [req.auth.empresaId, p.clienteId, valorTotal, req.auth.usuarioId]
        );
        await client.query(
          `insert into orcamento_itens (empresa_id, orcamento_id, servico_id, descricao, quantidade, valor_unit)
           values ($1,$2,$3,$4,$5,$6)`,
          [req.auth.empresaId, orcamento.rows[0].id, p.servicoId || null, p.descricao, p.quantidade, p.valorUnit]
        );
        acaoResultado = { tipo: 'orcamento_criado', orcamento: orcamento.rows[0] };
      } else if (interacao.rows[0].intent === 'registrar_pagamento') {
        const parsed = confirmarPagamentoSchema.safeParse(req.body);
        if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message);
        const p = parsed.data;

        const cliente = await client.query('select id from clientes where id = $1 and deleted_at is null', [p.clienteId]);
        if (cliente.rowCount === 0) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.');

        const conta = await client.query(
          `insert into contas_receber (empresa_id, cliente_id, descricao, valor, vencimento, status, pago_em, created_by)
           values ($1,$2,$3,$4, current_date, 'pago', now(), $5) returning *`,
          [req.auth.empresaId, p.clienteId, p.descricao || 'Recebimento via WhatsApp', p.valor, req.auth.usuarioId]
        );
        const pagamento = await client.query(
          `insert into pagamentos (empresa_id, conta_receber_id, valor, metodo, created_by)
           values ($1,$2,$3,$4,$5) returning *`,
          [req.auth.empresaId, conta.rows[0].id, p.valor, p.metodo, req.auth.usuarioId]
        );
        acaoResultado = { tipo: 'pagamento_registrado', conta_receber: conta.rows[0], pagamento: pagamento.rows[0] };
      } else {
        throw new ApiError(
          422, 'INTENT_NAO_CONFIRMAVEL',
          `A intenção "${interacao.rows[0].intent}" ainda não tem uma ação automática de confirmação implementada.`
        );
      }

      await client.query(
        `insert into ia_acoes (empresa_id, ia_interacao_id, tipo_acao, payload, executada_por, resultado, executada_em)
         values ($1,$2,$3,$4,$5,$6, now())`,
        [req.auth.empresaId, interacao.rows[0].id, acaoResultado.tipo, JSON.stringify(req.body), req.auth.usuarioId, JSON.stringify(acaoResultado)]
      );
      const atualizada = await client.query(
        `update ia_interacoes set status = 'executada', updated_by = $1 where id = $2 returning *`,
        [req.auth.usuarioId, req.params.id]
      );

      return { interacao: atualizada.rows[0], acao: acaoResultado };
    });
    return res.json({ success: true, data: resultado });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
