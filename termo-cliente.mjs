/*
 * Termo de aceite do cliente (LGPD). Ao mudar o texto, mude também TERMO_VERSAO:
 * todos os clientes terão de aceitar a nova versão no próximo acesso.
 * Cada aceite guarda a versão, o hash SHA-256 deste texto, data, hora, IP e navegador.
 */
export const TERMO_VERSAO = "1.1";

export const TERMO_TEXTO = `TERMO DE ACEITE, RESPONSABILIDADE E TRATAMENTO DE DADOS PESSOAIS
Portal Foto Abastecimento – acesso do cliente – versão 1.1

Este termo regula o acesso do cliente ao Portal Foto Abastecimento, mantido pela rede de postos responsável por este portal (a "Matriz"), nos termos da Lei nº 13.709/2018 (Lei Geral de Proteção de Dados Pessoais – LGPD) e da Lei nº 12.965/2014 (Marco Civil da Internet).

1. OBJETO
1.1. O acesso permite consultar e visualizar na tela as fotos de autenticação de abastecimento e os documentos fiscais (NF-e e NFC-e) emitidos para o CNPJ ou CPF usado no login, nos postos da rede.
1.2. O acesso é somente para visualização: o portal não permite baixar fotos, notas, arquivos .zip ou relatórios. Se precisar de cópia de algum documento, o cliente deve solicitá-la à Matriz.
1.3. O acesso é pessoal e restrito aos documentos emitidos para esse CNPJ ou CPF. Documentos de terceiros não ficam disponíveis.

2. DADOS DISPONÍVEIS
2.1. Fotos do abastecimento. Podem conter imagem de pessoas (motoristas, colaboradores ou terceiros), de veículos e de placas, além do carimbo com data, hora, posto, motorista informado, número da nota e dados técnicos do registro.
2.2. Documentos fiscais e seus dados: número, série, chave de acesso, emitente, destinatário, itens e valores.
2.3. Informações de cada registro: posto, data e hora, motorista informado e código de integridade (hash) dos arquivos.

3. FINALIDADE
3.1. O acesso destina-se exclusivamente à conferência, ao controle, à auditoria e à comprovação dos abastecimentos do próprio cliente.
3.2. É vedado qualquer outro uso, em especial a divulgação pública, a comercialização ou o uso discriminatório das imagens e dos dados (art. 6º, incisos I, III e IX, da LGPD).

4. RESPONSABILIDADES DO USUÁRIO
Ao aceitar este termo, o usuário declara e se obriga a:
a) Manter sob sigilo a senha de acesso, que é pessoal e intransferível, respondendo por todo acesso e por toda ação realizados com ela.
b) Responsabilizar-se pelo uso das fotos e dos documentos da sua empresa (ou seus, se pessoa física) que visualizar no portal, e não tentar contornar o bloqueio de download.
c) Não capturar, fotografar ou reproduzir a tela, salvo para a finalidade do item 3.1. Qualquer cópia assim obtida, por si ou por seus prepostos, passa a ser de responsabilidade do cliente, como controlador (art. 5º, VI, da LGPD). Ela deve ser guardada em ambiente seguro, com acesso restrito, e eliminada quando não houver mais finalidade ou obrigação legal para mantê-la.
d) Não compartilhar, publicar ou repassar as fotos e os documentos a terceiros não autorizados.
e) Tratar as imagens de motoristas, colaboradores e terceiros com base legal adequada (art. 7º da LGPD) e informá-los conforme as políticas internas do cliente.
f) Comunicar imediatamente à Matriz qualquer suspeita de acesso indevido, perda da senha ou incidente de segurança envolvendo os dados visualizados no portal.

5. REGISTRO DE ACESSOS E AÇÕES
5.1. Para segurança e cumprimento legal, o portal registra cada acesso e cada ação do usuário: login, aceite deste termo, troca de senha, abertura de fotos e de notas e tentativas de download, com data, hora e endereço IP.
5.2. Esses registros são guardados pelo prazo legal, no mínimo 6 meses (art. 15 do Marco Civil da Internet). Podem ser usados para apurar uso indevido e para atender a autoridades.

6. SEGURANÇA
6.1. O portal usa conexão criptografada (HTTPS). A senha é guardada de forma protegida, e o acesso é bloqueado após 5 tentativas com senha errada.
6.2. A Matriz pode suspender ou cancelar o acesso em caso de uso indevido, de descumprimento deste termo ou de solicitação do cliente.

7. DIREITOS DOS TITULARES
7.1. Os titulares dos dados, inclusive motoristas e colaboradores, podem exercer os direitos do art. 18 da LGPD perante a Matriz, quanto aos dados mantidos no portal, e perante o cliente, quanto a eventuais cópias em seu poder.

8. VIGÊNCIA
8.1. Este termo vale enquanto o acesso estiver ativo. O cliente pode pedir o cancelamento do acesso à Matriz a qualquer momento.
8.2. Uma nova versão deste termo exigirá novo aceite no acesso seguinte.

9. DECLARAÇÃO DE ACEITE
Ao marcar a caixa de concordância e clicar em "Aceito", o usuário declara que:
a) leu e compreendeu este termo;
b) tem poderes para representar a empresa titular do CNPJ usado no login ou, se pessoa física, é o titular do CPF;
c) concorda integralmente com as condições acima.
O aceite é registrado eletronicamente com data, hora, endereço IP, navegador, versão e código de integridade (hash) deste texto.`;
