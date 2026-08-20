-- ============================================================
-- MokuWood Chat Tables
-- Safe setup for existing Supabase project
-- ============================================================

create table if not exists public.chat_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_type     text not null check (sender_type in ('user', 'ai', 'admin')),
  message         text not null check (char_length(message) between 1 and 4000),
  created_at      timestamptz not null default now()
);

create index if not exists chat_messages_conversation_id_idx
  on public.chat_messages (conversation_id, created_at);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;

-- Users can only read their own conversation.
drop policy if exists "chat_conversations_select_own" on public.chat_conversations;
create policy "chat_conversations_select_own"
  on public.chat_conversations for select
  to authenticated
  using (user_id = auth.uid());

-- Users can only create a conversation owned by their current user.
drop policy if exists "chat_conversations_insert_own" on public.chat_conversations;
create policy "chat_conversations_insert_own"
  on public.chat_conversations for insert
  to authenticated
  with check (user_id = auth.uid());

-- Users can only read messages from conversations they own.
drop policy if exists "chat_messages_select_own" on public.chat_messages;
create policy "chat_messages_select_own"
  on public.chat_messages for select
  to authenticated
  using (
    exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

-- Browser clients can only insert user messages into their own conversations.
drop policy if exists "chat_messages_insert_user" on public.chat_messages;
create policy "chat_messages_insert_user"
  on public.chat_messages for insert
  to authenticated
  with check (
    sender_type = 'user'
    and exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

-- No UPDATE / DELETE policies for authenticated users.
-- AI/admin writes must use a trusted server-side context (service role).

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
