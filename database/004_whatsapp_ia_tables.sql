-- =====================================================================
-- GInova — Migração 004 — WhatsApp + IA (Fase 2 do roadmap, seção 85)
--
-- Tabelas: whatsapp_contatos, conversas, whatsapp_mensagens,
-- ia_interacoes, ia_acoes.
--
-- Princípio da seção 5 do manual, aplicado literalmente aqui:
--   "A IA nunca deve executar uma ação financeira ou operacional
--    importante sem autorização."
-- Por isso ia_interacoes guarda a SUGESTÃO da IA (com confidence e
-- confirm_required), e só vira algo real (cliente, orçamento) quando
-- alguém confirma explicitamente — ver backend/whatsapp/confirmarRoutes.js.
-- =====================================================================

create table whatsapp_contatos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  cliente_id    uuid references clientes(id),          -- preenchido quando a IA_CLIENTE identifica/cria o cliente
  telefone      text not null,
  nome_perfil   text,                                    -- nome que aparece no WhatsApp da pessoa
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid
);
create unique index uq_whatsapp_contatos_telefone on whatsapp_contatos (empresa_id, telefone) where deleted_at is null;
create trigger trg_whatsapp_contatos_updated_at before update on whatsapp_contatos
  for each row execute function set_updated_at();

create table conversas (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references empresas(id),
  whatsapp_contato_id uuid not null references whatsapp_contatos(id),
  cliente_id          uuid references clientes(id),
  status              text not null default 'aberta' check (status in ('aberta','fechada')),
  ultima_mensagem_em  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  created_by          uuid,
  updated_by          uuid
);
create index ix_conversas_empresa on conversas (empresa_id) where deleted_at is null;
create trigger trg_conversas_updated_at before update on conversas
  for each row execute function set_updated_at();

create table whatsapp_mensagens (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references empresas(id),
  conversa_id         uuid not null references conversas(id),
  external_message_id text not null,     -- idempotência (seção 67): a mesma mensagem pode chegar 2x do provedor
  direcao             text not null check (direcao in ('entrada','saida')),
  tipo                text not null default 'texto' check (tipo in ('texto','imagem','audio','documento')),
  conteudo            text,
  processada          boolean not null default false,
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
-- a mesma mensagem (mesmo id do provedor) nunca pode ser gravada duas vezes na mesma empresa
create unique index uq_whatsapp_mensagens_external_id on whatsapp_mensagens (empresa_id, external_message_id);
create index ix_whatsapp_mensagens_conversa on whatsapp_mensagens (conversa_id, created_at);

create table ia_interacoes (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas(id),
  mensagem_id     uuid references whatsapp_mensagens(id),
  agente          text not null,          -- IA_CLIENTE | IA_ORCAMENTO | IA_AGENDA | IA_FINANCEIRO | IA_ESTOQUE | IA_ASSISTENTE (seção 25)
  intent          text not null,
  confidence      numeric(4,3),
  dados_extraidos jsonb not null default '{}',
  confirm_required boolean not null default true,
  status          text not null default 'pendente'
                    check (status in ('pendente','confirmada','rejeitada','executada','expirada')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  created_by      uuid,
  updated_by      uuid
);
create index ix_ia_interacoes_empresa_status on ia_interacoes (empresa_id, status) where deleted_at is null;
create trigger trg_ia_interacoes_updated_at before update on ia_interacoes
  for each row execute function set_updated_at();

create table ia_acoes (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas(id),
  ia_interacao_id uuid not null references ia_interacoes(id),
  tipo_acao       text not null,          -- ex: "criar_orcamento", "registrar_pagamento"
  payload         jsonb not null,
  executada_por   uuid,                    -- usuário humano que confirmou (nunca a IA sozinha — seção 29)
  resultado       jsonb,
  executada_em    timestamptz,
  created_at      timestamptz not null default now()
);
create index ix_ia_acoes_empresa on ia_acoes (empresa_id);

alter table whatsapp_contatos  enable row level security;
alter table conversas          enable row level security;
alter table whatsapp_mensagens enable row level security;
alter table ia_interacoes      enable row level security;
alter table ia_acoes           enable row level security;

create policy tenant_isolation_whatsapp_contatos on whatsapp_contatos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_conversas on conversas
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_whatsapp_mensagens on whatsapp_mensagens
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_ia_interacoes on ia_interacoes
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_ia_acoes on ia_acoes
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);

-- a role de aplicação precisa de acesso às tabelas novas também
grant select, insert, update, delete on
  whatsapp_contatos, conversas, whatsapp_mensagens, ia_interacoes, ia_acoes
  to ginova_app;
