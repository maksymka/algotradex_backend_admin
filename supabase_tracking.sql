-- Snapshots from admin backend (optional)
create table if not exists public.position_snapshots (
  id bigserial primary key,
  strategy text not null,
  balance numeric,
  unrealized_pnl numeric,
  positions jsonb,
  taken_at timestamptz default now()
);

create index if not exists position_snapshots_strategy_time
  on public.position_snapshots (strategy, taken_at desc);

alter table public.position_snapshots enable row level security;
-- service role writes; anon can read latest if you want public dashboard:
create policy "read snapshots" on public.position_snapshots
  for select to anon, authenticated using (true);
