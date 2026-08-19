/**
 * Marca como "vencido" toda conta a receber pendente cujo vencimento já
 * passou. Existe como função compartilhada porque mais de um módulo
 * (dashboard, financeiro, assistente) precisa desse status atualizado
 * antes de consultar — tê-la duplicada em cada rota foi exatamente o que
 * causou o bug em que o IA_ASSISTENTE não encontrava clientes atrasados
 * que o dashboard já via.
 *
 * Idealmente isso rodaria como um job agendado (seção 42: motor de
 * automação) em vez de "on-demand" a cada consulta — fica como próximo
 * passo quando houver fila/worker de verdade.
 */
async function marcarContasVencidas(client) {
  await client.query(`
    update contas_receber set status = 'vencido'
     where status = 'pendente' and vencimento < current_date and deleted_at is null`);
}

module.exports = { marcarContasVencidas };
