# Foto Abastecimento

Registro fotográfico de abastecimento. O sistema tem dois portais:

- **Portal do posto:** foto pela câmera, cliente/motorista, número da nota e PDF da nota.
- **Portal da matriz:** fotos de todos os postos, alertas e cadastro de postos.

Roda num único servidor Node.js, sem dependências externas. O banco é SQLite e as fotos e PDFs ficam numa pasta. No Railway, banco e arquivos ficam num **volume**, para não se perderem a cada publicação.

## Publicar no Railway

1. **GitHub.** Crie um repositório (de preferência **privado**), por exemplo `foto-abastecimento`, e envie estes arquivos, mantendo a pasta `public/`.
2. **Railway.** Vá em **New Project → Deploy from GitHub repo** e escolha o repositório. O Railway detecta o Node.js e usa `npm start`.
3. **Volume (obrigatório).**
   - No projeto, abra a paleta de comandos (⌘K / Ctrl+K) ou clique com o botão direito no fundo do projeto.
   - Crie um **Volume** e ligue ao serviço do sistema.
   - Mount path: `/data`.
   - O servidor encontra o volume sozinho, pela variável `RAILWAY_VOLUME_MOUNT_PATH`.
4. **Senha do admin.** Na aba **Variables** do serviço, crie `ADMIN_PASSWORD` com uma senha forte.
5. **Endereço público.** Em **Settings → Networking**, clique em **Generate Domain**. O endereço será algo como `https://foto-abastecimento-production.up.railway.app`.
6. **Conferir.** Abra `https://SEU-ENDERECO/api/status`.
   - `servidor`, `banco_DB` e `arquivos_FILES` devem estar **ok**.
   - `armazenamento` deve dizer **volume do Railway em /data**. Se aparecer "ATENÇÃO: sem volume", refaça o passo 3.
7. **Começar a usar.** Entre com usuário `admin` e a senha do passo 4. Em **Postos**, cadastre os postos.

## Arquivos

| Arquivo | Função |
|---|---|
| `server.js` | Servidor HTTP: banco SQLite, pasta de arquivos e telas |
| `logica.mjs` | Regras: login, envio de fotos, conferências, alertas, IP, usuários, postos |
| `pdf-texto.mjs` | Leitor de PDF do servidor (sem dependências) |
| `public/leitura-nf.js` | Regras de leitura da nota, usadas no navegador e no servidor |
| `public/` | Telas do posto e da matriz |
| `railway.json` | Comando de início e verificação de saúde para o Railway |

## Regras principais

- **Login:** `admin` abre o portal da matriz. CNPJ e senha abrem o portal do posto. Não há cadastro pela tela de login.
- **Foto:** sai só pela câmera do navegador. O carimbo leva data e hora de Brasília vindas do servidor, loja, CNPJ, cliente/motorista e nota.
- **Para salvar, são obrigatórios:**
  - foto, cliente/motorista e número da nota;
  - PDF da nota com o mesmo número;
  - cliente da nota;
  - emissão até 10 minutos antes ou depois da foto.
- **Fora do horário:** o envio é bloqueado com a mensagem "entre em contato com a matriz", e um alerta aparece no portal da matriz. Número de nota digitado errado não gera alerta.
- **Downloads:** o posto só visualiza as fotos. A matriz baixa fotos, notas e .zip.
- **Nome dos arquivos:** `NOTA_AAAA-MM-DD_HH-MM-SS.jpg` / `.pdf`, no horário de Brasília.

## Segurança e auditoria

- **Leitura da nota no servidor.** O servidor relê o PDF e faz as conferências com os dados lidos por ele:
  - número da nota;
  - hora da saída;
  - chave de acesso;
  - cliente.

  Se a leitura do navegador for diferente, vale a do servidor e a diferença fica registrada. Um PDF que o servidor não consiga ler (ex.: escaneado) é aceito com a marcação "não conferida no servidor".
- **Leitor de PDF próprio** (`pdf-texto.mjs`), sem dependências. Lê PDFs compactados, com object streams e protegidos com senha vazia (RC4 e AES-128/256).
- **IP:**
  - o IP do envio sai no carimbo da foto e fica gravado;
  - atrás do proxy do Railway, vale o último IP público do `X-Forwarded-For`;
  - o IP é o da internet do posto, não o de cada computador.
- **Semáforo de IP** na aba Alertas, olhando os últimos 5 envios de cada posto:
  - **verde:** mesmo IP em pelo menos 3 envios;
  - **vermelho:** o IP mudou;
  - **cinza:** poucos envios para avaliar.

  Cada troca de IP gera um alerta, sem bloquear o posto.
- **Hash SHA-256:** a foto e a nota recebem uma impressão digital no envio. Ela aparece na matriz e no relatório e prova que o arquivo não foi alterado depois.
- **Alertas com foto:** tentativas bloqueadas por horário guardam a foto e o PDF, que a matriz pode abrir.
- **Usuários de consulta:** criados pelo admin na aba Usuários.
  - Veem tudo e baixam fotos, notas e relatórios.
  - Não alteram postos, usuários nem alertas.
  - São desativados, nunca excluídos.
- **Relatório Excel** na aba Fotos. Respeita os filtros e traz IP, hashes, conferência e chave de acesso.
- **Nada é apagado:** a atualização do banco só acrescenta colunas e tabelas.

## Rodar no computador (teste)

Precisa de Node.js 22.13 ou mais novo.

```
npm start
```

Depois abra http://localhost:3000. Os dados ficam na pasta `data/`.
