const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { detectarIntencao } = require('../ia/intentEngine');

const router = express.Router();

/**
 * Validação de origem simplificada (seção 38: "validar origem"). Num
 * provedor real (Meta/WhatsApp Business API) isso seria a verificação de
 * assinatura HMAC do payload; aqui usamos um token compartilhado só pra
 * já deixar o ponto de extensão no lugar certo.
 */
function validarOrigem(req, res, next) {
  const esperado = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!esperado) return next(); // sem segredo configurado = modo dev, não bloqueia
  const recebido = req.headers['x-webhook-token'];
  if (recebido !== esperado) {
    return next(new ApiError(401, 'WEBHOOK_UNAUTHORIZED', 'Origem do webhook não confere.'));
  }
  return next();
}

// Payload simplificado. Num provedor real, o empresa_id seria resolvido a
// partir do "phone_number_id" da WhatsApp Business API (cada número
// conectado pertence a uma empresa) — fora do escopo deste protótipo.
const webhookSchema = z.object({
  empresaId: z.string().uuid(),
  telefone: z.string().min(8),
  nomePerfil: z.string().optional(),
  externalMessageId: z.string().min(1),
  texto: z.string().min(1),
});

// POST /api/v1/webhooks/whatsapp
router.post('/whatsapp', validarOrigem, async (req, res, next) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  }
  const { empresaId, telefone, nomePerfil, externalMessageId, texto } = parsed.data;

  try {
    const data = await withTenant(empresaId, async (client) => {
      // 1. encontra ou cria o contato do WhatsApp
      let contato = await client.query(
        `select * from whatsapp_contatos where telefone = $1 and deleted_at is null`,
        [telefone]
      );
      if (contato.rowCount === 0) {
        contato = await client.query(
          `insert into whatsapp_contatos (empresa_id, telefone, nome_perfil) values ($1,$2,$3) returning *`,
          [empresaId, telefone, nomePerfil || null]
        );
      }
      const contatoId = contato.rows[0].id;

      // 2. encontra a conversa aberta ou abre uma nova
      let conversa = await client.query(
        `select * from conversas where whatsapp_contato_id = $1 and status = 'aberta' and deleted_at is null
         order by created_at desc limit 1`,
        [contatoId]
      );
      if (conversa.rowCount === 0) {
        conversa = await client.query(
          `insert into conversas (empresa_id, whatsapp_contato_id, cliente_id) values ($1,$2,$3) returning *`,
          [empresaId, contatoId, contato.rows[0].cliente_id]
        );
      }
      const conversaId = conversa.rows[0].id;

      // 3. grava a mensagem — a unique constraint (empresa_id, external_message_id)
      //    garante a idempotência da seção 67: se o provedor reenviar o
      //    mesmo webhook, a segunda tentativa cai no catch abaixo.
      let mensagem;
      try {
        mensagem = await client.query(
          `insert into whatsapp_mensagens (empresa_id, conversa_id, external_message_id, direcao, conteudo)
           values ($1,$2,$3,'entrada',$4) returning *`,
          [empresaId, conversaId, externalMessageId, texto]
        );
      } catch (err) {
        if (err.code === '23505') {
          // já processamos essa mensagem antes — não é erro, é o comportamento esperado
          return { duplicada: true };
        }
        throw err;
      }

      await client.query(`update conversas set ultima_mensagem_em = now() where id = $1`, [conversaId]);

      // 4. roda o motor de intenção (hoje baseado em regras — troque por uma
      //    LLM real implementando a mesma interface em backend/ia/intentEngine.js)
      const deteccao = detectarIntencao(texto);
      const interacao = await client.query(
        `insert into ia_interacoes (empresa_id, mensagem_id, agente, intent, confidence, dados_extraidos, confirm_required)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [empresaId, mensagem.rows[0].id, deteccao.agente, deteccao.intent, deteccao.confidence,
         JSON.stringify(deteccao.dados), deteccao.confirmRequired]
      );

      return {
        duplicada: false,
        contato: contato.rows[0],
        conversa: conversa.rows[0],
        mensagem: mensagem.rows[0],
        ia_interacao: interacao.rows[0],
      };
    });

    // seção 66: o webhook nunca deve "segurar" a resposta esperando IA lenta.
    // Aqui o motor é baseado em regras (instantâneo), então processar inline
    // ainda responde rápido — mas ao trocar por uma LLM de verdade, mova a
    // chamada do intentEngine para um worker de fila (seção 65) e responda
    // 202 antes de rodar a IA.
    return res.status(data.duplicada ? 200 : 201).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
