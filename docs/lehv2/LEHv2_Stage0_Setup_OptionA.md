## 0. Goals

- Use **n8n Cloud** as the workflow engine.
- Use **Supabase Free** as the managed PostgreSQL database.
- Confirm:
  - n8n ↔ PostgreSQL connectivity.
  - Telegram bot ↔ n8n connectivity.
- Keep everything simple, reproducible, and documented.

---

## 1. Accounts and projects

### 1.1. n8n Cloud

- [ ] Create / log in to your **n8n Cloud** account.
- [ ] Create a workspace named e.g. `lublin-events-hub` (or similar).
- [ ] Note:
  - Workspace URL.
  - User/email used for this workspace (to reuse later for docs, screenshots).

### 1.2. Supabase

- [ ] Create / log in to your **Supabase** account.
- [ ] Create a new project:
  - Name: `leh-v2` or `lublin-events-hub`.
  - Region: **EU** (e.g. Frankfurt) to stay reasonably close to Poland.
  - Database password: generate and store in your password manager.
- [ ] In Supabase project settings select Transaction pooler, not Direct connection string, note:
  - `DB_HOST`
  - `DB_PORT`
  - `DB_NAME`
  - `DB_USER`
  - `DB_PASSWORD`
  - `DB_SSL` (true)
- [ ] Keep the default `public` schema for now.

---

## 2. Base database setup

Goal: have a minimal schema to test connections, then later expand to LEHv2 schema.

### 2.1. Create initial schema

In Supabase SQL editor:

- [ ] Create a simple test table to verify n8n connectivity:

```sql
create table if not exists leh_test_ping (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  note        text
); 
```
- [ ] (Optional) Create a dedicated user for n8n if you want tighter access later (can be postponed).
---

## 3. Connect n8n Cloud to Supabase Postgres

### 3.1. Create Postgres credentials in n8n

In n8n Cloud:

- [ ] Go to Credentials → New → choose Postgres.
- [ ] Fill in from Supabase:
    - Host: DB_HOST
    - Port: DB_PORT
    - Database: DB_NAME
    - User: DB_USER
    - Password: DB_PASSWORD
    - SSL: enabled 
- [ ]  Name the credential clearly: supabase-lehv2.

### 3.2. Test workflow: DB ping

Create workflow WF-TEST-DB-PING:

- [ ] Nodes:
    1. Manual Trigger
    2. Postgres (Insert) using supabase-lehv2:
        - Query:
        insert into leh_test_ping (note) values ('hello from n8n')
    3. Postgres (Select):
        - Query:
        select * from leh_test_ping order by id desc limit 5

- [ ] Run once.
- [ ] Confirm you see 5 latest records in the Select node output.
- [ ] Optionally check in Supabase UI that records are there.

If this works, n8n ↔ Postgres is confirmed.
---

## 4. Telegram bot basic wiring
### 4.1. Create bot via BotFather

- [ ] In Telegram, open @BotFather.
- [ ]  Use /newbot:
        - Name: Lublin Events v2 (for example).
        - Username: must end with bot, e.g. LublinEventsV2_bot.
- [ ] Copy the **bot token**.

### 4.2. Store Telegram credentials in n8n

In n8n:
- [ ] Go to **Credentials → New → Telegram**.
- [ ] Paste the token from BotFather.
- [ ] Name it telegram-lehv2-bot.

### 4.3. Test workflow: Telegram ping

Create workflow WF-TEST-TG-PING:

- [ ] Nodes:
    1. Telegram Trigger:
        - Use telegram-lehv2-bot.
        - Receive messages from your own chat.
    2. Telegram (Send Message):
        - Reply to the same chat with something simple like: 
        Bot is alive. You sent: {{$json["message"]["text"]}}
- [ ] Activate the workflow.
- [ ] In Telegram, send any message to your bot.
- [ ] Confirm you receive a reply.

If this works, Telegram ↔ n8n is confirmed.
---

## 5. Project conventions and secrets
### 5.1. Naming conventions

- Workflows:
        - WF-INGEST – daily ingestion (Stage 1).
        - WF-BOT-TG – Telegram bot (Stage 2).
        - WF-ADMIN – admin/diagnostics (later).
        - WF-ENRICH – LLM enrichment (later).

- Credentials:
        - supabase-lehv2 – Postgres.
        - telegram-lehv2-bot – Telegram bot.

### 5.2. Secret storage

- All secrets (tokens, DB passwords) live only in:
    - n8n Credentials,
    - Supabase project settings,
    - your password manager.
- They are not committed to GitHub.
---

## 6. Definition of done for Stage 0

Stage 0 is complete when:

- [ ] Supabase project is created and reachable.
- [ ] leh_test_ping table exists.
- [ ] WF-TEST-DB-PING runs successfully and you see data in Supabase.
- [ ] Telegram bot is created and connected to n8n.
- [ ] WF-TEST-TG-PING replies to your test message.
- [ ] You have this file (Stage 0 Setup) stored in the repo under docs/.