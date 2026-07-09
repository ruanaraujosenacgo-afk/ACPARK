# Deploy na Vercel

## Variaveis de ambiente

Configure estas variaveis no painel da Vercel em **Project Settings > Environment Variables**:

- `DATABASE_URL`: conexao PostgreSQL/Supabase em formato URL.
- `JWT_SECRET`: segredo longo para assinar sessoes de login.
- `NODE_ENV`: `production`.

Exemplo de `JWT_SECRET`: use uma frase/chave longa e exclusiva, sem compartilhar.

## Publicacao

1. Envie o projeto para um repositorio Git.
2. Na Vercel, clique em **Add New > Project**.
3. Importe o repositorio.
4. Framework preset: **Other**.
5. Build command: deixe vazio.
6. Output directory: deixe vazio.
7. Adicione as variaveis de ambiente.
8. Clique em **Deploy**.

## Acesso interno

O sistema continua protegido por login. Nao existe cadastro publico: apenas PDVs criados pelo Almoxarifado e o usuario do Almoxarifado conseguem entrar.

Para uma camada extra, ative **Deployment Protection** na Vercel se quiser bloquear a pagina antes mesmo do login do sistema.
