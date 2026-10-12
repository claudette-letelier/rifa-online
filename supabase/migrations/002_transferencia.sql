-- Transferencia a la cuenta del organizador.
-- Ejecutar en el SQL Editor si 001_rifa.sql ya corrió.

alter table public.raffles
  add column if not exists bank_name text,
  add column if not exists account_type text,
  add column if not exists account_number text,
  add column if not exists account_rut text,
  add column if not exists account_holder text;

alter table public.orders
  add column if not exists transfer_code text;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending', 'reported', 'paid', 'failed'));

drop view if exists public.raffle_public;
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
  bank_name,
  account_type,
  account_number,
  account_rut,
  account_holder,
  status,
  winner_number,
  drawn_at,
  created_at
from public.raffles;

grant select on public.raffle_public to anon, authenticated;

create or replace function public.rut_valido(p_rut text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := upper(regexp_replace(coalesce(p_rut, ''), '[^0-9kK]', '', 'g'));
  body text;
  dv text;
  suma integer := 0;
  mul integer := 2;
  i integer;
  resto integer;
  esperado text;
begin
  if v !~ '^[0-9]{7,8}[0-9K]$' then
    return false;
  end if;
  body := substr(v, 1, char_length(v) - 1);
  dv := right(v, 1);
  for i in reverse char_length(body)..1 loop
    suma := suma + substr(body, i, 1)::integer * mul;
    mul := case when mul = 7 then 2 else mul + 1 end;
  end loop;
  resto := 11 - (suma % 11);
  esperado := case when resto = 11 then '0' when resto = 10 then 'K' else resto::text end;
  return dv = esperado;
end;
$$;

create or replace function public.format_rut(p_rut text)
returns text
language plpgsql
immutable
as $$
declare
  v text := upper(regexp_replace(coalesce(p_rut, ''), '[^0-9kK]', '', 'g'));
  body text;
  dotted text := '';
begin
  body := substr(v, 1, char_length(v) - 1);
  while char_length(body) > 3 loop
    dotted := '.' || right(body, 3) || dotted;
    body := left(body, char_length(body) - 3);
  end loop;
  return body || dotted || '-' || right(v, 1);
end;
$$;

drop function if exists public.create_raffle(text, text, text, integer, integer, text, text);

create or replace function public.create_raffle(
  p_title text,
  p_prize text,
  p_description text,
  p_price integer,
  p_total integer,
  p_organizer_name text,
  p_organizer_phone text,
  p_bank_name text,
  p_account_type text,
  p_account_number text,
  p_account_rut text,
  p_account_holder text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_phone text := regexp_replace(coalesce(p_organizer_phone, ''), '[^0-9]', '', 'g');
  v_account text := regexp_replace(coalesce(p_account_number, ''), '[^0-9]', '', 'g');
begin
  if char_length(trim(coalesce(p_title, ''))) < 3
     or char_length(trim(coalesce(p_prize, ''))) < 3
     or char_length(trim(coalesce(p_organizer_name, ''))) < 3
     or char_length(v_phone) < 8
     or p_price < 1000 or p_price > 200000
     or p_total < 10 or p_total > 300 then
    raise exception 'invalid_raffle';
  end if;
  if char_length(trim(coalesce(p_bank_name, ''))) < 3
     or char_length(trim(coalesce(p_bank_name, ''))) > 40
     or p_account_type not in ('Cuenta RUT', 'Cuenta vista', 'Cuenta corriente', 'Cuenta de ahorro')
     or char_length(v_account) < 4
     or char_length(v_account) > 20
     or char_length(trim(coalesce(p_account_holder, ''))) < 3 then
    raise exception 'invalid_bank';
  end if;
  if not public.rut_valido(p_account_rut) then
    raise exception 'invalid_rut';
  end if;

  insert into public.raffles (
    id, title, prize, description, price_clp, total_numbers,
    organizer_name, organizer_phone, admin_token_hash,
    bank_name, account_type, account_number, account_rut, account_holder
  ) values (
    v_id,
    trim(p_title),
    trim(p_prize),
    left(trim(coalesce(p_description, '')), 500),
    p_price,
    p_total,
    trim(p_organizer_name),
    v_phone,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    trim(p_bank_name),
    p_account_type,
    v_account,
    public.format_rut(p_account_rut),
    trim(p_account_holder)
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
  v_until timestamptz := now() + interval '48 hours';
  v_count integer;
  v_code text := upper(substr(replace(v_order::text, '-', ''), 1, 6));
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
  if not exists (
    select 1 from public.raffles
    where id = p_raffle_id and char_length(coalesce(account_number, '')) >= 4
  ) then
    raise exception 'missing_account';
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
    and o.status in ('pending', 'reported')
    and o.reserved_until < now()
    and not exists (select 1 from public.tickets t where t.order_id = o.id);

  insert into public.orders (
    id, raffle_id, buyer_name, buyer_email, buyer_phone,
    amount_clp, status, reserved_until, transfer_code
  ) values (
    v_order,
    p_raffle_id,
    trim(p_name),
    lower(trim(p_email)),
    nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), ''),
    v_price * cardinality(p_numbers),
    'reported',
    v_until,
    v_code
  );

  insert into public.tickets (raffle_id, number, order_id, status)
  select p_raffle_id, x, v_order, 'reserved'
  from unnest(p_numbers) as x;

  return jsonb_build_object(
    'order_id', v_order,
    'amount', v_price * cardinality(p_numbers),
    'transfer_code', v_code,
    'reserved_until', v_until,
    'numbers', to_jsonb(p_numbers)
  );
exception
  when unique_violation then
    raise exception 'number_taken';
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
    'amount_clp', o.amount_clp,
    'transfer_code', o.transfer_code,
    'numbers', coalesce(
      (select jsonb_agg(t.number order by t.number) from public.tickets t where t.order_id = o.id),
      '[]'::jsonb
    )
  )
  from public.orders o
  where o.id = p_order_id;
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
            'transfer_code', o.transfer_code,
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
          and (
            o.status = 'paid'
            or (o.status in ('pending', 'reported') and o.reserved_until > now())
          )
      ), '[]'::jsonb)
    )
    from public.raffle_public rp
    where rp.id = p_raffle_id
  );
end;
$$;

create or replace function public.confirm_transfer(
  p_raffle_id uuid,
  p_token text,
  p_order_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if not public.admin_matches(p_raffle_id, p_token) then
    raise exception 'forbidden';
  end if;

  select status into v_status
  from public.orders
  where id = p_order_id
    and raffle_id = p_raffle_id
  for update;

  if not found then
    raise exception 'not_found';
  end if;
  if v_status = 'paid' then
    return;
  end if;
  if v_status not in ('pending', 'reported') then
    raise exception 'cannot_confirm';
  end if;
  if not exists (
    select 1 from public.tickets
    where order_id = p_order_id and status = 'reserved'
  ) then
    raise exception 'expired';
  end if;

  update public.orders
  set status = 'paid',
      paid_at = now()
  where id = p_order_id;

  update public.tickets
  set status = 'paid'
  where order_id = p_order_id;
end;
$$;

create or replace function public.reject_transfer(
  p_raffle_id uuid,
  p_token text,
  p_order_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if not public.admin_matches(p_raffle_id, p_token) then
    raise exception 'forbidden';
  end if;

  select status into v_status
  from public.orders
  where id = p_order_id
    and raffle_id = p_raffle_id
  for update;

  if not found then
    raise exception 'not_found';
  end if;
  if v_status = 'paid' then
    raise exception 'already_paid';
  end if;

  delete from public.tickets
  where order_id = p_order_id
    and status = 'reserved';

  update public.orders
  set status = 'failed'
  where id = p_order_id
    and status in ('pending', 'reported');
end;
$$;

revoke all on function public.create_raffle(text, text, text, integer, integer, text, text, text, text, text, text, text) from public;
revoke all on function public.reserve_numbers(uuid, integer[], text, text, text) from public;
revoke all on function public.confirm_transfer(uuid, text, uuid) from public;
revoke all on function public.reject_transfer(uuid, text, uuid) from public;
revoke all on function public.rut_valido(text) from public;
revoke all on function public.format_rut(text) from public;

grant execute on function public.create_raffle(text, text, text, integer, integer, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.reserve_numbers(uuid, integer[], text, text, text) to anon, authenticated, service_role;
grant execute on function public.confirm_transfer(uuid, text, uuid) to anon, authenticated;
grant execute on function public.reject_transfer(uuid, text, uuid) to anon, authenticated;
