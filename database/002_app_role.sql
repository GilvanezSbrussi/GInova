-- =====================================================================
-- GInova — Role de aplicação (execute logo após o 001_mvp1_schema.sql)
--
-- MOTIVO CRÍTICO: no PostgreSQL, superusuários (e roles com BYPASSRLS)
-- ignoram TODAS as políticas de Row Level Security, mesmo que elas
-- existam e estejam corretas. Se o backend se conectar como "postgres"
-- (o padrão em muitos tutoriais e no docker-compose "de brincadeira"),
-- o isolamento multi-tenant da seção 33 do manual simplesmente não
-- funciona — cada empresa consegue ler e editar os dados de qualquer
-- outra. Isso foi detectado pelos testes de integração em
-- backend/tests/clientes.test.js, que forjam o ID de um cliente de uma
-- empresa e tentam acessá-lo com o token de outra.
--
-- A aplicação (backend/common/db.js → DATABASE_URL) DEVE se conectar
-- com esta role, nunca com "postgres".
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ginova_app') then
    create role ginova_app with login password 'troque-esta-senha-em-producao';
  end if;
end
$$;

-- nunca deve ter esse atributo — é o que faria a role voltar a ignorar RLS
alter role ginova_app nosuperuser nobypassrls;

grant usage on schema public to ginova_app;
grant select, insert, update, delete on all tables in schema public to ginova_app;
grant usage, select on all sequences in schema public to ginova_app;

-- garante que tabelas criadas em migrações futuras também sejam acessíveis
alter default privileges in schema public
  grant select, insert, update, delete on tables to ginova_app;
alter default privileges in schema public
  grant usage, select on sequences to ginova_app;
