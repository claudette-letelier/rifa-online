-- Rifa Online: rifas, reservas y números pagados.
-- Ejecutar en el SQL Editor de Supabase o con `supabase db push`.

create extension if not exists pgcrypto with schema extensions;

create table public.raffles (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 80),
  prize text not null check (char_length(prize) between 3 and 140),
  description text not null default '' check (char_length(description) <= 500),
  price_clp integer not null check (price_clp between 1000 and 200000),
  total_numbers integer not null check (total_numbers between 10 and 300),
  organizer_name text not null check (char_length(organizer_name) between 3 and 80),
  organizer_phone text not null check (char_length(organizer_phone) between 8 and 20),
  admin_token_hash text not null,
  status text not null default 'open' check (status in ('open', 'closed', 'drawn')),
  winner_number integer,
  drawn_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles (id) on delete cascade,
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  amount_clp integer not null check (amount_clp > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  mp_preference_id text,
  mp_payment_id text unique,
  reserved_until timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles (id) on delete cascade,
  number integer not null check (number > 0),
  order_id uuid not null references public.orders (id) on delete cascade,
  status text not null check (status in ('reserved', 'paid')),
  unique (raffle_id, number)
);

create index tickets_raffle_idx on public.tickets (raffle_id, status);
create index orders_raffle_idx on public.orders (raffle_id, status);

alter table public.raffles enable row level security;
alter table public.orders enable row level security;
alter table public.tickets enable row level security;

revoke all on public.raffles from anon, authenticated;
revoke all on public.orders from anon, authenticated;
revoke all on public.tickets from anon, authenticated;

create view public.raffle_public
with (security_invoker = false) as
select
  id,
  title,
  prize,
  description,
  price_clp,
  total_numbers,
  organizer_name,
  organizer_phone,
  status,
  winner_number,
  drawn_at,
  created_at
from public.raffles;

create view public.ticket_public
with (security_invoker = false) as
select
  t.raffle_id,
  t.number,
  case
    when t.status = 'paid' then 'paid'
    when t.status = 'reserved' and o.reserved_until > now() then 'reserved'
  end as status
from public.tickets t
join public.orders o on o.id = t.order_id
where t.status = 'paid'
   or (t.status = 'reserved' and o.reserved_until > now());

grant select on public.raffle_public to anon, authenticated;
grant select on public.ticket_public to anon, authenticated;

create or replace function public.create_raffle(
  p_title text,
  p_prize text,
  p_description text,
  p_price integer,
  p_total integer,
  p_organizer_name text,
  p_organizer_phone text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_phone text := regexp_replace(coalesce(p_organizer_phone, ''), '[^0-9]', '', 'g');
begin
  if char_length(trim(coalesce(p_title, ''))) < 3
     or char_length(trim(coalesce(p_prize, ''))) < 3
     or char_length(trim(coalesce(p_organizer_name, ''))) < 3
     or char_length(v_phone) < 8
     or p_price < 1000 or p_price > 200000
     or p_total < 10 or p_total > 300 then
    raise exception 'invalid_raffle';
  end if;

  insert into public.raffles (
    id, title, prize, description, price_clp, total_numbers,
    organizer_name, organizer_phone, admin_token_hash
  ) values (
    v_id,
    trim(p_title),
    trim(p_prize),
    left(trim(coalesce(p_description, '')), 500),
    p_price,
    p_total,
    trim(p_organizer_name),
    v_phone,
    encode(extensions.digest(v_token, 'sha256'), 'hex')
  );

  return jsonb_build_object('id', v_id, 'admin_token', v_token);
end;
$$;

create or replace function public.reserve_numbers(
  p_raffle_id uuid,
  p_numbers integer[],
  p_name text,
  p_email text,
  p_phone text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_order uuid := gen_random_uuid();
  v_price integer;
  v_total integer;
  v_status text;
  v_title text;
  v_until timestamptz := now() + interval '20 minutes';
  v_count integer;
begin
  if p_name is null or char_length(trim(p_name)) < 3 or char_length(p_name) > 80 then
    raise exception 'invalid_name';
  end if;
  if p_email is null or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(p_email) > 120 then
    raise exception 'invalid_email';
  end if;
  if p_numbers is null or cardinality(p_numbers) < 1 or cardinality(p_numbers) > 15 then
    raise exception 'invalid_numbers';
  end if;

  select price_clp, total_numbers, status, title
    into v_price, v_total, v_status, v_title
  from public.raffles
  where id = p_raffle_id
  for update;

  if not found then
    raise exception 'not_found';
  end if;
  if v_status <> 'open' then
    raise exception 'raffle_closed';
  end if;

  select count(distinct x) into v_count from unnest(p_numbers) as x;
  if v_count <> cardinality(p_numbers) then
    raise exception 'duplicate_numbers';
  end if;
  if exists (select 1 from unnest(p_numbers) as x where x < 1 or x > v_total) then
    raise exception 'number_out_of_range';
  end if;

  delete from public.tickets t
  using public.orders o
  where t.order_id = o.id
    and t.raffle_id = p_raffle_id
    and t.status = 'reserved'
    and o.reserved_until < now();

  delete from public.orders o
  where o.raffle_id = p_raffle_id
    and o.status = 'pending'
    and o.reserved_until < now()
    and not exists (select 1 from public.tickets t where t.order_id = o.id);

  insert into public.orders (
    id, raffle_id, buyer_name, buyer_email, buyer_phone, amount_clp, status, reserved_until
  ) values (
    v_order,
    p_raffle_id,
    trim(p_name),
    lower(trim(p_email)),
    nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), ''),
    v_price * cardinality(p_numbers),
    'pending',
    v_until
  );

  insert into public.tickets (raffle_id, number, order_id, status)
  select p_raffle_id, x, v_order, 'reserved'
  from unnest(p_numbers) as x;

  return jsonb_build_object(
    'order_id', v_order,
    'amount', v_price * cardinality(p_numbers),
    'unit_price', v_price,
    'title', v_title,
    'reserved_until', v_until,
    'numbers', to_jsonb(p_numbers)
  );
exception
  when unique_violation then
    raise exception 'number_taken';
end;
$$;

create or replace function public.attach_preference(
  p_order_id uuid,
  p_preference_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
  set mp_preference_id = p_preference_id
  where id = p_order_id
    and status = 'pending';
end;
$$;

create or replace function public.release_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.tickets
  where order_id = p_order_id
    and status = 'reserved';

  update public.orders
  set status = 'failed'
  where id = p_order_id
    and status = 'pending';
end;
$$;

create or replace function public.confirm_payment(
  p_order_id uuid,
  p_payment_id text,
  p_amount integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer;
  v_status text;
  v_existing text;
begin
  select amount_clp, status, mp_payment_id
    into v_amount, v_status, v_existing
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return 'missing';
  end if;
  if v_status = 'paid' then
    return 'already_paid';
  end if;
  if v_status <> 'pending' then
    return 'not_pending';
  end if;
  if v_amount <> p_amount then
    return 'amount_mismatch';
  end if;

  update public.orders
  set status = 'paid',
      mp_payment_id = p_payment_id,
      paid_at = now()
  where id = p_order_id;

  update public.tickets
  set status = 'paid'
  where order_id = p_order_id;

  return 'paid';
end;
$$;

create or replace function public.order_status(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', o.status,
    'raffle_id', o.raffle_id,
    'numbers', coalesce(
      (select jsonb_agg(t.number order by t.number) from public.tickets t where t.order_id = o.id),
      '[]'::jsonb
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;

create or replace function public.admin_matches(p_raffle_id uuid, p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.raffles r
    where r.id = p_raffle_id
      and r.admin_token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.get_admin_raffle(p_raffle_id uuid, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.admin_matches(p_raffle_id, p_token) then
    raise exception 'forbidden';
  end if;

  return (
    select jsonb_build_object(
      'raffle', to_jsonb(rp),
      'orders', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', o.id,
            'buyer_name', o.buyer_name,
            'buyer_email', o.buyer_email,
            'buyer_phone', o.buyer_phone,
            'amount_clp', o.amount_clp,
            'status', o.status,
            'paid_at', o.paid_at,
            'numbers', (
              select coalesce(jsonb_agg(t.number order by t.number), '[]'::jsonb)
              from public.tickets t
              where t.order_id = o.id
            )
          )
          order by o.created_at desc
        )
        from public.orders o
        where o.raffle_id = p_raffle_id
          and (o.status = 'paid' or (o.status = 'pending' and o.reserved_until > now()))
      ), '[]'::jsonb)
    )
    from public.raffle_public rp
    where rp.id = p_raffle_id
  );
end;
$$;

create or replace function public.set_raffle_status(
  p_raffle_id uuid,
  p_token text,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.admin_matches(p_raffle_id, p_token) then
    raise exception 'forbidden';
  end if;
  if p_status not in ('open', 'closed') then
    raise exception 'invalid_status';
  end if;

  update public.raffles
  set status = p_status
  where id = p_raffle_id
    and status <> 'drawn'
    and status <> p_status;

  if not found then
    raise exception 'cannot_change';
  end if;
end;
$$;

create or replace function public.draw_winner(p_raffle_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_winner integer;
  v_count integer;
begin
  if not public.admin_matches(p_raffle_id, p_token) then
    raise exception 'forbidden';
  end if;

  perform 1
  from public.raffles
  where id = p_raffle_id
  for update;

  if exists (select 1 from public.raffles where id = p_raffle_id and status = 'drawn') then
    raise exception 'already_drawn';
  end if;

  select count(*) into v_count
  from public.tickets
  where raffle_id = p_raffle_id
    and status = 'paid';

  if v_count = 0 then
    raise exception 'no_paid_tickets';
  end if;

  select number into v_winner
  from public.tickets
  where raffle_id = p_raffle_id
    and status = 'paid'
  order by extensions.gen_random_uuid()
  limit 1;

  update public.raffles
  set status = 'drawn',
      winner_number = v_winner,
      drawn_at = now()
  where id = p_raffle_id
    and status <> 'drawn';

  return jsonb_build_object('winner_number', v_winner);
end;
$$;

revoke all on function public.create_raffle(text, text, text, integer, integer, text, text) from public;
revoke all on function public.reserve_numbers(uuid, integer[], text, text, text) from public;
revoke all on function public.attach_preference(uuid, text) from public;
revoke all on function public.release_order(uuid) from public;
revoke all on function public.confirm_payment(uuid, text, integer) from public;
revoke all on function public.order_status(uuid) from public;
revoke all on function public.admin_matches(uuid, text) from public;
revoke all on function public.get_admin_raffle(uuid, text) from public;
revoke all on function public.set_raffle_status(uuid, text, text) from public;
revoke all on function public.draw_winner(uuid, text) from public;

grant execute on function public.create_raffle(text, text, text, integer, integer, text, text) to anon, authenticated;
grant execute on function public.order_status(uuid) to anon, authenticated;
grant execute on function public.get_admin_raffle(uuid, text) to anon, authenticated;
grant execute on function public.set_raffle_status(uuid, text, text) to anon, authenticated;
grant execute on function public.draw_winner(uuid, text) to anon, authenticated;

grant execute on function public.reserve_numbers(uuid, integer[], text, text, text) to service_role;
grant execute on function public.attach_preference(uuid, text) to service_role;
grant execute on function public.release_order(uuid) to service_role;
grant execute on function public.confirm_payment(uuid, text, integer) to service_role;
