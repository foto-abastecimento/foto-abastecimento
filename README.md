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
- **Downloads:** o posto não abre nem baixa fotos e notas já enviadas. A matriz baixa fotos, notas e .zip.
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
  - o posto não vê o próprio IP na tela de acesso;
  - atrás do proxy do Railway, vale o último IP público do `X-Forwarded-For`;
  - o IP é o da internet do posto, não o de cada computador.
- **Controle de IP pelo login do posto.**
  - Cada login do posto fica registrado com IP, data e navegador. Senha errada não conta.
  - A aba Alertas mostra um semáforo com os últimos 5 logins de cada posto:
    - **verde:** mesmo IP em pelo menos 3 logins seguidos;
    - **vermelho:** o IP mudou;
    - **cinza:** poucos logins para avaliar (o primeiro acesso não conta).
  - Um login de IP diferente do anterior gera alerta, sem bloquear o posto.
  - O envio da foto continua gravando o IP. Se ele for diferente do IP do login, a diferença fica anotada no registro.
- **Hash SHA-256:** a foto e a nota recebem uma impressão digital no envio. Ela aparece na matriz e no relatório e prova que o arquivo não foi alterado depois.
- **Alertas com foto:** tentativas bloqueadas por horário guardam a foto e o PDF, que a matriz pode abrir.
- **Usuários de consulta:** criados pelo admin na aba Usuários.
  - Veem tudo e baixam fotos, notas e relatórios.
  - Não alteram postos, usuários nem alertas.
  - São desativados, nunca excluídos.
- **Relatório Excel** na aba Fotos. Respeita os filtros e traz IP, hashes, conferência e chave de acesso.
- **Bloqueio por senha errada.**
  - Depois de 5 senhas erradas seguidas, a conta (posto ou usuário da matriz) fica bloqueada por 30 minutos. Um acerto antes disso zera a contagem.
  - O bloqueio gera um alerta e entra no registro de ações.
  - Quem tem o poder de alterar postos ou usuários pode desbloquear antes do prazo.
  - O usuário `admin` é bloqueado só no IP de onde vieram as tentativas, para que um ataque não tranque o administrador para fora.
- **Poderes dos usuários da matriz.** Todo usuário vê as fotos e a lista de postos. O admin escolhe, para cada um:
  - baixar fotos, notas e relatórios;
  - ver alertas e farol de IP;
  - alterar postos;
  - alterar usuários da matriz.

  Ninguém concede um poder que não tem, nem altera o próprio usuário. Usuários criados antes desta versão mantêm o que já faziam (baixar e ver alertas).
- **Registro de ações** (aba só do admin):
  - entradas na matriz e downloads de foto, NF e alerta (o .zip conta como um registro, com a quantidade de arquivos);
  - relatórios Excel, com os filtros usados;
  - cadastros e alterações de postos e usuários (com o antes e o depois) e desbloqueios;
  - alertas marcados como vistos;
  - bloqueios;
  - cada vez que um posto abre uma foto.
- **Posto vê só miniatura borrada (LGPD).**
  - Na captura, o navegador gera uma miniatura de 160 px muito borrada: rosto, placa e textos do carimbo ficam ilegíveis.
  - A miniatura é guardada separada, e só ela vai para o banco do posto, junto com cliente, data/hora, nota, CNPJ/CPF e motorista.
  - A foto original e a nota só abrem para a matriz.
  - Envios feitos antes desta versão não têm miniatura e aparecem só como registro.
- **Erros sem detalhes técnicos.** O usuário vê uma mensagem simples com um código. O detalhe fica só no log do servidor, com o mesmo código. `/api/status` só abre para o admin logado.
- **Nada é apagado:** a atualização do banco só acrescenta colunas e tabelas.

## Rodar no computador (teste)

Precisa de Node.js 22.13 ou mais novo.

```
npm start
```

Depois abra http://localhost:3000. Os dados ficam na pasta `data/`.
