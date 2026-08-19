/**
 * Este módulo é o "encaixe" onde entra uma IA de verdade no futuro.
 * A interface (entrada: texto da mensagem; saída: { intent, confidence,
 * dados, confirmRequired }) é a mesma seção 64 do manual. Hoje é baseado
 * em regras simples — o suficiente pra reconhecer os casos mais comuns
 * do dia a dia de um prestador de serviço — mas o resto do sistema
 * (webhook, ia_interacoes, confirmação) não muda nada quando isso virar
 * uma chamada para a API de um LLM.
 *
 * Para trocar por uma LLM real: implemente uma função com a mesma
 * assinatura de `detectarIntencao(texto)` que chama a API (ex: Anthropic
 * Messages API com um system prompt pedindo JSON estruturado), troque o
 * require em whatsapp/webhookRoutes.js, e pronto — nenhum outro módulo
 * precisa mudar.
 */

const REGEX_VALOR = /r?\$?\s?(\d+(?:[.,]\d{1,2})?)/i;
const REGEX_QUANTIDADE = /\b(\d+)\s*x?\b/;

function extrairValor(texto) {
  const m = texto.match(REGEX_VALOR);
  if (!m) return null;
  return Number(m[1].replace(',', '.'));
}

function detectarIntencao(texto) {
  const t = texto.toLowerCase();

  // IA_FINANCEIRO — "recebi 500 do João pelo serviço de instalação" (seção 27)
  if (/\brecebi\b/.test(t) || /\bpagou\b/.test(t)) {
    return {
      agente: 'IA_FINANCEIRO',
      intent: 'registrar_pagamento',
      confidence: 0.7,
      dados: { valor: extrairValor(t), descricao_bruta: texto },
      confirmRequired: true,
    };
  }

  // IA_ORCAMENTO — "queria orçamento pra instalar 3 ventiladores" / "quanto fica instalar..." (seção 4)
  if (/\bor[çc]amento\b/.test(t) || /\bquanto fica\b/.test(t) || /\binstalar\b/.test(t)) {
    const quantidadeMatch = t.match(REGEX_QUANTIDADE);
    return {
      agente: 'IA_ORCAMENTO',
      intent: 'orcamento',
      confidence: 0.65,
      dados: {
        quantidade: quantidadeMatch ? Number(quantidadeMatch[1]) : 1,
        descricao_bruta: texto,
      },
      confirmRequired: true,
    };
  }

  // IA_AGENDA — "marca para sexta" / "pode vir amanhã às 14h"
  if (/\bmarca(r)?\b/.test(t) || /\bagend/i.test(t)) {
    return {
      agente: 'IA_AGENDA',
      intent: 'agendamento',
      confidence: 0.55,
      dados: { descricao_bruta: texto },
      confirmRequired: true,
    };
  }

  // sem padrão reconhecido — cai pra atendimento humano
  return {
    agente: 'IA_ASSISTENTE',
    intent: 'duvida',
    confidence: 0.3,
    dados: { descricao_bruta: texto },
    confirmRequired: false,
  };
}

module.exports = { detectarIntencao };
