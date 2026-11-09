# Conferência de Mercadorias

Sistema web para conferir mercadorias recebidas, feito em HTML, CSS e JavaScript puro, com login e banco de dados no [Supabase](https://supabase.com).

## Funcionalidades

- Login com três perfis: **conferente**, **compras** e **administrador**
- Nova conferência com leitura de código de barras pela câmera, foto, quantidade e observação (aceita produto sem código de barras)
- Histórico de conferências com busca e exportação para Excel e PDF com fotos
- Pedidos de compra
- Comparação entre pedido e conferência (falta, sobra e quantidade divergente), visível só para o administrador
- Perdas acumuladas por período, que só o administrador pode zerar
- Cadastro de produtos (preenchido automaticamente ao salvar as conferências)
- Cadastro de conferentes pela aba Usuários, usando uma função segura do Supabase

## Como o acesso funciona

- O conferente vê apenas as conferências que ele mesmo criou
- Compras vê as conferências e os pedidos
- O administrador vê tudo
- Essas regras ficam no banco (RLS, triggers e funções SQL), e não só na tela

## Estrutura do projeto

| Arquivo | O que faz |
| --- | --- |
| `index.html` | Telas do sistema |
| `app.js` | Lógica do sistema |
| `styles.css` | Visual |
| `supabase-*.sql` | Ajustes do banco de dados, para rodar no SQL Editor do Supabase |
| `supabase-funcao-criar-conferente.md` | Como publicar a função que cadastra conferentes |
| `supabase/functions/criar-conferente/` | Código da função que cadastra conferentes |

## Como configurar

1. Crie um projeto no Supabase.
2. No `app.js`, confira `supabaseUrl` e `supabaseKey` no topo do arquivo. A chave `sb_publishable_...` é a chave pública, feita para ficar no navegador. **Nunca** coloque a chave `service_role` neste arquivo.
3. No **SQL Editor** do Supabase, rode os arquivos `supabase-*.sql`.
4. Publique a função `criar-conferente`, seguindo o passo a passo em `supabase-funcao-criar-conferente.md`.
5. Abra o `index.html` no navegador, ou publique a pasta em um serviço de hospedagem de sites estáticos.

> Atenção: este repositório tem só os ajustes do banco. As tabelas base (`conferences`, `conference_items`, `purchase_orders`, `profiles`), a função `my_role()` e o bucket de fotos `mercadoria-fotos` precisam existir no projeto do Supabase. Confirme também que o RLS está ligado em todas as tabelas.
