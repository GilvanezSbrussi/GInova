const express = require('express');
const { withTenant } = require('../common/db');
const { marcarContasVencidas } = require('../common/vencimentos');
const { requireAuth } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/dashboard — tudo que a tela "Início" precisa numa chamada só.
router.get('/', async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      await marcarContasVencidas(client);

      const [
        recebidoHoje, aReceber, cobrancasVencidas, servicosHoje,
        orcamentosAguardando, faturamentoHoje, faturamentoMedio30d, produtosEstoqueBaixo,
      ] = await Promise.all([
        client.query(`
          select coalesce(sum(valor),0) as total from pagamentos
           where conta_receber_id is not null and pago_em::date = current_date and deleted_at is null`),
        client.query(`
          select coalesce(sum(valor),0) as total from contas_receber
           where status in ('pendente','vencido') and deleted_at is null`),
        client.query(`
          select cr.id, cr.valor, cr.vencimento, (current_date - cr.vencimento) as dias_atraso,
                 c.id as cliente_id, c.nome as cliente_nome
            from contas_receber cr join clientes c on c.id = cr.cliente_id
           where cr.status = 'vencido' and cr.deleted_at is null
           order by cr.vencimento asc`),
        client.query(`
          select a.id, a.titulo, a.data_hora, a.status, c.nome as cliente_nome
            from agendamentos a join clientes c on c.id = a.cliente_id
           where a.data_hora::date = current_date and a.status <> 'cancelado' and a.deleted_at is null
           order by a.data_hora asc`),
        client.query(`
          select o.id, o.numero, o.valor_total, o.enviado_em, c.nome as cliente_nome,
                 extract(day from now() - o.enviado_em)::int as dias_aguardando
            from orcamentos o join clientes c on c.id = o.cliente_id
           where o.status in ('enviado','visualizado','aguardando_resposta') and o.deleted_at is null
           order by o.enviado_em asc`),
        client.query(`
          select coalesce(sum(valor_total),0) as total from orcamentos
           where status = 'aprovado' and created_at::date = current_date and deleted_at is null`),
        client.query(`
          select coalesce(avg(diario.total), 0) as media from (
            select created_at::date as dia, sum(valor_total) as total
              from orcamentos
             where status = 'aprovado'
               and created_at >= current_date - interval '30 days'
               and created_at < current_date
               and deleted_at is null
             group by created_at::date
          ) diario`),
        client.query(`
          select id, nome, estoque_atual, estoque_minimo from produtos
           where estoque_atual <= estoque_minimo and ativo = true and deleted_at is null
           order by nome asc`),
      ]);

      const alertas = [];

      for (const p of produtosEstoqueBaixo.rows) {
        alertas.push({
          tipo: 'estoque_baixo',
          severidade: 'media',
          mensagem: `${p.nome} está com estoque baixo (${p.estoque_atual} restantes, mínimo é ${p.estoque_minimo}).`,
          meta: { produto_id: p.id, estoque_atual: p.estoque_atual, estoque_minimo: p.estoque_minimo },
        });
      }

      for (const c of cobrancasVencidas.rows) {
        alertas.push({
          tipo: 'cobranca_vencida',
          severidade: 'alta',
          mensagem: `${c.cliente_nome} possui uma cobrança vencida de R$ ${Number(c.valor).toFixed(2)}.`,
          meta: { dias_atraso: c.dias_atraso, cliente_id: c.cliente_id, conta_receber_id: c.id },
        });
      }

      for (const o of orcamentosAguardando.rows) {
        if (o.dias_aguardando >= 2) {
          alertas.push({
            tipo: 'orcamento_sem_resposta',
            severidade: 'media',
            mensagem: `${o.cliente_nome} ainda não respondeu ao orçamento #${o.numero}.`,
            meta: { dias_aguardando: o.dias_aguardando, orcamento_id: o.id },
          });
        }
      }

      const media = Number(faturamentoMedio30d.rows[0].media);
      const hoje = Number(faturamentoHoje.rows[0].total);
      if (media > 0) {
        const variacaoPct = Math.round(((hoje - media) / media) * 100);
        if (Math.abs(variacaoPct) >= 10) {
          alertas.push({
            tipo: variacaoPct >= 0 ? 'faturamento_acima_media' : 'faturamento_abaixo_media',
            severidade: variacaoPct >= 0 ? 'boa_noticia' : 'media',
            mensagem: `Hoje seu faturamento está ${Math.abs(variacaoPct)}% ${variacaoPct >= 0 ? 'acima' : 'abaixo'} da média dos últimos 30 dias.`,
            meta: { variacao_pct: variacaoPct },
          });
        }
      }

      return {
        resumo: {
          recebido_hoje: Number(recebidoHoje.rows[0].total),
          a_receber: Number(aReceber.rows[0].total),
          vencido: cobrancasVencidas.rows.reduce((s, c) => s + Number(c.valor), 0),
          servicos_hoje: servicosHoje.rows.length,
          cobrancas_pendentes: cobrancasVencidas.rows.length,
        },
        agenda_hoje: servicosHoje.rows,
        alertas,
      };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
