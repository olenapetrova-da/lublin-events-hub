-- approved schema description is docs/lehv2/LEHv2_DB_schema_S1.md 

-- OPTIONAL: clean up previous attempts
drop table if exists public.user_state;
drop table if exists public.showtimes;
drop table if exists public.events;
drop table if exists public.sources;

-- 1) sources
create table public.sources (
  source_id text primary key,
  label     text not null,
  url       text not null,
  enabled   boolean not null default true
);

-- 2) events
create table public.events (
  event_id     text primary key,
  title        text not null,
  source       text not null references public.sources(source_id),
  url          text not null,
  category_raw text
);

alter table public.events
  add constraint events_source_url_unique
  unique (source, url);

-- 3) showtimes
create table public.showtimes (
  showtime_id bigserial primary key,
  event_id    text not null references public.events(event_id),
  date        date not null,
  time        time,
  _end_date   date not null,
  venue       text,
  payment     text not null default 'unknown'
);

alter table public.showtimes
  add constraint showtimes_event_date_time_venue_unique
  unique (event_id, date, time, venue);

create index showtimes_date_payment_idx
  on public.showtimes (date, payment);

create index showtimes_event_id_idx
  on public.showtimes (event_id);

-- 4) user_state
create table public.user_state (
  user_state_id bigserial primary key,
  chat_id    text not null,
  step       text not null default 'idle',
  period     text,
  category   text,
  payment    text,
  page_offset     integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_state
  add constraint user_state_chat_id_unique
  unique (chat_id);
