process.env.NODE_ENV = 'test';
// IMPORTANTE: nunca usar a role "postgres" (superusuário) aqui — ela ignora
// Row Level Security e mascararia justamente os bugs de isolamento entre
// empresas que estes testes existem para pegar. Ver database/002_app_role.sql.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://ginova_app:troque-esta-senha-em-producao@localhost:5432/ginova_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
