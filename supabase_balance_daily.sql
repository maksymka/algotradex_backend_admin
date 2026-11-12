-- =====================================================================
-- AlgoTradeX: денні баланси, equity, поповнення/виведення, закриті угоди
-- Скрипт ІДЕМПОТЕНТНИЙ — його можна запускати повторно скільки завгодно.
-- =====================================================================

-- 1) денний підсумок: баланс гаманця, equity (баланс + нереалізований PnL), внутрішньоденні min/max
create table if not exists public.balance_daily (
  strategy   text        not null,
  day        date        not null,
  balance    numeric     not null,
  updated_at timestamptz not null default now(),
  primary key (strategy, day)
);
alter table public.balance_daily add column if not exists equity     numeric;
alter table public.balance_daily add column if not exists equity_min numeric;
alter table public.balance_daily add column if not exists equity_max numeric;

-- 2) поповнення (+) і виведення (−); source = 'api' (бекенд) або 'manual' (ви вручну)
create table if not exists public.balance_flows (
  strategy text        not null,
  ref      text        not null,
  ts       timestamptz not null,
  amount   numeric     not null,
  asset    text,
  source   text        not null default 'api',
  primary key (strategy, ref)
);
create index if not exists balance_flows_strategy_ts on public.balance_flows (strategy, ts);

-- 3) закриті угоди (realized PnL) для справжнього win rate
create table if not exists public.closed_pnl (
  strategy text        not null,
  ref      text        not null,
  ts       timestamptz not null,
  symbol   text,
  pnl      numeric     not null,
  source   text        not null default 'api',
  primary key (strategy, ref)
);
create index if not exists closed_pnl_strategy_ts on public.closed_pnl (strategy, ts);

-- 4) RLS: фронтенд ходить через бекенд (service key), прямий доступ не потрібен
alter table public.balance_daily enable row level security;
alter table public.balance_flows enable row level security;
alter table public.closed_pnl    enable row level security;
drop policy if exists "read balance_daily" on public.balance_daily;
create policy "read balance_daily" on public.balance_daily
  for select to anon, authenticated using (true);

-- 5) одноразовий бекфіл денних балансів з balance_history (день за київським часом, останній запис дня).
--    Існуючі рядки з equity НЕ перезаписуються.
insert into public.balance_daily (strategy, day, balance)
select distinct on (strategy, (recorded_at at time zone 'Europe/Kyiv')::date)
       strategy,
       (recorded_at at time zone 'Europe/Kyiv')::date,
       balance
from public.balance_history
where balance is not null
order by strategy, (recorded_at at time zone 'Europe/Kyiv')::date, recorded_at desc
on conflict (strategy, day) do nothing;

-- 6) Beta (ліквідована, API вимкнене): переносимо історію, яка раніше була вписана в index.html
insert into public.balance_daily (strategy, day, balance, equity, equity_min, equity_max)
select 'beta', d::date, v, v, v, v
from (values
  ('2026-10-04',783.01),('2026-10-05',784.64),('2026-10-06',785.64),('2026-10-07',787.18),('2026-10-08',790.50),
  ('2026-10-09',790.32),('2026-10-10',895.65),('2026-10-11',895.87),('2026-10-12',895.87),('2026-10-13',930.05),
  ('2026-10-14',917.74),('2026-10-15',932.27),('2026-10-16',932.46),('2026-10-17',0)
) as t(d, v)
where not exists (select 1 from public.balance_daily where strategy = 'beta')
on conflict (strategy, day) do nothing;

-- 7) Виведення 81 USDT з Beta (раніше було вписано в код як "Out: 81"). Дату ПЕРЕВІРТЕ й за потреби виправте — вона приблизна.
insert into public.balance_flows (strategy, ref, ts, amount, asset, source)
values ('beta', 'manual-beta-withdraw-1', '2026-10-16T12:00:00Z', -81, 'USDT', 'manual')
on conflict (strategy, ref) do nothing;

-- 8) Інші поповнення/виведення, яких API не віддає (старіші за ~3 міс. або до підключення ключів), вносьте так:
--    amount > 0 — поповнення, amount < 0 — виведення.
-- insert into public.balance_flows (strategy, ref, ts, amount, asset, source)
-- values ('alpha', 'manual-alpha-deposit-1', '2026-07-15T12:00:00Z', 200, 'USDT', 'manual')
-- on conflict (strategy, ref) do nothing;
