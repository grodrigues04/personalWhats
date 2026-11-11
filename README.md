# personalWhats

Envia mensagens de WhatsApp para as minhas automações pessoais. Não conhece nenhum projeto: cada
projeto enfileira a mensagem (texto, destinatário, anexos) no MongoDB usando a
[interface-personal-whats](https://github.com/grodrigues04/interface-personal-whats), e o
personalWhats só valida e envia.

```
projeto ──interface──▶ MongoDB: received
                           │
        validator ─────────┤── senha errada / dados inválidos ──▶ rejected
                           ▼
                       validated
                           │
        whatsapp ──────────┴──▶ sending ──▶ sent
                                   └──────▶ validated de novo (erro temporário, até 5 tentativas)
                                   └──────▶ failed
```

| Container                   | O que faz                                                                 |
|-----------------------------|---------------------------------------------------------------------------|
| `personal-whats-validator`  | Python. Descriptografa e valida cada mensagem `received` com a interface. Cria a verificação da senha (`settings.key_check`) e os índices, inclusive o TTL que apaga mensagens 30 dias após o status final. |
| `personal-whats-whatsapp`   | Node (Baileys). Mantém a sessão do WhatsApp e envia só mensagens `validated`. |

Nenhum dos dois expõe porta, exceto a página do QR code em `http://localhost:3010`.

## Configuração

```bash
cp .env.example .env   # MONGO_URI, ENCRYPTION_PASSWORD, DEFAULT_RECIPIENT
docker compose up -d --build
docker compose logs -f
```

- `ENCRYPTION_PASSWORD` é a mesma em todos os projetos que enviam mensagens e é a senha do botão
  "Descriptografar" do frontend. Se mudar, apague `personal_whats.settings` `key_check` antes de
  subir de novo: mensagens criptografadas com a senha antiga serão rejeitadas.
- `DEFAULT_RECIPIENT`: número (DDI + DDD + número) usado quando a mensagem não tem destinatário.
- Primeira conexão: abra `http://localhost:3010` e escaneie o QR code em *Aparelhos conectados*.
  A sessão fica em `whatsapp-auth/` (nunca commitar).
- Nova versão da interface: `docker compose build --no-cache validator && docker compose up -d`.

## Mensagens enviadas

- Só texto: uma mensagem de texto.
- Com anexos: o texto vira a legenda do primeiro anexo; se ele já tiver legenda, o texto vai antes
  numa mensagem separada. `image/*` e `video/*` vão como mídia, o resto como documento.
- Erros permanentes (número sem WhatsApp, sem destinatário) viram `failed` na hora; os demais são
  tentados de novo a cada 60s, até 5 vezes.

## Desenvolvimento

```bash
cd validator && uv sync && uv run pytest     # usa ../../interface-personal-whats local
cd whatsapp && npm install && npm test       # inclui os vetores de criptografia da interface
```

`whatsapp/test/vectors/v1.json` é uma cópia de `interface-personal-whats/tests/vectors/v1.json`:
atualize junto quando a criptografia mudar.
