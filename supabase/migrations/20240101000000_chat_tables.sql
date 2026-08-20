-- ============================================================
-- MokuWood Chat Tables
-- Run this in Supabase Dashboard > SQL Editor
-- ============================================================

-- ── chat_conversations ──────────────────────────────────────
create table if not exists public.chat_conversations (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── chat_messages ────────────────────────────────────────────
create table if not exists public.chat_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.chat_conversations(id) on delete cascade,
  sender_type     text        not null check (sender_type in ('user', 'ai', 'admin')),
  message         text        not null,
  created_at      timestamptz not null default now()
);

-- Index for fast per-conversation queries
create index if not exists chat_messages_conversation_id_idx
  on public.chat_messages (conversation_id, created_at);

-- ── Row Level Security ────────────────────────────────────────
alter table public.chat_conversations enable row level security;
alter table public.chat_messages       enable row level security;

-- chat_conversations: owner can SELECT
drop policy if exists "chat_conversations_select_own" on public.chat_conversations;
create policy "chat_conversations_select_own"
  on public.chat_conversations for select
  using (user_id = auth.uid());

-- chat_conversations: owner can INSERT (user_id must equal their own uid)
drop policy if exists "chat_conversations_insert_own" on public.chat_conversations;
create policy "chat_conversations_insert_own"
  on public.chat_conversations for insert
  with check (user_id = auth.uid());

-- chat_messages: users can SELECT messages belonging to their conversations
drop policy if exists "chat_messages_select_own" on public.chat_messages;
create policy "chat_messages_select_own"
  on public.chat_messages for select
  using (
    exists (
      select 1 from public.chat_conversations
      where id = conversation_id
        and user_id = auth.uid()
    )
  );

-- chat_messages: users can INSERT only 'user' messages into own conversations
drop policy if exists "chat_messages_insert_user" on public.chat_messages;
create policy "chat_messages_insert_user"
  on public.chat_messages for insert
  with check (
    sender_type = 'user'
    and exists (
      select 1 from public.chat_conversations
      where id = conversation_id
        and user_id = auth.uid()
    )
  );

-- No UPDATE / DELETE for users (AI / admin only via service_role)

-- ── Realtime ──────────────────────────────────────────────────
-- Enable realtime for chat_messages so admin dashboards receive new messages live.
-- Run this separately if the publication already exists:
--   alter publication supabase_realtime add table public.chat_messages;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
