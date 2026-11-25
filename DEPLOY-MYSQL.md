# LicitAI no Lightsail com MySQL

## Preparar o servidor

Confirme `node --version`, `npm --version` e `mysql --version`. Use Node.js 22 LTS ou mais recente e MySQL 8.0.19 ou mais recente da linha 8. A instalação parte de um banco vazio. Os PDFs e relatórios ficam em disco.

Abra o MySQL com uma conta administrativa, por exemplo com `sudo mysql` se o servidor usa autenticação local por socket. Troque o valor de exemplo em `IDENTIFIED BY` por uma senha forte exclusiva do banco.

```sql
CREATE DATABASE IF NOT EXISTS licitai CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'licitai_app'@'127.0.0.1' IDENTIFIED BY 'SUBSTITUA_POR_UMA_SENHA_FORTE';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES
ON licitai.* TO 'licitai_app'@'127.0.0.1';
```

Se esse nome de usuário já estiver em uso, escolha outro e ajuste `MYSQL_USER`. Confirme que a conta funciona com `mysql -h 127.0.0.1 -u licitai_app -p licitai`. A API usa essa conta de aplicação, enquanto a conta administrativa prepara o banco vazio.

## Enviar e iniciar a API

1. Clone a branch `codex/mysql-lightsail` em uma pasta nova `/opt/licitai`. Garanta que o usuário Linux do serviço possa escrever em `/opt/licitai/tmp`, `/opt/licitai/uploads` e `/opt/licitai/data`.
2. Entre na pasta e rode `npm ci --omit=dev`.
3. Crie o arquivo `.env` de produção com `cp env.mysql.example .env` e `chmod 600 .env`. Preencha `MYSQL_PASSWORD`, gere `JWT_SECRET` com `openssl rand -hex 32`, preencha as chaves Azure utilizadas e informe a senha combinada em `REALENERGY_ADMIN_PASSWORD`. A senha MySQL é independente da senha de login da REALENERGY.
4. Rode `npm start` e aguarde a mensagem de que a API está ouvindo. O boot cria as tabelas e índices e registra `admin@realenergy.com.br` como proprietário da REALENERGY. Em outro terminal, rode `curl -fsS http://127.0.0.1:3011/health`.
5. Faça login no frontend ou via `POST /api/auth/login` com o e-mail e a senha inicial. Depois de confirmar o login, altere a senha via `PATCH /api/me/password` ou pelas configurações do frontend e retire `REALENERGY_ADMIN_PASSWORD` do `.env`. A inicialização registra que a conta já foi criada e preserva seu hash em reinícios.

Se precisar provisionar as tabelas sem iniciar o servidor HTTP, rode `npm run db:init` com o mesmo `.env`.

## Manter o processo ativo

Confirme o caminho absoluto do Node com `command -v node` e use-o no `ExecStart`. Crie `/etc/systemd/system/licitai.service` com `sudoedit`. Ajuste `User` ao usuário Linux que possui a aplicação e o arquivo `.env`.

```ini
[Unit]
Description=LicitAI API
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/licitai
ExecStart=/usr/bin/node /opt/licitai/src/server.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
```

Pare o teste manual com Ctrl+C antes de iniciar o serviço.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now licitai
sudo journalctl -u licitai -n 50 --no-pager
curl -fsS http://127.0.0.1:3011/health
```

No Nginx existente, adicione um host separado para `licittai.duckdns.org` encaminhando para `127.0.0.1:3011`, com limite de upload adequado aos PDFs. Valide a configuração antes de recarregar o Nginx. Mantenha a porta MySQL fora do firewall público. Para a análise de edital, o frontend precisa enviar `Authorization: Bearer <token>`.

Inclua o banco MySQL e o diretório `data` nos backups. Reenvie os CATs pelo frontend para alimentar o novo banco.

## Testar em um banco separado

Para executar o teste de integração, provisione um banco vazio chamado `licitai_test` e uma conexão de teste com as mesmas permissões. Exporte as variáveis `MYSQL_*` apontando para esse banco e execute `RUN_MYSQL_TEST=1 npm test`. O teste cria um administrador com uma senha de teste e valida login, reinício, listagem e isolamento das evidências.
