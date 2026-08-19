-- =====================================================================
-- GInova — Schema PostgreSQL — MVP 1
-- Ordem seguida conforme manual do produto (seção 87 "Primeiro banco"):
--   empresas, usuarios, usuarios_empresas, clientes, servicos,
--   orcamentos, orcamento_itens, agendamentos, contas_receber,
--   contas_pagar, pagamentos.
--
-- Fora do escopo deste arquivo (fases seguintes, ver roadmap):
--   produtos, estoque, fornecedores, ordens_servico, cobrancas   -> MVP3
--   whatsapp_contatos, whatsapp_mensagens, conversas,
--   ia_interacoes, ia_acoes                                      -> MVP2
--   assinaturas, planos, logs, auditoria                         -> Fase 7
--
-- Princípios aplicados (seções 32, 33, 38):
--   - toda tabela relevante tem: id, empresa_id, created_at, updated_at,
--     deleted_at, created_by, updated_by;
--   - isolamento multi-tenant via empresa_id em toda tabela de negócio,
--     reforçado por Row Level Security (RLS);
--   - nenhuma senha em texto puro (armazenamos apenas hash).
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Função utilitária: atualiza updated_at automaticamente
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =====================================================================
-- 1. EMPRESAS
-- =====================================================================
create table empresas (
  id              uuid primary key default gen_random_uuid(),
  razao_social    text not null,
  nome_fantasia   text,
  cpf_cnpj        text not null,
  segmento        text,                          -- ex: "eletricista", "manicure"
  telefone        text,
  whatsapp        text,
  email           text,
  endereco        jsonb,
  status          text not null default 'ativa'  -- ativa | bloqueada | cancelada
                    check (status in ('ativa','bloqueada','cancelada')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  created_by      uuid,
  updated_by      uuid
);
create unique index uq_empresas_cpf_cnpj on empresas (cpf_cnpj) where deleted_at is null;
create trigger trg_empresas_updated_at before update on empresas
  for each row execute function set_updated_at();

-- =====================================================================
-- 2. USUARIOS
-- (usuário é uma identidade de login; pode pertencer a várias empresas
--  via usuarios_empresas — ex.: um técnico freelancer com dois clientes GInova)
-- =====================================================================
create table usuarios (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  email           text not null,
  telefone        text,
  senha_hash      text not null,                 -- nunca senha pura (seção 35)
  status          text not null default 'ativo'
                    check (status in ('ativo','inativo','bloqueado')),
  ultimo_login_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  created_by      uuid,
  updated_by      uuid
);
create unique index uq_usuarios_email on usuarios (email) where deleted_at is null;
create trigger trg_usuarios_updated_at before update on usuarios
  for each row execute function set_updated_at();

-- =====================================================================
-- 3. USUARIOS_EMPRESAS
-- (vínculo N:N + perfil/permissões — seções 36 e 37)
-- =====================================================================
create table usuarios_empresas (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  usuario_id    uuid not null references usuarios(id),
  perfil        text not null
                  check (perfil in ('ADMIN','EMPRESA_ADMIN','GERENTE','FUNCIONARIO','FINANCEIRO','TECNICO')),
  permissoes    jsonb not null default '[]',      -- ex: ["cliente.criar","financeiro.visualizar"]
  status        text not null default 'ativo' check (status in ('ativo','inativo')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid,
  unique (empresa_id, usuario_id)
);
create trigger trg_usuarios_empresas_updated_at before update on usuarios_empresas
  for each row execute function set_updated_at();

-- =====================================================================
-- 4. CLIENTES
-- =====================================================================
create table clientes (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references empresas(id),
  nome                text not null,
  cpf_cnpj            text,
  telefone            text,
  whatsapp            text,
  email               text,
  endereco            jsonb,
  observacoes         text,
  origem              text,                       -- ex: "whatsapp", "indicação"
  primeiro_contato_em date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  created_by          uuid,
  updated_by          uuid
);
create index ix_clientes_empresa on clientes (empresa_id) where deleted_at is null;
create index ix_clientes_whatsapp on clientes (empresa_id, whatsapp);
create trigger trg_clientes_updated_at before update on clientes
  for each row execute function set_updated_at();

-- =====================================================================
-- 5. SERVICOS  (catálogo)
-- =====================================================================
create table servicos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  nome          text not null,
  descricao     text,
  categoria     text,
  preco_padrao  numeric(12,2) not null default 0,
  custo         numeric(12,2) not null default 0,
  duracao_min   integer,                          -- duração estimada em minutos
  materiais     jsonb,                             -- lista livre de materiais necessários
  ativo         boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid
);
create index ix_servicos_empresa on servicos (empresa_id) where deleted_at is null;
create trigger trg_servicos_updated_at before update on servicos
  for each row execute function set_updated_at();

-- =====================================================================
-- 6. ORCAMENTOS  (seção 14: fluxo de status)
-- =====================================================================
create table orcamentos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  cliente_id    uuid not null references clientes(id),
  numero        serial,                            -- número sequencial amigável (por empresa idealmente via trigger futura)
  status        text not null default 'rascunho'
                  check (status in ('rascunho','enviado','visualizado','aguardando_resposta',
                                     'aprovado','recusado','expirado','cancelado')),
  valor_total   numeric(12,2) not null default 0,
  origem        text default 'manual'  check (origem in ('manual','whatsapp_ia')),
  enviado_em    timestamptz,
  respondido_em timestamptz,
  observacoes   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid
);
create index ix_orcamentos_empresa_status on orcamentos (empresa_id, status) where deleted_at is null;
create trigger trg_orcamentos_updated_at before update on orcamentos
  for each row execute function set_updated_at();

-- =====================================================================
-- 7. ORCAMENTO_ITENS
-- =====================================================================
create table orcamento_itens (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  orcamento_id  uuid not null references orcamentos(id) on delete cascade,
  servico_id    uuid references servicos(id),
  descricao     text not null,
  quantidade    numeric(10,2) not null default 1,
  valor_unit    numeric(12,2) not null default 0,
  valor_total   numeric(12,2) generated always as (quantidade * valor_unit) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index ix_orcamento_itens_orcamento on orcamento_itens (orcamento_id);
create trigger trg_orcamento_itens_updated_at before update on orcamento_itens
  for each row execute function set_updated_at();

-- =====================================================================
-- 8. AGENDAMENTOS  (seção 15/16 — versão simplificada de MVP1;
--    "ordens_servico" completa com itens entra no MVP3)
-- =====================================================================
create table agendamentos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  cliente_id    uuid not null references clientes(id),
  servico_id    uuid references servicos(id),
  orcamento_id  uuid references orcamentos(id),
  titulo        text not null,                     -- ex: "Instalação de ar-condicionado"
  data_hora     timestamptz not null,
  duracao_min   integer,
  endereco      jsonb,
  status        text not null default 'agendado'
                  check (status in ('agendado','em_andamento','concluido','cancelado')),
  valor         numeric(12,2) default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid
);
create index ix_agendamentos_empresa_data on agendamentos (empresa_id, data_hora) where deleted_at is null;
create trigger trg_agendamentos_updated_at before update on agendamentos
  for each row execute function set_updated_at();

-- =====================================================================
-- 9. CONTAS_RECEBER
-- =====================================================================
create table contas_receber (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresas(id),
  cliente_id     uuid not null references clientes(id),
  agendamento_id uuid references agendamentos(id),
  orcamento_id   uuid references orcamentos(id),
  descricao      text not null,
  valor          numeric(12,2) not null,
  vencimento     date not null,
  status         text not null default 'pendente'
                   check (status in ('pendente','pago','vencido','cancelado')),
  pago_em        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  created_by     uuid,
  updated_by     uuid
);
create index ix_contas_receber_empresa_status on contas_receber (empresa_id, status) where deleted_at is null;
create index ix_contas_receber_vencimento on contas_receber (empresa_id, vencimento);
create trigger trg_contas_receber_updated_at before update on contas_receber
  for each row execute function set_updated_at();

-- =====================================================================
-- 10. CONTAS_PAGAR
-- =====================================================================
create table contas_pagar (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresas(id),
  fornecedor     text,                              -- texto livre no MVP1; tabela fornecedores entra no MVP3
  descricao      text not null,
  categoria      text,                               -- aluguel | combustível | funcionários | impostos | outros
  valor          numeric(12,2) not null,
  vencimento     date not null,
  status         text not null default 'pendente'
                   check (status in ('pendente','pago','vencido','cancelado')),
  pago_em        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  created_by     uuid,
  updated_by     uuid
);
create index ix_contas_pagar_empresa_status on contas_pagar (empresa_id, status) where deleted_at is null;
create trigger trg_contas_pagar_updated_at before update on contas_pagar
  for each row execute function set_updated_at();

-- =====================================================================
-- 11. PAGAMENTOS  (baixa de contas a receber/pagar)
-- =====================================================================
create table pagamentos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references empresas(id),
  conta_receber_id  uuid references contas_receber(id),
  conta_pagar_id    uuid references contas_pagar(id),
  valor             numeric(12,2) not null,
  metodo            text check (metodo in ('pix','dinheiro','cartao','transferencia','outro')),
  pago_em           timestamptz not null default now(),
  observacoes       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  created_by        uuid,
  updated_by        uuid,
  constraint chk_pagamento_um_destino
    check (num_nonnulls(conta_receber_id, conta_pagar_id) = 1)
);
create index ix_pagamentos_empresa on pagamentos (empresa_id) where deleted_at is null;
create trigger trg_pagamentos_updated_at before update on pagamentos
  for each row execute function set_updated_at();

-- =====================================================================
-- ROW LEVEL SECURITY — isolamento multi-tenant (seção 33)
-- A aplicação deve executar `set_config('app.empresa_id', '<uuid>', true)`
-- no início de cada transação/request autenticada.
-- =====================================================================
alter table clientes       enable row level security;
alter table servicos       enable row level security;
alter table orcamentos     enable row level security;
alter table orcamento_itens enable row level security;
alter table agendamentos   enable row level security;
alter table contas_receber enable row level security;
alter table contas_pagar   enable row level security;
alter table pagamentos     enable row level security;

create policy tenant_isolation_clientes on clientes
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_servicos on servicos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_orcamentos on orcamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_orcamento_itens on orcamento_itens
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_agendamentos on agendamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_contas_receber on contas_receber
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_contas_pagar on contas_pagar
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_pagamentos on pagamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);

-- =====================================================================
-- SEED mínimo para desenvolvimento local
-- =====================================================================
insert into empresas (id, razao_social, nome_fantasia, cpf_cnpj, segmento)
values ('00000000-0000-0000-0000-000000000001', 'João da Silva Elétrica', 'Elétrica JR', '000.000.000-00', 'eletricista');
