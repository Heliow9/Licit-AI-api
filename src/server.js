const { PORT } = require('./Config/env');
const app = require('./app');

app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});
