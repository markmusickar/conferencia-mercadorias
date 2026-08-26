# Função `criar-conferente`

Essa função permite cadastrar conferentes direto pela aba `Usuários` do sistema, sem abrir o painel do Supabase para cada novo funcionário.

Ela é segura porque a chave secreta fica dentro da Edge Function do Supabase, não no site público.

## Publicar a função

No computador com Supabase CLI instalado e logado:

```powershell
cd C:\Users\Marquinho\Documents\Codex\2026-06-20\ol\outputs\conferencia-mercadorias
supabase link --project-ref upozyqpdmxhhnynqoefs
supabase functions deploy criar-conferente
```

Depois disso, entre no sistema como administrador e use:

```text
Usuários > Cadastrar conferente
```

## O que a função faz

- Confirma se quem está logado é `admin`.
- Cria o usuário no Supabase Auth.
- Confirma o e-mail automaticamente.
- Cria/atualiza o perfil na tabela `profiles` com `role = conferente`.
