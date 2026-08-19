const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./common/apiError');
const authRoutes = require('./auth/authRoutes');
const clientesRoutes = require('./clientes/clientesRoutes');
const servicosRoutes = require('./servicos/servicosRoutes');
const orcamentosRoutes = require('./orcamentos/orcamentosRoutes');
const agendaRoutes = require('./agenda/agendaRoutes');
const financeiroRoutes = require('./financeiro/financeiroRoutes');
const dashboardRoutes = require('./dashboard/dashboardRoutes');
// próximas fases (ver README): estoque, whatsapp, ia, notificacoes, assinaturas

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
if (process.env.NODE_ENV !== 'test') {
  app.use(rateLimit({ windowMs: 60_000, max: 120 })); // seção 38: rate limiting (desligado em teste pra não travar a suíte)
}

app.get('/api/v1/health', (req, res) => res.json({ success: true, data: { status: 'ok' } }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/clientes', clientesRoutes);
app.use('/api/v1/servicos', servicosRoutes);
app.use('/api/v1/orcamentos', orcamentosRoutes);
app.use('/api/v1/agenda', agendaRoutes);
app.use('/api/v1/financeiro', financeiroRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);

app.use((req, res, next) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
});

app.use(errorHandler); // sempre por último (seção 103)

module.exports = app;
