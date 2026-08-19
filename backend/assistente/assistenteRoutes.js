const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { marcarContasVencidas } = require('../common/vencimentos');
const { ApiError } = require('../common/apiError');
const { requireAuth } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

async function quantoTenhoParaReceber(client) {
  const { rows } = await client.query(`
    select coalesce(sum(valor),0) as total,
           coalesce(sum(valor) filter (where status = 'vencido'),0) as vencido
      from contas_receber where status in ('pendente','vencido') and deleted_at is null`);
  const total = Number(rows[0].total);
  const vencido = Number(rows[0].vencido);
  const texto = vencido > 0
    ? `Você tem R$ ${total.toFixed(2)} para receber, sendo R$ ${vencido.toFixed(2)} já vencidos.`
    : `Você tem R$ ${total.toFixed(2)} para receber.`;
  return { texto, dados: { total, vencido } };
}

async function quemEstaAtrasado(client) {
  const { rows } = await client.query(`
    select c.nome, cr.valor, cr.vencimento, (current_date - cr.vencimento) as dias_atraso
      from contas_receber cr join clientes c on c.id = cr.cliente_id
     where cr.status = 'vencido' and cr.deleted_at is null
     order by cr.vencimento asc`);
  if (rows.length === 0) return { texto: 'Ninguém está atrasado no momento. 🎉', dados: { clientes: [] } };
  const nomes = rows.map((r) => `${r.nome} (R$ ${Number(r.valor).toFixed(2)}, ${r.dias_atraso} dias)`).join('; ');
  const texto = `${rows.length} cliente${rows.length > 1 ? 's estão' : ' está'} atrasado${rows.length > 1 ? 's' : ''}: ${nomes}.`;
  return { texto, dados: { clientes: rows } };
}

async function quantoVendiEsseMes(client) {
  const { rows } = await client.query(`
    select coalesce(sum(valor_total),0) as total from orcamentos
     where status = 'aprovado' and created_at >= date_trunc('month', current_date) and deleted_at is null`);
  const total = Number(rows[0].total);
  return { texto: `Você vendeu R$ ${total.toFixed(2)} em serviços aprovados este mês.`, dados: { total } };
}

async function qualServicoVendeMais(client) {
  const { rows } = await client.query(`
    select coalesce(s.nome, oi.descricao) as nome, count(*) as qtd
      from orcamento_itens oi
      join orcamentos o on o.id = oi.orcamento_id and o.status = 'aprovado'
      left join servicos s on s.id = oi.servico_id
     where oi.deleted_at is null
     group by coalesce(s.nome, oi.descricao)
     order by qtd desc
     limit 1`);
  if (rows.length === 0) return { texto: 'Ainda não há serviços aprovados suficientes pra saber isso.', dados: null };
  return { texto: `${rows[0].nome} é o serviço que mais vende, com ${rows[0].qtd} orçamentos aprovados.`, dados: rows[0] };
}

const PADROES = [
  { re: /quanto.*(receber|a receber)/i, fn: quantoTenhoParaReceber },
  { re: /quem.*atrasad/i, fn: quemEstaAtrasado },
  { re: /quanto.*vendi/i, fn: quantoVendiEsseMes },
  { re: /qual.*servi[çc]o.*(vende|mais)/i, fn: qualServicoVendeMais },
];

const perguntaSchema = z.object({ pergunta: z.string().min(2) });

// POST /api/v1/assistente/perguntar
router.post('/perguntar', async (req, res, next) => {
  const parsed = perguntaSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));

  const padrao = PADROES.find((p) => p.re.test(parsed.data.pergunta));

  try {
    if (!padrao) {
      return res.json({
        success: true,
        data: {
          texto: 'Ainda não sei responder isso — mas já reconheço perguntas sobre "quanto tenho a receber", "quem está atrasado", "quanto vendi esse mês" e "qual serviço vende mais".',
          dados: null,
          reconhecida: false,
        },
      });
    }
    const resposta = await withTenant(req.auth.empresaId, async (client) => {
      await marcarContasVencidas(client);
      return padrao.fn(client);
    });
    return res.json({ success: true, data: { ...resposta, reconhecida: true } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
