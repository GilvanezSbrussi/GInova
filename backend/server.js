require('dotenv').config();
const app = require('./app');

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`GInova API rodando em http://localhost:${port}`));
