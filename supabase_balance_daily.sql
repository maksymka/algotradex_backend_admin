-- 1) таблиця денних «закриваючих» балансів (бекенд робить upsert при кожному sync)
create table if not exists public.balance_daily (
  strategy   text        not null,
  day        date        not null,
  balance    numeric     not null,
  updated_at timestamptz not null default now(),
  primary key (strategy, day)
);

alter table public.balance_daily enable row level security;
create policy "read balance_daily" on public.balance_daily
  for select to anon, authenticated using (true);

-- 2) одноразовий бекфіл з існуючої balance_history (день за київським часом, останній запис дня)
insert into public.balance_daily (strategy, day, balance)
select distinct on (strategy, (recorded_at at time zone 'Europe/Kyiv')::date)
       strategy,
       (recorded_at at time zone 'Europe/Kyiv')::date,
       balance
from public.balance_history
where balance is not null
order by strategy, (recorded_at at time zone 'Europe/Kyiv')::date, recorded_at desc
on conflict (strategy, day) do update set balance = excluded.balance, updated_at = now();

-- 3) equity (баланс + нереалізований PnL) і внутрішньоденні екстремуми — для точного Max Drawdown
alter table public.balance_daily add column if not exists equity     numeric;
alter table public.balance_daily add column if not exists equity_min numeric;
alter table public.balance_daily add column if not exists equity_max numeric;
